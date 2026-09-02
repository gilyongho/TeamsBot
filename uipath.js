//------------------------------------------------
// orchestrator.js
//------------------------------------------------

// 필요한 패키지: npm install dotenv axios
const axios = require('axios');
const { URLSearchParams } = require('url'); // Node.js 내장 모듈

// load environment variables from .env file
require('dotenv').config();

// 환경 변수 (.env 파일에서 관리)
const uipathAppId = process.env.UiPathAppId || '';
const uipathAppSecret = process.env.UiPathAppSecret || '';
const uipathBaseURL = process.env.UiPathBaseURL || 'https://cloud.uipath.com';
const uipathOrganizationName = process.env.UiPathOrganizationName || '';
const uipathTenantName = process.env.UiPathTenantName || '';
const uipathFolderId = process.env.UiPathFolderId || '';
const uipathProcessName = process.env.UiPathProcessName || '';
const uipathQueueName = process.env.UiPathQueueName || '';
// 요청 스코프.
//   기본값은 기존 동작 유지를 위해 전체 스코프다. 그러나 이 코드가 실제로 쓰는 것은
//   StartJobs · Jobs({id}) · StopJobs · Machines 뿐이므로, 자격증명 유출 시 폭발 반경을
//   줄이려면 .env 에 아래 한 줄만 넣으면 된다.
//     UiPathAuthScope="OR.Jobs OR.Jobs.Read OR.Jobs.Write OR.Machines.Read OR.Monitoring"
//   스코프를 좁히면 토큰 발급부터 실패하므로 스테이징에서 먼저 확인할 것.
const uipathAuthScope = process.env.UiPathAuthScope || 'OR.Administration OR.Administration.Read OR.Administration.Write OR.Analytics OR.Analytics.Read OR.Analytics.Write OR.Assets OR.Assets.Read OR.Assets.Write OR.Audit OR.Audit.Read OR.Audit.Write OR.AutomationSolutions.Access OR.BackgroundTasks OR.BackgroundTasks.Read OR.BackgroundTasks.Write OR.Execution OR.Execution.Read OR.Execution.Write OR.Folders OR.Folders.Read OR.Folders.Write OR.Hypervisor OR.Hypervisor.Read OR.Hypervisor.Write OR.Jobs OR.Jobs.Read OR.Jobs.Write OR.License OR.License.Read OR.License.Write OR.Machines OR.Machines.Read OR.Machines.Write OR.ML OR.ML.Read OR.ML.Write OR.Monitoring OR.Monitoring.Read OR.Monitoring.Write OR.Queues OR.Queues.Read OR.Queues.Write OR.Robots OR.Robots.Read OR.Robots.Write OR.Settings OR.Settings.Read OR.Settings.Write OR.Tasks OR.Tasks.Read OR.Tasks.Write OR.TestDataQueues OR.TestDataQueues.Read OR.TestDataQueues.Write OR.TestSetExecutions OR.TestSetExecutions.Read OR.TestSetExecutions.Write OR.TestSets OR.TestSets.Read OR.TestSets.Write OR.TestSetSchedules OR.TestSetSchedules.Read OR.TestSetSchedules.Write OR.Users OR.Users.Read OR.Users.Write OR.Webhooks OR.Webhooks.Read OR.Webhooks.Write';
//const uipathAuthScope = 'OR.Jobs OR.Machines OR.Monitoring';
const uipathASRobotName = process.env.UiPathASRobotName || '[Default] Automation Suite Robot';
const longNameLength = process.env.LongNameLength || 36;

// Orchestrator OData 의 기본 경로.
//
//   정규 구조는  {도메인}/{org}/{tenant}/{service}/odata/...  이고
//   {service} 는 orchestrator_ · dataservice_ 처럼 서비스를 가리킨다.
//
//   그런데 이 배포(as.lgcnsrpa.com)는 {service} 없이도 Orchestrator 로 라우팅한다.
//   2026-09-02 확인 결과:
//
//     /innotek/DefaultTenant/odata/Jobs                    → 401  (도달, 인증만 없음)
//     /innotek/DefaultTenant/orchestrator_/odata/Jobs      → 401  (동일)
//     /innotek/DefaultTenant/bogus_/odata/Jobs             → 302  (미인식 서비스 → 포털)
//     /innotek/DefaultTenant/orchestrator_/odata/NoSuchEntity → 404
//
//   bogus_ 가 401 이 아니라 302 이므로 인증 게이트가 앞단에 있는 것이 아니다.
//   즉 위 401 은 "경로가 유효하다"는 신호이고, 두 형태 모두 실제로 유효하다.
//   운영에서도 {service} 없는 형태로 StartJobs 가 201 을 받는다(8/31 로그).
//
//   기본값을 '' 로 두는 이유: 운영 중인 시스템의 URL 5개를 한꺼번에 바꾸지 않기
//   위해서다. 정규 형태로 가려면 스테이징에서 확인한 뒤 .env 에 한 줄만 넣으면 된다.
//     UiPathOrchestratorPath="orchestrator_"
//   플랫폼 업그레이드로 {service} 없는 형태가 막히면 같은 한 줄로 복구된다.
const uipathOrchestratorPath = process.env.UiPathOrchestratorPath || '';

// HTTP 타임아웃.
//   axios 기본값은 0(무한 대기)이다. TCP 는 붙었는데 응답이 오지 않는 상태
//   (ingress 장애·failover·half-open NAT)에서 프라미스가 영원히 settle 되지 않으면
//   tryProcessRun 의 finally 가 실행되지 않아 스케줄러가 통째로 잠긴다.
const uipathHttpTimeout = (() => {
    const n = Number(process.env.UiPathHttpTimeoutMs);
    // '0' 은 truthy 문자열이라 || 로는 걸러지지 않고, axios 에서 0 은 "무한 대기"다.
    // 오타는 NaN 이 되어 역시 무한 대기가 된다. 둘 다 이 상수의 존재 이유를 무력화한다.
    if (!Number.isFinite(n) || n < 1000) {
        if (process.env.UiPathHttpTimeoutMs !== undefined) {
            console.error(
                `⚠️ UiPathHttpTimeoutMs='${process.env.UiPathHttpTimeoutMs}' 은(는) 유효하지 않습니다. ` +
                `기본값 15000 을 사용합니다.`);
        }
        return 15000;
    }
    return n;
})();

// {base}/{org}/{tenant}[/{orchestratorPath}]
function odataBase() {
    const prefix = `${uipathBaseURL}/${uipathOrganizationName}/${uipathTenantName}`;
    return uipathOrchestratorPath ? `${prefix}/${uipathOrchestratorPath}` : prefix;
}

// 모듈 내부 토큰 캐시 (getAccessToken 호출 시 자동 갱신됨)
let cachedTokenObj = null;

// UiPath 인증 토큰 가져오기 함수
async function getAccessToken() {

    const params = new URLSearchParams();
    // URLSearchParams 객체를 data로 전달하면,
    // axios가 자동으로 'Content-Type': 'application/x-www-form-urlencoded' 헤더를 설정해준다.
    //params.append('Content-Type', 'application/x-www-form-urlencoded');
    params.append('grant_type', 'client_credentials');
    params.append('client_id', uipathAppId);
    params.append('client_secret', uipathAppSecret);
    params.append('scope', uipathAuthScope);

    const apiUrl = uipathBaseURL + '/identity_/connect/token';

    try {

        console.log(`\n[${new Date().toLocaleString()}] UiPath 인증 토큰 요청 중...`);

        const response = await axios.post(apiUrl, params, { timeout: uipathHttpTimeout });

        const accessToken = response.data.access_token;
        const expiresIn = response.data.expires_in; // 만료 시간(초)
        const tokenType = response.data.token_type; // (e.g., "Bearer")

        console.log(`[${new Date().toLocaleString()}] ✅ UiPath 인증 토큰 가져오기 성공:`);
        console.log(`   - Token Type: ${tokenType}`);
        console.log(`   - Expires In: ${expiresIn} 초`);

        cachedTokenObj = {
            token: accessToken,
            expiry: expiresIn
        };
        return cachedTokenObj;

    } catch (error) {

        console.error(`[${new Date().toLocaleString()}] ❌ UiPath 인증 토큰 가져오기 실패:`);

        if (error.response) {
            // 서버가 에러 응답을 반환한 경우 (e.g., 400, 401, 403)
            console.error(`   - Status: ${error.response.status}`);
            console.error(`   - Error: ${error.response.data.error}`);
            console.error(`   - Description: ${error.response.data.error_description}`);
        } else if (error.request) {
            // 요청이 전송되었으나 응답을 받지 못한 경우 (네트워크 오류 등)
            console.error('   - Error: No response received from UiPath Identity Server.');
        } else {
            // 요청 설정 중 오류가 발생한 경우
            console.error(`   - Error: ${error.message}`);
        }

        return null;
    }
}

// UiPath 프로세스 실행 함수
// job id를 반환한다.
async function runProcess(token, inputArguments) {

    if (!token) {
        console.error(`[${new Date().toLocaleString()}] UiPath 인증 토큰이 없습니다. 프로세스를 실행할 수 없습니다.`);
        return null;
    }

    const apiUrl = `${odataBase()}/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs`;

    const jobPayload = {
        startInfo: {
            'ReleaseName': uipathProcessName,
            'Strategy': 'JobsCount',
            'JobsCount': 1,
            'InputArguments': JSON.stringify(inputArguments)
        }
    };

    try {

        const response = await axios.post(apiUrl, jobPayload, {
            timeout: uipathHttpTimeout,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-UIPATH-OrganizationUnitId': uipathFolderId
            }
        });

        console.log(`[${new Date().toLocaleString()}] ✅ UiPath 프로세스 실행 성공.`);
        console.log(`   - Status: ${response.status}`);
        console.log(`   - Job ID: ${response.data.value[0].Id}`);
        return response.data.value[0].Id;

    } catch (error) {

        console.error(`[${new Date().toLocaleString()}] ❌ UiPath 프로세스 실행 실패:`);

        if (error.response) {
            // 서버가 에러 응답을 반환한 경우 (e.g., 400, 401, 403)
            console.error(`   - Status: ${error.response.status}`);
            console.error(`   - Data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            // 요청이 전송되었으나 응답을 받지 못한 경우 (네트워크 오류 등)
            console.error('   - Error: No response received from UiPath API.');
        } else {
            // 요청 설정 중 오류가 발생한 경우
            console.error(`   - Error: ${error.message}`);
        }

        return null;
    }
}

// 가용한 런타임 수를 반환한다. (총 Unattended 슬롯 - UsedRuntimes)
//
// [D-7] 주의 — 현재 호출부가 없다 (커밋 312ff30에서 런타임 검사 제거).
//   아래 두 조회의 범위가 서로 다르다:
//     - Machines 조회: 폴더 헤더 없음 → 테넌트 범위의 UnattendedSlots
//     - Jobs 조회    : 폴더 헤더 있음 → 폴더 범위의 Running Job
//   분모는 테넌트, 분자는 폴더이므로 다른 폴더가 같은 머신을 쓰면 가용량이
//   과대 산정된다. 또한 사용량 판별이 HostMachineName 길이(LongNameLength)
//   휴리스틱이라 머신 이름 규칙이 바뀌면 조용히 오작동한다.
//   재사용하기 전에 MachineId 기준 필터로 교체할 것.
async function getAvailableRuntimes(token) {

    if (!token) {
        console.error(`[${new Date().toLocaleString()}] UiPath 인증 토큰이 없습니다. 로봇 가용 여부를 확인할 수 없습니다.`);
        return 0;
    }

    try {
        // 특정 머신의 Total Runtimes 조회

        const machineUrl = `${odataBase()}/odata/Machines`;
        const machineRes = await axios.get(machineUrl, {
            timeout: uipathHttpTimeout,
            params: {
                $filter: `Name eq '${uipathASRobotName}'`
            },
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        const machineData = machineRes.data;
        //console.log(machineData);

        if (!machineData.value || machineData.value.length === 0) {
            console.error(`'${uipathASRobotName}' not found!`);
            return 0;
        }

        const machine = machineData.value[0];
        const machineId = machine.Id;
        const totalRuntimes = machine.UnattendedSlots || 0;

        console.log(`Total Runtimes=${totalRuntimes}`);

        // 해당 머신에서 실행 중인 job 수 조회

        const jobsUrl = `${odataBase()}/odata/Jobs`;
        const jobsRes = await axios.get(jobsUrl, {
            timeout: uipathHttpTimeout,
            params: {
                //$filter: `State eq 'Running' and HostMachineName eq ${MACHINE_NAME}`
                $filter: `State eq 'Running'`,
                $select: 'Id,State,HostMachineName'
            },
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-UIPATH-OrganizationUnitId': uipathFolderId
            }
        });
        const jobsData = jobsRes.data;
        //console.log(jobsData);

        const longNameJobs = (jobsData.value || []).filter(j => (j.HostMachineName ?? '').length >= longNameLength);
        const runtimesInUse = longNameJobs.length;
        console.log(`Running jobs (licenses in use): ${runtimesInUse}`);

        const availableRuntimes = totalRuntimes - runtimesInUse;
        console.log(`Available Runtimes            : ${availableRuntimes}`);

        return availableRuntimes;

    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] ❌ 로봇 가용 여부 확인 실패:`);
        if (error.response) {
            console.error(`   - Status: ${error.response.status}`);
            console.error(`   - Data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            console.error('   - Error: No response received from UiPath API.');
        } else {
            console.error(`   - Error: ${error.message}`);
        }
        return 0;
    }
}

// job의 상태를 반환한다.
// Pending, Running, Stopping, Terminating, Faulted, Successful, Stopped, Suspended, Resumed
async function getJobState(token, jobId) {

    if (!token) {
        console.error('UiPath 인증 토큰이 없습니다. Job 상태를 확인할 수 없습니다.');
        return null;
    }

    const apiUrl = `${odataBase()}/odata/Jobs(${jobId})`;

    try {
        const response = await axios.get(apiUrl, {
            timeout: uipathHttpTimeout,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-UIPATH-OrganizationUnitId': uipathFolderId
            }
        });

        const state = response.data.State;
        console.log(`[${new Date().toLocaleString()}] Job ${jobId} 상태: ${state}`);
        return state;

    } catch (error) {
        console.error(`❌ Job ${jobId} 상태 확인 실패:`);
        if (error.response) {
            console.error(`   - Status: ${error.response.status}`);
            console.error(`   - Data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            console.error('   - Error: No response received from UiPath API.');
        } else {
            console.error(`   - Error: ${error.message}`);
        }
        return null;
    }
}

// [D-15] job을 중지시킨다.
//
//   POST /odata/Jobs/UiPath.Server.Configuration.OData.StopJobs
//   body { "jobIds": [<id>], "strategy": "Kill" }
//
//   컬렉션 레벨의 벌크 액션이다. 키 지정 형태(Jobs({id})/...StopJob)는 문서에 없다.
//   위의 runProcess() 가 쓰는 StartJobs 와 같은 모양이다.
//   strategy 허용값: "SoftStop" | "1" | "Kill" | "2"
//
//   SoftStop 은 프로세스가 Should Stop 지점에 도달해야 멈추고 Successful 로 간다.
//   대화형 에이전트는 사용자 입력을 기다리는 동안 그 지점에 도달하지 못할 수 있어
//   Kill 을 기본값으로 둔다. Kill 은 Terminating 을 거쳐 Stopped 로 간다.
//
//   참고: https://docs.uipath.com/orchestrator/automation-cloud/latest/api-guide/jobs-requests
async function stopJob(token, jobId, strategy = 'Kill') {

    if (!token) {
        console.error(`[${new Date().toLocaleString()}] UiPath 인증 토큰이 없습니다. Job을 중지할 수 없습니다.`);
        return false;
    }

    const apiUrl = `${odataBase()}/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs`;

    // jobIds 는 숫자 배열이다. runProcess 가 반환하는 Id 를 그대로 넘기되 숫자로 맞춘다.
    const payload = { jobIds: [Number(jobId)], strategy: strategy };

    try {
        await axios.post(apiUrl, payload, {
            timeout: uipathHttpTimeout,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-UIPATH-OrganizationUnitId': uipathFolderId
            }
        });

        console.log(`[${new Date().toLocaleString()}] ✅ Job ${jobId} 중지 요청 성공 (${strategy}).`);
        return true;

    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] ❌ Job ${jobId} 중지 실패:`);
        if (error.response) {
            console.error(`   - Status: ${error.response.status}`);
            console.error(`   - Data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            console.error('   - Error: No response received from UiPath API.');
        } else {
            console.error(`   - Error: ${error.message}`);
        }
        return false;
    }
}

module.exports = {
    getAccessToken,
    runProcess,
    getAvailableRuntimes,
    getJobState,
    stopJob
};
