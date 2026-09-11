//------------------------------------------------
// convrefstore.js
//
// 사용자(AAD Object ID)별 대화 참조(conversationReference)를 보관한다.
//
// 왜 필요한가
//   종전에는 발송할 때마다 ConnectorClient.conversations.createConversation() 을
//   호출해 대화를 새로 만들고, 그 결과로 얻은 참조를 지역 변수에 담아 한 번 쓰고
//   버렸다. Microsoft 의 proactive 메시지 문서는 그 반대를 권장한다 — 대화는 한 번만
//   만들고, 얻은 conversationId 를 보관해 이후 발송에 재사용하라.
//
//   또한 관측된 403 "Bot is not installed in user's personal scope" 는
//   createConversation 단계의 응답이다. 보관한 참조로 보내는 경로는 그 단계를
//   지나지 않는다. 이 저장소는 그 경로를 가능하게 하기 위한 것이다.
//
// 설계 원칙
//   1. 재사용이 실패하면 즉시 버리고 createConversation 으로 되돌아간다.
//      참조는 serviceUrl 변경·대화 삭제 등으로 오래되면 쓸 수 없게 되는데,
//      그때 발송이 통째로 실패하면 종전보다 나빠진다. 반드시 폴백이 있어야 한다.
//   2. 메모리에만 둔다. 재시작하면 비고, 비면 종전 동작(createConversation)으로
//      돌아간다. 즉 이 표가 없어도 기능이 깨지지 않는다.
//   3. 무한히 자라지 않는다. 상한을 넘으면 가장 오래 쓰지 않은 것부터 버린다.
//      버려도 폴백이 있으므로 손실은 호출 한 번뿐이다.
//
// 이 모듈은 네트워크·파일·타이머를 쓰지 않는다. 단위 테스트가 사전 준비 없이
// 돌 수 있어야 하기 때문이다. (test/convrefstore.smoke.js)
//------------------------------------------------

// 상한. 알림 대상이 131명 규모이므로 넉넉하다. 넘으면 LRU 로 버린다.
const DEFAULT_MAX_ENTRIES = 5000;

// 참조가 발송에 쓸 수 있는 모양인지 본다.
//   불완전한 참조를 보관하면 재사용 때마다 실패하고 폴백해서, 호출이 두 배가 되고
//   로그만 지저분해진다. 담기 전에 거른다.
function isUsable(ref) {
    return !!(ref
        && typeof ref === 'object'
        && ref.serviceUrl
        && ref.conversation
        && ref.conversation.id
        && ref.bot
        && ref.bot.id);
}

class ConvRefStore {
    constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
        const n = Number(maxEntries);
        this.maxEntries = (Number.isFinite(n) && n >= 1) ? Math.floor(n) : DEFAULT_MAX_ENTRIES;
        // Map 은 삽입 순서를 유지한다. get() 에서 재삽입해 LRU 로 쓴다.
        this.map = new Map();
    }

    // 보관한다. 담을 수 없는 모양이면 false.
    set(userId, ref) {
        if (!userId || typeof userId !== 'string') return false;
        if (!isUsable(ref)) return false;

        // 이미 있으면 지웠다가 다시 넣어 순서를 갱신한다.
        if (this.map.has(userId)) this.map.delete(userId);
        this.map.set(userId, ref);

        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
        return true;
    }

    // 꺼낸다. 없으면 null. 꺼내면 최근 사용으로 올린다.
    get(userId) {
        if (!userId || typeof userId !== 'string') return null;
        const ref = this.map.get(userId);
        if (!ref) return null;
        this.map.delete(userId);
        this.map.set(userId, ref);
        return ref;
    }

    has(userId) {
        return !!(userId && typeof userId === 'string' && this.map.has(userId));
    }

    // 버린다. 재사용이 실패했을 때 호출한다.
    delete(userId) {
        if (!userId || typeof userId !== 'string') return false;
        return this.map.delete(userId);
    }

    size() {
        return this.map.size;
    }

    clear() {
        this.map.clear();
    }
}

module.exports = {
    ConvRefStore,
    DEFAULT_MAX_ENTRIES,
    isUsable,
    // 프로세스 전역 인스턴스. teamsapp.js 가 이것을 쓴다.
    store: new ConvRefStore()
};
