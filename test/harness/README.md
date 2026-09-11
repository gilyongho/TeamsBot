# 대화 재사용 검증 (생활건강 계열)

발송마다 `createConversation` 을 호출하던 것을, 보관해 둔 대화 참조 재사용으로
바꾼 부분만 확인합니다. **이 브랜치는 그 한 가지만 바꿉니다.**

**세는 것은 "보낸 메시지 수" 가 아니라 "대화를 몇 번 만들었는가"** 입니다.

## 준비

운영 디렉터리가 아닌 곳에서 하십시오. `.env` 와 `cert.pem` / `key.pem` 을 덮어씁니다.

```bash
# 운영 경로 밖인지 먼저 확인
pwd

# 자체 서명 인증서 (없을 때만)
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=localhost"
```

`.env` 는 상류를 mock 으로, 포트를 운영과 다르게 잡습니다.

```
UiPathBaseURL="http://127.0.0.1:19000"
UiPathWebhookUrl="http://127.0.0.1:19000/webhook"
MicrosoftAppId=""                 # 비워야 진짜 Teams 로 나가지 않습니다
MicrosoftAppType="MultiTenant"
MicrosoftAppPort=3979
MessageQueuePort=8081
TeamsAppApiKey="harness-ta-key"
```

`MicrosoftAppId` 를 비우지 않으면 **진짜 사용자에게 메시지가 나갈 수 있습니다.**

## 실행

```bash
node test/harness/mock-upstream.js > /tmp/mock.log 2>&1 &
node main.js > /tmp/app.log 2>&1 &
bash test/harness/reuse.sh
```

종전 동작과 비교하려면 앱과 스크립트를 같은 설정으로 돌립니다.

```bash
ReuseConversation=false node main.js > /tmp/app-old.log 2>&1 &
ReuseConversation=false bash test/harness/reuse.sh
```

## 무엇을 보는가

| | 보는 것 | 종전 | 재사용 |
|---|---|---|---|
| R-1 | 대화가 있는 사람에게 3회 발송 | 생성 **3회**, 대화 3개 | **0회**, 한 대화 |
| R-2 | 첫 접촉 후 2회 더 | 3회 | **1회** |
| R-3 | 보관한 참조가 못 쓰게 됨 | 해당 없음 | 버리고 재생성, 발송 안 끊김 |
| R-4 | 대화 생성이 403 | 200 (결함) | **200 그대로** — 범위 밖 |

R-4 는 고쳐졌는지가 아니라 **바뀌지 않았는지**를 고정합니다. 실패를 502 로 알리는
것은 RPA 잡이 `Faulted` 로 떨어질 수 있어 고객 확인이 필요한 별도 사안입니다.

## mock 제어

```bash
curl -s localhost:19000/__control -d '{"teams":"forbidden"}'   -H 'content-type: application/json'
curl -s localhost:19000/__control -d '{"staleConv":"c-aad-1"}' -H 'content-type: application/json'
curl -s localhost:19000/__state | python3 -m json.tool
```

`forbidden` 은 운영에서 관측된 403 `Bot is not installed in user's personal scope`
를 응답 본문이 빈 것까지 그대로 재현하고, `staleConv` 는 그 대화로의 전송만 403 으로
만들어 **오래된 참조**를 흉내냅니다.

## 여기서 확인할 수 없는 것

**실제 테넌트에서 403 이 사라지는지는 알 수 없습니다.** mock 은 Teams 백엔드가
아닙니다. 여기서 확정되는 것은 "발송이 더 이상 `createConversation` 을 지나지
않는다" 까지입니다.
