import { saveCapture, listCaptures, clearCaptures, sanitize, compareWithAssumptions } from '../src/core/capture.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(46) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const PROFILE = {
  base: 'https://plato.pusan.ac.kr',
  paths: { smartbookAction: '/local/ubsmartbook/action.php' },
  typeParam: 'action',
  actions: { submitAttendance: 'smartanswer' },
};

// --- 사용자 입력은 절대 저장하지 않는다 ---
{
  const s = sanitize({
    courseId: '1001',
    fields: { action: 'smartanswer', id: '1001', smartid: '12345', authkey: '482913' },
    capturedHtml: '<form id="sb-smart-answer-form">…</form>',
  });
  check('authkey 값이 지워짐', s.fields.authkey === '', JSON.stringify(s.fields.authkey));
  check('authkey 이름은 남음 (구조 파악용)', s.fieldNames.includes('authkey'));
  check('서버가 준 값은 보존', s.fields.smartid === '12345' && s.fields.id === '1001');
  check('저장물 전체에 인증번호 흔적 없음', !JSON.stringify(s).includes('482913'));
}

// --- HTML 길이 제한 ---
{
  const s = sanitize({ fields: {}, capturedHtml: 'x'.repeat(50000) });
  check('HTML 20000자로 절단', s.html.length === 20000 && s.htmlTruncated === true, `${s.html.length}자`);
}

// --- 저장/조회/삭제 (메모리 폴백) ---
{
  await clearCaptures();
  check('초기 상태는 빈 목록', (await listCaptures()).length === 0);
  for (let i = 0; i < 7; i++) await saveCapture({ courseId: String(i), fields: {} });
  const list = await listCaptures();
  check('최대 5건만 유지', list.length === 5, `${list.length}건`);
  check('최신이 앞에', list[0].courseId === '6', list[0].courseId);
  await clearCaptures();
  check('삭제 동작', (await listCaptures()).length === 0);
}

// --- 가정 대조 ---
{
  // 인라인 형태: action 값을 페이지에서 읽었다 → 대조에 의미가 있다
  const good = sanitize({
    courseId: '1001',
    fields: { action: 'smartanswer', id: '1001', smartid: '12345' },
    action: 'https://plato.pusan.ac.kr/local/ubsmartbook/action.php',
    readerId: 'inline', detectedBy: 'form', assumed: [],
  });
  const rows = compareWithAssumptions(good, PROFILE);
  check('페이지에서 읽은 값은 대조가 성립', rows.filter((r) => r.label !== '예상 밖 필드').every((r) => r.ok),
    rows.filter((r) => !r.ok).map((r) => r.label).join());

  // 설정 JSON 형태: action 값이 페이지에 없어 상수로 채웠다 →
  // 상수를 상수와 비교하며 "일치" 라고 하면 안 된다
  const assumedRow = compareWithAssumptions(sanitize({
    courseId: '1001',
    fields: { action: 'smartanswer', id: '1001', smartid: '12345' },
    action: 'https://plato.pusan.ac.kr/local/ubsmartbook/action.php',
    readerId: 'config', detectedBy: 'form', assumed: ['action'],
  }), PROFILE).find((r) => r.label === 'action 값');
  check('상수로 채운 값은 확인됨으로 표시하지 않는다', assumedRow.ok === false, String(assumedRow.ok));
  // 다만 "다름" 도 아니다 — 값은 같고 대조할 근거가 없을 뿐이다.
  check('  상수로 채운 값은 "다름" 이 아니라 "미확인"', assumedRow.state === 'skip', assumedRow.state);
  check('  왜 확인할 수 없는지 설명이 붙는다', Boolean(assumedRow.note), assumedRow.note || '(없음)');
  check('  그 사실을 화면에 밝힌다', assumedRow.actual.includes('상수로 채움'), assumedRow.actual);

  const bad = sanitize({
    courseId: '1001',
    fields: { action: 'somethingElse', id: '1001', extra: '1' },
    action: 'https://plato.pusan.ac.kr/local/other/action.php',
    readerId: 'inline', detectedBy: 'form', assumed: [],
  });
  const rows2 = compareWithAssumptions(bad, PROFILE);
  check('action 이 다르면 잡아냄', rows2.find((r) => r.label === 'action URL').ok === false);
  check('action 값이 다르면 잡아냄', rows2.find((r) => r.label === 'action 값').ok === false);
  check('  값이 실제로 다를 때는 "다름"', rows2.find((r) => r.label === 'action 값').state === 'bad');
  check('  이상 없는 캡처에는 bad 가 없다',
    compareWithAssumptions(good, PROFILE).every((r) => r.state !== 'bad'));
  check('smartid 없으면 잡아냄', rows2.find((r) => r.label === 'smartid').ok === false);
  check('예상 밖 필드를 보고', rows2.find((r) => r.label === '예상 밖 필드').actual === 'extra');
}

// --- parseSession → 캡처 왕복 ---
// 필드를 손으로 옮겨 적다가 readerId / detectedBy / assumed 를 빠뜨린 적이 있다.
// 잘 읽고도 대조표에 "제출 정보를 읽지 못함" 으로 뜨고, 상수로 채운 값이
// "OK" 로 보였다. 세션 객체가 통째로 흘러가는지 확인한다.
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { parseSession } = await import('../src/core/attendance.js');
  const { profileForHost } = await import('../src/config/endpoints.js');
  const { sel } = await import('../src/config/selectors.js');

  const P = profileForHost('plato.pusan.ac.kr');
  const html = fs.readFileSync(
    path.join(path.resolve(new URL('.', import.meta.url).pathname), 'fixtures', 'smart-answer-open-amd.html'),
    'utf8');
  const session = parseSession(P, {
    courseId: '9999', html,
    doc: { querySelector: (css) => (css === sel(P, 'smartAnswerForm') ? { closest: () => null, outerHTML: '<div></div>' } : null) },
  });
  check('세션을 읽었다', session && session.complete === true);

  await clearCaptures();
  await saveCapture(session, '과목가 (060)');
  const c = (await listCaptures())[0];

  check('읽은 방법이 캡처에 남는다', c.readerId === 'config', String(c.readerId));
  check('감지 경로가 캡처에 남는다', c.detectedBy === 'form', String(c.detectedBy));
  check('상수로 채운 항목이 캡처에 남는다', (c.assumed || []).includes('action'), JSON.stringify(c.assumed));
  check('과목 이름', c.courseName === '과목가 (060)');
  check('제출 파라미터', c.fields.smartid === '12345' && c.fields.id === '9999');

  const rows = compareWithAssumptions(c, PROFILE);
  const reader = rows.find((r) => r.label === '읽은 방법');
  check('대조표가 "읽었음" 으로 표시', reader.ok === true, reader.actual);
  const actionRow = rows.find((r) => r.label === 'action 값');
  check('  상수로 채운 값은 확인됨으로 표시하지 않음', actionRow.ok === false, actionRow.actual);
  check('  실제 세션 캡처에 "다름" 항목은 없다',
    rows.every((r) => r.state !== 'bad'), rows.filter((r) => r.state === 'bad').map((r) => r.label).join());
  await clearCaptures();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
