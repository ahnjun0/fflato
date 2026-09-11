// sesskey 캐시. 네트워크를 타면 실패하도록 구성해, 캐시 경로가 정말 요청을
// 하지 않는지 확인한다.
import { openSession, forgetSession } from '../src/core/session.js';
import { set } from '../src/lib/storage.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(48) + (detail ?? ''));
  cond ? pass++ : fail++;
};

// fetch 를 막아 둔다. 캐시가 동작하면 호출되지 않아야 한다.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('네트워크를 타면 안 됩니다'); };

const seed = (patch = {}) => set('fflato.session.v1', {
  profileId: 'v2', sesskey: 'CACHED123', themeMatched: true, at: Date.now(), ...patch,
});

{
  await seed();
  fetchCalls = 0;
  const s = await openSession();
  check('캐시가 있으면 요청 없이 반환', fetchCalls === 0 && s.sesskey === 'CACHED123', `fetch ${fetchCalls}회`);
  check('  fromCache 표시', s.fromCache === true);
  check('  프로파일 복원', s.profile.id === 'v2');
  check('  themeMatched 복원', s.themeMatched === true);
}
{
  await seed({ at: Date.now() - 2 * 60 * 60 * 1000 }); // 2시간 전
  fetchCalls = 0;
  await openSession().catch(() => {});
  check('1시간 넘은 캐시는 무시하고 재취득 시도', fetchCalls === 1, `fetch ${fetchCalls}회`);
}
{
  await seed({ profileId: 'v1' });
  fetchCalls = 0;
  await openSession().catch(() => {});
  check('다른 프로파일 캐시는 쓰지 않음', fetchCalls === 1, `fetch ${fetchCalls}회`);
}
{
  await seed({ sesskey: '' });
  fetchCalls = 0;
  await openSession().catch(() => {});
  check('빈 sesskey 캐시는 쓰지 않음', fetchCalls === 1, `fetch ${fetchCalls}회`);
}
{
  await seed();
  fetchCalls = 0;
  await openSession({ allowCached: false }).catch(() => {});
  check('allowCached:false 면 캐시 무시', fetchCalls === 1, `fetch ${fetchCalls}회`);
}
{
  await seed();
  await forgetSession();
  fetchCalls = 0;
  await openSession().catch(() => {});
  check('forgetSession 후에는 재취득', fetchCalls === 1, `fetch ${fetchCalls}회`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
