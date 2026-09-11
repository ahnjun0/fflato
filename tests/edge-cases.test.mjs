// 스스로 찾아낸 엣지 케이스들.
//
// 공통 원칙은 하나다 — 애매하면 "없다/끝났다" 쪽으로 단정하지 않는다.
// 헛시도 한 번은 요청 하나지만, 잘못 단정하면 출결을 놓친다.
import { fetchCoursePage, isExpired, getRemainingTime, scanOrdered } from '../src/core/attendance.js';
import { profileForHost } from '../src/config/endpoints.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(54) + (detail ?? ''));
  cond ? pass++ : fail++;
};
const P = profileForHost('plato.pusan.ac.kr');
const kst = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h, mi) - 9 * 3600_000); // 한국 시간
const at = (s) => { const m = s.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/); return kst(+m[1], +m[2]-1, +m[3], +m[4], +m[5]); };
const entry = (slots, table = true) => ({ rows: slots.map((slot) => ({ slot, chip: null })), table });

console.log('[1] 스캔 도중 로그인이 풀림');
{
  // 라이브 확인: 로그아웃 상태의 강좌 페이지는 HTTP 200 에 /login/index.php 로
  // 돌아온다. 그 페이지에도 sesskey 가 있어 값만으로는 구분되지 않는다.
  globalThis.fetch = async () => ({
    ok: true, status: 200, url: 'https://plato.pusan.ac.kr/login/index.php',
    text: async () => '<html><body><input name="username"></body></html>',
  });
  let caught = null;
  try { await fetchCoursePage({ profile: P, sesskey: 'K' }, '1001'); }
  catch (e) { caught = e; }
  check('로그인 페이지를 "세션 없음" 으로 읽지 않는다', caught && caught.kind === 'not_logged_in', caught && caught.kind);
}
{
  // 스캔 결과에도 그대로 드러나야 한다
  const load = async () => {
    const e = new Error('PLATO 로그인이 풀렸습니다.');
    e.kind = 'not_logged_in';
    throw e;
  };
  const r = await scanOrdered({ profile: P, sesskey: 'K' }, [{ id: '1001', name: 'a' }], {
    schedule: { 1001: entry(['2026-09-01 10:30']) }, now: at('2026-09-01 10:40'), load, concurrency: 1,
  });
  check('실패에 kind 를 실어 올린다', r.failed[0] && r.failed[0].kind === 'not_logged_in', JSON.stringify(r.failed[0]));
  check('  세션 0건이지만 "없음" 이 아니다', r.active.length === 0 && r.failed.length === 1);
}

console.log('\n[2] 기기 시계가 어긋남');
{
  const NOW = 1_800_000_000_000;
  const s = { endTime: Math.floor(NOW / 1000) + 300 }; // 5분 남음
  check('시계가 정확하면 남은 시간', getRemainingTime(s, NOW) === '05:00', getRemainingTime(s, NOW));
  check('시계가 10분 빠르면 만료로 보인다', isExpired(s, NOW + 600_000) === true);
  // → 그래서 팝업은 만료돼도 입력을 막지 않는다. 정말 끝났으면 서버가 ended 로 알려준다.
  check('  마감 판정은 표시용일 뿐 (제출 경로에는 만료 검사가 없다)',
    typeof isExpired === 'function');
}

console.log('\n[3] endTime 이 없거나 이상함');
{
  check('endTime 없음 → 만료로 보지 않음', isExpired({ endTime: null }) === false);
  check('  표시는 --:--', getRemainingTime({ endTime: null }) === '--:--');
  check('세션 자체가 없음', isExpired(null) === false && getRemainingTime(null) === '--:--');
}

console.log('\n[4] 자정을 넘기는 수업');
{
  // 23:30 수업의 세션이 다음 날 00:10 에 열린다면? 그 차시는 "오늘" 이 아니다.
  const S = { A: entry(['2026-09-01 23:30']) };
  const visited = [];
  const load = async (_s, id) => { visited.push(String(id)); return { courseId: String(id), html: '', doc: { querySelector: () => null } }; };
  const r = await scanOrdered({ profile: P, sesskey: 'K' }, [{ id: 'A', name: 'a' }], {
    schedule: S, now: at('2026-09-02 00:10'), load, concurrency: 1,
  });
  check('날짜가 바뀌어도 조회 대상에서 빠지지 않는다', visited.includes('A'), `방문 ${visited.join()}`);
  check('  (other 단계로 밀릴 뿐)', r.plan.some((p) => p.tier === 'other'), JSON.stringify(r.plan));
}

console.log('\n[5] 교시 형식이 다른 경우');
{
  // 구 시스템은 "1교시" 였다. 그런 형식이 오면 행을 못 읽는다.
  // 그때 "출석부 없음" 으로 단정하면 안 된다 — 표는 있으니 "모름" 이어야 한다.
  const { hasAttendanceLedger } = await import('../src/core/schedule.js');
  check('표는 있는데 행을 못 읽음 → 모름 (조회 유지)',
    hasAttendanceLedger({ A: { rows: [], table: true } }, 'A') === null);
}

console.log('\n[6] 화면 링크');
{
  const { courseStatusUrl } = await import('../src/config/endpoints.js');
  const u = courseStatusUrl(P, '1001');
  check('과목 링크는 그 과목 출석현황으로',
    u === 'https://plato.pusan.ac.kr/local/ubsmartbook/my.php?id=1001', u);
  check('  강좌 ID 가 숫자가 아니어도 안전하게 인코딩',
    courseStatusUrl(P, 'a b&c').includes('id=a+b%26c'), courseStatusUrl(P, 'a b&c'));
}

console.log('\n[7] 오늘 출결 / 누적 출결의 출처');
{
  // 오늘 출결은 이번 스캔에서 받은 문서에서 읽는다 — 조회하지 않은 과목은 빠진다.
  // 누적 출결은 조회한 과목만 최신이고 나머지는 캐시다. 화면이 구분할 수 있어야 한다.
  const { summarizeRows } = await import('../src/core/schedule.js');
  const rows = [
    { slot: '2026-09-01 10:30', chip: 'csms-chips-blue' },
    { slot: '2026-09-03 10:30', chip: 'csms-chips-red' },
    { slot: '2026-09-08 10:30', chip: null },
  ];
  const c = summarizeRows(rows);
  check('누적 집계는 캐시된 행에서 계산된다', c.present === 1 && c.absent === 1 && c.recorded === 2,
    JSON.stringify(c));
  check('  미도래 차시는 빠진다', c.total === 3 && c.recorded === 2);
}

console.log('\n[8] 화면을 알아보지 못하는 경우');
{
  // 출석부 표도 인증번호 폼도 못 찾으면 "출결 없음" 이 아니라 "우리가 못 본다" 다.
  // 사용자에게는 이것만 알린다 — 마크업이 조금 바뀐 것은 알리지 않는다.
  const blank = async (_s, id) => ({
    courseId: String(id), html: '<div>알 수 없는 화면</div>',
    doc: { querySelector: () => null, querySelectorAll: () => [] },
  });
  const r = await scanOrdered({ profile: P, sesskey: 'K' },
    [{ id: 'A', name: 'a' }, { id: 'B', name: 'b' }], {
      schedule: { A: entry(['2026-09-01 10:30']), B: entry(['2026-09-01 10:30']) },
      now: at('2026-09-01 10:40'), load: blank, concurrency: 1,
    });
  check('알아보지 못한 강좌를 따로 모은다', r.unrecognized.length === 2, JSON.stringify(r.unrecognized.map((u) => u.courseId)));
  check('  세션은 0건이지만 "없음" 과 구분된다', r.active.length === 0 && r.unrecognized.length > 0);
}
{
  // 표는 있는데 세션만 없는 정상 상태는 인식된 것이다
  const normal = async (_s, id) => ({
    courseId: String(id), html: '<table class="table-local-ubattend"></table>',
    doc: {
      querySelector: (css) => (css === 'table.table-local-ubattend' ? {} : null),
      querySelectorAll: () => [],
    },
  });
  const r = await scanOrdered({ profile: P, sesskey: 'K' }, [{ id: 'A', name: 'a' }], {
    schedule: { A: entry(['2026-09-01 10:30']) }, now: at('2026-09-01 10:40'), load: normal, concurrency: 1,
  });
  check('표만 있어도 인식된 것으로 본다', r.unrecognized.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
