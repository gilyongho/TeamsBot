//------------------------------------------------
// msgqueue.js
//------------------------------------------------

// 필요한 패키지: npm install axios restify crypto fs dotenv
const axios = require('axios');
const restify = require('restify');
const crypto = require('crypto');
const fs = require('fs');

// load environment variables from .env file
require('dotenv').config();

// 환경 변수 (.env 파일에서 관리)
const msgPort = process.env.MessageQueuePort || 8080;
const messageQueueApiKey = process.env.MessageQueueApiKey || '';
const uipathWebhookUrl = process.env.UiPathWebhookUrl || '';
const uipathWebhookKey = process.env.UiPathWebhookKey || '';
const uipathWebhookFormat = process.env.UiPathWebhookFormat || 'x-uipath-webhookkey';
const uipathWebhookRetryAfter = process.env.UiPathWebhookRetryAfter || 1;

// API Key Authentication
const apiKeyAuth = (req, res, next) => {
    const clientKey = req.headers['x-api-key'];

    if (!clientKey) {
        console.error(`[${new Date().toLocaleString()}] MQ API Key missing in HTTP request header!`);
        return res.send(403, { error: '권한이 없습니다.' })
    }

    // 보안 강화: 타임 상수 비교
    try {
        const isMatch = crypto.timingSafeEqual(
            Buffer.from(clientKey),
            Buffer.from(messageQueueApiKey)
        );

        if (isMatch) {
            //console.log('MQ API key identical');
            next();
        } else {
            console.error(`[${new Date().toLocaleString()}] MQ API Key NOT identical!`);
            res.send(403, { error: '권한이 없습니다.' })
        }
    } catch (e) {
        console.error(`[${new Date().toLocaleString()}] MQ API Key NOT same length!`);
        res.send(403, { error: '권한이 없습니다.' })
    }
};

// 메시지 큐 클래스
class MessageQueue {
    constructor() {
        this.queue = new Map();

        // 사용자별 직렬 전송 체인.
        //   재시도가 setTimeout 이면 실패한 메시지가 뒤에 온 메시지보다 늦게 도착해
        //   순차 질의응답 에이전트가 답변 순서를 뒤바꿔 소비한다. 사용자 단위로
        //   앞 전송이 끝난 뒤에 다음 전송을 시작해 순서를 보장한다.
        this.sendChains = new Map();

        // reset 세대. 재시도 도중 /reset 이 호출되면 그 메시지는 이전 세션의
        //   것이므로 새 세션 큐에 넣으면 안 된다.
        this.generation = new Map();
    }

    isEmpty(id) {
        if (!this.queue.has(id)) {
            return true;
        } else {
            return this.queue.get(id).length === 0;
        }
    }

    reset(id) {
        this.queue.set(id, []);
        this.generation.set(id, (this.generation.get(id) || 0) + 1);
    }

    enqueue(id, message) {

        if (!this.queue.has(id)) {
            this.queue.set(id, []);
        }
        if (!this.generation.has(id)) {
            this.generation.set(id, 0);
        }

        // Webhook 미설정 시에도 메시지를 잃지 않도록 큐에 적재한다.
        if (!uipathWebhookUrl) {
            console.log(`[${new Date().toLocaleString()}] Webhook URL is empty! 메시지를 큐에 적재합니다.`);
            this.queue.get(id).push(message);
            return;
        }

        // 같은 사용자의 이전 전송이 끝난 뒤에 보낸다. (순서 보장)
        const gen = this.generation.get(id);
        const prev = this.sendChains.get(id) || Promise.resolve();
        const next = prev.then(() => this._send(id, message, gen)).catch(() => {});
        this.sendChains.set(id, next);
    }

    async _send(id, message, gen) {

        const messageId = crypto.randomUUID();

        const postData = {
            user_id: id,
            message: message,
            message_id: messageId
        };

        const postConfig = {
            headers: {
                'Content-Type': 'application/json',
                [uipathWebhookFormat]: uipathWebhookKey
            }
        };

        const logError = (phase, error) => {
            console.error(`[${new Date().toLocaleString()}] ❌ UiPath Webhook ${phase} 알림 실패: [msg:${messageId}]`);
            if (error.response) {
                console.error(`   - Status: ${error.response.status}`);
                console.error(`   - Data: ${JSON.stringify(error.response.data)}`);
            } else if (error.request) {
                console.error('   - Error: No response received from UiPath API.');
            } else {
                console.error(`   - Error: ${error.message}`);
            }
        };

        try {
            await axios.post(uipathWebhookUrl, postData, postConfig);
            console.log(`[${new Date().toLocaleString()}] ✅ UiPath Webhook 1차 알림 성공. [msg:${messageId}]`);
            return;
        } catch (error) {
            logError('1차', error);
        }

        // 1차가 실패한 경우에만 재시도한다.
        await new Promise(r => setTimeout(r, Number(uipathWebhookRetryAfter) * 1000));

        try {
            await axios.post(uipathWebhookUrl, postData, postConfig);
            console.log(`[${new Date().toLocaleString()}] ✅ UiPath Webhook 2차 알림 성공. [msg:${messageId}]`);
            return;
        } catch (error) {
            logError('2차', error);
        }

        // 재시도 중 /reset 이 호출됐다면 이 메시지는 이전 세션의 것이다.
        // 새 세션 큐에 넣으면 다음 대화의 첫 dequeue 가 엉뚱한 답변을 가져간다.
        if (this.generation.get(id) !== gen) {
            console.error(
                `[${new Date().toLocaleString()}] ⚠️ 이전 세션의 메시지이므로 큐에 넣지 않고 버립니다. ` +
                `[msg:${messageId}]`);
            return;
        }

        this.queue.get(id).push(message);
        console.error(`[${new Date().toLocaleString()}] ⚠️ 메시지를 큐에 적재했습니다. [msg:${messageId}]`);
    }

    dequeue(id) {
        if (this.isEmpty(id)) {
            return null;
        } else {
            return this.queue.get(id).shift();
        }
    }

    print() {
        if (this.queue.size === 0) {
            console.log('\n--- 메시지 큐가 비어있습니다 ---');
            return;
        }
        this.queue.forEach((messages, id) => {
            console.log(`\n--- ${id} 내용 ---`);
            messages.forEach((msg, index) => {
                console.log(`${index + 1}: '${msg}'`);
            });
        });
    }
}

// 메시지 큐 인스턴스 생성
const msgQueue = new MessageQueue();

// Message Queue REST 서버 생성
const serverOptions = {
    certificate: fs.readFileSync('cert.pem'),
    key: fs.readFileSync('key.pem')
};
//const msgQueueServer = restify.createServer();  // HTTP 서버
const msgQueueServer = restify.createServer(serverOptions);  // HTTPS 서버
msgQueueServer.use(restify.plugins.bodyParser());

// Message Queue 헬스체크 엔드포인트
msgQueueServer.get('/', apiKeyAuth, async (req, res) => {
    msgQueue.print();
    res.send('Message Queue 서버가 실행 중입니다.');
});

// Message Queue REST 서버 시작
msgQueueServer.listen(msgPort, () => {
    console.log(`\n[${new Date().toLocaleString()}] Message Queue Server listening to ${msgQueueServer.url}`);
    console.log('Message Queue 서버 시작됨.\n');
});

// Reset message queue for specified user
msgQueueServer.post('/reset', apiKeyAuth, async (req, res) => {
    const id = req.body.id;
    msgQueue.reset(id);
    console.log(`[${new Date().toLocaleString()}] Message Queue ${id}가 초기화되었습니다.`);
    res.send(`Message Queue ${id}가 초기화되었습니다.`);
});

// Retrieve a message (polling)
msgQueueServer.post('/dequeue', apiKeyAuth, async (req, res) => {
    const id = req.body.id;
    const message = msgQueue.dequeue(id);
    if (message) {
        console.log(`[${new Date().toLocaleString()}] Dequeued message: ${message}`);
        res.send({ message: message });
    } else {
        //console.log('Message Queue is empty.');
        res.send({ message: null });
    }
});

module.exports = {
    msgQueue
};
