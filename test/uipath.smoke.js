//------------------------------------------------
// test/uipath.smoke.js
//
// stopJob() 이 문서대로 요청을 만드는지 고정한다.
//   POST /odata/Jobs/UiPath.Server.Configuration.OData.StopJobs
//   body { "jobIds": [<number>], "strategy": "Kill" }
//
// 초판에서 키 지정 형태(Jobs({id})/...StopJob)로 잘못 구현했고 배포했다면
// 404 였다. 이 테스트가 그 회귀를 막는다.
//
// 참고: https://docs.uipath.com/orchestrator/automation-cloud/latest/api-guide/jobs-requests
//------------------------------------------------

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
process.env.UiPathBaseURL = 'https://cloud.uipath.com';
process.env.UiPathOrganizationName = 'myorg';
process.env.UiPathTenantName = 'mytenant';
process.env.UiPathFolderId = '999';

let captured = null;
let shouldFail = false;
const axiosMock = {
    post: (url, data, cfg) => {
        captured = { url, data, cfg };
        return shouldFail
            ? Promise.reject({ response: { status: 404, data: { message: 'not found' } } })
            : Promise.resolve({ status: 200 });
    },
    get: () => getBehaviour()
};
// getJobState 검증용. 기본은 Running.
let getBehaviour = () => Promise.resolve({ data: { State: 'Running' } });

const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'axios') return axiosMock;
    return realLoad.apply(this, arguments);
};

const UIPATH = require(path.join(ROOT, 'uipath.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  ✅', name); }
    else { fail++; console.log('  ❌', name, detail); }
};

(async () => {
    console.log('\n[1] stopJob 요청 형식이 문서와 일치');
    const ok = await UIPATH.stopJob('tok', 32867);
    check('true 반환', ok === true);
    check('경로가 컬렉션 레벨 StopJobs',
        captured.url.endsWith('/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs'),
        captured.url);
    check('키 지정 형태(Jobs(id)/StopJob)가 아님',
        !/Jobs\(\d+\)/.test(captured.url), captured.url);
    check('body.jobIds 가 숫자 배열',
        Array.isArray(captured.data.jobIds)
        && captured.data.jobIds.length === 1
        && captured.data.jobIds[0] === 32867
        && typeof captured.data.jobIds[0] === 'number',
        JSON.stringify(captured.data));
    check('strategy 기본값이 Kill', captured.data.strategy === 'Kill');
    check('폴더 헤더 포함',
        captured.cfg.headers['X-UIPATH-OrganizationUnitId'] === '999',
        JSON.stringify(captured.cfg.headers));
    check('Authorization 헤더 포함',
        captured.cfg.headers['Authorization'] === 'Bearer tok');

    console.log('\n[2] strategy 는 SoftStop 으로도 지정 가능');
    await UIPATH.stopJob('tok', 100, 'SoftStop');
    check('전달한 값이 그대로 실림', captured.data.strategy === 'SoftStop');

    console.log('\n[3] 토큰이 없으면 호출하지 않고 false');
    captured = null;
    const noTok = await UIPATH.stopJob(null, 100);
    check('false 반환', noTok === false);
    check('HTTP 호출 없음', captured === null);

    console.log('\n[4] 실패 시 false 반환 (예외를 던지지 않음)');
    shouldFail = true;
    const failed = await UIPATH.stopJob('tok', 100);
    check('false 반환', failed === false);

    console.log('\n[5] odataBase — 기본값은 현재 운영 경로를 그대로 유지');
    captured = null; shouldFail = false;
    await UIPATH.stopJob('tok', 1);
    check('orchestrator_ 세그먼트 없음 (운영 현행)',
        captured.url === 'https://cloud.uipath.com/myorg/mytenant'
                       + '/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs',
        captured.url);

    console.log('\n[6] 모든 HTTP 호출에 타임아웃이 설정됨');
    captured = null; shouldFail = false;
    await UIPATH.stopJob('tok', 1);
    check('stopJob 에 timeout', typeof captured.cfg.timeout === 'number' && captured.cfg.timeout > 0,
        JSON.stringify(captured.cfg.timeout));
    {
        const src = require('fs').readFileSync(path.join(ROOT, 'uipath.js'), 'utf8');
        const calls = (src.match(/axios\.(post|get)\(/g) || []).length;
        const timeouts = (src.match(/timeout: uipathHttpTimeout/g) || []).length;
        check(`axios 호출 ${calls}건 전부에 timeout (${timeouts}건)`, calls === timeouts,
            `호출 ${calls} / timeout ${timeouts}`);
    }

    // getJobState 가 "그런 Job 없음(404)" 과 "물어보지 못함(5xx·타임아웃)" 을 구분해야 한다.
    //   이 둘을 뭉뚱그리면 호출부가 이전 Job 의 생사를 모르는 채 새 Job 을 띄우게 되고,
    //   한 대화에 에이전트가 둘 붙는다 — 이번 장애와 같은 종류의 고장이다.
    console.log('\n[7] getJobState — 404 와 조회 실패를 구분');

    getBehaviour = () => Promise.resolve({ data: { State: 'Running' } });
    check('정상 응답은 상태 문자열', await UIPATH.getJobState('tok', 1) === 'Running');

    getBehaviour = () => Promise.reject({ response: { status: 404, data: {} } });
    check('404 는 JOB_NOT_FOUND (null 아님)',
        await UIPATH.getJobState('tok', 1) === UIPATH.JOB_NOT_FOUND);

    getBehaviour = () => Promise.reject({ response: { status: 500, data: {} } });
    check('5xx 는 null (알 수 없음)', await UIPATH.getJobState('tok', 1) === null);

    getBehaviour = () => Promise.reject({ request: {}, message: 'timeout' });
    check('타임아웃은 null (알 수 없음)', await UIPATH.getJobState('tok', 1) === null);

    check('JOB_NOT_FOUND 가 실제 Job 상태값과 겹치지 않음',
        !['Pending', 'Running', 'Stopping', 'Terminating', 'Suspended', 'Resumed',
          'Successful', 'Faulted', 'Stopped'].includes(UIPATH.JOB_NOT_FOUND),
        UIPATH.JOB_NOT_FOUND);

    console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
    process.exit(fail ? 1 : 0);
})();
