// 제출 성공 후 확인 절차.
//
// ok:true 만 믿지 않는다. 확인을 건너뛰어 아끼는 것은 요청 하나지만,
// 출석이 안 됐는데 됐다고 믿으면 그 과목을 다시 보지 않아 출결을 놓친다.
import { submit } from '../src/app/scan.js';
import { readSlotStatus } from '../src/core/schedule.js';
import { listAttended, clearAttended, verifiedSlots } from '../src/core/attended.js';
import { profileForHost } from '../src/config/endpoints.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(50) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const P = profileForHost('plato.pusan.ac.kr');
const SLOT = '2026-09-03 10:30';
const NOW = new Date(Date.UTC(2026, 8, 3, 10, 40) - 9 * 3600_000); // 한국 시간
const context = {
  session: { profile: P, sesskey: 'K' },
  schedule: { 1001: { rows: [{ slot: SLOT, chip: 'csms-chips-red' }], table: true } },
};
const active = {
  courseId: '1001',
  action: 'https://plato.pusan.ac.kr/local/ubsmartbook/action.php',
  fields: { id: '1001', action: 'smartanswer', smartid: '12345' },
};

globalThis.fetch = async () => ({
  ok: true, status: 200, headers: new Map(),
  text: async () => JSON.stringify({ ok: true }),
});

const run = (verification) => submit(context, active, '123456', { now: NOW, verify: async () => verification });

// --- 확인 성공 ---
{
  await clearAttended();
  const r = await run({ verified: true, chip: 'csms-chips-blue', text: '출석' });
  check('제출 성공', r.ok === true);
  check('  확인 결과를 함께 반환', r.verification.verified === true);
  const rec = (await listAttended())[0];
  check('  기록에 verified=true', rec.verified === true, JSON.stringify(rec.chip));
  check('  → 확인된 차시로 집계', (await verifiedSlots('1001')).has(SLOT));
}

// --- 확인 실패: 모르는 칩 ---
{
  await clearAttended();
  const r = await run({ verified: false, chip: 'csms-chips-orange', text: '지각', reason: '아는 값이 아님' });
  check('확인 실패해도 제출 성공은 성공', r.ok === true);
  const rec = (await listAttended())[0];
  check('  기록은 남기되 verified=false', rec.verified === false);
  check('  관측한 값을 보존 (나중에 규칙에 추가할 수 있게)', rec.chip === 'csms-chips-orange' && rec.statusText === '지각');
  check('  → 확인된 차시에 들어가지 않음', !(await verifiedSlots('1001')).has(SLOT));
}

// --- 확인 실패: 네트워크 오류 ---
{
  await clearAttended();
  await run({ verified: false, chip: null, text: '', reason: '네트워크 오류' });
  check('확인 요청이 실패하면 미확인으로', !(await verifiedSlots('1001')).has(SLOT));
}

// --- 차시를 모르면 확인조차 시도하지 않는다 ---
{
  await clearAttended();
  let called = false;
  const r = await submit({ ...context, schedule: {} }, active, '123456',
    { now: NOW, verify: async () => { called = true; return { verified: true }; } });
  check('차시를 모르면 확인 생략', called === false);
  check('  기록은 남기되 미확인', (await listAttended())[0].verified === false);
  check('  slot 은 null', r.slot === null);
}

// --- 제출 실패면 확인도 기록도 없다 ---
{
  await clearAttended();
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Map(),
    text: async () => JSON.stringify({ ok: false, error: '인증번호가 일치하지 않습니다.' }),
  });
  let called = false;
  const r = await submit(context, active, '000000', { now: NOW, verify: async () => { called = true; return {}; } });
  check('제출 실패 시 확인하지 않음', r.ok === false && called === false);
  check('  기록 없음', (await listAttended()).length === 0);
  await clearAttended();
}

// --- 상태 읽기: 칩 색상으로 판별 (글자는 언어에 따라 바뀐다) ---
// 전체 목록은 벤더 페이지의 교수용 상태 변경 드롭다운에서 확인했다.
{
  const doc = (chip, text) => ({
    querySelectorAll: () => [{
      children: [
        { textContent: '2026-09-03' },
        { textContent: '10:30' },
        { textContent: text, querySelector: () => (chip ? { className: `csms-chips ${chip} csms-chips-lg` } : null) },
      ],
    }],
  });
  const cases = [
    ['csms-chips-blue', '출석', { registered: true, key: 'present', tone: 'ok' }],
    ['csms-chips-green', '지각', { registered: true, key: 'late', tone: 'warn' }],
    ['csms-chips-red', '결석', { registered: false, key: 'absent', tone: 'bad' }],
    ['csms-chips-yellow', '조퇴', { registered: true, key: 'early_leave', tone: 'warn' }],
    ['csms-chips-gray-light', '지각 조퇴', { registered: true, key: 'late_early_leave', tone: 'warn' }],
  ];
  for (const [chip, text, want] of cases) {
    const r = readSlotStatus(doc(chip, text), P, SLOT);
    check(`${text} (${chip})`,
      r.registered === want.registered && r.key === want.key && r.tone === want.tone && r.chip === chip,
      `registered=${r.registered} key=${r.key} tone=${r.tone} chip=${r.chip}`);
  }
  check('하이픈이 든 클래스도 온전히 잡는다',
    readSlotStatus(doc('csms-chips-gray-light', '지각 조퇴'), P, SLOT).chip === 'csms-chips-gray-light');
  check('결석만 registered=false (지각·조퇴는 응답이 반영된 것)',
    readSlotStatus(doc('csms-chips-red', '결석'), P, SLOT).registered === false
    && ['csms-chips-blue', 'csms-chips-green', 'csms-chips-yellow', 'csms-chips-gray-light']
      .every((c) => readSlotStatus(doc(c, 'x'), P, SLOT).registered === true));
  check('영어 화면에서도 동일 (글자를 보지 않음)',
    readSlotStatus(doc('csms-chips-blue', 'Present'), P, SLOT).registered === true);
  check('목록에 없는 칩 → null (반영됨으로 읽지 않음)',
    readSlotStatus(doc('csms-chips-purple', '???'), P, SLOT).registered === null);
  check('칩 없음 → null', readSlotStatus(doc(null, '-'), P, SLOT).registered === null);
  check('다른 차시는 찾지 못함',
    readSlotStatus(doc('csms-chips-blue', '출석'), P, '2026-09-10 10:30').registered === null);
}

// --- 목록에 없는 상태 ---
// 서버가 새 상태를 추가할 수 있다. 모르는 것을 반영됨으로 읽지 않되,
// 글자와 클래스는 그대로 전달해 화면이 보여주고 우리가 규칙에 추가할 수 있게 한다.
{
  const doc = (chip, text) => ({
    querySelectorAll: () => [{
      children: [
        { textContent: '2026-09-03' },
        { textContent: '10:30' },
        { textContent: text, querySelector: () => (chip ? { className: `csms-chips ${chip} ` } : null) },
      ],
    }],
  });
  // 목록에 없는 칩이 나오면 반영됨으로 읽지 않고, 글자와 클래스는 그대로 남긴다
  for (const [chip, text] of [['csms-chips-purple', '공결'], ['csms-chips-orange', '기타']]) {
    const r = readSlotStatus(doc(chip, text), P, SLOT);
    check(`${text}: 반영됨으로 읽지 않음`, r.registered === null, `registered=${r.registered}`);
    check(`  글자를 그대로 전달`, r.text === text, r.text);
    check(`  클래스도 보존 (규칙에 추가할 수 있게)`, r.chip === chip, r.chip);
  }
}
{
  // 제출 후 모르는 상태가 오면 확인 실패로 두되 글자를 남긴다
  // (앞 블록이 fetch 를 실패 응답으로 바꿔 두었으므로 되돌린다)
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Map(),
    text: async () => JSON.stringify({ ok: true }),
  });
  await clearAttended();
  const r = await run({ verified: false, chip: 'csms-chips-purple', text: '공결' });
  check('모르는 상태는 확인됨으로 기록하지 않음', (await listAttended())[0].verified === false);
  check('  화면이 쓸 수 있게 글자를 반환', r.verification.text === '공결');
  await clearAttended();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
