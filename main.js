//------------------------------------------------
// main.js
//------------------------------------------------

// [D-5] 전역 예외 핸들러
//   require 보다 먼저 등록해야 모듈 로드 중 발생한 예외까지 잡을 수 있다.
//   (teamsapp.js 와 msgqueue.js 는 로드 시점에 cert.pem/key.pem 을 읽고
//    HTTPS 서버를 기동한다)
//
//   기존에는 핸들러가 없어 비동기 예외가 로그 없이 사라졌다.
//   systemd Restart=on-failure 가 재시작은 하지만 원인이 남지 않았다.
process.on('unhandledRejection', (reason) => {
    console.error(`[${new Date().toLocaleString()}] ❌ Unhandled Rejection`);
    console.error(`   - Reason: ${reason instanceof Error ? reason.stack : reason}`);
});

process.on('uncaughtException', (error) => {
    console.error(`[${new Date().toLocaleString()}] ❌ Uncaught Exception`);
    console.error(`   - ${error.stack || error}`);
    // 상태가 오염됐을 수 있으므로 종료하고 systemd 재시작에 맡긴다.
    process.exit(1);
});

process.on('SIGTERM', () => {
    console.log(`[${new Date().toLocaleString()}] SIGTERM 수신. 종료합니다.`);
    process.exit(0);
});

// 모듈 불러오기
const UIPATH = require('./uipath');
const TEAMSAPP = require('./teamsapp');
const MSGQUEUE = require('./msgqueue');
const PROCQUEUE = require('./procqueue')
const JOBTABLE = require('./jobtable')
