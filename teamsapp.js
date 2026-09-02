//------------------------------------------------
// teamsapp.js
//------------------------------------------------

// 모듈 불러오기
const UIPATH = require('./uipath');
const MSGQUEUE = require('./msgqueue');
const PROCQUEUE = require('./procqueue')
const JOBTABLE = require('./jobtable')

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

// 환경 변수 (.env 파일에서 관리)
const teamsAppApiKey = process.env.TeamsAppApiKey || '';
const appId = process.env.MicrosoftAppId || '';
const appPassword = process.env.MicrosoftAppPassword || '';
const appType = process.env.MicrosoftAppType || 'SingleTenant';
const appTenantId = process.env.MicrosoftAppTenantId || '';
const appPort = process.env.MicrosoftAppPort || 3978;
const pollingSec = process.env.PollingIntervalSeconds || 3;
const processTriggerInterval = process.env.ProcessTriggerInterval || 10;
const processTriggerKeywords = (process.env.ProcessTriggerKeywords || '거래처,거래선').split(',');
const textFormat = process.env.TextFormat || 'markdown';
const requiredRuntimes = process.env.RequiredRuntimes || 0;
const taskOwnerIds = process.env.TaskOwnerIds ? process.env.TaskOwnerIds.split(' ') : [];
const appMessage1 = process.env.AppMessage1 || '';
const appMessage2 = process.env.AppMessage2 || '';
const appMessage3 = process.env.AppMessage3 || '';
const appMessage4 = process.env.AppMessage4 || '';
const appMessage5 = process.env.AppMessage5 || '';

// [D-15] 실행 중인 Job이 있을 때 트리거 키워드를 재시작으로 처리할지 여부.
//   기존 동작은 appMessage5로 거부하고 입력을 버렸다. 그런데 사용자가 트리거를
//   입력하는 상황은 대개 이전 Job이 응답을 기다리며 살아 있는 상황이므로,
//   정작 재시작이 필요한 순간에 거부되는 문제가 있었다.
//   false로 두면 종전 동작으로 되돌아간다.
const restartOnTrigger = String(process.env.RestartOnTrigger ?? 'true').toLowerCase() !== 'false';

// [D-15] Job 중지 방식. Kill = 즉시, SoftStop = 프로세스의 정지 지점까지 대기.
//   대화형 에이전트는 사용자 입력 대기 중 정지 지점에 도달하지 못할 수 있어 Kill이 기본값.
const stopStrategy = process.env.JobStopStrategy || 'Kill';

// [D-15] 재시작 안내 메시지
const appMessage6 = process.env.AppMessage6
    || '진행 중이던 작업을 종료하고 처음부터 다시 시작합니다.<br>잠시만 기다려주세요.';

// [D-8] Job 상태 조회 연속 실패 허용 횟수
const maxStateCheckRetry = Number(process.env.MaxStateCheckRetry || 3);

// [D-15] 중지 후 실제 종료 확인 폴링
const STOP_CONFIRM_TRIES = 5;
const STOP_CONFIRM_INTERVAL_MS = 1000;

// [D-8] tryProcessRun 동시 실행 가드.
//   onMessage와 setInterval 양쪽에서 호출되므로 await 구간에서 겹칠 수 있다.
let processRunInFlight = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isTerminal = (state) => ['FAULTED', 'SUCCESSFUL', 'STOPPED'].includes(String(state).toUpperCase());

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
/*
// IP CIDR 허용 범위 (Microsoft Teams 채팅의 IP 범위)
const allowedCidrs = ['52.112.0.0/14', '52.122.0.0/15'];

function ipToInt(ip) {
    return ip.split('.').reduce((acc, oct) => (acc * 256 + parseInt(oct)) >>> 0, 0);
}

function ipInCidr(ip, cidr) {
    const [range, bits] = cidr.split('/');
    const mask = (0xFFFFFFFF << (32 - parseInt(bits))) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
}
*/
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
        this.ready = false; // [D-10] UiPath 연동 준비 완료 여부 (헬스체크용)
        this.conversationReference = null; // 대화 참조 정보

        // 메시지 수신 핸들러
        this.onMessage(async (context, next) => {
            
            // 대화 참조 정보 저장
            this.conversationReference = TurnContext.getConversationReference(context.activity);
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
            
            if (processTriggerKeywords.some(keyword => cleanText.replace(/\s/g, '').toUpperCase().includes(keyword.toUpperCase()))) {

                // 프로세스 큐에 추가한다.
                PROCQUEUE.queue.enqueue({
                    "id": userInfo.id,
                    "name": userInfo.name,
                    "email": userInfo.email,
                    "response": cleanText,
                    "notified": false  // 사용자에게 알림 발송 여부
                });

                // 큐를 트리거해준다.
                tryProcessRun();

            } else {
                // 메시지 큐에 메시지 추가
                MSGQUEUE.msgQueue.enqueue(userInfo.id, cleanText);
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

    // Get OAuth token for Microsoft Graph API
    async getGraphToken() {
        const credential = new ClientSecretCredential(
            appTenantId,
            appId,
            appPassword
        );

        try {
            const tokenResponse = await credential.getToken('https://graph.microsoft.com/.default');
            //console.log('Graph token:', tokenResponse.token);
            //console.log('Token expires on:', tokenResponse.expiresOnTimestamp);

            return tokenResponse.token;
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] Graph 토큰을 가져오는 중 오류 발생: ${error.message}`);
            throw error;
        }
    }

    // Get user info
    async getUserInfo(context) {

        const token = await this.getGraphToken();

        const client = Client.init({
            authProvider: (done) => {
                done(null, token);
            }
        });

        const user = await client
            .api(`/users/${context.activity.from.aadObjectId}`)
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

    async createConversationAndContinue(userId, callback) {
        const appCredentials = new MicrosoftAppCredentials(
            appId,
            appPassword,
            appTenantId
        );

        const connectorClient = new ConnectorClient(appCredentials, { baseUri: this.conversationReference.serviceUrl });

        const conversationParameters = {
            isGroup: false,
            tenantId: appTenantId,
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
                tenantId: appTenantId,
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
            console.error(`[${new Date().toLocaleString()}] 사용자 '${userId}'에게 메시지 전송 중 오류 발생: ${error}`);
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
            console.error(`[${new Date().toLocaleString()}] 사용자 '${userId}'에게 typing indicator 전송 중 오류 발생: ${error}`);
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
                app.ready = true;
                console.log(`[${new Date().toLocaleString()}] ✅ UiPath 인증 토큰 갱신 성공.\n`);
            } else {
                // [D-10] 갱신 실패 상태를 헬스체크에 반영한다.
                app.ready = false;
                console.error(`[${new Date().toLocaleString()}] ❌ UiPath 인증 토큰 갱신 실패.\n`);
            }
        },
        (app.uipathToken.expiry - 60) * 1000 // 만료 1분 전에 갱신 시도
    );
}

async function runProcess(item) {
    await app.createConversationAndSendMessage(item.id, appMessage2);

    const jobId = await UIPATH.runProcess(
        app.uipathToken.token,
        {
            "g_polling_sec": pollingSec,
            "g_task_owner_ids": taskOwnerIds,
            "g_user_info": {
                id: item.id,
                name: item.name,
                email: item.email
            },
            "g_user_response": item.response
        }
    );

    if (jobId) {
        JOBTABLE.table.setJob(item.id, jobId);
    }
}

async function tryProcessRun() {

    // [D-8] 동시 실행 가드
    if (processRunInFlight) {
        return;
    }
    if (PROCQUEUE.queue.isEmpty()) {
        return;
    }

    processRunInFlight = true;
    try {
        const item = PROCQUEUE.queue.dequeue();
        if (!item) {
            console.log('Something strange...');
            return;
        }

        const jobId = JOBTABLE.table.getJob(item.id);

        // 등록된 Job이 없으면 그대로 기동한다.
        if (!jobId) {
            await runProcess(item);
            return;
        }

        const state = await UIPATH.getJobState(app.uipathToken.token, jobId);

        // ── [D-8] 상태 조회 실패 ──────────────────────────────
        // 이전 Job이 실제로 살아 있는지 모르는 채로 새 Job을 기동하면
        // 같은 대화에 두 에이전트가 붙는다. 기동을 보류하고 재시도한다.
        if (!state) {
            item.stateCheckRetry = (item.stateCheckRetry || 0) + 1;

            if (item.stateCheckRetry < maxStateCheckRetry) {
                console.error(
                    `[${new Date().toLocaleString()}] ⚠️ Job ${jobId} 상태 확인 실패 ` +
                    `(${item.stateCheckRetry}/${maxStateCheckRetry}). 기동을 보류하고 재시도합니다.`);
                PROCQUEUE.queue.putBack(item);
                return;
            }

            // 임계치 초과 — 영구 정지를 막기 위해 기동을 허용한다.
            console.error(
                `[${new Date().toLocaleString()}] ⚠️ Job ${jobId} 상태를 ${maxStateCheckRetry}회 ` +
                `확인하지 못했습니다. 중복 실행 위험을 감수하고 새 Job을 기동합니다.`);
            JOBTABLE.table.deleteJob(item.id);
            await runProcess(item);
            return;
        }

        item.stateCheckRetry = 0;

        // ── [D-4] 이전 Job이 이미 종료됨 ──────────────────────
        if (isTerminal(state)) {
            JOBTABLE.table.deleteJob(item.id);
            await runProcess(item);
            return;
        }

        // ── 이전 Job이 실행 중 ────────────────────────────────
        if (!restartOnTrigger) {
            console.log(`Job ${jobId} is in '${state}' state. Not allowed to run a new job.`);
            await app.createConversationAndSendMessage(item.id, appMessage5);
            return;
        }

        // ── [D-15] 기존 Job을 중지하고 새로 기동한다 ──────────
        if (!item.stopRequested) {
            console.log(`[${new Date().toLocaleString()}] 재시작 요청 — Job ${jobId} 중지를 시도합니다.`);

            const stopped = await UIPATH.stopJob(app.uipathToken.token, jobId, stopStrategy);

            if (!stopped) {
                item.restartRetry = (item.restartRetry || 0) + 1;

                if (item.restartRetry < 3) {
                    console.error(
                        `[${new Date().toLocaleString()}] ⚠️ Job ${jobId} 중지 실패 ` +
                        `(${item.restartRetry}/3). 재시도합니다.`);
                    PROCQUEUE.queue.putBack(item);   // 메시지를 버리지 않는다
                } else {
                    console.error(`[${new Date().toLocaleString()}] ❌ Job ${jobId} 중지를 3회 실패했습니다.`);
                    await app.createConversationAndSendMessage(item.id, appMessage5);
                }
                return;
            }

            item.stopRequested = true;
        }

        if (!item.restartNotified) {
            await app.createConversationAndSendMessage(item.id, appMessage6);
            item.restartNotified = true;
        }

        // 종료가 실제로 반영될 때까지 짧게 확인한다.
        // 확인 없이 곧바로 기동하면 같은 대화에 두 Job이 붙는 상황이 재현될 수 있다.
        let confirmed = false;
        for (let i = 0; i < STOP_CONFIRM_TRIES; i++) {
            await sleep(STOP_CONFIRM_INTERVAL_MS);
            const s = await UIPATH.getJobState(app.uipathToken.token, jobId);
            if (!s || isTerminal(s)) {
                confirmed = true;
                break;
            }
        }

        if (!confirmed) {
            console.error(
                `[${new Date().toLocaleString()}] ⚠️ Job ${jobId}가 아직 종료되지 않았습니다. ` +
                `다음 주기에 다시 확인합니다.`);
            PROCQUEUE.queue.putBack(item);
            return;
        }

        JOBTABLE.table.deleteJob(item.id);
        await runProcess(item);

    } finally {
        processRunInFlight = false;
    }
}

function triggerProcessRun() {
    setInterval(tryProcessRun, processTriggerInterval * 1000);
}

// Start Teams App REST server
teamsAppServer.listen(appPort, async () => {

    console.log(`\nApp ID: ${appId}`);
    console.log(`App Password: ${appPassword.substring(0, 8)}...`);
    console.log(`Tenant ID: ${appTenantId}`);

    console.log(`\nTeams App listening to ${teamsAppServer.url}`);

    // [D-10] 종전 코드는 async IIFE 안에서 throw 한 뒤 process.exit(1)을 두었다.
    //   throw 뒤의 줄은 실행되지 않으므로 그 exit는 죽은 코드였고, 종료는 Node의
    //   기본 unhandled-rejection 동작에 의존하고 있었다. 전역 핸들러를 추가하면
    //   그 기본 동작이 사라져 포트만 열린 채 아무 일도 하지 않는 상태가 된다.
    app.uipathToken = await UIPATH.getAccessToken();

    if (!app.uipathToken) {
        console.error(
            `[${new Date().toLocaleString()}] ❌ UiPath 인증 실패로 인해 에이전트를 시작할 수 없습니다.`);
        process.exit(1);   // systemd Restart=on-failure 가 재시도한다
        return;
    }

    console.log(`\n[${new Date().toLocaleString()}] UiPath와의 통신 준비 완료.\n`);
    triggerUipathTokenRenewal();
    triggerProcessRun();
    app.ready = true;
});

// Teams App 헬스체크 엔드포인트
teamsAppServer.get('/', async (req, res) => {
    // [D-10] 종전에는 어떤 상황에서도 200을 반환해 준비되지 않은 상태를 감지할 수 없었다.
    if (!app.ready || !app.uipathToken) {
        res.send(503, 'UiPath 연동이 준비되지 않았습니다.');
        return;
    }
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
