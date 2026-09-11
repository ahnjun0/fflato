// scanOrdered 가 "필터가 아니라 순서" 라는 성질을 고정한다.
// 보강 시나리오에서 절대 놓치지 않는지가 핵심이다.
import { scanOrdered } from '../src/core/attendance.js';
import { clearAttended, markAttended } from '../src/core/attended.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(50) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const PROFILE = { id: 'v2', base: 'https://x', paths: {}, typeParam: 'coursemostype', actions: {} };
const session = { profile: PROFILE, sesskey: 'K' };

// 화/목 수업 두 개, 수요일 수업 하나
const row = (slot) => ({ slot, status: '-', chip: null });
// 캐시 항목은 { rows, table } 이다. table=false 만 "출석부 없음" 의 근거가 된다.
const entry = (slots, table = true) => ({ rows: slots.map(row), table });
const SCHEDULE = {
  A: entry(['2026-09-01 10:30', '2026-09-03 10:30']),
  B: entry(['2026-09-01 09:00', '2026-09-03 09:00']),
  C: entry(['2026-09-02 15:00']),
};
const COURSES = ['A', 'B', 'C'].map((id) => ({ id, name: id }));
const kst = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h, mi) - 9 * 3600_000); // 한국 시간
const at = (s) => { const m = s.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/); return kst(+m[1], +m[2]-1, +m[3], +m[4], +m[5]); };

// openIn 에 지정한 강좌에서만 세션이 열려 있는 가짜 페이지.
// 실제 저장본(2026-09-02)의 구조를 그대로 흉내낸다 — tests/real-session.test.mjs 참고.
const openHtml = (courseId) => `
  <form id="sb-smart-answer-form"><input id="sb-smart-answer-key"></form>
  <script>
    var endtime = 1788327638;
    $.post(M.cfg.wwwroot + '/local/ubsmartbook/action.php',
      { id: ${courseId}, action: 'smartanswer', sesskey: M.cfg.sesskey, smartid: 12345, authkey: authkey })
  </script>`;
const makeLoad = (openIn, visited) => async (_s, courseId) => {
  visited.push(String(courseId));
  const isOpen = String(courseId) === openIn;
  const html = isOpen ? openHtml(courseId) : '<div>진행 중인 자동출결 없음</div>';
  return {
    courseId: String(courseId),
    html,
    doc: { querySelector: (css) => (isOpen && css === '#sb-smart-answer-form' ? { tagName: 'FORM' } : null) },
  };
};

const run = async (openIn, when) => {
  const visited = [];
  const r = await scanOrdered(session, COURSES, {
    schedule: SCHEDULE, now: at(when), load: makeLoad(openIn, visited), concurrency: 1,
  });
  return { visited, found: r.active.map((a) => a.courseId), plan: r.plan, requests: r.requestCount };
};

await clearAttended();

// --- 정상: 수업 중인 과목에서 열림 ---
{
  const { visited, found } = await run('A', '2026-09-01 10:40');
  check('수업 중 과목에서 열리면 첫 요청에 발견', found.join() === 'A' && visited[0] === 'A', `방문 ${visited.join('>')}`);
  check('찾으면 나머지는 보지 않음', visited.length <= 2, `${visited.length}회`);
}

// --- 보강 1: 수업이 아예 없는 날(토요일) ---
{
  const { visited, found } = await run('A', '2026-09-05 14:00');
  check('토요일 보강도 발견', found.join() === 'A', `찾음 ${found.join()}`);
  check('  → other 단계까지 진행', visited.includes('A'), `방문 ${visited.join('>')}`);
}

// --- 보강 2: 다른 요일 (화요일 수업 A 를 수요일에) ---
{
  const { visited, found } = await run('A', '2026-09-02 15:10');
  check('다른 요일 보강도 발견', found.join() === 'A', `찾음 ${found.join()}`);
  check('  → 수업 중인 C 를 먼저 보고 A 로 넘어감', visited[0] === 'C' && visited.includes('A'), `방문 ${visited.join('>')}`);
}

// --- 보강 3: 시간표에 없는 과목 ---
{
  const visited = [];
  const r = await scanOrdered(session, [...COURSES, { id: 'D', name: 'D' }], {
    schedule: SCHEDULE, now: at('2026-09-05 14:00'), load: makeLoad('D', visited), concurrency: 1,
  });
  check('시간표를 모르는 과목은 가장 먼저', visited[0] === 'D', `방문 ${visited.join('>')}`);
  check('  → 발견', r.active.map((a) => a.courseId).join() === 'D');
}

// --- 아무 데도 안 열려 있으면 전부 커버 ---
{
  const { visited, found } = await run('없음', '2026-09-01 10:40');
  check('세션이 없으면 전 과목을 다 봄', visited.sort().join() === 'A,B,C', `방문 ${visited.join('>')}`);
  check('  → 발견 0건', found.length === 0);
}

// --- 출석을 마쳐도 계속 조회한다 (다회차 대응) ---
// 구 시스템 실측: 한 차시에 자동출결이 2회 열렸고, 1회차 미응답 + 2회차 응답
// → 최종 지각. 1회차를 출석했다고 그 과목을 그만 보면 2회차를 놓친다.
{
  await markAttended('A', '2026-09-01 10:30', undefined, { verified: true });
  const { visited } = await run('없음', '2026-09-01 10:40');
  check('출석이 확인된 과목도 계속 조회', visited.includes('A'), `방문 ${visited.join('>')}`);
  check('  → 나머지도 정상 조회', visited.sort().join() === 'A,B,C');
  await clearAttended();
}
{
  // 2회차가 열리면 발견해야 한다
  await markAttended('A', '2026-09-01 10:30', undefined, { verified: true });
  const visited = [];
  const r = await scanOrdered(session, [{ id: 'A', name: 'A' }], {
    schedule: { A: entry(['2026-09-01 10:30']) },
    now: at('2026-09-01 11:30'), load: makeLoad('A', visited), concurrency: 1,
  });
  check('같은 차시의 2회차 세션을 발견', r.active.length === 1, `발견 ${r.active.length}건`);
  await clearAttended();
}

// --- 출석부가 없는 강좌는 조회하지 않는다 ---
// 자율강좌는 ubsmartbook/my.php 에 출결 표 자체가 없다(실측). 한 번 받아 본
// 결과가 빈 배열로 남으므로 그걸로 제외한다. 이름 규칙에 기대지 않는다.
{
  const S = { A: entry(['2026-09-01 10:30']), Z: entry([], false) };  // Z = 표 자체가 없음
  const visited = [];
  const r = await scanOrdered(session, [{ id: 'A', name: 'A' }, { id: 'Z', name: '자율강좌' }], {
    schedule: S, now: at('2026-09-01 10:40'), load: makeLoad('없음', visited), concurrency: 1,
  });
  check('출석부 없는 강좌는 요청하지 않음', !visited.includes('Z'), `방문 ${visited.join('>')}`);
  check('  → 그 이유를 따로 보고', r.skippedNoLedger.join() === 'Z', r.skippedNoLedger.join());
  check('  → 나머지는 정상 조회', visited.includes('A'));
}
{
  // 아직 받아 보지 않은 강좌(캐시에 없음)는 제외하지 않는다 — 모르면 보는 쪽
  const S = { A: entry(['2026-09-01 10:30']) };
  const visited = [];
  const r = await scanOrdered(session, [{ id: 'A', name: 'A' }, { id: 'NEW', name: '새 강좌' }], {
    schedule: S, now: at('2026-09-01 10:40'), load: makeLoad('없음', visited), concurrency: 1,
  });
  check('캐시에 없는 강좌는 제외하지 않음', visited.includes('NEW'), `방문 ${visited.join('>')}`);
  check('  → 제외 목록 비어 있음', r.skippedNoLedger.length === 0);
}
{
  // 나중에 차시가 생기면 자동으로 되돌아온다
  const S = { Z: entry(['2026-09-01 10:30']) };
  const visited = [];
  await scanOrdered(session, [{ id: 'Z', name: '이제 차시 생김' }], {
    schedule: S, now: at('2026-09-01 10:40'), load: makeLoad('Z', visited), concurrency: 1,
  });
  check('차시가 생기면 다시 조회 대상', visited.includes('Z'));
}
{
  // 캐시가 통째로 없을 때 전 과목을 제외해 버리면 첫 실행이 아무것도 못 찾는다
  const visited = [];
  const r = await scanOrdered(session, COURSES, {
    schedule: null, now: at('2026-09-01 10:40'), load: makeLoad('없음', visited), concurrency: 1,
  });
  check('캐시가 없으면 아무것도 제외하지 않음', r.skippedNoLedger.length === 0 && visited.length === 3,
    `제외 ${r.skippedNoLedger.length} / 방문 ${visited.length}`);
}

// --- 조기 종료로 못 본 과목을 보고한다 ---
// 같은 시각에 다른 과목의 출결이 열려 있을 수 있다(보강 등). 찾았다고 멈추는
// 것 자체는 유지하되, 무엇을 안 봤는지 알려야 사용자가 마저 볼 수 있다.
{
  const visited = [];
  const r = await scanOrdered(session, COURSES, {
    schedule: SCHEDULE, now: at('2026-09-02 15:10'), load: makeLoad('C', visited), concurrency: 1,
  });
  check('찾으면 멈춘다', r.active.length === 1 && visited.length < 3, `방문 ${visited.join('>')}`);
  check('  못 본 과목을 보고', r.notScanned.sort().join() === 'A,B', r.notScanned.join());
  check('  어느 단계에서 멈췄는지도', r.stoppedAt === 'now', String(r.stoppedAt));
}
{
  // full 이면 끝까지 본다
  const visited = [];
  const r = await scanOrdered(session, COURSES, {
    schedule: SCHEDULE, now: at('2026-09-02 15:10'), load: makeLoad('C', visited), concurrency: 1, full: true,
  });
  check('full 이면 전부 조회', visited.sort().join() === 'A,B,C', `방문 ${visited.join('>')}`);
  check('  못 본 과목 없음', r.notScanned.length === 0);
  check('  stoppedAt 없음', r.stoppedAt === null);
}
{
  // 동시에 두 과목이 열려 있고 같은 단계에 있으면 둘 다 찾는다
  const visited = [];
  const load = async (_s, id) => {
    visited.push(String(id));
    const open = ['A', 'B'].includes(String(id));
    return {
      courseId: String(id),
      html: open ? openHtml(id) : '<div>없음</div>',
      doc: { querySelector: (css) => (open && css === '#sb-smart-answer-form' ? { tagName: 'FORM' } : null) },
    };
  };
  const r = await scanOrdered(session, COURSES, {
    schedule: SCHEDULE, now: at('2026-09-01 10:40'), load, concurrency: 1,
  });
  check('같은 단계의 동시 세션은 둘 다 발견', r.active.length === 2, `${r.active.length}건`);
}
{
  // 아무것도 못 찾으면 못 본 과목이 없어야 한다 (전부 봤으므로)
  const visited = [];
  const r = await scanOrdered(session, COURSES, {
    schedule: SCHEDULE, now: at('2026-09-02 15:10'), load: makeLoad('없음', visited), concurrency: 1,
  });
  check('못 찾으면 전부 조회하고 못 본 과목 0', r.notScanned.length === 0 && visited.length === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
