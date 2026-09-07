//------------------------------------------------
// outboundcontext.js
//
// 봇이 /api/sendMessage 로 먼저 말을 건 사용자를 기록한다.
//
// 왜 필요한가
//   J-7 은 "진행 중인 세션이 없는 일반 메시지"를 webhook 으로 보내지 않고 시작 안내(M8)
//   로 돌린다. 그 전제는 "이 메시지를 소비할 주체가 없다" 인데, 판정 기준이
//   jobtable(= 봇이 Orchestrator 에 띄운 Job)뿐이라 한 경우를 놓친다.
//
//   외부 시스템이 /api/sendMessage 로 대화를 시작하고 사용자 답변을 webhook 으로 받는
//   구성에서는, 그 시스템이 바로 답변을 기다리는 소비자다. jobtable 에는 없지만 맥락은
//   있다. 그 사용자의 답변을 M8 로 흡수하면 외부 시스템은 영원히 대기한다.
//
// 왜 jobtable 에 넣지 않는가
//   jobtable 은 userId → jobId 이고, D-8 / D-15 가 그 jobId 로 Orchestrator 에 상태를
//   조회하거나 StopJobs 를 던진다. 가짜 항목을 넣으면 그 로직이 존재하지 않는 Job 을
//   조회하게 되어 깨진다. 표를 분리해 두는 것이 맞다.
//
// 왜 설정 스위치가 아닌가
//   이 표는 /api/sendMessage 를 실제로 호출한 사용자만 담는다. 그 API 를 쓰지 않는
//   배포에서는 표가 항상 비어 있으므로 판정이 기존과 완전히 동일하다. 고객별로
//   켜고 끌 필요가 없다 — 기능을 쓰면 켜지고 안 쓰면 안 켜진다.
//
// 한계 (README 에도 기록)
//   - 프로세스 안의 Map 이므로 재기동하면 사라진다. jobtable 도 같은 성질이다.
//   - TTL 이 지난 뒤 도착한 답변은 다시 M8 로 흡수된다.
//   - 표가 살아 있는 동안에는 그 사용자의 무관한 메시지도 webhook 으로 나간다.
//     J-7 이전 동작으로 돌아가는 것이며, 창은 TTL 로 제한된다.
//------------------------------------------------

const DEFAULT_TTL_MS = 600000;   // 10분

class OutboundContext {
    constructor(ttlMs = DEFAULT_TTL_MS) {
        this.ttlMs = ttlMs;
        this.seen = new Map();   // userId → 마지막 발송 시각(ms)
    }

    // 유효한 TTL 만 받는다. 잘못된 값으로 표가 즉시 만료되거나 영구 보존되면
    // 판정이 조용히 뒤집히므로, 호출부(numEnv)와 여기 두 곳에서 막는다.
    configure(ttlMs) {
        if (Number.isFinite(ttlMs) && ttlMs > 0) {
            this.ttlMs = ttlMs;
        }
        return this.ttlMs;
    }

    mark(userId) {
        if (!userId) {
            return false;
        }
        this.seen.set(userId, Date.now());
        return true;
    }

    has(userId) {
        if (!userId) {
            return false;
        }
        const at = this.seen.get(userId);
        if (at === undefined) {
            return false;
        }
        if (Date.now() - at > this.ttlMs) {
            this.seen.delete(userId);   // 읽는 김에 정리한다
            return false;
        }
        return true;
    }

    // 다시 읽히지 않는 항목은 has() 로 정리되지 않는다. 주기적으로 비운다.
    // 타이머는 이 모듈에 두지 않는다 — 테스트가 그 타이머에 붙잡히지 않도록,
    // 호출 주기는 teamsapp.js 가 정한다.
    sweep() {
        const now = Date.now();
        let removed = 0;
        for (const [userId, at] of this.seen) {
            if (now - at > this.ttlMs) {
                this.seen.delete(userId);
                removed += 1;
            }
        }
        return removed;
    }

    // 누적 여부를 관찰하기 위한 헬퍼 (jobtable.size() 와 같은 목적)
    size() {
        return this.seen.size;
    }
}

const context = new OutboundContext();

module.exports = {
    OutboundContext,
    context,
    DEFAULT_TTL_MS
};
