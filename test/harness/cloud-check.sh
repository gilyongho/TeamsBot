#!/usr/bin/env bash
#------------------------------------------------
# test/harness/cloud-check.sh
#
# 진짜 Orchestrator 를 상대로, 이 코드가 보내는 것과 똑같은 요청을 던져본다.
# 대상은 고객 환경이 아니라 본인 Automation Cloud 테넌트다.
#
# 확인하는 것:
#   1) 토큰이 발급되는가 (스코프가 맞는가)
#   2) {org}/{tenant}/odata 와 {org}/{tenant}/orchestrator_/odata 중 무엇이 유효한가
#      ← 운영은 앞 형태로 동작한다. 그게 관례인지 그 환경 특유인지 여기서 갈린다.
#   3) 폴더 헤더 X-UIPATH-OrganizationUnitId 가 먹히는가
#   4) StartJobs 의 ReleaseName 전략이 맞는가
#   5) StopJobs 의 body 형태와 strategy 표기가 맞는가   ← 마지막 미검증 경로
#
# 기본은 읽기 전용이다. Job 을 실제로 띄우고 죽이는 것은 --start-stop 을 줄 때만 한다.
#
#   cp test/harness/env.cloud.example test/harness/env.cloud   # AppId/Secret 채우기
#   bash test/harness/cloud-check.sh                 # 읽기만
#   bash test/harness/cloud-check.sh --start-stop    # Job 기동 → Kill 까지
#
# 토큰과 시크릿은 출력하지 않는다.
#------------------------------------------------
set -u

ENVF=${ENVF:-test/harness/env.cloud}
DO_START_STOP=0
[ "${1:-}" = "--start-stop" ] && DO_START_STOP=1

pass=0; fails=0; warns=0; gate_fail=0
ok()   { pass=$((pass+1));  printf '  \033[32m✅\033[0m %s\n' "$1"; }
no()   { fails=$((fails+1)); printf '  \033[31m❌\033[0m %s\n' "$1"; }
warn() { warns=$((warns+1)); printf '  \033[33m⚠️\033[0m  %s\n' "$1"; }
# RestartOnTrigger 를 켤지 결정하는 항목만 따로 센다.
# Release·런타임은 --start-stop 의 전제일 뿐, 재시작 형식과 무관하다.
gate()  { gate_fail=$((gate_fail+1)); }
info() { printf '     \033[2m%s\033[0m\n' "$1"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

jq_() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
$1"; }

# ── 설정 읽기 ────────────────────────────────────────────────
if [ ! -f "$ENVF" ]; then
    echo "❌ $ENVF 가 없습니다."
    echo "   cp test/harness/env.cloud.example $ENVF   후 AppId / AppSecret 을 채우십시오."
    exit 1
fi
# .env 형식을 셸로 source 하면 값 안의 $ ` " 가 해석된다. App Secret 은 그런 문자를
# 자주 포함하므로(실제로 '$r7G' 때문에 unbound variable 로 죽었다), 해석하지 않고
# 따옴표만 벗겨서 읽는다. 파일에 있는 임의의 셸 코드가 실행되는 것도 함께 막힌다.
load_env() {
    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*|*[!=]*) : ;; esac
        case "$line" in ''|'#'*) continue ;; esac
        case "$line" in *=*) : ;; *) continue ;; esac
        key=${line%%=*}
        val=${line#*=}
        case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
        case "$val" in
            \"*\") val=${val#\"}; val=${val%\"} ;;
            \'*\') val=${val#\'}; val=${val%\'} ;;
        esac
        printf -v "$key" '%s' "$val"
    done < "$1"
}
load_env "$ENVF"

for v in UiPathBaseURL UiPathOrganizationName UiPathTenantName UiPathFolderId UiPathAppId UiPathAppSecret; do
    if [ -z "${!v:-}" ]; then echo "❌ $ENVF 에 $v 가 비어 있습니다."; exit 1; fi
done

BASE="$UiPathBaseURL"
ORG="$UiPathOrganizationName"
TEN="$UiPathTenantName"
FID="$UiPathFolderId"
SCOPE="${UiPathAuthScope:-OR.Jobs OR.Execution OR.Folders.Read OR.Machines.Read}"

printf '\033[1m═══ 실제 Orchestrator 검증 ═══\033[0m\n'
info "$BASE/$ORG/$TEN   folder=$FID"

# ── 1. 토큰 ──────────────────────────────────────────────────
hdr '1. 토큰 발급'
TOKRES=$(curl -s -X POST "$BASE/identity_/connect/token" \
    -d grant_type=client_credentials \
    -d client_id="$UiPathAppId" \
    --data-urlencode client_secret="$UiPathAppSecret" \
    --data-urlencode scope="$SCOPE")
TOKEN=$(printf '%s' "$TOKRES" | jq_ 'print(d.get("access_token",""))' 2>/dev/null)

if [ -z "${TOKEN:-}" ]; then
    no "토큰 발급 실패"
    info "$(printf '%s' "$TOKRES" | head -c 300)"
    info "invalid_scope 라면 External Application 에 부여한 스코프와"
    info "$ENVF 의 UiPathAuthScope 가 다릅니다."
    exit 1
fi
ok "토큰 발급 성공 (스코프 수락됨)"

AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
FOLDER=(-H "X-UIPATH-OrganizationUnitId: $FID")

# ── 2. 경로 형태 비교 ────────────────────────────────────────
hdr '2. 경로 형태 — orchestrator_ 가 필요한가'
probe() {   # $1 = base prefix
    curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$1/odata/Folders?\$top=1"
}
P_PLAIN="$BASE/$ORG/$TEN"
P_SVC="$BASE/$ORG/$TEN/orchestrator_"
C_PLAIN=$(probe "$P_PLAIN")
C_SVC=$(probe "$P_SVC")
printf '  %-14s %s  →  %s\n' 'orchestrator_ 없음' "/$ORG/$TEN/odata/Folders" "$C_PLAIN"
printf '  %-14s %s  →  %s\n' 'orchestrator_ 있음' "/$ORG/$TEN/orchestrator_/odata/Folders" "$C_SVC"

if [ "$C_SVC" = "200" ] && [ "$C_PLAIN" = "200" ]; then
    ok "두 형태 모두 유효 — 운영의 빈 UiPathOrchestratorPath 는 관례에 어긋나지 않음"
    ROOT="$P_SVC"
elif [ "$C_SVC" = "200" ]; then
    ok "orchestrator_ 형태만 유효 (Automation Cloud 표준)"
    info "운영(Automation Suite)이 빈 값으로 동작하는 것은 그 환경 특성입니다."
    ROOT="$P_SVC"
elif [ "$C_PLAIN" = "200" ]; then
    ok "orchestrator_ 없는 형태만 유효"
    ROOT="$P_PLAIN"
else
    no "두 형태 모두 실패 ($C_PLAIN / $C_SVC) — org·tenant 이름 또는 스코프를 확인하십시오"
    exit 1
fi
info "이후 요청 기준 경로: $ROOT"

# ── 3. 폴더 헤더 ─────────────────────────────────────────────
hdr '3. 폴더 — X-UIPATH-OrganizationUnitId'
FRES=$(curl -s "${AUTH[@]}" "$ROOT/odata/Folders")
FNAME=$(printf '%s' "$FRES" | jq_ "
v=d.get('value',[])
m=[f for f in v if str(f.get('Id'))=='$FID']
print(m[0]['FullyQualifiedName'] if m else '')")
if [ -n "$FNAME" ]; then
    ok "폴더 $FID = '$FNAME'"
else
    no "폴더 $FID 을(를) 찾지 못했습니다"; gate
    info "$(printf '%s' "$FRES" | jq_ "print(', '.join(f\"{f['Id']}={f['FullyQualifiedName']}\" for f in d.get('value',[])))")"
fi

# ── 4. Release — StartJobs 가 쓰는 이름 ──────────────────────
hdr '4. Release — StartJobs 의 ReleaseName'
RRES=$(curl -s "${AUTH[@]}" "${FOLDER[@]}" "$ROOT/odata/Releases")
RLIST=$(printf '%s' "$RRES" | jq_ "print('\n'.join(f\"       {r['Name']}   (key={r.get('Key','')[:8]}…)\" for r in d.get('value',[])))")
if [ -n "$RLIST" ]; then
    ok "폴더 안의 Release:"
    printf '%s\n' "$RLIST"
    WANT="${UiPathProcessName:-}"
    if [ -n "$WANT" ]; then
        printf '%s' "$RRES" | jq_ "
names=[r['Name'] for r in d.get('value',[])]
import sys; sys.exit(0 if '$WANT' in names else 1)" \
            && ok "UiPathProcessName='$WANT' 이 목록에 있습니다" \
            || no "UiPathProcessName='$WANT' 이 목록에 없습니다 — 위 이름 중 하나로 맞추십시오"
    fi
elif printf '%s' "$RRES" | jq_ "import sys; sys.exit(0 if isinstance(d.get('value'),list) else 1)"; then
    # 200 + value:[] 는 조회 실패가 아니다. 폴더에 활성화된 프로세스가 없을 뿐이고,
    # 이는 --start-stop 에만 영향을 준다. StopJobs 형식 확인(6번)과는 무관하다.
    warn "폴더에 Release 가 없습니다 (@odata.count=0)"
    info "Orchestrator 의 Deployments 가 Inactive 이면 Release 가 생기지 않습니다."
    info "--start-stop 만 사용할 수 없고, 아래 6번 검증에는 영향이 없습니다."
else
    no "Release 조회 실패 — 응답이 OData 형식이 아닙니다"
    info "$(printf '%s' "$RRES" | head -c 300)"
fi

# ── 5. 런타임 ────────────────────────────────────────────────
hdr '5. 런타임 — Job 을 띄울 수 있는가'
MRES=$(curl -s "${AUTH[@]}" "$ROOT/odata/Machines")
SLOTS=$(printf '%s' "$MRES" | jq_ "print(sum(m.get('UnattendedSlots') or 0 for m in d.get('value',[])))")
if [ "${SLOTS:-0}" -gt 0 ] 2>/dev/null; then
    ok "Unattended 슬롯 ${SLOTS}개"
else
    printf '  \033[33m⚠️\033[0m  Unattended 슬롯이 없습니다 (%s)\n' "${SLOTS:-확인불가}"
    info "StartJobs 는 Pending 에 머뭅니다. StopJobs 형식 확인에는 지장이 없습니다."
fi

# ── 6. StopJobs 형식 ─────────────────────────────────────────
# 존재하지 않는 Job ID 로 던져서 '라우트와 body 형태' 자체를 먼저 검증한다.
# 404 면 경로 문제, 400 이면 body/strategy 문제, 그 외면 형태는 수용된 것이다.
hdr '6. StopJobs — 라우트와 body 형태'
STOP_URL="$ROOT/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs"
try_stop() {   # $1 = jobId, $2 = strategy → HTTP code
    curl -s -o /tmp/stopres.$$ -w '%{http_code}' -X POST \
        "${AUTH[@]}" "${FOLDER[@]}" \
        -d "{\"jobIds\":[$1],\"strategy\":\"$2\"}" "$STOP_URL"
}
C=$(try_stop 999999999 Kill)
BODY=$(head -c 200 /tmp/stopres.$$ 2>/dev/null); rm -f /tmp/stopres.$$
printf '  jobIds=[999999999] strategy="Kill"  →  HTTP %s\n' "$C"
case "$C" in
    404) no "라우트가 없습니다 — UiPathOrchestratorPath 를 다시 확인하십시오"; gate ;;
    400) printf '  \033[33m⚠️\033[0m  400 — body 또는 strategy 표기 문제일 수 있습니다\n'
         info "$BODY"
         C2=$(try_stop 999999999 2); rm -f /tmp/stopres.$$
         printf '  jobIds=[999999999] strategy="2"     →  HTTP %s\n' "$C2"
         if [ "$C2" != "400" ]; then
             no 'strategy 는 "Kill" 이 아니라 "2" 여야 합니다 → JobStopStrategy="2"'; gate
         else
             info '두 표기 모두 400 — 존재하지 않는 Job 때문일 수 있습니다'
         fi ;;
    *)   ok "라우트와 body 형태가 수용되었습니다 (HTTP $C)"
         info "존재하지 않는 Job 이라 실제 중지는 일어나지 않았습니다." ;;
esac

# ── 7. 실제 Job 기동 → 중지 (선택) ───────────────────────────
if [ "$DO_START_STOP" = "1" ]; then
    hdr '7. 실제 Job 기동 → Kill  (--start-stop)'
    SRES=$(curl -s -X POST "${AUTH[@]}" "${FOLDER[@]}" "$ROOT/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs" \
        -d "{\"startInfo\":{\"ReleaseName\":\"${UiPathProcessName}\",\"Strategy\":\"JobsCount\",\"JobsCount\":1,\"InputArguments\":\"{}\"}}")
    JOB=$(printf '%s' "$SRES" | jq_ "
v=d.get('value') or []
print(v[0]['Id'] if v else '')")
    if [ -z "$JOB" ]; then
        no "StartJobs 실패"
        info "$(printf '%s' "$SRES" | head -c 400)"
    else
        ok "StartJobs → Job $JOB"
        for i in 1 2 3 4 5; do
            ST=$(curl -s "${AUTH[@]}" "${FOLDER[@]}" "$ROOT/odata/Jobs($JOB)" | jq_ "print(d.get('State',''))")
            info "Jobs($JOB) → $ST"
            [ "$ST" = "Running" ] && break
            sleep 3
        done
        CS=$(try_stop "$JOB" Kill); rm -f /tmp/stopres.$$
        printf '  StopJobs jobIds=[%s] strategy="Kill"  →  HTTP %s\n' "$JOB" "$CS"
        [ "$CS" = "200" ] || [ "$CS" = "204" ] && ok "StopJobs 수락됨" || no "StopJobs 거부됨 (HTTP $CS)"
        for i in 1 2 3 4 5; do
            sleep 3
            ST=$(curl -s "${AUTH[@]}" "${FOLDER[@]}" "$ROOT/odata/Jobs($JOB)" | jq_ "print(d.get('State',''))")
            info "Jobs($JOB) → $ST"
            case "$ST" in Stopped|Faulted|Successful) break;; esac
        done
        case "$ST" in
            Stopped)     ok "Job 이 Stopped 로 전이 — 재시작 경로 전 과정 확인됨" ;;
            Terminating) printf '  \033[33m⚠️\033[0m  Terminating 에 머무름 — 코드의 확인 루프가 처리하는 경우입니다\n' ;;
            *)           printf '  \033[33m⚠️\033[0m  최종 상태 %s\n' "$ST" ;;
        esac
    fi
fi

# ── 결과 ─────────────────────────────────────────────────────
# RestartOnTrigger 가부는 gate 항목(토큰·경로·폴더·StopJobs)으로만 판단한다.
# Release 나 런타임이 없는 것은 --start-stop 을 못 쓴다는 뜻일 뿐이다.
printf '\n\033[1m결과: %d 통과 / %d 실패 / %d 경고\033[0m\n' "$pass" "$fails" "$warns"
if [ "$gate_fail" -eq 0 ]; then
    printf '\033[1;32m실제 Orchestrator 가 이 코드의 요청 형태를 받아들입니다.\033[0m\n'
    printf '재시작 경로의 라우트·body·strategy 표기가 확정되었습니다.\n'
    printf '\033[2m다만 존재하지 않는 Job 으로 확인한 것이라, 실제 Job 에 대한 Kill 의 효과까지\n'
    printf '증명된 것은 아닙니다. 고객 환경(Automation Suite)은 버전도 다를 수 있으니,\n'
    printf '배포 창에서 같은 확인을 한 번 더 하십시오.\033[0m\n\n'
    [ "$warns" -gt 0 ] && printf '\033[33m경고 %d건은 --start-stop 에만 영향을 줍니다.\033[0m\n\n' "$warns"
    exit 0
else
    printf '\033[1;31m재시작에 필요한 항목 %d건이 실패했습니다. RestartOnTrigger=false 로 두십시오.\033[0m\n\n' "$gate_fail"
    exit 1
fi
