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

# 사용자 ID 는 실행마다 새로 만든다.
#   jobtable 은 앱 프로세스 안에 있어서 시나리오가 끝나도 남는다. 같은 ID 를 다시 쓰면
#   두 번째 실행의 H-1("진행 중인 세션이 없을 때")이 이미 세션이 있는 상태로 돌아
#   실패한다 — 코드가 아니라 전제가 틀린 것이다. 앱 재기동을 강요하는 대신 ID 를 바꾼다.
RUN_ID=${RUN_ID:-$$-$RANDOM}
USER_ID=${USER_ID:-aad-user-$RUN_ID}

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '    \033[32m✅\033[0m %s\n' "$1"; }
no()  { fail=$((fail+1)); printf '    \033[31m❌\033[0m %s  %s\n' "$1" "${2:-}"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

ctl()   { curl -s -X POST $MOCK/__control -H 'content-type: application/json' -d "$1" >/dev/null; }
state() { curl -s $MOCK/__state; }
clear_state() { ctl '{"clear":true}'; }

# Teams 활동 주입.  say "본문" [사용자ID]
#   두 번째 인자로 사용자를 바꿀 수 있다. 앞 시나리오가 남긴 세션·재시작 쿨다운이
#   다음 시나리오의 전제를 흐리므로, 독립적인 판정이 필요한 곳에서는 새 사용자를 쓴다.
say() {
  local text="$1"
  local uid="${2:-$USER_ID}"
  curl -k -s -o /dev/null -X POST $APP/api/messages -H 'content-type: application/json' \
    -d "{\"type\":\"message\",\"id\":\"$RANDOM\",\"timestamp\":\"2026-09-02T06:00:00Z\",
         \"serviceUrl\":\"$MOCK/teams\",\"channelId\":\"msteams\",
         \"from\":{\"id\":\"29:$uid\",\"aadObjectId\":\"$uid\",\"name\":\"테스트\"},
         \"conversation\":{\"id\":\"c-$uid\",\"tenantId\":\"t\"},
         \"recipient\":{\"id\":\"28:bot\",\"name\":\"bot\"},
         \"text\":\"$text\",\"locale\":\"ko-KR\"}"
}

# 외부 시스템이 /api/sendMessage 로 대화를 시작하는 것을 흉내낸다.
#   sendmsg "본문" [사용자ID]  →  HTTP 상태 코드를 표준출력으로 돌려준다.
#   TeamsAppApiKey 는 env.harness 의 값과 같아야 한다.
TA_KEY=${TA_KEY:-harness-ta-key}
sendmsg() {
  local text="$1"
  local uid="${2:-$USER_ID}"
  curl -k -s -o /dev/null -w '%{http_code}' -X POST $APP/api/sendMessage \
    -H 'content-type: application/json' -H "x-api-key: $TA_KEY" \
    -d "{\"userId\":\"$uid\",\"message\":\"$text\"}"
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

# ── H-7 : 상태 조회가 실패할 때 새 Job 을 띄우지 않는가 ────
# 동료 리뷰 2차의 핵심 지적. 이전 Job 의 생사를 모르는 채 기동하면 한 대화에
# 에이전트가 둘 붙는다 — 이번 장애와 같은 종류의 고장이다.
hdr 'H-7  상태 조회 실패(5xx) → 기동하지 않고 사용자 안내  ← 중복 실행 방지'
# 앞 시나리오의 세션과 재시작 쿨다운을 물려받지 않도록 전용 사용자를 쓴다.
U7=aad-user-h7-$RUN_ID
clear_state; ctl '{"jobState":"ok","webhook":"ok"}'
say "에이전트 시작" "$U7"; sleep 3                 # 이 사용자의 세션을 하나 만든다
before=$(count startJob)
if [ "$before" != "1" ]; then
  no "전제 실패 — 첫 기동이 1회가 아님" "${before}회"
else
  ok "전제: 이 사용자에게 Job 1개 (StartJobs 1회)"
  ctl '{"jobState":"fail"}'                        # Orchestrator 상태 조회가 죽는다
  say "에이전트 시작" "$U7"; sleep 12               # 재시도 임계치를 넘길 만큼
  after=$(count startJob)
  [ "$after" = "1" ] \
    && ok "상태를 모르는 채로 새 Job 을 띄우지 않음 (여전히 1회)" \
    || no "새 Job 이 기동됨 — 한 대화에 에이전트 둘" "1 → ${after}"
  msgs | grep -q "상태를 확인할 수 없어" \
    && ok "사용자가 안내를 받음 (M10)" \
    || no "안내 없음 — 사용자가 영문도 모르고 기다림" "$(msgs | tail -1)"
fi

# ── H-8 : 404 는 확정된 답이므로 기동해야 한다 ──────────────
hdr 'H-8  상태 조회 404 → 등록 정리 후 기동  ← 영구 정지 방지'
# H-7 의 사용자를 그대로 쓴다. jobtable 에 등록이 남아 있는 상태에서,
# Orchestrator 가 404("그런 Job 없음")로 답하면 정리하고 기동해야 한다.
clear_state; ctl '{"jobState":"notfound"}'
say "에이전트 시작" "$U7"; sleep 6
n8=$(count startJob)
[ "${n8:-0}" -gt 0 ] 2>/dev/null \
  && ok "404 면 등록을 정리하고 새로 기동함 (${n8}회)" \
  || no "기동하지 않음 — 오래된 Job ID 로 사용자가 영구 정지됨" "${n8}"
ctl '{"jobState":"ok"}'

# ══════════════════════════════════════════════════════════════
#  [J-7 보완] 외부 시스템이 시작한 대화
#
#  J-7 은 "진행 중인 세션이 없는 일반 메시지"를 webhook 으로 보내지 않고 시작
#  안내(M8)로 돌린다. 그 판정이 jobtable 뿐이라, /api/sendMessage 로 대화를
#  시작한 외부 시스템(예: 2차인증 RPA)의 답변까지 흡수해 버렸다.
#  아래 세 시나리오가 그 경계를 고정한다.
# ══════════════════════════════════════════════════════════════

# ── H-9 : sendMessage 로 시작한 대화의 답변은 webhook 으로 가야 한다 ──
hdr 'H-9  /api/sendMessage 로 시작 → 답변이 webhook 으로  ← J-7 보완의 핵심'
# 전용 사용자를 쓴다. 앞 시나리오의 jobtable 등록이 남아 있으면 hasJob 만으로
# 통과해 버려서, 정작 검증하려는 outbound 맥락 판정을 지나친다.
U9=aad-user-h9-$RUN_ID
clear_state
# createConversationAndContinue 가 conversationReference 를 역참조한다.
#   그 값은 onMessage 에서만 채워지므로, 한 번도 활동이 없으면 sendMessage 가 502 다.
#   실제 운영에서도 재기동 직후 같은 상태가 되므로, 별도 소견으로 보고한다.
say "안녕" "$U9" >/dev/null; sleep 2
clear_state
code=$(sendmsg "인증 코드를 입력해 주세요" "$U9")
if [ "$code" != "200" ]; then
  no "전제 실패 — /api/sendMessage 가 200 이 아님" "HTTP $code"
else
  ok "전제: /api/sendMessage 200"
  sleep 1
  clear_state
  say "483920" "$U9"; sleep 3               # 사용자가 인증 코드를 입력한다
  n9=$(count webhook)
  [ "$n9" = "1" ] \
    && ok "답변이 webhook 으로 정확히 1회 전달됨" \
    || no "webhook 발송 횟수" "${n9}회 — 0 이면 M8 이 답변을 흡수한 것(외부 시스템 영구 대기)"
  msgs | grep -q "진행 중인 대화가 없습니다" \
    && no "M8 이 발송됨 — 맥락 판정이 동작하지 않음" \
    || ok "M8 을 보내지 않음"
fi

# ── H-10 : TTL 이 지나면 다시 J-7 이 적용된다 ────────────────
hdr 'H-10 outbound 맥락 TTL 만료 → 다시 시작 안내(M8)  ※ OutboundContextTtlMs 짧게 설정 필요'
# env.harness 의 OutboundContextTtlMs 가 3000 이하일 때만 의미가 있다.
# 기본값(600000)으로 돌리면 대기 시간이 10분이라 시나리오가 성립하지 않는다.
TTL_MS=${OUTBOUND_TTL_MS_FOR_TEST:-3000}
if [ "$TTL_MS" -gt 5000 ] 2>/dev/null; then
  printf '    \033[33m—\033[0m OutboundContextTtlMs 가 커서 건너뜀 (env.harness 에서 3000 으로 낮추면 검증됨)\n'
else
  U10=aad-user-h10-$RUN_ID
  clear_state
  say "안녕" "$U10" >/dev/null; sleep 2
  code=$(sendmsg "인증 코드를 입력해 주세요" "$U10")
  if [ "$code" != "200" ]; then
    no "전제 실패 — /api/sendMessage 가 200 이 아님" "HTTP $code"
  else
    sleep $(( TTL_MS / 1000 + 2 ))          # TTL 을 확실히 넘긴다
    clear_state
    say "483920" "$U10"; sleep 3
    n10=$(count webhook)
    [ "${n10:-0}" = "0" ] \
      && ok "TTL 경과 후에는 webhook 으로 보내지 않음" \
      || no "TTL 이 만료되지 않음" "${n10}회 발송됨"
    msgs | grep -q "진행 중인 대화가 없습니다" \
      && ok "시작 안내(M8)로 되돌아감 — J-7 이 유지됨" \
      || no "M8 없음" "$(msgs | tr '\n' '|')"
  fi
fi

# ── H-11 : sendMessage 를 쓰지 않는 배포는 기존 동작과 동일해야 한다 ──
hdr 'H-11 sendMessage 미사용 사용자 → J-7 그대로  ← 다른 고객 회귀 방지'
# 이 성질이 깨지면 고객별 설정 없이 단일 소스로 운영할 수 없게 된다.
# H-1 과 같은 판정이지만, outbound 표가 다른 사용자로 채워진 상태에서 확인한다.
U11=aad-user-h11-$RUN_ID
clear_state
say "아무 말" "$U11"; sleep 3
n11=$(count webhook)
[ "${n11:-0}" = "0" ] \
  && ok "webhook 으로 보내지 않음 (다른 사용자의 outbound 맥락에 영향받지 않음)" \
  || no "webhook 발송됨 — J-7 이 무력화됨" "${n11}회"
msgs | grep -q "진행 중인 대화가 없습니다" \
  && ok "시작 안내를 받음" \
  || no "시작 안내 없음" "$(msgs | tr '\n' '|')"

printf '\n\033[1m결과: %d 통과 / %d 실패\033[0m\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
