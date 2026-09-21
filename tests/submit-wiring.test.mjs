// "제출 버튼을 누르면 정말 나가는가" 를 끝에서 끝까지 확인한다.
//
// tests/fixtures 의 합성 픽스처로 세션을 만들고, popup 이 부르는 것과 같은
// submit() 을 호출한 뒤 fetch 로 나가는 요청을 그대로 검사한다.
// 네트워크는 타지 않는다.
//
// 픽스처가 실제 서버 응답과 같은 모양인지는 real-session.test.mjs 가 확인한다.
import fs from 'node:fs'; import path from 'node:path';
import { parseSession } from '../src/core/attendance.js';
import { profileForHost } from '../src/config/endpoints.js';
import { submit } from '../src/app/scan.js';
import { listAttended, clearAttended } from '../src/core/attended.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(48) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const P = profileForHost('plato.pusan.ac.kr');
const html = fs.readFileSync(
  path.join(path.resolve(new URL('.', import.meta.url).pathname), 'fixtures', 'smart-answer-open.html'),
  'utf8'
);

// parseSession 은 doc.querySelector 만 쓴다. 폼이 있다는 사실만 흉내내면 된다.
const page = {
  courseId: '9999',
  html,
  doc: { querySelector: (css) => (css === '#sb-smart-answer-form' ? { tagName: 'FORM' } : null) },
};
const active = parseSession(P, page);
check('실제 HTML 에서 세션을 만든다', active && active.complete === true);

const context = {
  session: { profile: P, sesskey: 'SESSKEY99' },
  schedule: { 9999: { rows: [{ slot: '2026-09-02 13:30', chip: 'csms-chips-red' }], table: true } },
};
// 실제 시각에 의존하면 창을 벗어나는 시간대에 테스트가 흔들린다.
const NOW = new Date(Date.UTC(2026, 8, 2, 13, 40) - 9 * 3600_000); // 한국 시간

// --- 성공 경로: 나가는 요청을 그대로 잡는다 ---
let sent = null;
globalThis.fetch = async (url, opts) => {
  sent = { url: String(url), ...opts };
  return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ ok: true }) };
};

await clearAttended();
// 확인 절차는 verify.test.mjs 가 본다. 여기서는 제출 요청 자체만 검사한다.
const VERIFIED = async () => ({ verified: true, chip: 'csms-chips-blue', text: '출석' });
const result = await submit(context, active, ' 482913 ', { now: NOW, verify: VERIFIED });

check('제출 결과가 성공', result.ok === true, result.message);
check('확인 결과를 함께 반환', result.verification && result.verification.verified === true);
check('POST 로 나간다', sent.method === 'POST', sent.method);
check('실제 엔드포인트', sent.url === 'https://plato.pusan.ac.kr/local/ubsmartbook/action.php', sent.url);
check('urlencoded 로 인코딩', String(sent.headers['Content-Type']).startsWith('application/x-www-form-urlencoded'), sent.headers['Content-Type']);
check('XHR 헤더 포함', sent.headers['X-Requested-With'] === 'XMLHttpRequest');
check('쿠키를 실어 보낸다', sent.credentials === 'include', sent.credentials);

{
  const body = new URLSearchParams(sent.body);
  check('  id', body.get('id') === '9999', body.get('id'));
  check('  action', body.get('action') === 'smartanswer', body.get('action'));
  check('  smartid (페이지에서 읽은 값)', body.get('smartid') === '12345', body.get('smartid'));
  check('  sesskey (세션에서 채운 값)', body.get('sesskey') === 'SESSKEY99', body.get('sesskey'));
  check('  authkey (사용자 입력, 공백 제거)', body.get('authkey') === '482913', body.get('authkey'));
  check('  그 외 파라미터 없음', [...body.keys()].sort().join() === 'action,authkey,id,sesskey,smartid',
    [...body.keys()].sort().join());
}

// --- 성공하면 그 차시를 출석 완료로 남긴다 ---
{
  const rec = await listAttended();
  check('출석 기록 1건', rec.length === 1, JSON.stringify(rec));
  check('  차시까지 기록', rec[0] && rec[0].slot === '2026-09-02 13:30', rec[0] && rec[0].slot);
  check('  강좌 ID', rec[0] && rec[0].courseId === '9999');
  await clearAttended();
}

// --- 실패하면 기록하지 않는다 ---
{
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Map(),
    text: async () => JSON.stringify({ ok: false, error: '인증번호가 일치하지 않습니다.' }),
  });
  const r = await submit(context, active, '000000', { now: NOW, verify: VERIFIED });
  check('틀린 인증번호는 실패로', r.ok === false && r.message.includes('일치하지'), r.message);
  check('  출석 기록을 남기지 않음', (await listAttended()).length === 0);
  await clearAttended();
}

// --- 종료된 세션 ---
{
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Map(),
    text: async () => JSON.stringify({ ok: false, error: 'ended' }),
  });
  const r = await submit(context, active, '000000', { now: NOW, verify: VERIFIED });
  check('종료된 세션은 종료로 안내', r.kind === 'ended' && r.message.includes('종료'), r.message);
  await clearAttended();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
