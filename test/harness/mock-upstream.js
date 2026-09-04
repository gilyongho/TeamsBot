//------------------------------------------------
// test/harness/mock-upstream.js
//
// TeamsBot 의 상류 3곳을 한 프로세스로 흉내낸다.
//   1) UiPath Identity   — 토큰 발급
//   2) UiPath Orchestrator — StartJobs / Jobs(id) / StopJobs / Machines
//   3) UiPath Webhook 수신 — 사용자 답변을 받는 곳
//   4) Bot Framework Connector — 봇이 사용자에게 보내는 메시지를 받는 곳
//
// 덕분에 운영 서버를 건드리지 않고, 실제 HTTP 를 오가는 상태로
// TeamsBot 의 동작 대부분을 확인할 수 있다.
//
// 실행:  node test/harness/mock-upstream.js
// 제어:  curl -s localhost:19000/__control -d '{"webhook":"fail"}' -H 'content-type: application/json'
// 관찰:  curl -s localhost:19000/__state | python3 -m json.tool
//------------------------------------------------

const http = require('http');

const PORT = Number(process.env.MockPort || 19000);

// ── 동작 모드 ────────────────────────────────────────────────
//   ok       : 정상 응답
//   fail     : 500 반환
//   hang     : 응답하지 않음 (타임아웃 검증용)
//   notfound : 404 반환 (jobState 전용 — "그런 Job 없음"과 "물어보지 못함"의 구분 검증)
const mode = {
    webhook: 'ok',
    token: 'ok',
    startJob: 'ok',
    jobState: 'ok',
    stopJob: 'ok'
};

// 다음 StartJobs 가 돌려줄 Job ID
let nextJobId = 1000;
// Job ID -> 상태.  Kill 요청을 받으면 stopTransition 에 따라 바뀐다.
const jobs = new Map();
// 'immediate' = 즉시 Stopped, 'terminating' = Terminating 에 머무름(확인 루프 검증)
let stopTransition = 'immediate';

// 관찰 기록
const seen = {
    webhook: [],        // 사용자 답변 (user_id, message, message_id, 헤더)
    startJob: [],
    stopJob: [],
    jobState: [],
    botMessages: []     // 봇이 사용자에게 보낸 메시지
};

const log = (...a) => console.log(`[mock ${new Date().toISOString().slice(11, 19)}]`, ...a);

function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); }
            catch { resolve({ _raw: raw }); }
        });
    });
}

const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

    // ── 제어 / 관찰 ──────────────────────────────────────────
    if (url === '/__control' && req.method === 'POST') {
        for (const k of Object.keys(mode)) {
            if (body[k]) { mode[k] = body[k]; }
        }
        if (body.stopTransition) { stopTransition = body.stopTransition; }
        if (body.setJobState) {
            jobs.set(Number(body.setJobState.id), body.setJobState.state);
        }
        if (body.clear) {
            for (const k of Object.keys(seen)) { seen[k] = []; }
        }
        log('control →', JSON.stringify({ ...mode, stopTransition }));
        return json(res, 200, { mode, stopTransition });
    }

    if (url === '/__state') {
        return json(res, 200, {
            mode,
            stopTransition,
            jobs: Object.fromEntries(jobs),
            counts: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.length])),
            seen
        });
    }

    // ── 1) 토큰 ──────────────────────────────────────────────
    if (url.endsWith('/identity_/connect/token')) {
        if (mode.token === 'hang') { log('token → 응답 보류(hang)'); return; }
        if (mode.token === 'fail') { log('token → 500'); return json(res, 500, { error: 'mock' }); }
        log('token → 200');
        return json(res, 200, {
            access_token: 'mock-token-' + Date.now(),
            expires_in: 120,          // 짧게 두면 갱신 경로를 빨리 관찰할 수 있다
            token_type: 'Bearer'
        });
    }

    // ── 2) Orchestrator ──────────────────────────────────────
    if (url.endsWith('/UiPath.Server.Configuration.OData.StartJobs')) {
        seen.startJob.push({ at: Date.now(), body });
        if (mode.startJob === 'hang') { log('StartJobs → 응답 보류(hang)'); return; }
        if (mode.startJob === 'fail') { log('StartJobs → 500'); return json(res, 500, { error: 'mock' }); }
        const id = nextJobId++;
        jobs.set(id, 'Running');
        log(`StartJobs → 201  Job ${id}`);
        return json(res, 201, { value: [{ Id: id }] });
    }

    if (url.endsWith('/UiPath.Server.Configuration.OData.StopJobs')) {
        seen.stopJob.push({ at: Date.now(), body, headers: req.headers });
        if (mode.stopJob === 'hang') { log('StopJobs → 응답 보류(hang)'); return; }
        if (mode.stopJob === 'fail') { log('StopJobs → 500'); return json(res, 500, { error: 'mock' }); }
        const ids = Array.isArray(body.jobIds) ? body.jobIds : [];
        for (const id of ids) {
            jobs.set(Number(id), stopTransition === 'immediate' ? 'Stopped' : 'Terminating');
        }
        log(`StopJobs → 200  jobIds=${JSON.stringify(ids)} strategy=${body.strategy} → ${stopTransition === 'immediate' ? 'Stopped' : 'Terminating'}`);
        return json(res, 200, {});
    }

    const jobMatch = url.match(/\/odata\/Jobs\((\d+)\)$/);
    if (jobMatch) {
        const id = Number(jobMatch[1]);
        seen.jobState.push({ at: Date.now(), id });
        if (mode.jobState === 'hang') { log(`Jobs(${id}) → 응답 보류(hang)`); return; }
        if (mode.jobState === 'fail') { log(`Jobs(${id}) → 500`); return json(res, 500, { error: 'mock' }); }
        // 404 는 "그런 Job 없다"는 확정된 답이다. 500 과 달리 새 Job 기동이 안전하다.
        if (mode.jobState === 'notfound') { log(`Jobs(${id}) → 404`); return json(res, 404, { message: 'not found' }); }
        const state = jobs.get(id) || 'Running';
        log(`Jobs(${id}) → ${state}`);
        return json(res, 200, { Id: id, State: state });
    }

    if (url.endsWith('/odata/Machines')) {
        return json(res, 200, { value: [{ Id: 1, UnattendedSlots: 4 }] });
    }

    // ── 3) Webhook 수신 (사용자 답변) ─────────────────────────
    if (url === '/webhook') {
        seen.webhook.push({ at: Date.now(), body, headers: req.headers });
        if (mode.webhook === 'hang') { log('webhook → 응답 보류(hang)'); return; }
        if (mode.webhook === 'fail') {
            log(`webhook → 500  '${body.message}'`);
            return json(res, 500, { error: 'mock' });
        }
        log(`webhook → 200  '${body.message}'  [msg:${(body.message_id || '').slice(0, 8)}]`);
        return json(res, 200, {});
    }

    // ── 4) Bot Framework Connector (봇 → 사용자) ──────────────
    //   대화 생성
    if (url === '/teams/v3/conversations' && req.method === 'POST') {
        const id = 'conv-' + Date.now();
        log(`createConversation → ${id}`);
        return json(res, 200, { id, activityId: 'act-1' });
    }
    //   활동(메시지) 전송
    const actMatch = url.match(/^\/teams\/v3\/conversations\/([^/]+)\/activities/);
    if (actMatch && req.method === 'POST') {
        if (body.type === 'typing') {
            return json(res, 200, { id: 'act-typing' });
        }
        seen.botMessages.push({ at: Date.now(), text: body.text });
        log(`봇 → 사용자:  ${String(body.text || '').replace(/<br>/g, ' ').slice(0, 90)}`);
        return json(res, 200, { id: 'act-' + Date.now() });
    }

    log(`404  ${req.method} ${url}`);
    json(res, 404, { error: 'not found', url });
});

server.listen(PORT, '127.0.0.1', () => {
    log(`mock upstream listening on http://127.0.0.1:${PORT}`);
    log('  UiPathBaseURL      = http://127.0.0.1:' + PORT);
    log('  UiPathWebhookUrl   = http://127.0.0.1:' + PORT + '/webhook');
    log('  activity serviceUrl= http://127.0.0.1:' + PORT + '/teams');
});
