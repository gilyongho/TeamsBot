//------------------------------------------------
// test/outboundcontext.smoke.js
//
// [J-7 보완] OutboundContext 동작 검증.
//
// 고정하는 것:
//   - /api/sendMessage 를 쓰지 않는 배포에서는 표가 비어 있어 판정이 기존과 동일하다.
//     (이 성질이 깨지면 고객별 설정 없이 단일 소스로 운영할 수 없게 된다)
//   - 표시한 사용자는 TTL 안에서 "맥락 있음" 이다.
//   - TTL 이 지나면 만료된다.
//   - 만료 항목이 무한히 쌓이지 않는다.
//   - 잘못된 TTL 값으로 판정이 조용히 뒤집히지 않는다.
//
// 실행:  npm test        (사전 준비 없음. 네트워크·인증서·포트를 쓰지 않는다)
//------------------------------------------------

const path = require('path');
const { OutboundContext, context, DEFAULT_TTL_MS } =
    require(path.join(path.resolve(__dirname, '..'), 'outboundcontext.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
    else { fail += 1; console.log(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    console.log('\n=== OutboundContext (J-7 보완) ===\n');

    // ── 1. 쓰지 않는 배포에서는 아무것도 바뀌지 않는다 ────────────────
    //   이것이 이 설계의 핵심 성질이다. 표를 건드리지 않은 상태에서 has() 가
    //   true 를 돌려주면, 그 배포의 J-7 이 조용히 무력화된다.
    {
        const c = new OutboundContext();
        check('표시하지 않은 사용자는 맥락 없음', c.has('u1') === false);
        check('빈 표의 크기는 0', c.size() === 0, `실제 ${c.size()}`);
        check('userId 가 없으면 맥락 없음', c.has(undefined) === false && c.has('') === false);
    }

    // ── 2. 표시한 사용자는 TTL 안에서 맥락 있음 ──────────────────────
    {
        const c = new OutboundContext(60000);
        check('mark() 가 성공을 반환', c.mark('u1') === true);
        check('표시한 사용자는 맥락 있음', c.has('u1') === true);
        check('다른 사용자는 여전히 맥락 없음', c.has('u2') === false);
        check('표 크기 1', c.size() === 1, `실제 ${c.size()}`);
        check('userId 가 없으면 표시하지 않음',
            c.mark(undefined) === false && c.mark('') === false && c.size() === 1);
    }

    // ── 3. TTL 만료 ──────────────────────────────────────────────────
    {
        const c = new OutboundContext(80);
        c.mark('u1');
        check('만료 전에는 맥락 있음', c.has('u1') === true);
        await sleep(140);
        check('TTL 경과 후 맥락 없음', c.has('u1') === false);
        check('읽는 김에 항목이 정리됨', c.size() === 0, `실제 ${c.size()}`);
    }

    // ── 4. 재표시로 TTL 이 갱신된다 ──────────────────────────────────
    //   다회 문답 구성에서 매 발송마다 창이 다시 열려야 한다.
    {
        const c = new OutboundContext(120);
        c.mark('u1');
        await sleep(80);
        c.mark('u1');                       // 다시 발송
        await sleep(80);                    // 첫 표시로부터 160ms — 갱신이 없으면 만료
        check('재표시로 TTL 갱신됨', c.has('u1') === true);
    }

    // ── 5. sweep() — 다시 읽히지 않는 항목도 정리된다 ────────────────
    //   has() 는 읽은 항목만 정리하므로, 이것이 없으면 표가 무한히 자란다.
    {
        const c = new OutboundContext(60);
        for (let i = 0; i < 50; i++) c.mark(`u${i}`);
        check('표 크기 50', c.size() === 50, `실제 ${c.size()}`);
        await sleep(120);
        const removed = c.sweep();
        check('sweep() 이 만료 항목 50건 제거', removed === 50, `실제 ${removed}`);
        check('sweep() 후 표 크기 0', c.size() === 0, `실제 ${c.size()}`);
    }

    // ── 6. sweep() 은 유효 항목을 건드리지 않는다 ────────────────────
    {
        const c = new OutboundContext(60000);
        c.mark('u1'); c.mark('u2');
        check('sweep() 이 유효 항목을 지우지 않음', c.sweep() === 0 && c.size() === 2,
            `제거 ${c.sweep()}건 / 크기 ${c.size()}`);
    }

    // ── 7. 잘못된 TTL 값이 판정을 뒤집지 않는다 ──────────────────────
    //   0 이나 음수가 들어가면 표시한 사용자가 즉시 만료되어 J-7 보완이 무효가 된다.
    //   NaN 이면 비교가 항상 false 라 영구 보존된다. 둘 다 조용한 고장이다.
    {
        const c = new OutboundContext(5000);
        check('0 은 거부되고 기존 값 유지', c.configure(0) === 5000, `실제 ${c.ttlMs}`);
        check('음수는 거부', c.configure(-1) === 5000, `실제 ${c.ttlMs}`);
        check('NaN 은 거부', c.configure(Number('abc')) === 5000, `실제 ${c.ttlMs}`);
        check('Infinity 는 거부', c.configure(Infinity) === 5000, `실제 ${c.ttlMs}`);
        check('유효한 값은 수락', c.configure(1234) === 1234, `실제 ${c.ttlMs}`);
    }

    // ── 8. 싱글턴과 기본값 ──────────────────────────────────────────
    {
        check('기본 TTL 은 10분', DEFAULT_TTL_MS === 600000, `실제 ${DEFAULT_TTL_MS}`);
        check('싱글턴이 export 됨', context instanceof OutboundContext);
        check('싱글턴 초기 상태는 비어 있음', context.size() === 0, `실제 ${context.size()}`);
    }

    console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
    process.exit(fail ? 1 : 0);
})();
