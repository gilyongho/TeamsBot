#!/usr/bin/env bash
#------------------------------------------------
# test/harness/preflight.sh
#
# 하네스를 띄우기 전에 "운영을 망가뜨릴 수 있는 상태"인지 검사한다.
# 하나라도 걸리면 아무것도 하지 않고 종료한다.
#
#   bash test/harness/preflight.sh && bash test/harness/setup.sh
#------------------------------------------------
set -u

PROD_DIR=${PROD_DIR:-/home/teamsuser/workspace/TeamsBot}
PROD_UNIT=${PROD_UNIT:-teams-app}
HERE=$(pwd -P)

fail=0
ok()   { printf '  \033[32m✅\033[0m %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  \033[31m❌\033[0m %s\n     \033[31m→ %s\033[0m\n' "$1" "$2"; }
warn() { printf '  \033[33m⚠️\033[0m  %s\n' "$1"; }

printf '\033[1m═══ 하네스 사전 검사 ═══\033[0m\n\n'

# ── 1. 운영 디렉터리 안이 아닌가 ──────────────────────────────
printf '\033[1m디렉터리\033[0m\n'
PROD_REAL=$(cd "$PROD_DIR" 2>/dev/null && pwd -P || echo "__none__")
if [ "$HERE" = "$PROD_REAL" ]; then
    bad "운영 디렉터리에서 실행하려 합니다: $HERE" \
        "여기서 .env / cert.pem 을 만들면 운영을 덮어씁니다. 다른 곳에 클론하십시오."
elif [ "$PROD_REAL" != "__none__" ] && case "$HERE" in "$PROD_REAL"/*) true;; *) false;; esac; then
    bad "운영 디렉터리 하위입니다: $HERE" "운영 경로 밖으로 옮기십시오."
else
    ok "운영 경로 밖입니다: $HERE"
fi

# ── 2. 기존 운영 자재를 덮어쓰지 않는가 ───────────────────────
for f in .env cert.pem key.pem; do
    if [ -e "$f" ]; then
        bad "$f 가 이미 있습니다" "덮어쓰면 되돌릴 수 없습니다. 이 디렉터리가 맞는지 확인하십시오."
    fi
done
[ -e .env ] || [ -e cert.pem ] || [ -e key.pem ] || ok "덮어쓸 .env / 인증서가 없습니다"

# ── 3. 운영 서비스가 이 디렉터리를 쓰고 있지 않은가 ───────────
printf '\n\033[1m운영 서비스\033[0m\n'
UNIT_WD=$(systemctl show "$PROD_UNIT" -p WorkingDirectory --value 2>/dev/null || echo '')
if [ -n "$UNIT_WD" ] && [ "$(cd "$UNIT_WD" 2>/dev/null && pwd -P)" = "$HERE" ]; then
    bad "systemd $PROD_UNIT 의 WorkingDirectory 가 여기입니다" "운영이 이 디렉터리를 읽습니다."
else
    ok "systemd $PROD_UNIT 은 다른 디렉터리를 씁니다 (${UNIT_WD:-확인불가})"
fi
if systemctl is-active --quiet "$PROD_UNIT" 2>/dev/null; then
    ok "운영 서비스 정상 동작 중 (건드리지 않습니다)"
else
    warn "운영 서비스가 실행 중이 아닙니다. 하네스와 무관하지만 확인하십시오."
fi

# ── 4. 포트가 비어 있는가 / 운영 포트와 겹치지 않는가 ─────────
printf '\n\033[1m포트\033[0m\n'
# ss(리눅스) / netstat / lsof(macOS) 중 있는 것을 쓴다.
inuse() {
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | grep -q "[:.]$1 "
    elif command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
    elif command -v netstat >/dev/null 2>&1; then
        netstat -an 2>/dev/null | grep -q "[:.]$1 .*LISTEN"
    else
        return 1
    fi
}
for p in 3979 8081 19000; do
    if inuse "$p"; then bad "포트 $p 사용 중" "하네스가 기동하지 못합니다."
    else ok "포트 $p 비어 있음"; fi
done
for p in 3978 8080; do
    inuse "$p" && ok "운영 포트 $p 는 그대로 사용 중" || warn "운영 포트 $p 가 열려 있지 않습니다"
done

# ── 5. 하네스 설정이 진짜 상류를 가리키지 않는가 ──────────────
printf '\n\033[1m하네스 설정\033[0m\n'
ENVF=test/harness/env.harness
if [ ! -f "$ENVF" ]; then
    bad "$ENVF 가 없습니다" "브랜치를 잘못 받았습니다."
else
    if grep -qE '^UiPathBaseURL="http://127\.0\.0\.1:' "$ENVF"; then
        ok "UiPathBaseURL 이 로컬 mock 을 가리킵니다"
    else
        bad "UiPathBaseURL 이 로컬이 아닙니다" "진짜 Orchestrator 에 Job 을 띄울 수 있습니다."
    fi
    if grep -qE '^UiPathWebhookUrl="http://127\.0\.0\.1:' "$ENVF"; then
        ok "UiPathWebhookUrl 이 로컬 mock 을 가리킵니다"
    else
        bad "UiPathWebhookUrl 이 로컬이 아닙니다" "진짜 Maestro 로 메시지가 갑니다."
    fi
    if grep -qE '^MicrosoftAppId=""' "$ENVF"; then
        ok "MicrosoftAppId 가 비어 있습니다 (진짜 Teams 로 발신 불가)"
    else
        bad "MicrosoftAppId 가 채워져 있습니다" "진짜 사용자에게 메시지를 보낼 수 있습니다."
    fi
    if grep -qE '^MicrosoftAppPort=3979' "$ENVF" && grep -qE '^MessageQueuePort=8081' "$ENVF"; then
        ok "포트가 운영과 분리돼 있습니다 (3979 / 8081)"
    else
        bad "포트 설정이 운영과 겹칠 수 있습니다" "env.harness 를 확인하십시오."
    fi
fi

# ── 6. 자원 ───────────────────────────────────────────────────
printf '\n\033[1m자원\033[0m\n'
# free 는 리눅스 전용이다. macOS 등에서는 건너뛴다.
if command -v free >/dev/null 2>&1; then
    MEM=$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')
    if [ -n "${MEM:-}" ]; then
        [ "$MEM" -gt 400 ] && ok "가용 메모리 ${MEM}MB" || bad "가용 메모리 ${MEM}MB" "Node 프로세스 추가에 최소 400MB 를 권장합니다."
    fi
else
    warn "메모리 확인 생략 (free 없음 — 리눅스가 아닙니다)"
fi
DISK=$(df -Pm . | awk 'NR==2{print $4}')
[ "$DISK" -gt 500 ] && ok "가용 디스크 ${DISK}MB" || bad "가용 디스크 ${DISK}MB" "npm install 에 약 300MB 가 필요합니다."

# ── 결과 ──────────────────────────────────────────────────────
printf '\n'
if [ "$fail" -eq 0 ]; then
    printf '\033[1;32m통과. 하네스를 띄워도 안전합니다.\033[0m\n\n'
    printf '  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 1 -nodes -subj "/CN=localhost"\n'
    printf '  cp test/harness/env.harness .env\n'
    printf '  node test/harness/mock-upstream.js &\n'
    printf '  node main.js &\n'
    printf '  bash test/harness/scenarios.sh\n\n'
    exit 0
else
    printf '\033[1;31m%d건 걸렸습니다. 아무것도 실행하지 마십시오.\033[0m\n\n' "$fail"
    exit 1
fi
