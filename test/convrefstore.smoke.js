//------------------------------------------------
// test/convrefstore.smoke.js
//
// 대화 참조 저장소 동작 검증.
//
// 고정하는 것:
//   - 담지 않은 사용자는 조회되지 않는다. (이 성질이 깨지면 엉뚱한 사람의 대화로
//     메시지가 나간다. 이 표에서 가장 위험한 결함이다)
//   - 사용자별로 분리된다. 한 사람의 참조가 다른 사람 조회에 나오지 않는다.
//   - 쓸 수 없는 모양의 참조는 담지 않는다.
//   - 버리면 사라진다. (재사용 실패 시 폴백이 성립하려면 필요하다)
//   - 상한을 넘으면 가장 오래 쓰지 않은 것부터 버린다. 무한히 자라지 않는다.
//
// 실행:  npm test        (사전 준비 없음. 네트워크·인증서·포트를 쓰지 않는다)
//------------------------------------------------

const path = require('path');
const { ConvRefStore, isUsable, DEFAULT_MAX_ENTRIES } =
    require(path.join(path.resolve(__dirname, '..'), 'convrefstore.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
    else { fail += 1; console.log(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
}

// 실제 TurnContext.getConversationReference() 가 돌려주는 모양을 줄인 것.
function ref(convId, serviceUrl = 'https://smba.trafficmanager.net/kr/') {
    return {
        activityId: 'act-1',
        channelId: 'msteams',
        serviceUrl,
        conversation: { id: convId, tenantId: 't-1', conversationType: 'personal' },
        bot: { id: '28:bot-1', name: 'AI Agent' },
        user: { id: 'u-x' }
    };
}

console.log('\n=== ConvRefStore (대화 참조 재사용) ===\n');

// ── 1. 담지 않은 사용자는 나오지 않는다 ──────────────────────────
//   가장 중요한 성질이다. 여기서 아무거나 돌려주면 다른 사람의 대화창으로
//   메시지가 나간다.
{
    const s = new ConvRefStore();
    check('담지 않은 사용자는 null', s.get('aad-1') === null);
    check('빈 표의 크기는 0', s.size() === 0, `실제 ${s.size()}`);
    check('userId 가 없으면 null',
        s.get(undefined) === null && s.get('') === null && s.get(null) === null);
    check('userId 가 없으면 담지 않음',
        s.set(undefined, ref('c1')) === false && s.set('', ref('c1')) === false && s.size() === 0);
}

// ── 2. 담고 꺼낸다 ───────────────────────────────────────────────
{
    const s = new ConvRefStore();
    check('set 이 성공을 반환', s.set('aad-1', ref('c1')) === true);
    check('담은 것이 그대로 나옴', s.get('aad-1').conversation.id === 'c1');
    check('has 가 맞음', s.has('aad-1') === true && s.has('aad-2') === false);
    check('표 크기 1', s.size() === 1, `실제 ${s.size()}`);
}

// ── 3. 사용자별로 분리된다 ───────────────────────────────────────
//   지금 결함의 본질이 "참조가 프로세스에 하나뿐" 이라는 것이므로,
//   이 성질이 이 수정의 존재 이유다.
{
    const s = new ConvRefStore();
    s.set('aad-1', ref('c1'));
    s.set('aad-2', ref('c2'));
    check('A 는 A 의 대화', s.get('aad-1').conversation.id === 'c1');
    check('B 는 B 의 대화', s.get('aad-2').conversation.id === 'c2');
    check('나중에 담아도 앞사람 것이 덮이지 않음', s.get('aad-1').conversation.id === 'c1');

    // 같은 사람을 다시 담으면 최신으로 갱신된다 (serviceUrl 이 바뀌는 경우)
    s.set('aad-1', ref('c1-new', 'https://smba.trafficmanager.net/kr2/'));
    check('같은 사용자는 갱신됨', s.get('aad-1').conversation.id === 'c1-new');
    check('갱신해도 인원 수는 그대로', s.size() === 2, `실제 ${s.size()}`);
}

// ── 4. 쓸 수 없는 모양은 담지 않는다 ─────────────────────────────
//   담아 두면 재사용마다 실패하고 폴백해서 호출이 두 배가 된다.
{
    const s = new ConvRefStore();
    const noConv = ref('c1'); delete noConv.conversation;
    const noConvId = ref('c1'); noConvId.conversation = {};
    const noUrl = ref('c1'); delete noUrl.serviceUrl;
    const noBot = ref('c1'); delete noBot.bot;

    check('conversation 없음 → 거부', s.set('a', noConv) === false);
    check('conversation.id 없음 → 거부', s.set('a', noConvId) === false);
    check('serviceUrl 없음 → 거부', s.set('a', noUrl) === false);
    check('bot 없음 → 거부', s.set('a', noBot) === false);
    check('null/undefined → 거부', s.set('a', null) === false && s.set('a', undefined) === false);
    check('거부된 것은 쌓이지 않음', s.size() === 0, `실제 ${s.size()}`);
    check('isUsable 이 정상 참조는 통과', isUsable(ref('c1')) === true);
}

// ── 5. 버리면 사라진다 ───────────────────────────────────────────
//   재사용이 실패했을 때 버리고 createConversation 으로 되돌아가는 경로가
//   성립하려면 필요하다.
{
    const s = new ConvRefStore();
    s.set('aad-1', ref('c1'));
    check('delete 가 성공을 반환', s.delete('aad-1') === true);
    check('버린 뒤에는 null', s.get('aad-1') === null);
    check('없는 것을 버리면 false', s.delete('aad-1') === false);
    check('버린 뒤 크기 0', s.size() === 0, `실제 ${s.size()}`);
}

// ── 6. 상한 — 무한히 자라지 않는다 ───────────────────────────────
{
    const s = new ConvRefStore(3);
    s.set('a', ref('ca'));
    s.set('b', ref('cb'));
    s.set('c', ref('cc'));
    check('상한까지는 모두 남음', s.size() === 3, `실제 ${s.size()}`);

    s.set('d', ref('cd'));
    check('상한을 넘으면 크기가 유지됨', s.size() === 3, `실제 ${s.size()}`);
    check('가장 오래된 것이 버려짐', s.get('a') === null);
    check('나머지는 남음', s.get('b') !== null && s.get('c') !== null && s.get('d') !== null);

    // 최근 사용한 것은 살아남는다 (LRU)
    const s2 = new ConvRefStore(2);
    s2.set('a', ref('ca'));
    s2.set('b', ref('cb'));
    s2.get('a');                 // a 를 최근 사용으로 올린다
    s2.set('c', ref('cc'));
    check('최근 쓴 것은 살아남음', s2.get('a') !== null);
    check('안 쓴 것이 버려짐', s2.get('b') === null);
}

// ── 7. 잘못된 상한값으로 조용히 무력화되지 않는다 ────────────────
{
    check('상한 0 → 기본값', new ConvRefStore(0).maxEntries === DEFAULT_MAX_ENTRIES);
    check('상한 음수 → 기본값', new ConvRefStore(-5).maxEntries === DEFAULT_MAX_ENTRIES);
    check('상한 문자열 → 기본값', new ConvRefStore('abc').maxEntries === DEFAULT_MAX_ENTRIES);
    check('상한 미지정 → 기본값', new ConvRefStore().maxEntries === DEFAULT_MAX_ENTRIES);
    check('상한 숫자 문자열은 인정', new ConvRefStore('10').maxEntries === 10);
}

console.log(`\n  통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
