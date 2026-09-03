#!/usr/bin/env bash
#------------------------------------------------
# test/harness/scenarios.sh
#
# mock 상류를 붙인 두 번째 인스턴스에 대고 시나리오를 실행한다.
# 운영 인스턴스(3978/8080)는 건드리지 않는다.
#
# 사전:
#   1) node test/harness/mock-upstream.js &
#   2) cp test/harness/env.harness .env      ← 별도 디렉터리에 클론해서 사용할 것
#   3) node main.js &
#   4) bash test/harness/scenarios.sh
#------------------------------------------------
set -u

MOCK=http://127.0.0.1:19000
APP=https://localhost:3979
USER_ID=${USER_ID:-aad-user-1}

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '    \033[32m✅\033[0m %s\n' "$1"; }
no()  { fail=$((fail+1)); printf '    \033[31m❌\033[0m %s  %s\n' "$1" "${2:-}"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

ctl()   { curl -s -X POST $MOCK/__control -H 'content-type: application/json' -d "$1" >/dev/null; }
state() { curl -s $MOCK/__state; }
clear_state() { ctl '{"clear":true}'; }

# Teams 활동 주입
say() {
  local text="$1"
  curl -k -s -o /dev/null -X POST $APP/api/messages -H 'content-type: application/json' \
    -d "{\"type\":\"message\",\"id\":\"$RANDOM\",\"timestamp\":\"2026-09-02T06:00:00Z\",
         \"serviceUrl\":\"$MOCK/teams\",\"channelId\":\"msteams\",
         \"from\":{\"id\":\"29:u\",\"aadObjectId\":\"$USER_ID\",\"name\":\"테스트\"},
         \"conversation\":{\"id\":\"c1\",\"tenantId\":\"t\"},
         \"recipient\":{\"id\":\"28:bot\",\"name\":\"bot\"},
         \"text\":\"$text\",\"locale\":\"ko-KR\"}"
}

# mock 이 죽어 있으면 curl 이 빈 문자열을 돌려주고 python 이 트레이스백을 쏟는다.
# 아래 세 헬퍼는 그 경우 조용히 빈 값 / -1 을 돌려주고, 판정은 사전 검사에서 막는다.
msgs() { curl -s --max-time 5 "$MOCK/__state" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
print('\n'.join(m['text'] or '' for m in d['seen']['botMessages']))" 2>/dev/null; }

count() { curl -s --max-time 5 "$MOCK/__state" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['counts']['$1'])
except Exception: print(-1)" 2>/dev/null; }

stopbody() { curl -s --max-time 5 "$MOCK/__state" | python3 -c "
import json,sys
try: s=json.load(sys.stdin)['seen']['stopJob']
except Exception: print('{}'); sys.exit(0)
print(json.dumps(s[-1]['body'], ensure_ascii=False) if s else '{}')" 2>/dev/null; }

printf '\033[1m═══ TeamsBot 로컬 검증 시나리오 ═══\033[0m\n'

# ── 사전 확인 ────────────────────────────────────────────────
# 둘 중 하나라도 떠 있지 않으면 모든 시나리오가 무의미하게 실패한다.
# 그걸 "테스트 실패"로 보고하면 코드 결함으로 오인된다. 판정 전에 멈춘다.
down=0
if [ "$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' "$MOCK/__state")" != "200" ]; then
    printf '\n\033[31m❌ mock 이 응답하지 않습니다\033[0m  (%s)\n' "$MOCK"
    printf '     \033[2mnode test/harness/mock-upstream.js > /tmp/mock.log 2>&1 &\033[0m\n'
    down=1
fi
if ! curl -k -s --max-time 3 -o /dev/null "$APP/api/messages" 2>/dev/null; then
    printf '\n\033[31m❌ 앱이 응답하지 않습니다\033[0m  (%s)\n' "$APP"
    printf '     \033[2mcp test/harness/env.harness .env  그리고 인증서가 있어야 기동합니다.\033[0m\n'
    printf '     \033[2m기동 실패 원인은 /tmp/app.log 에 있습니다.\033[0m\n'
    down=1
fi
if [ "$down" = "1" ]; then
    printf '\n\033[1;31m기동되지 않은 상태입니다. 시나리오를 실행하지 않았습니다.\033[0m\n\n'
    exit 2
fi

# ── H-1 : 진행 중 세션이 없을 때의 일반 메시지 ──────────────
hdr 'H-1  세션 없음 + 일반 메시지 → 시작 방법 안내 (침묵 아님)'
clear_state; ctl '{"webhook":"ok"}'
say "안녕하세요 도와주세요"; sleep 2
if msgs | grep -q "진행 중인 대화가 없습니다"; then ok "시작 안내를 받음"; else no "시작 안내 없음" "$(msgs|tr '\n' '|')"; fi
[ "$(count webhook)" = "0" ] && ok "webhook 으로 보내지 않음" || no "webhook 발송됨" "$(count webhook)건"

# ── H-2 : 트리거 → Job 기동 ────────────────────────────────
hdr 'H-2  트리거 → Job 기동'
clear_state
say "에이전트 시작"; sleep 3
[ "$(count startJob)" = "1" ] && ok "StartJobs 1회" || no "StartJobs 횟수" "$(count startJob)"
msgs | grep -q "준비중" && ok "준비 안내 수신" || no "준비 안내 없음"

# ── H-3 : 대화 중 답변 → webhook 정확히 1회 (핵심) ─────────
hdr 'H-3  답변 → webhook 정확히 1회  ← 이번 장애의 원인'
clear_state
say "국내"; sleep 3
n=$(count webhook)
[ "$n" = "1" ] && ok "webhook 정확히 1회" || no "webhook 발송 횟수" "${n}회 (2회면 중복 발송 재발)"
curl -s $MOCK/__state | python3 -c "
import json,sys
w=json.load(sys.stdin)['seen']['webhook']
if w:
    h=w[0]['headers']
    print('    ✅ 헤더명 x-uipath-webhookkey' if 'x-uipath-webhookkey' in h else '    ❌ 헤더명 오류: '+str([k for k in h if 'uipath' in k.lower()]))
    print('    ✅ message_id 포함' if w[0]['body'].get('message_id') else '    ❌ message_id 없음')"

# ── H-4 : webhook 실패 → 재시도 → 사용자 안내 ──────────────
hdr 'H-4  webhook 실패 → 재시도 → 사용자에게 재입력 안내  ← R-1'
clear_state; ctl '{"webhook":"fail"}'
say "발송해줘"; sleep 5
n=$(count webhook)
[ "$n" = "2" ] && ok "1차+재시도 = 2회" || no "발송 횟수" "${n}회"
msgs | grep -q "처리하지 못했습니다" && ok "사용자가 재입력 안내를 받음" || no "안내 없음 — 메시지가 조용히 소실됨"
ctl '{"webhook":"ok"}'

# ── H-5 : webhook 무응답 → 타임아웃이 걸리는가 ─────────────
hdr 'H-5  webhook 무응답 → 타임아웃 (무한 대기 아님)'
clear_state; ctl '{"webhook":"hang"}'
t0=$(date +%s)
say "무응답테스트"; sleep 14
t1=$(date +%s)
msgs | grep -q "처리하지 못했습니다" \
  && ok "$((t1-t0))초 안에 실패 처리됨 (타임아웃 동작)" \
  || no "타임아웃 미동작 — 무한 대기 의심"
ctl '{"webhook":"ok"}'

# ── H-6 : 재시작 (RestartOnTrigger=true 일 때만) ───────────
hdr 'H-6  재시작 — StopJobs 요청 형식  ※ RestartOnTrigger=true 필요'
clear_state; ctl '{"stopTransition":"immediate"}'
say "다시 시작"; sleep 6
# count 가 -1(조회 실패)이거나 0 이면 호출되지 않은 것이다.
# 예전에는 != "0" 으로만 봐서, 조회에 실패한 빈 문자열이 "호출됨"으로 통과했다.
ns=$(count stopJob)
if [ "${ns:-0}" -gt 0 ] 2>/dev/null; then
  b=$(stopbody)
  echo "$b" | grep -q '"jobIds"' && ok "body 에 jobIds 배열" || no "jobIds 없음" "$b"
  echo "$b" | grep -q '"strategy"' && ok "body 에 strategy" || no "strategy 없음" "$b"
  ok "StopJobs 호출됨: $b"
else
  printf '    \033[33m—\033[0m RestartOnTrigger=false 라 건너뜀 (정상)\n'
fi

printf '\n\033[1m결과: %d 통과 / %d 실패\033[0m\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
