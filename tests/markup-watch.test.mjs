// 화면 변경 감지.
//
// 자가진단은 "우리가 쓰는 것" 만 본다. 서버가 무언가를 **더하는** 변화는 잡지
// 못한다 — 2026-09-04 에 출결 요약 섹션이 생겼을 때가 그랬고, 그때 우리가
// 모르던 상태(조퇴)가 드러났다. 사람이 우연히 발견했다.
import { collectTokens, newTokens, watch, acceptChanges, pendingChanges, clearMarkupWatch } from '../src/core/markup-watch.js';
import { KNOWN_MARKUP } from '../src/config/selectors.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(52) + (detail ?? ''));
  cond ? pass++ : fail++;
};

// 문서 스텁: class 문자열 목록을 준다.
// querySelector 는 셀렉터를 구분한다 — 무엇이든 돌려주면 "출석현황 페이지인가"
// 검사가 항상 통과해 버려서, 검사가 있으나 마나가 된다.
const docOf = (classes, { statusTable = true } = {}) => ({
  querySelector: (css) => {
    if (String(css).includes('table-local-ubattend')) return statusTable ? {} : null;
    return { querySelectorAll: () => classes.map((c) => ({ getAttribute: () => c })) };
  },
});

{
  const t = collectTokens(docOf(['a b', 'b c', '', 'd']));
  check('클래스 토큰을 모은다', [...t].sort().join() === 'a,b,c,d', [...t].join());
  check('빈 class 는 무시', !t.has(''));
}

{
  check('기준선에 있는 토큰은 새것이 아니다',
    newTokens(new Set(['table-local-ubattend', 'csms-chips-red'])).length === 0);
  check('처음 보는 토큰만 골라낸다',
    newTokens(new Set(['table-local-ubattend', 'brand-new-thing'])).join() === 'brand-new-thing');
  check('확인 완료한 것은 다시 알리지 않는다',
    newTokens(new Set(['brand-new-thing']), ['brand-new-thing']).length === 0);
}

// --- 2026-09-04 에 실제로 생긴 요소들 ---
{
  // 그날 새로 나타난 토큰. 지금은 기준선에 들어 있으므로 알리지 않아야 한다.
  const added = ['attendance-info', 'attendance-status-list', 'status-item', 'csms-chips-yellow'];
  check('그날 추가분은 이제 기준선에 있다', added.every((t) => KNOWN_MARKUP.has(t)), added.filter((t) => !KNOWN_MARKUP.has(t)).join());

  // 세션이 열렸을 때만 나타나는 폼 요소도 기준선에 있어야 한다 (헛경보 방지)
  const formOnly = ['alert', 'alert-info', 'btn', 'btn-primary', 'form-control'];
  check('세션 전용 요소도 기준선에 (헛경보 방지)', formOnly.every((t) => KNOWN_MARKUP.has(t)));
}

// --- 상태 저장 ---
{
  await clearMarkupWatch();
  const first = await watch(docOf(['table-local-ubattend']));
  check('변화가 없으면 조용하다', first.changed === false);

  const second = await watch(docOf(['table-local-ubattend new-widget another-new']));
  check('새 토큰을 알린다', second.changed === true && second.tokens.length === 2, second.tokens.join());
  check('  처음 관측 시각을 남긴다', typeof second.firstSeen === 'string');

  const again = await watch(docOf(['new-widget another-new']));
  check('같은 변화는 중복 누적되지 않는다', again.tokens.length === 2, again.tokens.join());

  const p = await pendingChanges();
  check('대기 중인 변경을 조회', p.tokens.length === 2);

  await acceptChanges();
  const after = await pendingChanges();
  check('확인 완료하면 비워진다', after.tokens.length === 0 && after.accepted === 2, JSON.stringify(after));

  const quiet = await watch(docOf(['new-widget another-new']));
  check('확인 완료 후에는 다시 알리지 않는다', quiet.changed === false);
  await clearMarkupWatch();
}

// --- 사라진 토큰은 알리지 않는다 ---
{
  await clearMarkupWatch();
  // 인증번호 폼이 없는 페이지 — 폼 토큰이 사라져도 정상이다
  const r = await watch(docOf(['table-local-ubattend csms-box']));
  check('토큰이 사라진 것은 변화로 보지 않는다', r.changed === false);
  await clearMarkupWatch();
}

// --- 로그인 화면을 PLATO 변경으로 오해하지 않는다 ---
{
  await clearMarkupWatch();
  // 로그인이 풀리면 같은 주소에 로그인 화면이 온다. 출결 표가 없다.
  const r = await watch(docOf(['login-form some-unknown-thing'], { statusTable: false }));
  check('출석현황 페이지가 아니면 대조하지 않는다', r.changed === false, JSON.stringify(r));
  check('  왜 건너뛰었는지 밝힌다', r.skipped === 'not_status_page', String(r.skipped));
  const after = await pendingChanges();
  check('  기준선을 오염시키지 않는다', after.tokens.length === 0, after.tokens.join());
}

// --- 부트스트랩 유틸리티는 알리지 않는다 ---
{
  await clearMarkupWatch();
  // 실제로 보고됐던 조합. 여백과 글씨 굵기는 출결 구조와 무관하다.
  const r = await watch(docOf(['table-local-ubattend btn-sm fw-bold mt-2']));
  check('유틸리티 클래스만 늘어난 것은 알리지 않는다', r.changed === false, r.tokens.join());
}
{
  await clearMarkupWatch();
  // 다만 PLATO 고유 클래스는 유틸리티에 섞여 있어도 놓치지 않는다.
  const r = await watch(docOf(['table-local-ubattend mt-2 csms-chips-purple']));
  check('유틸리티에 섞인 고유 클래스는 잡는다',
    r.changed === true && r.tokens.join() === 'csms-chips-purple', r.tokens.join());
}
{
  // 규칙이 생기기 전에 저장된 노이즈는 읽을 때 걸러 낸다.
  await clearMarkupWatch();
  await watch(docOf(['table-local-ubattend csms-chips-purple']));
  const p = await pendingChanges();
  check('남은 대기 목록에 노이즈가 없다', p.tokens.every((t) => !/^mt-|^fw-|^btn-sm$/.test(t)),
    p.tokens.join());
  await clearMarkupWatch();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
