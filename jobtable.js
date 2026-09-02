//------------------------------------------------
// jobtable.js
//------------------------------------------------

// Any user can run only one job at a time
class JobTable {
    constructor() {
        this.jobs = new Map();
    }

    setJob(userId, jobId) {
        this.jobs.set(userId, jobId);
    }

    getJob(userId) {
        if (this.jobs.has(userId)) {
            return this.jobs.get(userId);
        } else {
            return null;
        }
    }

    hasJob(userId) {
        return this.jobs.has(userId);
    }

    // [D-4] job이 종료된 뒤 항목을 제거한다.
    // 제거하지 않으면 매 요청마다 불필요한 getJobState 호출이 발생하고,
    // 그 호출이 실패했을 때 중복 실행 위험이 생긴다.
    deleteJob(userId) {
        return this.jobs.delete(userId);
    }

    // [D-4] 누적 여부를 관찰하기 위한 헬퍼
    size() {
        return this.jobs.size;
    }
}

const table = new JobTable();

module.exports = {
    table
};
