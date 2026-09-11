// 로그인이 풀렸을 때의 처리.
//
// 실제로 이런 문구가 사용자에게 그대로 노출됐다:
//   "수강 중인 과목을 찾지 못했습니다. PLATO 로그인 상태를 확인해주세요.
//    (fromWebService: 웹서비스 실패 (servicerequireslogin) / fromDashboard: 빈 목록)"
// 내부 실패 내역이 새어 나왔고, 미로그인을 미로그인으로 인식하지도 못했다.
import { getCourses } from '../src/core/courses.js';
import { isNotLoggedInCode } from '../src/core/http.js';
import { profileForHost, loginUrl } from '../src/config/endpoints.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(48) + (detail ?? ''));
  cond ? pass++ : fail++;
};

// --- 오류코드 판별 (문구가 아니라 코드라 언어와 무관) ---
check('servicerequireslogin', isNotLoggedInCode('servicerequireslogin'));
check('requireloginerror', isNotLoggedInCode('requireloginerror'));
check('notloggedin', isNotLoggedInCode('notloggedin'));
check('sessionerroruser', isNotLoggedInCode('sessionerroruser'));
check('invalidsesskey 는 미로그인이 아님 (갱신 대상)', !isNotLoggedInCode('invalidsesskey'));
check('모르는 코드는 미로그인이 아님', !isNotLoggedInCode('somethingelse'));

// --- 미로그인이면 다음 경로를 시도하지 않는다 ---
{
  const notLoggedIn = async () => {
    const e = new Error('PLATO에 로그인되어 있지 않습니다.');
    e.kind = 'not_logged_in';
    throw e;
  };
  let dashboardCalled = false;
  const dashboard = async () => { dashboardCalled = true; return []; };

  let caught = null;
  try {
    await getCourses({}, { providers: [notLoggedIn, dashboard] });
  } catch (err) { caught = err; }

  check('미로그인 오류를 그대로 전파', caught && caught.kind === 'not_logged_in', caught && caught.kind);
  check('  대시보드를 시도하지 않음', dashboardCalled === false);
  check('  내부 실패 내역이 메시지에 없음',
    caught && !caught.message.includes('fromWebService') && !caught.message.includes('빈 목록'),
    caught && caught.message);
}

// --- 그 외 실패는 사용자 메시지에 내부 내역을 넣지 않는다 ---
{
  const boom = async () => { throw new Error('웹서비스 실패 (someerror)'); };
  const empty = async () => [];
  let caught = null;
  try {
    await getCourses({}, { providers: [boom, empty] });
  } catch (err) { caught = err; }

  check('과목을 못 찾으면 no_courses', caught && caught.kind === 'no_courses');
  check('  메시지에 내부 내역 없음', !caught.message.includes('someerror'), caught.message);
  check('  원인은 details 에만', Array.isArray(caught.details) && caught.details.some((d) => d.includes('someerror')),
    JSON.stringify(caught.details));
}

// --- 로그인 URL ---
{
  const P = profileForHost('plato.pusan.ac.kr');
  const u = loginUrl(P);
  check('로그인 URL', u === 'https://plato.pusan.ac.kr/login/index.php?loginredirect=1', u);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
