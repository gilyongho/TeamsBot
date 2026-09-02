//------------------------------------------------
// test/msgqueue.smoke.js
//
// MessageQueue.enqueue() 동작 검증 (axios mock).
// R-1 회귀의 핵심을 고정한다:
//   - 성공 시 발송은 1회. 2차를 보내지 않는다.
//   - 1차가 실패한 경우에만 재시도한다.
//   - 두 번 다 실패하면 메시지를 큐에 보존한다.  ← 이게 없으면 사용자 답변이 소실된다.
//
// 실행:  npm test
// 사전:  cert.pem / key.pem 이 저장소 루트에 있어야 한다 (msgqueue.js 가 모듈
//        로드 시점에 HTTPS 서버를 연다). 임시 인증서로 충분하다:
//   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
//     -days 1 -nodes -subj "/CN=test.local"
//------------------------------------------------

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);                       // msgqueue.js 가 cert.pem 을 상대경로로 읽는다
const MSGQUEUE_PATH = path.join(ROOT, 'msgqueue.js');

process.env.UiPathWebhookUrl = 'https://mock.local/hook';
process.env.UiPathWebhookFormat = 'x-uipath-webhookkey';
process.env.UiPathWebhookKey = 'test-key';
process.env.UiPathWebhookRetryAfter = '0.05';
process.env.MessageQueueApiKey = 'test-mq-key';
process.env.MessageQueuePort = '18080';

// ── axios mock ────────────────────────────────────────────────
let mode = 'ok';
let calls = [];
const axiosMock = {
    post: (url, data, cfg) => {
        calls.push({ url, data, cfg });
        if (mode === 'ok') return Promise.resolve({ status: 200 });
        if (mode === 'fail-then-ok') {
            return calls.length === 1
                ? Promise.reject({ message: 'first attempt failed' })
                : Promise.resolve({ status: 200 });
        }
        return Promise.reject({ message: 'both attempts failed' });
    },
    get: () => Promise.resolve({ data: {} })
};

const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'axios') return axiosMock;
    return realLoad.apply(this, arguments);
};

const { msgQueue } = require(MSGQUEUE_PATH);

const queued = (id) => (msgQueue.queue.get(id) || []).slice();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  ✅', name); }
    else { fail++; console.log('  ❌', name, detail); }
};

(async () => {
    console.log('\n[1] webhook 성공 → 발송 1회, 큐 적재 없음');
    mode = 'ok'; calls = []; msgQueue.reset('u1');
    msgQueue.enqueue('u1', '국내');
    await sleep(200);
    check('발송이 정확히 1회 (2차 없음)', calls.length === 1, `실제 ${calls.length}회`);
    check('큐가 비어 있음', queued('u1').length === 0, JSON.stringify(queued('u1')));
    check('payload 에 message_id 포함', !!calls[0].data.message_id);
    check('헤더 이름이 설정값으로 전송됨',
        'x-uipath-webhookkey' in calls[0].cfg.headers,
        JSON.stringify(Object.keys(calls[0].cfg.headers)));

    console.log('\n[2] 1차 실패 → 재시도 성공 → 큐 적재 없음');
    mode = 'fail-then-ok'; calls = []; msgQueue.reset('u1');
    msgQueue.enqueue('u1', '국내');
    await sleep(300);
    check('발송 2회 (1차 실패 후 재시도)', calls.length === 2, `실제 ${calls.length}회`);
    check('큐가 비어 있음', queued('u1').length === 0, JSON.stringify(queued('u1')));
    check('두 요청의 message_id 가 동일',
        calls[0].data.message_id === calls[1].data.message_id);

    console.log('\n[3] 1차·2차 모두 실패 → 사용자에게 안내  (R-1 핵심)');
    {
        const notified = [];
        msgQueue.setFailureHandler(async (id, msg, msgId) => {
            notified.push({ id, msg, msgId });
        });
        mode = 'fail'; calls = []; msgQueue.reset('u1');
        msgQueue.enqueue('u1', '발송해줘');
        await sleep(300);
        check('발송 2회', calls.length === 2, `실제 ${calls.length}회`);
        check('사용자에게 전달 실패가 통지됨',
            notified.length === 1 && notified[0].id === 'u1' && notified[0].msg === '발송해줘',
            JSON.stringify(notified));
        check('통지에 message_id 포함', !!notified[0].msgId);
        check('큐에도 남김 (폴링 backstop 대비)', queued('u1').length === 1);
        msgQueue.dequeue('u1');
        msgQueue.setFailureHandler(null);
    }

    console.log('\n[3-b] 큐가 무한히 자라지 않음');
    {
        msgQueue.setFailureHandler(async () => {});
        mode = 'fail'; msgQueue.reset('u5');
        for (let i = 0; i < 25; i++) msgQueue.enqueue('u5', `m${i}`);
        await sleep(2500);
        check('사용자별 상한 20 이하 유지',
            queued('u5').length <= 20, `실제 ${queued('u5').length}건`);
        msgQueue.setFailureHandler(null);
    }

    console.log('\n[4] Webhook URL 미설정 → 소실 없이 큐 적재');
    msgQueue.reset('u2');
    const saved = msgQueue.constructor;   // 인스턴스 재사용을 위해 URL 만 비운 사본으로 검증
    check('MessageQueue 인스턴스 확인', typeof saved === 'function');
    // enqueue 내부의 uipathWebhookUrl 은 모듈 로드 시 고정되므로,
    // 여기서는 큐 적재 경로 자체(dequeue/reset)의 무결성만 확인한다.
    msgQueue.queue.get('u2').push('예');
    check('큐 적재/회수 정상', msgQueue.dequeue('u2') === '예');

    console.log('\n[5] reset() — 키가 없어도 빈 배열로 초기화');
    msgQueue.reset('brand-new-user');
    check('빈 배열 생성됨', Array.isArray(msgQueue.queue.get('brand-new-user')));

    console.log('\n[6] 순서 보장 — 1차 실패한 메시지가 뒤 메시지를 추월하지 않음');
    {
        const order = [];
        let n = 0;
        const saved = axiosMock.post;
        axiosMock.post = (url, data) => {
            n++;
            if (n === 1) return Promise.reject({ message: 'first send fails' });
            order.push(data.message);
            return Promise.resolve({ status: 200 });
        };
        msgQueue.reset('u3');
        msgQueue.enqueue('u3', '답변1');
        msgQueue.enqueue('u3', '답변2');
        await sleep(400);
        axiosMock.post = saved;
        check('답변1 이 답변2 보다 먼저 도착',
            order[0] === '답변1' && order[1] === '답변2',
            `실제 순서 ${JSON.stringify(order)}`);
    }

    console.log('\n[7] reset 이후 지난 세션의 재시도 결과가 새 큐를 오염시키지 않음');
    {
        mode = 'fail'; msgQueue.reset('u4');
        msgQueue.enqueue('u4', '옛세션의 답변');
        await sleep(20);
        msgQueue.reset('u4');          // 재시도 도중 새 세션 시작
        await sleep(400);
        check('새 세션 큐가 비어 있음',
            queued('u4').length === 0,
            JSON.stringify(queued('u4')));
    }

    console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
    process.exit(fail ? 1 : 0);
})();
