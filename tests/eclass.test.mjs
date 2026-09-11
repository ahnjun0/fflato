// 자율강좌 판별.
//
// PLATO 가 자율강좌만 싣는 페이지를 따로 준다. 서버가 스스로 가르는 기준이라
// shortname 이 해시처럼 생겼는지 보는 추측보다 확실하다.
import { parseSelfCourseIds, getSelfCourseIds, clearSelfCourses, SELF_LIST_LIFETIME } from '../src/core/eclass.js';
import { profileForHost } from '../src/config/endpoints.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(52) + (detail ?? ''));
  cond ? pass++ : fail++;
};
const P = profileForHost('plato.pusan.ac.kr');

// 실제 페이지 구조 (2026-09-03 실측: h2 자율강좌 + a.course-card 3개, 교과 0개)
const docOf = (hrefs) => ({
  querySelectorAll: (css) => (css.includes('course-card')
    ? hrefs.map((h) => ({ getAttribute: () => h }))
    : []),
});

{
  const ids = parseSelfCourseIds(docOf([
    'https://plato.pusan.ac.kr/course/view.php?id=13010',
    'https://plato.pusan.ac.kr/course/view.php?id=11666',
    '/course/view.php?id=10502',
  ]), P);
  check('자율강좌 ID 를 뽑는다', [...ids].sort().join() === '10502,11666,13010', [...ids].join());
  check('상대 경로도 처리', ids.has('10502'));
}
{
  check('강좌 링크가 아닌 것은 무시',
    parseSelfCourseIds(docOf(['/local/ubeclass/my.php', '#']), P).size === 0);
  check('비어 있으면 빈 집합', parseSelfCourseIds(docOf([]), P).size === 0);
}

// --- 목록을 못 받아도 치명적이지 않다 ---
{
  await clearSelfCourses();
  globalThis.fetch = async () => { throw new Error('네트워크 오류'); };
  const r = await getSelfCourseIds({ profile: P, sesskey: 'K' });
  check('요청이 실패하면 빈 집합', r.ids.size === 0, `failed=${r.failed}`);
  check('  실패 사유를 알린다', typeof r.failed === 'string');
  check('  → 아무도 제외되지 않는다 (출석부 유무로 가리는 경로가 남는다)', r.ids.size === 0);
}

// --- 로그인이 풀리면 위로 올린다 ---
{
  await clearSelfCourses();
  globalThis.fetch = async () => ({
    ok: true, status: 200, url: 'https://plato.pusan.ac.kr/login/index.php',
    text: async () => '<html></html>',
  });
  let caught = null;
  try { await getSelfCourseIds({ profile: P, sesskey: 'K' }); } catch (e) { caught = e; }
  check('로그인 페이지면 not_logged_in 을 던진다', caught && caught.kind === 'not_logged_in');
}

// --- 캐시 ---
// Node 에는 DOMParser 가 없다. 파싱은 위에서 따로 검증했으므로, 여기서는
// 캐시 동작만 보기 위해 최소 스텁을 둔다.
{
  globalThis.DOMParser = class {
    parseFromString(html) {
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      return { querySelectorAll: () => hrefs.map((h) => ({ getAttribute: () => h })) };
    }
  };
  await clearSelfCourses();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: true, status: 200, url: 'https://plato.pusan.ac.kr/local/ubeclass/my.php',
      text: async () => '<a class="course-card" href="/course/view.php?id=999"></a>',
    };
  };
  const first = await getSelfCourseIds({ profile: P, sesskey: 'K' });
  check('처음에는 받아 온다', calls === 1 && first.ids.has('999'));
  const second = await getSelfCourseIds({ profile: P, sesskey: 'K' });
  check('두 번째는 캐시', calls === 1 && second.fromCache === true, `요청 ${calls}회`);
  const forced = await getSelfCourseIds({ profile: P, sesskey: 'K' }, { force: true });
  check('force 면 다시 받는다', calls === 2 && forced.fromCache === false);
  check('수명이 노출된다', SELF_LIST_LIFETIME.hours === 24, SELF_LIST_LIFETIME.label);
  await clearSelfCourses();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
