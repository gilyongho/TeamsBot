# 로컬 검증 하네스

스테이징 서버가 없고 운영 서버 하나뿐인 상황에서, **운영 프로세스를 건드리지 않고**
동작 대부분을 확인하기 위한 도구입니다.

두 번째 인스턴스를 다른 포트로 띄우고, 상류(UiPath Identity·Orchestrator·Webhook 수신부와
Bot Framework Connector)를 mock 으로 대체합니다. Teams 활동은 `/api/messages` 에 직접
주입하고, 봇이 사용자에게 보내는 메시지는 mock 이 받아서 그대로 보여줍니다.

```
  [curl] ──활동 주입──▶ TeamsBot(3979/8081) ──▶ mock-upstream(19000)
                              ▲                        │
                              └──── 봇 메시지 ─────────┘   (관찰 가능)
```

## 무엇을 확인할 수 있나

| 확인 가능 | 확인 불가 |
|---|---|
| webhook 발송 횟수·헤더·payload | 실제 Orchestrator 가 요청을 받아들이는지 |
| `StopJobs` 요청 형식과 재시작 전 과정 | Maestro 프로세스의 실제 반응 |
| 전달 실패 시 사용자 안내 | 실제 Teams 렌더링 |
| 타임아웃·워치독·큐 기아 | 실제 사용자의 대화 흐름 |
| 헬스체크·인증·기동 실패 처리 | |

**실제 Orchestrator 검증은 별도로 필요합니다** — 아래 "남은 한 가지" 참조.

## 위험과 방지

하네스 자체는 운영 프로세스를 건드리지 않습니다. 위험은 전부 **디렉터리를 잘못 잡는
한 가지 실수**에서 나옵니다.

| 실수 | 결과 |
|---|---|
| 운영 디렉터리에서 `cp … .env` | 운영 설정이 덮어씌워짐. 다음 재시작 때 운영이 가짜 상류를 바라봄 |
| 운영 디렉터리에서 `openssl … cert.pem` | **운영 TLS 인증서 파괴 → 서비스 중단** |
| 운영 디렉터리에서 `npm install` | 의존성이 브랜치 것으로 바뀜 |
| 하네스 `.env` 에 운영 값이 섞임 | 진짜 Orchestrator 에 Job 기동, 진짜 사용자에게 Teams 발송 |

**그래서 먼저 `preflight.sh` 를 실행하십시오.** 위 조건을 검사하고 하나라도 걸리면
아무것도 하지 않고 멈춥니다.

```bash
bash test/harness/preflight.sh
```

검사 항목: 운영 경로 밖인지 · 덮어쓸 `.env`/인증서가 없는지 · systemd 유닛의
`WorkingDirectory` 와 겹치지 않는지 · 포트 3979/8081/19000 이 비었는지 ·
하네스 설정이 로컬 mock 을 가리키는지 · `MicrosoftAppId` 가 비었는지 · 메모리와 디스크.

남는 위험 두 가지는 검사로 막을 수 없으니 알고 계셔야 합니다.

- 앱의 HTTPS 서버는 `0.0.0.0` 에 바인딩합니다. 하네스 동안 **3979/8081 이 사내망에
  노출**되고, 로컬 개발 모드라 `/api/messages` 는 인증 없이 활동을 받습니다. 도달 범위는
  mock 뿐이지만, 실행 시간을 짧게 가져가거나 방화벽으로 막으십시오.
- 프로세스를 정리하지 않으면 포트가 계속 점유됩니다. 아래 "정리" 를 반드시 수행하십시오.

## 준비

운영 디렉터리와 **분리된 곳**에 클론하십시오.

```bash
cd ~   # 운영 경로(/home/teamsuser/workspace/TeamsBot) 밖
git clone -b fix/full-remediation https://github.com/gilyongho/TeamsBot.git tb-harness
cd tb-harness && npm install

# 하네스용 인증서 (운영 것을 쓰지 마십시오)
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 1 -nodes -subj "/CN=localhost"

bash test/harness/preflight.sh      # ← 통과해야만 다음으로
cp test/harness/env.harness .env
```

`env.harness` 는 포트를 **3979 / 8081** 로, 상류를 **127.0.0.1:19000** 으로 지정합니다.
운영(3978 / 8080)과 겹치지 않습니다.

## 실행

```bash
# 터미널 1
node test/harness/mock-upstream.js

# 터미널 2
node main.js

# 터미널 3
bash test/harness/scenarios.sh
```

기대 출력:

```
H-1  세션 없음 + 일반 메시지 → 시작 방법 안내       ✅ ✅
H-2  트리거 → Job 기동                              ✅ ✅
H-3  답변 → webhook 정확히 1회   ← 이번 장애 원인    ✅ ✅ ✅
H-4  webhook 실패 → 재시도 → 사용자 안내  ← R-1      ✅ ✅
H-5  webhook 무응답 → 타임아웃                       ✅
결과: 8 통과 / 0 실패
```

## 재시작 경로 확인

`RestartOnTrigger=true` 로 바꾼 뒤 앱을 재기동하면 H-6 이 동작합니다.

```bash
# 리눅스
sed -i    's/^RestartOnTrigger=.*/RestartOnTrigger=true/' .env
# macOS (BSD sed 는 -i 뒤에 빈 인자를 요구한다)
sed -i '' 's/^RestartOnTrigger=.*/RestartOnTrigger=true/' .env

pkill -f "node main.js"
node main.js > /tmp/app.log 2>&1 &
sleep 3
bash test/harness/scenarios.sh
```

2026-09-02 실측 결과:

```
StopJobs 요청 body : {"jobIds": [1002], "strategy": "Kill"}
폴더 헤더          : X-UIPATH-OrganizationUnitId 포함
인증 헤더          : Bearer …
결과               : Job 1002 → Stopped, 새 Job 1003 기동
사용자 수신        : M2 → M6   (중복 M2 없음)
```

`Terminating` 에 머무는 경우(`stopTransition: "terminating"`)도 확인했습니다.
Kill 이 라운드마다 재발행되고(3회), 포기 시 M9 로 정직하게 안내하며,
**다른 사용자의 요청은 계속 처리됩니다**(큐 기아 없음).

## 수동 조작

```bash
M=http://127.0.0.1:19000

# webhook 을 실패시키기 / 무응답으로 만들기 / 되돌리기
curl -s $M/__control -H 'content-type: application/json' -d '{"webhook":"fail"}'
curl -s $M/__control -H 'content-type: application/json' -d '{"webhook":"hang"}'
curl -s $M/__control -H 'content-type: application/json' -d '{"webhook":"ok"}'

# Orchestrator 를 죽이기 (D-8 상태조회 실패 경로)
curl -s $M/__control -H 'content-type: application/json' -d '{"jobState":"fail"}'

# Kill 후 Terminating 에 머무르게 하기 (확인 루프 / 포기 경로)
curl -s $M/__control -H 'content-type: application/json' -d '{"stopTransition":"terminating"}'

# 무슨 일이 있었는지 보기
curl -s $M/__state | python3 -m json.tool

# Teams 메시지 주입
curl -k -s -X POST https://localhost:3979/api/messages -H 'content-type: application/json' -d '{
  "type":"message","id":"1","timestamp":"2026-09-02T06:00:00Z",
  "serviceUrl":"http://127.0.0.1:19000/teams","channelId":"msteams",
  "from":{"id":"29:u","aadObjectId":"aad-user-1","name":"테스트"},
  "conversation":{"id":"c1","tenantId":"t"},"recipient":{"id":"28:bot"},
  "text":"에이전트 시작","locale":"ko-KR"}'
```

## 왜 인증 없이 활동을 주입할 수 있나

`env.harness` 는 `MicrosoftAppType=MultiTenant` 에 `MicrosoftAppId` 를 비워 둡니다.
이는 Bot Framework 의 로컬 개발(에뮬레이터) 모드로, `/api/messages` 가 JWT 없이
활동을 받습니다.

**운영 `.env` 는 `SingleTenant` 에 실제 AppId 가 들어 있어 이 모드가 되지 않습니다.**
빈 AppId + SingleTenant 조합은 모듈 로드 시점에 예외를 던지고 프로세스가 시작조차
하지 않으므로, 실수로 운영이 인증 없이 열릴 위험은 없습니다.

## 정리

```bash
pkill -f "node main.js"
pkill -f mock-upstream
rm -f .env cert.pem key.pem
```

## 남은 한 가지 — 실제 Orchestrator 검증

하네스는 mock 이 요청을 받아준다는 것만 증명합니다. **실제 Orchestrator 가 이 요청을
받아들이는지는 확인되지 않았습니다.** Teams 도 고객도 필요 없는 5분짜리 확인입니다.

```bash
# 1) 운영에서 쓰는 것과 같은 방식으로 토큰 발급
TOKEN=$(curl -s -X POST "https://as.lgcnsrpa.com/identity_/connect/token" \
  -d grant_type=client_credentials \
  -d client_id="$UiPathAppId" -d client_secret="$UiPathAppSecret" \
  -d scope="OR.Jobs" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# 2) Orchestrator UI 에서 프로세스를 직접 하나 실행하고 Job ID 를 확인
JOB=<그 Job ID>

# 3) 서버가 보낼 것과 똑같은 요청을 보낸다
curl -i -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-UIPATH-OrganizationUnitId: $UiPathFolderId" \
  -d "{\"jobIds\":[$JOB],\"strategy\":\"Kill\"}" \
  "https://as.lgcnsrpa.com/innotek/DefaultTenant/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs"
```

- **200/204** → 형식 확정. `RestartOnTrigger=true` 로 켜도 됩니다.
- **400** → `strategy` 표기 문제. `"2"` 로 바꿔 재시도하십시오(`JobStopStrategy="2"`).
- **404** → 경로 문제. `orchestrator_` 를 넣어 재시도하십시오
  (`UiPathOrchestratorPath="orchestrator_"`).

이 확인 전까지는 `RestartOnTrigger=false` 로 두십시오. 재시작 기능만 꺼지고
나머지 수정은 모두 동작합니다.

## 계층 2 — 진짜 Orchestrator 검증 (고객 불필요)

위 하네스는 mock 이 요청을 받아준다는 것만 증명한다. 진짜 Orchestrator 가 같은
요청을 받아들이는지는 **본인 Automation Cloud 테넌트**로 확인할 수 있다.
고객 환경도, 운영 서버도 건드리지 않는다.

| 계층 | Orchestrator | Webhook / Teams | 검증 대상 |
|---|---|---|---|
| 1 | mock | mock | 큐·순서·중복·타임아웃 |
| 2 | **진짜 (본인 테넌트)** | mock | 토큰·스코프·경로·폴더 헤더·StartJobs·StopJobs |
| 3 | 고객 Automation Suite | — | 배포 창에서 `curl` 한 번 |

```bash
cp test/harness/env.cloud.example test/harness/env.cloud
# UiPathAppId / UiPathAppSecret 두 줄만 채운다 (.gitignore 에 걸려 있다)

bash test/harness/cloud-check.sh                # 읽기 전용
bash test/harness/cloud-check.sh --start-stop   # Job 기동 → Kill 까지
```

확인 항목:

1. 토큰 발급 — External Application 스코프가 맞는가
2. `{org}/{tenant}/odata` 와 `{org}/{tenant}/orchestrator_/odata` 중 무엇이 유효한가
   — 운영은 앞 형태로 동작한다. 그것이 관례인지 그 환경 특성인지 여기서 갈린다
3. 폴더 헤더 `X-UIPATH-OrganizationUnitId`
4. `StartJobs` 의 `ReleaseName` 전략과 폴더 안의 실제 Release 이름
5. **`StopJobs` 의 라우트·body·`strategy` 표기** — 2026-09-03 확정 (Cloud·고객 Suite 양쪽 200)
6. `--start-stop` 을 주면 Job 을 실제로 띄우고 Kill 해 `Stopped` 전이까지 확인

토큰과 시크릿은 출력하지 않는다. 6번은 존재하지 않는 Job ID 로 먼저 던져서,
`404`(경로 문제)와 `400`(body/strategy 문제)을 실제 중지 없이 구분한다.

**Automation Cloud 에서 통과해도 고객 Automation Suite 는 버전이 다를 수 있다.**
"모른다"가 "거의 확실하다"로 바뀌는 것이지 확정은 아니다. 배포 창에서 같은 확인을
한 번 더 하는 것을 권한다.

## 어디서 돌릴 수 있나 — 우분투가 꼭 필요하지는 않다

하네스가 요구하는 것은 **Node · curl · python3 · openssl** 뿐이다. 운영 서버의
OS 동작이 아니라 애플리케이션 로직을 보는 도구이므로, macOS 에서도 리눅스
컨테이너에서도 동일하게 돈다(이 저장소의 8/8 결과는 우분투가 아닌 컨테이너에서
얻은 것이다). `preflight.sh` 도 `ss` / `lsof` / `netstat` 중 있는 것을 쓰고,
`free` 가 없으면 메모리 검사만 건너뛴다.

우분투가 의미를 갖는 것은 **배포 리허설**을 할 때다 — `npm install` 이 그 OS 에서
되는지, systemd 로 띄웠을 때 문제가 없는지는 우분투에서만 확인된다.
그 목적이라면 다음이 무료다.

| 방법 | 성격 | 비고 |
|---|---|---|
| Multipass | 맥에 진짜 우분투 VM | `multipass launch --name tb 24.04` · 설치에 관리자 권한 필요 |
| GitHub Codespaces | 브라우저 안의 우분투 | 개인 계정 무료 한도 · 로컬 설치 없음 · 사내망 프록시를 우회한다 |
| Google Cloud Shell | 브라우저 안의 데비안 | 무료·신용카드 불필요 · 우분투는 아님 |
| Podman / Colima | 맥 위의 컨테이너 | Docker Desktop 은 기업 사용 시 유료 |

`cloud-check.sh` 는 `cloud.uipath.com` 으로 나가야 하므로, 사내망에서 TLS 검사
프록시에 걸리면 Codespaces 쪽이 더 수월하다.
