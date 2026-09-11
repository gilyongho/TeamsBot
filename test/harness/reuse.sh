#!/usr/bin/env bash
#------------------------------------------------
# test/harness/reuse.sh
#
# 대화 재사용(ReuseConversation) 검증.
#
# 무엇을 세는가
#   "봇이 메시지를 몇 통 보냈는가" 가 아니라 "대화를 몇 번 만들었는가" 를 센다.
#   지금 문제의 본질이 발송마다 createConversation 을 호출하는 것이므로,
#   그 호출 수가 줄었는지가 유일하게 의미 있는 지표다.
#
# 전제
#   mock-upstream 과 앱이 떠 있어야 한다. scenarios.sh 와 같다.
#     node test/harness/mock-upstream.js > /tmp/mock.log 2>&1 &
#     node main.js > /tmp/app.log 2>&1 &
#------------------------------------------------
set -u

MOCK=${MOCK:-http://127.0.0.1:19000}
APP=${APP:-https://127.0.0.1:3979}
TA_KEY=${TA_KEY:-harness-ta-key}
RUN_ID=${RUN_ID:-$$-$RANDOM}

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '    \033[32m✅\033[0m %s\n' "$1"; }
no()  { fail=$((fail+1)); printf '    \033[31m❌\033[0m %s  %s\n' "$1" "${2:-}"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

ctl()         { curl -s -X POST $MOCK/__control -H 'content-type: application/json' -d "$1" >/dev/null; }
clear_state() { ctl '{"clear":true}'; }

say() {
  local text="$1" uid="$2"
  curl -k -s -o /dev/null -X POST $APP/api/messages -H 'content-type: application/json' \
    -d "{\"type\":\"message\",\"id\":\"$RANDOM\",\"timestamp\":\"2026-09-11T06:00:00Z\",
         \"serviceUrl\":\"$MOCK/teams\",\"channelId\":\"msteams\",
         \"from\":{\"id\":\"29:$uid\",\"aadObjectId\":\"$uid\",\"name\":\"테스트\"},
         \"conversation\":{\"id\":\"c-$uid\",\"tenantId\":\"t\"},
         \"recipient\":{\"id\":\"28:bot\",\"name\":\"bot\"},
         \"text\":\"$text\",\"locale\":\"ko-KR\"}"
}

sendmsg() {
  local text="$1" uid="$2"
  curl -k -s -o /dev/null -w '%{http_code}' -X POST $APP/api/sendMessage \
    -H 'content-type: application/json' -H "x-api-key: $TA_KEY" \
    -d "{\"userId\":\"$uid\",\"message\":\"$text\"}"
}

count() { curl -s --max-time 5 "$MOCK/__state" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['counts']['$1'])
except Exception: print(-1)" 2>/dev/null; }

# 봇이 메시지를 내보낸 대화 id 목록 (중복 제거 없이 순서대로)
convids() { curl -s --max-time 5 "$MOCK/__state" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
print(' '.join(m.get('conversationId','?') for m in d['seen']['botMessages']))" 2>/dev/null; }

uniqconvs() { curl -s --max-time 5 "$MOCK/__state" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(-1); sys.exit(0)
print(len({m.get('conversationId') for m in d['seen']['botMessages']}))" 2>/dev/null; }

printf '\033[1m═══ 대화 재사용 검증 ═══\033[0m\n'

if [ "$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' "$MOCK/__state")" != "200" ]; then
    printf '\n\033[31m❌ mock 이 응답하지 않습니다\033[0m (%s)\n\n' "$MOCK"; exit 2
fi
if ! curl -k -s --max-time 3 -o /dev/null "$APP/api/messages" 2>/dev/null; then
    printf '\n\033[31m❌ 앱이 응답하지 않습니다\033[0m (%s)\n\n' "$APP"; exit 2
fi

MODE=$(curl -k -s --max-time 3 -o /dev/null -w '%{http_code}' "$APP/api/messages" >/dev/null; echo "${ReuseConversation:-true}")
printf '  ReuseConversation=%s  (앱 기동 시 설정)\n' "$MODE"

#===================================================================
hdr "R-1  이미 대화가 있는 사람에게 연속 발송 — 대화를 다시 만들지 않는다"
#-------------------------------------------------------------------
#  담당자가 봇에게 말을 건 뒤, 시스템이 그 담당자에게 알림을 세 번 보낸다.
#  9월 9일 11:55:28 이 바로 이 모양이었다 — 2초 전에 참조가 잡혀 있는데도
#  대화를 새로 만들다가 403 을 받았다.
#===================================================================
U1="aad-r1-$RUN_ID"
clear_state
say "안녕하세요" "$U1"; sleep 2
clear_state                      # 인사 응답은 세지 않는다. 여기서부터가 측정 구간이다.

c1=$(sendmsg "첫 번째 알림" "$U1"); sleep 1
c2=$(sendmsg "두 번째 알림" "$U1"); sleep 1
c3=$(sendmsg "세 번째 알림" "$U1"); sleep 1

[ "$c1$c2$c3" = "200200200" ] && ok "세 번 모두 200" || no "발송 응답" "$c1 $c2 $c3"

n=$(count createConversation)
if [ "${ReuseConversation:-true}" = "false" ]; then
    [ "$n" = "3" ] && ok "종전 동작: 대화 생성 3회 (발송마다 1회)" \
                   || no "종전 동작이면 3회여야 함" "실제 $n"
else
    [ "$n" = "0" ] && ok "대화 생성 0회 — createConversation 을 한 번도 부르지 않음" \
                   || no "대화 생성이 남아 있음" "실제 $n"
fi

m=$(count botMessages)
[ "$m" = "3" ] && ok "메시지 3통 전달됨" || no "전달된 메시지 수" "실제 $m"

u=$(uniqconvs)
if [ "${ReuseConversation:-true}" = "false" ]; then
    # 종전 동작에서는 같은 사람에게 세 통을 보내는데 대화가 세 개 만들어진다.
    # 이 줄이 지금 결함의 모양 그 자체다.
    [ "$u" = "3" ] && ok "종전 동작: 한 사람에게 세 통인데 대화가 3개로 갈라짐" \
                   || no "종전 동작이면 3개여야 함" "실제 $u"
else
    [ "$u" = "1" ] && ok "세 통이 모두 같은 대화로 나감" || no "대화가 갈라짐" "서로 다른 대화 $u 개"
fi
printf '      \033[2m대화 id: %s\033[0m\n' "$(convids)"

#===================================================================
hdr "R-2  한 번도 말을 건 적 없는 사람 — 처음 한 번만 대화를 만든다"
#-------------------------------------------------------------------
#  첫 접촉에는 createConversation 이 필요하다. 그 결과를 보관하는지가 관건이다.
#===================================================================
U2="aad-r2-$RUN_ID"
clear_state
c1=$(sendmsg "첫 접촉" "$U2"); sleep 1
n1=$(count createConversation)
[ "$c1" = "200" ] && ok "첫 발송 200" || no "첫 발송" "HTTP $c1"
[ "$n1" = "1" ] && ok "첫 발송에서 대화 생성 1회 (필요한 호출)" || no "첫 발송 대화 생성" "실제 $n1"

c2=$(sendmsg "두 번째" "$U2"); sleep 1
c3=$(sendmsg "세 번째" "$U2"); sleep 1
n2=$(count createConversation)
if [ "${ReuseConversation:-true}" = "false" ]; then
    [ "$n2" = "3" ] && ok "종전 동작: 누적 3회" || no "종전 동작이면 3회" "실제 $n2"
else
    [ "$n2" = "1" ] && ok "이후 두 번은 대화를 만들지 않음 (누적 1회 그대로)" \
                    || no "이후에도 대화를 만듦" "누적 $n2"
fi
[ "$(count botMessages)" = "3" ] && ok "메시지 3통 전달됨" || no "전달 수" "$(count botMessages)"

#===================================================================
hdr "R-3  보관한 참조가 못 쓰게 됐을 때 — 버리고 다시 만들어 보낸다"
#-------------------------------------------------------------------
#  이것이 없으면 재사용을 넣은 쪽이 더 나빠진다. 참조는 serviceUrl 변경·
#  대화 삭제로 언제든 못 쓰게 될 수 있다.
#===================================================================
U3="aad-r3-$RUN_ID"
clear_state
say "안녕하세요" "$U3"; sleep 2
clear_state
ctl "{\"staleConv\":\"c-$U3\"}"        # 보관된 대화로의 전송을 막는다

c1=$(sendmsg "알림" "$U3"); sleep 2
ctl '{"staleConv":""}'

if [ "${ReuseConversation:-true}" = "false" ]; then
    ok "종전 동작에서는 해당 없음 (건너뜀)"
else
    [ "$c1" = "200" ] && ok "폴백이 동작해 200 — 발송이 끊기지 않음" \
                      || no "폴백 실패" "HTTP $c1"
    n=$(count createConversation)
    [ "$n" = "1" ] && ok "못 쓰게 된 참조를 버리고 대화를 1회 다시 만듦" \
                   || no "재생성 횟수" "실제 $n"
    [ "$(count botMessages)" = "1" ] && ok "메시지가 결국 전달됨" \
                                     || no "전달 실패" "$(count botMessages)"

    # 버린 뒤 새로 보관했는지 — 다음 발송은 다시 생성 없이 나가야 한다
    clear_state
    c2=$(sendmsg "다음 알림" "$U3"); sleep 1
    [ "$(count createConversation)" = "0" ] && ok "새 참조가 보관되어 다음 발송은 생성 0회" \
                                            || no "다음 발송에서 또 생성" "$(count createConversation)"
fi

#===================================================================
hdr "R-4  대화 생성이 403 이면 — 200 으로 숨기지 않는다"
#-------------------------------------------------------------------
#  운영에서 관측된 403 을 대화 생성 단계에서 재현한다. 재사용이 있어도
#  보관분이 없는 첫 접촉은 이 경로를 지난다.
#===================================================================
U4="aad-r4-$RUN_ID"
clear_state
ctl '{"teams":"forbidden"}'
c1=$(sendmsg "알림" "$U4"); sleep 2
ctl '{"teams":"ok"}'

[ "$c1" = "502" ] && ok "502 를 돌려줌 — RPA 가 실패를 알 수 있음" \
                  || no "실패가 숨겨짐" "HTTP $c1 (200 이면 종전 결함)"
[ "$(count botMessages)" = "0" ] && ok "실제로 전달된 메시지 없음 (일치)" \
                                 || no "전달 기록이 남음" "$(count botMessages)"

#===================================================================
printf '\n\033[1m결과: 통과 %d / 실패 %d\033[0m\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
