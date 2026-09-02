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

## 준비

운영 디렉터리와 **분리된 곳**에 클론하십시오. 같은 디렉터리에서 `.env` 를 바꾸면
운영 인스턴스가 재시작될 때 그 설정을 읽습니다.

```bash
cd ~   # 운영 경로(/home/teamsuser/workspace/TeamsBot) 밖
git clone -b fix/full-remediation https://github.com/gilyongho/TeamsBot.git tb-harness
cd tb-harness && npm install

# 하네스용 인증서 (운영 것을 쓰지 마십시오)
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 1 -nodes -subj "/CN=localhost"

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
sed -i 's/^RestartOnTrigger=.*/RestartOnTrigger=true/' .env
# 앱 재기동 후
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
