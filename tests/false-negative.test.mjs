// 위음성(FN) 감사.
//
// 서버 쪽이 positive(출결이 열려 있음 / 응답이 반영됨)인데 우리가 negative 로
// 판단하는 경로를 전부 세어 고정한다. 이 확장에서 가장 비싼 실패다 —
// 위양성은 요청 하나를 더 하는 것으로 끝나지만, 위음성은 출결을 놓친다.
import { scanOrdered, parseSession } from '../src/core/attendance.js';
import { selectCourses } from '../src/core/courses.js';
import { hasAttendanceLedger, tierCourses } from '../src/core/schedule.js';
import { profileForHost } from '../src/config/endpoints.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(54) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const P = profileForHost('plato.pusan.ac.kr');
const session = { profile: P, sesskey: 'K' };
const at = (s) => { const m = s.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/); return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]); };
const entry = (slots, table = true) => ({ rows: slots.map((slot) => ({ slot, chip: null })), table });

console.log('[1] 이름으로 강좌를 빼는 경로');
{
  // 해시처럼 생긴 shortname 을 가진 교과 과목이 있다면? 이름으로 빼면 영영 못 본다.
  const courses = [
    { id: '1', kind: 'academic', name: 'a' },
    { id: '2', kind: 'self', name: 'b' },
    { id: '3', kind: 'unknown', name: 'c' },
  ];
  const kept = selectCourses(courses).map((c) => c.id).join();
  check('자율로 분류돼도 조회 대상에서 빼지 않는다', kept === '1,2,3', kept);

  // 다만 우선순위는 낮춘다 — 이름으로 빼지는 않되 맨 나중에 본다.
  const t = tierCourses(courses, {}, at('2026-09-01 10:40'));
  check('  시간표를 모르는 자율강좌는 맨 나중 단계로',
    t.other.map((c) => c.id).join() === '2', `now=${t.now.map((c) => c.id)} other=${t.other.map((c) => c.id)}`);
  check('  교과/미상은 먼저', t.now.map((c) => c.id).join() === '1,3');
}
{
  // 한 번 조회해 표가 없다고 확인되면 그 뒤로는 아예 빠진다 (라이브 확인:
  // 자율강좌 3개 모두 table 없음 / 교과는 표 30행)
  check('표가 없다고 확인되면 완전히 제외',
    hasAttendanceLedger({ Z: { rows: [], table: false } }, 'Z') === false);
}

console.log('\n[2] 출석부 없음으로 빼는 경로');
{
  check('표가 없다고 서버가 보여준 경우만 제외',
    hasAttendanceLedger({ X: { rows: [], table: false } }, 'X') === false);
  check('표는 있는데 행이 0 → 모름 (파서 문제일 수 있다)',
    hasAttendanceLedger({ X: { rows: [], table: true } }, 'X') === null);
  check('캐시에 없으면 모름', hasAttendanceLedger({}, 'X') === null);
  check('캐시 자체가 없으면 모름', hasAttendanceLedger(null, 'X') === null);
  check('행이 있으면 있음', hasAttendanceLedger({ X: { rows: [{ slot: 's' }], table: true } }, 'X') === true);

  // 날짜 형식이 바뀌어 파서가 전 과목의 행을 못 읽는 상황
  const broken = { A: { rows: [], table: true }, B: { rows: [], table: true } };
  const excluded = ['A', 'B'].filter((id) => hasAttendanceLedger(broken, id) === false);
  check('파서가 전부 못 읽어도 아무도 제외하지 않는다', excluded.length === 0, excluded.join());
}

console.log('\n[3] 조회 실패를 "세션 없음" 으로 묻는 경로');
{
  const load = async (_s, id) => {
    if (String(id) === 'B') throw new Error('요청 시간 초과 (15초)');
    return {
      courseId: String(id), html: '<div>없음</div>',
      doc: { querySelector: () => null },
    };
  };
  const r = await scanOrdered(session, [{ id: 'A', name: 'a' }, { id: 'B', name: 'b' }], {
    schedule: { A: entry(['2026-09-01 10:30']), B: entry(['2026-09-01 10:30']) },
    now: at('2026-09-01 10:40'), load, concurrency: 1,
  });
  check('실패한 강좌를 따로 보고', r.failed.length === 1 && r.failed[0].courseId === 'B',
    JSON.stringify(r.failed.map((f) => f.courseId)));
  check('  실패 사유를 담는다', /시간 초과/.test(r.failed[0].reason), r.failed[0].reason);
  check('  성공한 강좌는 정상 처리', r.log.length === 2);
}

console.log('\n[4] 세션 감지 자체');
{
  const page = (html) => ({
    courseId: '1', html,
    doc: { querySelector: (css) => (css === '#sb-smart-answer-form' && html.includes('sb-smart-answer-form') ? { tagName: 'FORM' } : null) },
  });
  check('폼이 없으면 null (정상)', parseSession(P, page('<div>없음</div>')) === null);

  // 폼은 있는데 제출 정보를 못 읽는 경우 — 없다고 하지 않고 불완전으로 보고
  const partial = parseSession(P, page('<form id="sb-smart-answer-form"></form>'));
  check('폼이 있으면 제출 정보를 못 읽어도 null 이 아니다', partial !== null);
  check('  불완전으로 보고', partial.complete === false, partial.reason);
}

console.log('\n[5] 시간창으로 강좌를 빼는 경로');
{
  // 창은 순서일 뿐이어야 한다. 어느 단계에도 없는 강좌가 생기면 안 된다.
  const S = { A: entry(['2026-09-01 10:30']), B: entry(['2026-09-05 09:00']) };
  const all = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const t = tierCourses(all, S, at('2026-09-01 23:00'));
  const total = t.now.length + t.today.length + t.other.length;
  check('모든 강좌가 어느 단계엔가 들어간다', total === 3, `now=${t.now.length} today=${t.today.length} other=${t.other.length}`);
  check('시간표를 모르는 강좌는 가장 먼저', t.now.some((c) => c.id === 'C'));
}

console.log('\n[6] 조기 종료');
{
  const load = async (_s, id) => {
    const open = String(id) === 'A';
    const html = open ? '<form id="sb-smart-answer-form"></form>' : '<div>없음</div>';
    return { courseId: String(id), html, doc: { querySelector: (css) => (open && css === '#sb-smart-answer-form' ? {} : null) } };
  };
  const S = { A: entry(['2026-09-01 10:30']), B: entry(['2026-09-05 09:00']) };
  const r = await scanOrdered(session, [{ id: 'A', name: 'a' }, { id: 'B', name: 'b' }], {
    schedule: S, now: at('2026-09-01 10:40'), load, concurrency: 1,
  });
  check('멈춘 뒤 안 본 강좌를 반드시 보고', r.notScanned.join() === 'B', r.notScanned.join());
  check('  full 이면 안 본 강좌가 없다',
    (await scanOrdered(session, [{ id: 'A', name: 'a' }, { id: 'B', name: 'b' }], {
      schedule: S, now: at('2026-09-01 10:40'), load, concurrency: 1, full: true,
    })).notScanned.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
