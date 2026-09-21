import { getCourses, selectCourses } from '../src/core/courses.js';
const C = (id, kind) => ({ id, kind, name: 'c' + id, displayName: 'c' + id });
const ok = (n) => async () => [C('1', 'academic'), C('2', 'self')].slice(0, n);
const boom = async () => { throw new Error('망함'); };
const empty = async () => [];
let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(44) + (detail ?? ''));
  cond ? pass++ : fail++;
};
const t = async (label, fn, expect) => {
  let got;
  try { got = JSON.stringify((await fn()).map((c) => c.id)); }
  catch (e) { got = 'throw: ' + (e.message.includes(expect.replace('throw: ','')) ? expect : e.message); }
  const good = got === expect || got.startsWith('throw:') && expect.startsWith('throw:');
  console.log((good ? 'PASS ' : 'FAIL ') + label.padEnd(38) + got);
  good ? pass++ : fail++;
};
// 이름으로 빼지 않는다 — 제외는 서버가 보여주는 출석부 유무로만 한다.
// 해시처럼 생긴 교과 과목이 하나라도 있으면 그 과목을 영영 놓치기 때문이다.
await t('웹서비스 성공 → 그대로 사용', () => getCourses({}, { providers: [ok(2), boom] }), '["1","2"]');
await t('웹서비스 예외 → DOM 폴백', () => getCourses({}, { providers: [boom, ok(2)] }), '["1","2"]');
await t('웹서비스 빈 목록 → DOM 폴백', () => getCourses({}, { providers: [empty, ok(2)] }), '["1","2"]');
await t('둘 다 실패 → 에러', () => getCourses({}, { providers: [boom, empty] }), 'throw: 수강 중인 과목을 찾지 못했습니다');
await t('자율로 분류돼도 목록에 남는다', () => getCourses({}, { providers: [ok(2)] }), '["1","2"]');
check('자율로 분류된 과목도 제외하지 않음', selectCourses([C('9', 'self')]).length === 1);

// --- 실제 shortname 으로 분류 (2026-09-03 라이브 데이터) ---
{
  const { classifyShortname } = await import('../src/core/courses.js');
  const cases = [
    ['0123456789abcdef0123456789abcdef', 'self', '접미사 없는 해시 (자율강좌 가)'],
    ['fedcba9876543210fedcba9876543210', 'self', '접미사 없는 해시 (자율강좌 나)'],
    ['00112233445566778899aabbccddeeff', 'self', '접미사 없는 해시 (자율강좌 다)'],
    ['fedcba9876543210fedcba9876543210_mig4392', 'self', '_mig 접미사가 있어도 자율'],
    ['과목가 (2026-0000, AA0000000_001)', 'academic', '학수번호'],
    ['과목나 (2026-0000, AA1111111_002)', 'academic', '학수번호'],
    ['과목다 (2026-0000, AA2222222_003)', 'academic', '학수번호'],
    ['', 'unknown', '빈 shortname'],
    ['알수없는형식', 'unknown', '모르는 형식은 unknown (안전상 포함)'],
  ];
  for (const [sn, want, why] of cases) {
    const got = classifyShortname(sn);
    check(`${why}`, got === want, `${got} (기대 ${want})  ${sn.slice(0, 34)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
