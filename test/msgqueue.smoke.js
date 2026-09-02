const path = require('path'), Module = require('module');
process.chdir('/home/claude/work/build');

process.env.UiPathWebhookUrl = 'https://mock.local/hook';
process.env.UiPathWebhookFormat = 'x-uipath-webhookkey';
process.env.UiPathWebhookKey = 'k';
process.env.UiPathWebhookRetryAfter = '0.05';
process.env.MessageQueueApiKey = 'mq';

// ── axios mock ──
let mode = 'ok', calls = [];
const axiosMock = { post: (url, data, cfg) => { calls.push({url, data, cfg});
    if (mode === 'ok') return Promise.resolve({status:200});
    if (mode === 'fail1' && calls.length === 1) return Promise.reject({message:'boom1'});
    if (mode === 'fail1') return Promise.resolve({status:200});
    return Promise.reject({message:'boom'}); }, get: () => Promise.resolve({data:{}}) };
const orig = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === 'axios') return axiosMock;
    return orig.apply(this, arguments);
};

const { msgQueue } = require('/home/claude/work/build/msgqueue.js');
const q = () => (msgQueue.queue.get('u1') || []).slice();
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let pass = 0, fail = 0;
  const t = (name, cond, extra='') => { cond ? (pass++, console.log('  ✅', name)) : (fail++, console.log('  ❌', name, extra)); };

  console.log('\n[1] webhook 성공 → 큐 적재 없음, 발송 1회');
  mode='ok'; calls=[]; msgQueue.reset('u1'); msgQueue.enqueue('u1','국내'); await sleep(200);
  t('발송 정확히 1회 (2차 없음)', calls.length===1, `실제 ${calls.length}회`);
  t('큐 비어 있음', q().length===0, JSON.stringify(q()));
  t('message_id 포함', !!calls[0].data.message_id);
  t('헤더명이 x-uipath-webhookkey', 'x-uipath-webhookkey' in calls[0].cfg.headers, JSON.stringify(Object.keys(calls[0].cfg.headers)));

  console.log('\n[2] 1차 실패 → 재시도 성공 → 큐 적재 없음');
  mode='fail1'; calls=[]; msgQueue.reset('u1'); msgQueue.enqueue('u1','국내'); await sleep(300);
  t('발송 2회 (1차 실패 후 재시도)', calls.length===2, `실제 ${calls.length}회`);
  t('큐 비어 있음', q().length===0, JSON.stringify(q()));
  t('두 요청의 message_id 동일', calls[0].data.message_id===calls[1].data.message_id);

  console.log('\n[3] 1차·2차 모두 실패 → 큐 적재 (R-1 핵심)');
  mode='fail'; calls=[]; msgQueue.reset('u1'); msgQueue.enqueue('u1','발송해줘'); await sleep(300);
  t('발송 2회', calls.length===2, `실제 ${calls.length}회`);
  t('큐에 메시지 보존', q().length===1 && q()[0]==='발송해줘', JSON.stringify(q()));
  t('dequeue 로 회수 가능', msgQueue.dequeue('u1')==='발송해줘');

  console.log('\n[4] Webhook URL 미설정 → 소실 없이 큐 적재');
  delete require.cache[require.resolve('/home/claude/work/build/msgqueue.js')];
  process.env.UiPathWebhookUrl = '';
  process.env.MessageQueuePort = '8091';
  const m2 = require('/home/claude/work/build/msgqueue.js').msgQueue;
  m2.enqueue('u2','예'); await sleep(50);
  t('큐에 적재됨', (m2.queue.get('u2')||[]).length===1);

  console.log('\n[5] reset() — 키가 없어도 초기화');
  msgQueue.reset('newuser');
  t('빈 배열 생성', Array.isArray(msgQueue.queue.get('newuser')));

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
