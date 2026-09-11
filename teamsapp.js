//------------------------------------------------
// teamsapp.js
//------------------------------------------------

// 모듈 불러오기
const UIPATH = require('./uipath');
const MSGQUEUE = require('./msgqueue');
const CONVREF = require('./convrefstore');

// 필요한 패키지: npm install botbuilder restify dotenv @microsoft/microsoft-graph-client
require('dotenv').config();
const restify = require('restify');
const {
    CloudAdapter,
    ConfigurationServiceClientCredentialFactory,
    TeamsActivityHandler,
    TurnContext,
    MessageFactory,
    ConfigurationBotFrameworkAuthentication,
    ActivityTypes
} = require('botbuilder');
const { Client } = require('@microsoft/microsoft-graph-client');
const { ClientSecretCredential } = require('@azure/identity');
const { ConnectorClient, MicrosoftAppCredentials } = require('botframework-connector');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 대화 참조 정보 저장 파일 (재시작 후 복구용)
const conversationReferencePath = path.join(__dirname, 'conversationReference.json');

// 환경 변수 (.env 파일에서 관리)
const teamsAppApiKey = process.env.TeamsAppApiKey || '';
const appId = process.env.MicrosoftAppId || '';
const appPassword = process.env.MicrosoftAppPassword || '';
const appType = process.env.MicrosoftAppType || 'SingleTenant';
const appTenantId = process.env.MicrosoftAppTenantId || '';
const appPort = process.env.MicrosoftAppPort || 3978;
const pollingSec = process.env.PollingIntervalSeconds || 3;
const processTriggerKeywords = (process.env.ProcessTriggerKeywords || '거래처,거래선').split(',');
const textFormat = process.env.TextFormat || 'markdown';
const requiredRuntimes = process.env.RequiredRuntimes || 0;
const taskOwnerIds = process.env.TaskOwnerIds ? process.env.TaskOwnerIds.split(' ') : [];
const appMessage1 = process.env.AppMessage1 || '';
const appMessage2 = process.env.AppMessage2 || '';
const appMessage3 = process.env.AppMessage3 || '';

// 보관한 대화 참조를 재사용할지. 기본은 재사용한다.
//   'false' 로 두면 발송마다 createConversation 을 호출하던 종전 동작으로 돌아간다.
//   되돌리는 데 배포가 필요 없어야 하므로 코드가 아니라 설정으로 둔다.
const reuseConversation = String(process.env.ReuseConversation || 'true').toLowerCase() !== 'false';
if (!reuseConversation) {
    console.log(`[${new Date().toLocaleString()}] ⚠️ ReuseConversation=false — ` +
        `발송마다 대화를 새로 만듭니다(종전 동작).`);
}

// API Key Authentication
const apiKeyAuth = (req, res, next) => {
    const clientKey = req.headers['x-api-key'];

    if (!clientKey) {
        console.error('TA API Key missing in HTTP request header!');
        return res.send(403, { error: '권한이 없습니다.' });
    }

    // 보안 강화: 타임 상수 비교
    try {
        const isMatch = crypto.timingSafeEqual(
            Buffer.from(clientKey),
            Buffer.from(teamsAppApiKey)
        );

        if (isMatch) {
            //console.log('TA API key identical');
            next();
        } else {
            console.error('TA API Key NOT identical!');
            res.send(403, { error: '권한이 없습니다.' });
        }
    } catch (e) {
        console.error('TA API Key NOT same length!');
        res.send(403, { error: '권한이 없습니다.' });
    }
};

// Create adapter
const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: appId,
    MicrosoftAppPassword: appPassword,
    MicrosoftAppType: appType,
    MicrosoftAppTenantId: appTenantId,
    MicrosoftAppPort: appPort
});

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication({}, credentialsFactory);
const adapter = new CloudAdapter(botFrameworkAuthentication);

// Error handler
adapter.onTurnError = async (context, error) => {
    console.error(`\n[onTurnError] ${error}`);
    await context.sendActivity(appMessage1);
};

// Teams App Class
class TeamsApp extends TeamsActivityHandler {
    constructor() {
        super();

        this.uipathToken = null; // UiPath 인증 토큰 (JSON 객체)
        this.conversationReference = this.loadConversationReference(); // 대화 참조 정보

        // 메시지 수신 핸들러
        this.onMessage(async (context, next) => {

            // 대화 참조 정보 저장
            this.conversationReference = TurnContext.getConversationReference(context.activity);
            this.saveConversationReference();

            // 같은 참조를 보낸 사람 앞으로도 보관한다.
            //   위의 this.conversationReference 는 프로세스에 하나뿐이라, 마지막으로
            //   말을 건 사람의 것으로 계속 덮어씌워진다. 그 사람이 아닌 다른 사람에게
            //   보낼 때는 쓸 수 없다. 사용자별로 따로 두어야 재사용이 성립한다.
            //   키는 발송에 쓰는 식별자와 같아야 한다 — createConversationAndSendMessage
            //   의 userId 는 AAD Object ID 이므로 여기서도 aadObjectId 를 쓴다.
            this.rememberConversationReference(context.activity);
            //console.log(`AAD Object ID: '${context.activity.from.aadObjectId}'`);

            // Get user info
            const userInfo = await this.getUserInfo(context);
            //console.log(`id: ${userInfo.id}`);
            //console.log(`name: ${userInfo.name}`);
            //console.log(`email: ${userInfo.email}`);
            //console.log(`department: ${userInfo.department}`);
            //console.log(`job title: ${userInfo.jobTitle}`);
            //console.log(`office location: ${userInfo.officeLocation}`);

            const text = context.activity.text;
            console.log(`[${new Date().toLocaleString()}] 원본 메시지: '${text}'`);

            const removedMentionText = TurnContext.removeRecipientMention(context.activity);
            const cleanText = removedMentionText ? removedMentionText.trim() : text;
            //console.log(`정제 메시지: '${cleanText}'`);
            
            if (processTriggerKeywords.some(keyword => cleanText.replace(/\s/g, '').toUpperCase().includes(keyword))) {
                await app.createConversationAndSendMessage(userInfo.id, appMessage1);

                // 메시지 큐에 메시지 추가
                //MSGQUEUE.msgQueue.enqueue(userInfo.id, cleanText);
                // 메시지 큐에 추가하는 대신 프로세스를 실행하여 처리함
                UIPATH.runProcess(
                    this.uipathToken.token,
                    {
                        "g_user_id": userInfo.id,
                        "g_message": cleanText
                    }
                );
            } else {
                await app.createConversationAndSendMessage(userInfo.id, appMessage2);
            }

            await next();
        });

        // 멤버 추가 핸들러 (앱이 팀에 추가될 때)
        this.onMembersAdded(async (context, next) => {
            const membersAdded = context.activity.membersAdded;
            for (let member of membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity(appMessage3);
                }
            }
            await next();
        });

        // 채널에서의 대화 업데이트 핸들러
        this.onTeamsChannelCreated(async (channelInfo, teamInfo, context, next) => {
            console.log(`[${new Date().toLocaleString()}] 새 채널 생성: ${channelInfo.name}`);
            await next();
        });
    }

    // 재시작 후에도 프로액티브 메시지를 보낼 수 있도록 대화 참조 정보를 복구한다.
    loadConversationReference() {
        try {
            const data = fs.readFileSync(conversationReferencePath, 'utf8');
            const conversationReference = JSON.parse(data);
            console.log(`[${new Date().toLocaleString()}] 대화 참조 정보를 복구했습니다.`);
            return conversationReference;
        } catch (e) {
            console.log(`[${new Date().toLocaleString()}] 복구할 대화 참조 정보가 없습니다: ${e.message}`);
            return null;
        }
    }

    saveConversationReference() {
        try {
            fs.writeFileSync(conversationReferencePath, JSON.stringify(this.conversationReference, null, 2));
        } catch (e) {
            // 저장에 실패해도 메시지 처리는 계속되어야 한다.
            console.error(`[${new Date().toLocaleString()}] 대화 참조 정보 저장 실패: ${e.message}`);
        }
    }

    // Get OAuth token for Microsoft Graph API
    async getGraphToken(tenantId) {
        const targetTenantId = tenantId || appTenantId;

        const credential = new ClientSecretCredential(
            targetTenantId,
            appId,
            appPassword
        );

        try {
            const tokenResponse = await credential.getToken('https://graph.microsoft.com/.default');
            //console.log('Graph token:', tokenResponse.token);
            //console.log('Token expires on:', tokenResponse.expiresOnTimestamp);

            return tokenResponse.token;
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] 테넌트 '${targetTenantId}'의 Graph 토큰을 가져오는 중 오류 발생: ${error.message}`);
            throw error;
        }
    }

    // Get user info
    async getUserInfo(context) {

        const aadObjectId = context.activity.from.aadObjectId;

        // 메시지가 발생한 테넌트를 우선 사용 (.env의 MicrosoftAppTenantId와 다를 수 있음)
        const tenantId = context.activity.conversation?.tenantId
            || context.activity.channelData?.tenant?.id
            || appTenantId;

        try {
            if (!aadObjectId) {
                throw new Error('activity.from.aadObjectId가 없습니다.');
            }

            const token = await this.getGraphToken(tenantId);

            const client = Client.init({
                authProvider: (done) => {
                    done(null, token);
                }
            });

            const user = await client
                .api(`/users/${aadObjectId}`)
                .select('id,displayName,mail,userPrincipalName,department,jobTitle,officeLocation')
                .get();

            return {
                id: user.id,
                name: user.displayName,
                email: user.mail || user.userPrincipalName,
                //department: user.department,
                //jobTitle: user.jobTitle,
                //officeLocation: user.officeLocation
            };
        } catch (error) {
            // Graph 조회에 실패해도 메시지 처리는 계속되어야 하므로 activity 정보로 대체
            console.error(`[${new Date().toLocaleString()}] Graph 사용자 조회 실패 (tenant: '${tenantId}', id: '${aadObjectId}'): ${error.message}`);
            console.error(`[${new Date().toLocaleString()}] activity 정보로 대체하여 계속 진행합니다.`);

            return {
                id: aadObjectId || context.activity.from.id,
                name: context.activity.from.name,
                email: null
            };
        }
    }

    // Send message to the current user in conversation
    async sendMessageToCurrentUser(text) {
        if (!this.conversationReference) {
            console.error(`[${new Date().toLocaleString()}] 대화 참조 정보가 없습니다. 메시지를 보낼 수 없습니다.`);
            return;
        }

        //console.log(`text: '${text}'`);

        const message = MessageFactory.text(text);
        message.textFormat = textFormat;

        await adapter.continueConversationAsync(
            appId,
            this.conversationReference,
            async (context) => {
                await context.sendActivity(message);
            }
        );
    }

    // 들어온 활동에서 대화 참조를 꺼내 보낸 사람 앞으로 보관한다.
    //   aadObjectId 가 없는 활동(일부 채널·시스템 활동)은 보관하지 않는다.
    //   발송 키와 다른 키로 담으면 영원히 조회되지 않는 항목이 쌓일 뿐이다.
    rememberConversationReference(activity) {
        if (!reuseConversation) return false;
        try {
            const userId = activity && activity.from && activity.from.aadObjectId;
            if (!userId) return false;
            const ref = TurnContext.getConversationReference(activity);
            return CONVREF.store.set(userId, ref);
        } catch (error) {
            // 보관 실패가 대화를 막아서는 안 된다. 없으면 종전 경로로 간다.
            console.error(`[${new Date().toLocaleString()}] ⚠️ 대화 참조 보관 실패: ${error.message}`);
            return false;
        }
    }

    // 사용자에게 보낸다.
    //
    //   1순위: 보관해 둔 대화 참조로 바로 보낸다. createConversation 을 부르지 않는다.
    //   2순위: 보관분이 없거나 그것으로 보내다 실패하면, 보관분을 버리고
    //          종전처럼 createConversation 으로 대화를 만들어 보낸 뒤 그 참조를 보관한다.
    //
    //   2순위가 반드시 있어야 한다. 참조는 serviceUrl 변경·대화 삭제로 오래되면
    //   쓸 수 없게 되는데, 그때 폴백이 없으면 재사용을 넣은 쪽이 더 나빠진다.
    async createConversationAndContinue(userId, callback) {
        // ── 1순위: 보관분 재사용 ──────────────────────────────
        if (reuseConversation) {
            const cached = CONVREF.store.get(userId);
            if (cached) {
                try {
                    await adapter.continueConversationAsync(appId, cached, callback);
                    return;
                } catch (error) {
                    // 오래된 참조로 판단하고 버린다. 그대로 두면 매번 실패 후 폴백이라
                    // 호출이 두 배가 된다.
                    CONVREF.store.delete(userId);
                    console.error(
                        `[${new Date().toLocaleString()}] ⚠️ 보관한 대화 참조로 보내지 못했습니다. ` +
                        `참조를 버리고 대화를 다시 만듭니다: ${error.message}`);
                }
            }
        }

        // ── 2순위: 종전 경로 (대화 생성) ──────────────────────
        //   이 아래는 손대지 않았다. 이 브랜치는 "대화 재사용" 한 가지만 바꾼다.
        //   여기의 조용한 return 은 알려진 별도 결함이지만(호출부가 그래도
        //   '전송 완료' 를 찍는다), 함께 고치면 403 이 줄어든 원인이 재사용 때문인지
        //   판별할 수 없게 된다.
        if (!this.conversationReference) {
            console.error(`[${new Date().toLocaleString()}] 대화 참조 정보가 없습니다. 메시지를 보낼 수 없습니다.`);
            return;
        }

        // 대화를 생성할 테넌트는 사용자가 속한 테넌트여야 한다.
        // MultiTenant 모드에서는 appTenantId가 비어 있으므로 대화 참조 정보에서 가져온다.
        const conversationTenantId = this.conversationReference.conversation?.tenantId || appTenantId;

        // MultiTenant 모드에서는 tenant를 비워 botframework.com 테넌트로 인증한다.
        const appCredentials = new MicrosoftAppCredentials(
            appId,
            appPassword,
            appTenantId
        );

        const connectorClient = new ConnectorClient(appCredentials, { baseUri: this.conversationReference.serviceUrl });

        const conversationParameters = {
            isGroup: false,
            tenantId: conversationTenantId,
            bot: {
                id: this.conversationReference.bot.id,
                name: this.conversationReference.bot.name
            },
            members: [
                {
                    id: userId
                }
            ]
        };

        const response = await connectorClient.conversations.createConversation(conversationParameters);

        const convRef = {
            activityId: response.activityId,
            channelId: 'msteams',
            serviceUrl: this.conversationReference.serviceUrl,
            conversation: {
                id: response.id,
                tenantId: conversationTenantId,
                conversationType: 'personal'
            },
            bot: {
                id: this.conversationReference.bot.id,
                name: this.conversationReference.bot.name
            },
            user: {
                id: userId
            }
        };

        // 만든 참조를 보관한다. 다음 발송부터는 1순위 경로로 간다.
        //   보내기 전에 담는다. 여기서 실패하더라도 그 실패는 대화 생성이 아니라
        //   전송 단계의 것이고, 참조 자체는 유효하기 때문이다.
        if (reuseConversation) CONVREF.store.set(userId, convRef);

        await adapter.continueConversationAsync(appId, convRef, callback);
    }

    // Send message to a specific user
    async createConversationAndSendMessage(userId, text) {
        try {
            await this.createConversationAndContinue(userId, async (context) => {
                const message = MessageFactory.text(text);
                message.textFormat = textFormat;
                await context.sendActivity(message);
            });
            console.log(`[${new Date().toLocaleString()}] 사용자 '${userId}'에게 메시지 전송 완료:\n${text}`);
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] 사용자 '${userId}'에게 메시지 전송 중 오류 발생:`);
            console.error(`  - Message: ${error.message}`);
            console.error(`  - Status : ${error.statusCode || error.code}`);
            if (error.body) console.error(`  - Body   : ${JSON.stringify(error.body)}`);
        }
    }

    // Send typing indicator to a specific user
    async createConversationAndSendTypingIndicator(userId) {
        try {
            await this.createConversationAndContinue(userId, async (context) => {
                await context.sendActivity({ type: ActivityTypes.Typing });
            });
            console.log(`[${new Date().toLocaleString()}] 사용자 '${userId}'에게 typing indicator 전송 완료.`);
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] 사용자 '${userId}'에게 typing indicator 전송 중 오류 발생:`);
            console.error(`  - Message: ${error.message}`);
            console.error(`  - Status : ${error.statusCode || error.code}`);
            if (error.body) console.error(`  - Body   : ${JSON.stringify(error.body)}`);
        }
    }
}

// Teams App 인스턴스 생성
const app = new TeamsApp();

// Teams App REST 서버 생성
const serverOptions = {
    certificate: fs.readFileSync('cert.pem'),
    key: fs.readFileSync('key.pem')
};
//const teamsAppServer = restify.createServer();  // HTTP 서버
const teamsAppServer = restify.createServer(serverOptions);  // HTTPS 서버
teamsAppServer.use(restify.plugins.bodyParser());

function triggerUipathTokenRenewal() {
    setInterval(
        async () => {
            const newToken = await UIPATH.getAccessToken();
            if (newToken) {
                app.uipathToken = newToken;
                console.log(`[${new Date().toLocaleString()}] ✅ UiPath 인증 토큰 갱신 성공.\n`);
            } else {
                console.error(`[${new Date().toLocaleString()}] ❌ UiPath 인증 토큰 갱신 실패.\n`);
            }
        },
        (app.uipathToken.expiry - 60) * 1000 // 만료 1분 전에 갱신 시도
    );
}

// Start Teams App REST server
teamsAppServer.listen(appPort, () => {
    (async () => {
        app.uipathToken = await UIPATH.getAccessToken();

        if (app.uipathToken) {
            console.log(`\n[${new Date().toLocaleString()}] UiPath와의 통신 준비 완료.\n`);
            triggerUipathTokenRenewal();
        } else {
            throw new Error(`\n[${new Date().toLocaleString()}] UiPath 인증 실패로 인해 에이전트를 시작할 수 없습니다.`);
        }
    })();

    console.log(`\nApp ID: ${appId}`);
    console.log(`App Password: ${appPassword.substring(0, 8)}...`);
    console.log(`Tenant ID: ${appTenantId}`);

    console.log(`\nTeams App listening to ${teamsAppServer.url}`);
});

// Teams App 헬스체크 엔드포인트
teamsAppServer.get('/', async (req, res) => {
    res.send('에이전트가 실행 중입니다.');
});

// Listen to incoming requests
teamsAppServer.post('/api/messages', async (req, res) => {
    /*
    console.log(`X-Forwarded-For: ${req.headers['x-forwarded-for']}`);
    console.log(`Remote Address : ${req.socket.remoteAddress}`);
    const remoteAddress = ((req.headers['x-forwarded-for'] || req.socket.remoteAddress) ?? '').split(',')[0].trim();
    console.log(`remote address: ${remoteAddress}`);
    if (!allowedCidrs.some(cidr => ipInCidr(remoteAddress, cidr))) {
        console.error(`허용되지 않은 IP: ${remoteAddress}`);
        res.send(403, { error: '허용되지 않은 IP 주소입니다.' });
        return;
    }
    */
    console.log(`\n[${new Date().toLocaleString()}] Teams App 메시지 수신됨.`);
    await adapter.process(req, res, (context) => app.run(context));
});

// Teams App 메시지 전송 엔드포인트 (특정 사용자)
teamsAppServer.post('/api/sendMessage', apiKeyAuth, async (req, res) => {
    /*
    console.log(`X-Forwarded-For: ${req.headers['x-forwarded-for']}`);
    console.log(`Remote Address : ${req.socket.remoteAddress}`);
    const remoteAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`remote address: ${remoteAddress}`);
    */
    const { userId, message } = req.body;

    if (!userId || !message) {
        console.log(`[${new Date().toLocaleString()}] userId와 message 필드가 필요합니다.`);
        res.send(400, 'userId와 message 필드가 필요합니다.');
        return;
    }

    try {
        await app.createConversationAndSendMessage(userId, message);
        res.send(`사용자 ${userId}에게 메시지를 보냈습니다.`);
    } catch (err) {
        console.error(`[${new Date().toLocaleString()}] 엔드포인트 에러:`, err);
        res.send(500, '오류 발생');
    }
});

teamsAppServer.post('/api/sendTypingIndicator', apiKeyAuth, async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        console.log(`[${new Date().toLocaleString()}] userId 필드가 필요합니다.`);
        res.send(400, 'userId 필드가 필요합니다.');
        return;
    }

    try {
        await app.createConversationAndSendTypingIndicator(userId);
        res.send(`사용자 ${userId}에게 typing indicator를 보냈습니다.`);
    } catch (err) {
        console.error(`[${new Date().toLocaleString()}] 엔드포인트 에러:`, err);
        res.send(500, '오류 발생');
    }
});
