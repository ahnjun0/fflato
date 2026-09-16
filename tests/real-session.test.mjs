// 자동출결 페이지 구조 검증.
//
// 기준은 tests/fixtures 의 합성 픽스처다. 실제 서버 응답은 저장소에 넣지 않는다 —
// MOODLE_WSTOKEN(웹서비스 토큰), sesskey, 이메일이 들어 있어 공개하면 자격증명을
// 유출하게 된다. 발췌해도 안전하다고 보장하기 어렵다.
//
// 실제 저장본이 로컬에 있으면(상위 디렉터리) 추가로 대조한다 —
// "우리 픽스처가 아직 현실과 같은 모양인가" 를 확인하는 것이다.
// 라이브 서버와의 차이는 debug 페이지의 자가진단이 잡는다.
import fs from 'node:fs'; import path from 'node:path';
import { parseSession, parsePayload } from '../src/core/attendance.js';
import { profileForHost } from '../src/config/endpoints.js';
import { pattern, sel } from '../src/config/selectors.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(50) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const P = profileForHost('plato.pusan.ac.kr');
const HERE = path.resolve(new URL('.', import.meta.url).pathname);
const fixture = (n) => fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8');

const open = fixture('smart-answer-open.html');
const openAmd = fixture('smart-answer-open-amd.html');
const done = fixture('smart-answer-done.html');
const pageOf = (html, courseId) => ({
  courseId, html,
  doc: { querySelector: (css) => (css === sel(P, 'smartAnswerForm') && html.includes('id="sb-smart-answer-form"') ? { tagName: 'FORM' } : null) },
});

// --- 세션 감지 ---
{
  const s = parseSession(P, pageOf(open, '9999'));
  check('열린 세션을 감지', s && s.complete === true);
  check('  마감 시각', s.endTime === 1900000000, String(s && s.endTime));
  check('  엔드포인트', s.action === 'https://plato.pusan.ac.kr/local/ubsmartbook/action.php', s && s.action);
  check('  id', s.fields.id === '9999', s && s.fields.id);
  check('  action', s.fields.action === 'smartanswer', s && s.fields.action);
  check('  smartid', s.fields.smartid === '12345', s && s.fields.smartid);
  check('  sesskey/authkey 는 런타임 값이라 제외',
    !('sesskey' in s.fields) && !('authkey' in s.fields), Object.keys(s.fields).sort().join());
}
check('출석 완료 상태에서는 세션 없음', parseSession(P, pageOf(done, '9999')) === null);

// --- 2026-09-07 형태: 제출 정보가 AMD 모듈 설정으로 옮겨졌다 ---
// 마크업은 그대로라 마크업 감시로는 잡히지 않는다. 읽는 방법을 여러 개 둔 이유다.
{
  const s = parseSession(P, pageOf(openAmd, '9999'));
  check('새 형태도 세션으로 인식', s && s.complete === true, s && s.reason);
  check('  마감 시각 (설정 JSON 안)', s.endTime === 1900000000, String(s && s.endTime));
  check('  엔드포인트', s.action === 'https://plato.pusan.ac.kr/local/ubsmartbook/action.php', s && s.action);
  check('  id / smartid', s.fields.id === '9999' && s.fields.smartid === '12345', JSON.stringify(s.fields));
  check('  action 값은 프로파일 상수로 (페이지에 없다)', s.fields.action === 'smartanswer');
  check('  sesskey 는 넣지 않는다 (제출 때 채운다)', !('sesskey' in s.fields));
  // 설정 JSON 은 사용자 문구도 싣는다. 서버가 언어에 맞춰 준 것이라 그대로 쓴다.
  check('  서버 문구를 읽는다 (wrong/ended/exceeded/success)',
    s.messages && s.messages.wrong_key === '인증번호가 일치하지 않습니다.'
      && s.messages.ended && s.messages.exceeded && s.messages.success,
    JSON.stringify(s.messages));
}
{
  // 옛 인라인 형태에는 문구가 없다. 없으면 빈 객체 — 우리 문구로 대신한다.
  const s = parseSession(P, pageOf(open, '9999'));
  check('옛 형태는 문구 없음 → 빈 객체', s.messages === undefined || Object.keys(s.messages).length === 0);
}
{
  // 폼은 있는데 어느 형태로도 못 읽으면 추측하지 않는다
  const broken = pageOf('<form id="sb-smart-answer-form"></form><script>amd.other()</script>', '9999');
  const s = parseSession(P, broken);
  check('모르는 형태는 불완전으로 보고', s && s.complete === false, s && s.reason);
}

// --- 폼에 name 이 없다 (직렬화할 것이 없다) ---
{
  const head = open.slice(open.indexOf('id="sb-smart-answer-form"'));
  check('폼에 name 속성이 없다', !/\sname=/.test(head.slice(0, head.indexOf('</form>'))));
}

// --- 출결 상태 칩 ---
{
  // 주석에도 날짜가 나오므로 반드시 표 본문 안에서만 찾는다.
  const chip = (html) => {
    const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    const row = body.slice(body.indexOf('2026-09-02'));
    const cellEnd = row.indexOf('</tr>');
    const cell = row.slice(0, cellEnd === -1 ? undefined : cellEnd);
    const m = cell.match(/csms-chips\s+(csms-chips-\w+)/);
    const t = cell.replace(/<[^>]+>/g, ' ');
    return { cls: m && m[1], text: /출석/.test(t) ? '출석' : (/결석/.test(t) ? '결석' : '-') };
  };
  const a = chip(open); const d = chip(done);
  check('세션 진행 중 기본 상태는 결석/빨강', a.text === '결석' && a.cls === 'csms-chips-red', `${a.text} ${a.cls}`);
  check('출석 처리되면 출석/파랑', d.text === '출석' && d.cls === 'csms-chips-blue', `${d.text} ${d.cls}`);
  check('→ "-" 가 아니라고 건너뛰면 안 된다', a.text === '결석');
}

// --- 실제 저장본이 있으면 대조 ---
const REAL = path.resolve(HERE, '..', '..');
const realOpen = path.join(REAL, '출석인식안됨.html');
const realDone = path.join(REAL, '출석현황이출석으로.html');

if (!fs.existsSync(realOpen) || !fs.existsSync(realDone)) {
  console.log('\n실제 저장본 없음 — 합성 픽스처만 검증했습니다.');
  console.log('(저장본은 토큰이 들어 있어 저장소에 넣지 않습니다. 로컬에 있으면 대조합니다.)');
} else {
  console.log('\n--- 실제 저장본(2026-09-02)과 대조 ---');
  const ro = fs.readFileSync(realOpen, 'utf8');
  const rd = fs.readFileSync(realDone, 'utf8');

  check('실제 열린 세션에도 같은 폼 id', ro.includes('id="sb-smart-answer-form"'));
  check('실제 완료 상태에는 폼 없음', !rd.includes('id="sb-smart-answer-form"'));
  check('마감 시각 패턴이 실제에도 매칭', pattern(P, 'smartAnswerEndTime').test(ro));
  check('$.post 패턴이 실제에도 매칭', pattern(P, 'smartAnswerPost').test(ro));

  const m = ro.match(pattern(P, 'smartAnswerPost'));
  const realFields = parsePayload(m[2]);
  const fakeFields = parsePayload(open.match(pattern(P, 'smartAnswerPost'))[2]);
  check('파라미터 이름 집합이 동일 (값은 다름)',
    Object.keys(realFields).sort().join() === Object.keys(fakeFields).sort().join(),
    `실제 ${Object.keys(realFields).sort().join()} / 픽스처 ${Object.keys(fakeFields).sort().join()}`);
  check('실제 엔드포인트 경로도 동일', m[1] === '/local/ubsmartbook/action.php', m[1]);

  const realBody = ro.slice(ro.indexOf('table-local-ubattend'));
  const realChip = realBody.slice(realBody.indexOf('2026-09-02'), realBody.indexOf('2026-09-02') + 1200);
  check('실제에서도 진행 중 상태는 결석/빨강', /csms-chips-red/.test(realChip) && /결석/.test(realChip.replace(/<[^>]+>/g, ' ')));
}

// --- 2026-09-07 실제 저장본과 대조 (로컬에 있을 때만) ---
const realAmd = path.join(REAL, '자동출결안됨1631.html');
if (fs.existsSync(realAmd)) {
  console.log('\n--- 실제 저장본(2026-09-07, AMD 형태)과 대조 ---');
  const ra = fs.readFileSync(realAmd, 'utf8');
  check('실제에도 같은 폼 id', ra.includes('id="sb-smart-answer-form"'));
  check('옛 $.post 패턴은 더는 매칭되지 않는다', !pattern(P, 'smartAnswerPost').test(ra));
  check('새 설정 패턴이 매칭된다', pattern(P, 'smartAnswerConfig').test(ra));

  const s = parseSession(P, {
    courseId: '6552', html: ra,
    doc: { querySelector: (css) => (css === sel(P, 'smartAnswerForm') ? { closest: () => null, outerHTML: '' } : null) },
  });
  check('실제 저장본에서 세션을 읽어낸다', s && s.complete === true, s && s.reason);
  check('  파라미터 이름 집합이 픽스처와 동일',
    Object.keys(s.fields).sort().join() === 'action,id,smartid', Object.keys(s.fields).sort().join());
  check('  엔드포인트 경로 동일', s.action.endsWith('/local/ubsmartbook/action.php'));
}

// --- PLATO 가 또 바꿨을 때 ---
// 지금까지 두 번 바뀌었고 두 번 다 "적힌 자리" 만 옮겼다. 앞으로도 그럴 것을
// 가정하고, 어디까지 버티는지 고정한다.
{
  const base = fixture('smart-answer-open-amd.html');
  const mkDoc = (html) => ({
    querySelector: (css) => {
      if (css === sel(P, 'smartAnswerForm')) {
        return html.includes('id="sb-smart-answer-form"') ? { closest: () => null, outerHTML: '' } : null;
      }
      if (css === sel(P, 'smartAnswerInput')) {
        return /<form[^>]*>[\s\S]{0,400}?inputmode="numeric"/.test(html)
          ? { closest: () => ({ closest: () => null, outerHTML: '' }) } : null;
      }
      return null;
    },
  });
  const run = (html) => parseSession(P, { courseId: '9999', html, doc: mkDoc(html) });

  {
    const s = run(base.replace(/id="sb-smart-answer-form"/g, 'id="sb-attend-v2"'));
    check('폼 id 가 바뀌어도 입력칸 구조로 찾는다', s && s.complete === true, s && s.detectedBy);
    check('  감지 경로를 알려준다', s.detectedBy === 'input');
  }
  {
    const s = run(base.replace(/amd\.smartAnswer\(/g, 'amd.startAttendance('));
    check('감싸는 함수 이름이 바뀌어도 설정을 읽는다', s && s.complete === true && s.fields.smartid === '12345');
  }
  {
    const s = run(base
      .replace(/id="sb-smart-answer-form"/g, 'id="x"')
      .replace(/amd\.smartAnswer\(/g, 'amd.q('));
    check('둘 다 바뀌어도 버틴다', s && s.complete === true, s && `${s.detectedBy}/${s.fields.smartid}`);
  }
  {
    // 설정의 키 이름까지 바뀌면 읽을 수 없다. 그때는 추측하지 않는다.
    const s = run(base.replace(/"smartid"/g, '"sid"'));
    check('설정 키가 바뀌면 불완전으로 보고 (추측 안 함)', s && s.complete === false, s && s.reason);
  }
  {
    const s = run(base.replace(/<form[\s\S]*?<\/form>/, '').replace(/"smartid"/g, '"sid"'));
    check('폼도 설정도 없으면 세션 없음', s === null);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
