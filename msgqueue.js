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
    }

    enqueue(id, message) {

        if (!this.queue.has(id)) {
            this.queue.set(id, []);
        }

        // [R-1] Webhook 미설정 시에도 메시지를 잃지 않도록 큐에 적재한다.
        if (!uipathWebhookUrl) {
            console.log(`[${new Date().toLocaleString()}] Webhook URL is empty! 메시지를 큐에 적재합니다.`);
            this.queue.get(id).push(message);
            return;
        }

        // [R-1] 수신측 중복 제거용 식별자. 로그 추적에도 사용한다.
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

        // 1차 알림
        axios.post(uipathWebhookUrl, postData, postConfig)
        .then(() => {
            console.log(`[${new Date().toLocaleString()}] ✅ UiPath Webhook 1차 알림 성공. [msg:${messageId}]`);
            // 성공하면 여기서 끝. 2차를 보내지 않는다.
        })
        .catch(error => {
            logError('1차', error);

            // [R-1] 1차가 실패한 경우에만 재시도한다.
            setTimeout(() => {
                axios.post(uipathWebhookUrl, postData, postConfig)
                .then(() => {
                    console.log(`[${new Date().toLocaleString()}] ✅ UiPath Webhook 2차 알림 성공. [msg:${messageId}]`);
                })
                .catch(err2 => {
                    logError('2차', err2);
                    // [R-1] 최종 실패 시에만 큐에 적재한다. (/dequeue 폴링 fallback)
                    this.queue.get(id).push(message);
                    console.error(`[${new Date().toLocaleString()}] ⚠️ 메시지를 큐에 적재했습니다. [msg:${messageId}]`);
                });
            }, Number(uipathWebhookRetryAfter) * 1000);
        });
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
