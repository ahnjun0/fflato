import { submitAttendance, interpretResult } from '../src/core/submit.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(50) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const PROFILE = {
  base: 'https://plato.pusan.ac.kr',
  paths: { smartbookAction: '/local/ubsmartbook/action.php' },
  typeParam: 'action',
  actions: { submitAttendance: 'smartanswer' },
  endedError: 'ended',
};
const session = () => ({ profile: PROFILE, sesskey: 'SESS1' });
// 실제 페이지의 $.post 에서 읽어 온 형태
const active = () => ({
  courseId: '1001',
  action: 'https://plato.pusan.ac.kr/local/ubsmartbook/action.php',
  fields: { id: '1001', action: 'smartanswer', smartid: '12345' },
});

// --- 응답 해석 ---
check('ok:true 는 성공', interpretResult({ ok: true, kind: 'success' }).message === '출석 완료!');
check('인증번호 불일치는 서버 문구 그대로',
  interpretResult({ ok: false, kind: 'failure', msg: '인증번호가 일치하지 않습니다.' }).message === '인증번호가 일치하지 않습니다.');
check('error:ended 는 종료 안내',
  interpretResult({ ok: false, kind: 'ended', msg: 'ended' }).message.includes('종료'));
check('404 응답은 세션 만료 안내 (업데이트 안내 아님)', (() => {
  const m = interpretResult({ ok: false, kind: 'rejected' }).message;
  return m.includes('세션이 만료') && !m.includes('업데이트');
})());
check('비JSON 은 업데이트 안내', interpretResult({ ok: false, kind: 'non_json' }).message.includes('업데이트'));

// --- 입력 검증 ---
check('빈 인증번호는 요청조차 하지 않음',
  (await submitAttendance(session(), active(), '  ', { transport: () => { throw new Error('불려선 안 됨'); } })).kind === 'empty_input');
check('세션 정보 없으면 거부',
  (await submitAttendance(session(), null, '123456', { transport: () => { throw new Error('불려선 안 됨'); } })).kind === 'no_session');

// --- 페이지에서 읽은 파라미터를 그대로 보내는가 ---
{
  let sent = null;
  await submitAttendance(session(), active(), ' 482913 ', {
    transport: async (p, urlStr, fields) => { sent = { urlStr, fields }; return { ok: true, kind: 'success' }; },
  });
  check('action URL 은 페이지에서 읽은 값', sent.urlStr === 'https://plato.pusan.ac.kr/local/ubsmartbook/action.php');
  check('smartid 를 그대로 전달', sent.fields.smartid === '12345');
  check('action 파라미터도 페이지 값', sent.fields.action === 'smartanswer');
  check('id 그대로', sent.fields.id === '1001');
  check('authkey 만 사용자 입력 (공백 제거)', sent.fields.authkey === '482913');
  check('원본 active.fields 를 변형하지 않음', !('authkey' in active().fields));
}

// --- 페이지에서 못 읽었을 때 폴백 ---
{
  let sent = null;
  await submitAttendance(session(),
    { courseId: '1001', action: 'https://plato.pusan.ac.kr/local/ubsmartbook/action.php', fields: {} }, '111111', {
      transport: async (p, u, fields) => { sent = fields; return { ok: true, kind: 'success' }; },
    });
  check('action 폴백', sent.action === 'smartanswer');
  check('id 폴백', sent.id === '1001');
  check('sesskey 폴백', sent.sesskey === 'SESS1');
}

// --- 재시도 경계 ---
{
  let calls = 0, refreshed = 0;
  const r = await submitAttendance(session(), active(), '111111', {
    transport: async () => (++calls === 1 ? { ok: false, kind: 'rejected' } : { ok: true, kind: 'success' }),
    refresh: async (s) => { refreshed++; s.sesskey = 'SESS2'; },
  });
  check('404 → sesskey 갱신 후 1회 재시도', calls === 2 && refreshed === 1 && r.ok, `호출 ${calls}회`);
}
{
  let calls = 0;
  await submitAttendance(session(), active(), '111111', {
    transport: async () => { calls++; return { ok: false, kind: 'failure', msg: '인증번호가 일치하지 않습니다.' }; },
  });
  check('인증번호 불일치는 재시도하지 않음', calls === 1, `호출 ${calls}회`);
}
{
  let calls = 0;
  await submitAttendance(session(), active(), '111111', {
    transport: async () => { calls++; return { ok: false, kind: 'ended', msg: 'ended' }; },
  });
  check('종료된 세션도 재시도하지 않음', calls === 1, `호출 ${calls}회`);
}
{
  let calls = 0;
  await submitAttendance(session(), active(), '111111', {
    transport: async () => { calls++; return { ok: false, kind: 'rejected' }; },
    refresh: async () => {},
  });
  check('404 가 계속돼도 재시도는 1회뿐', calls === 2, `호출 ${calls}회`);
}
{
  const r = await submitAttendance(session(), active(), '111111', {
    transport: async () => ({ ok: false, kind: 'rejected' }),
    refresh: async () => { throw new Error('PLATO에 로그인되어 있지 않습니다.'); },
  });
  check('재로그인 실패 시 안내', r.kind === 'not_logged_in');
}

{
  // 새 sesskey 로도 404 면 세션 문제가 아니다. 규약이 바뀌었다고 말해야
  // 사용자가 인증번호를 반복해서 누르는 헛수고를 하지 않는다.
  const r = await submitAttendance(session(), active(), '111111', {
    transport: async () => ({ ok: false, kind: 'rejected' }),
    refresh: async () => {},
  });
  check('갱신 후에도 404 면 규약 변경으로 진단', r.kind === 'contract_changed', r.kind);
  check('규약 변경은 업데이트를 안내', /업데이트/.test(r.message), r.message);
}
{
  // 첫 404 만 보고 성급히 규약 변경이라고 하면 안 된다 — 진짜 만료일 수 있다.
  let calls = 0;
  const r = await submitAttendance(session(), active(), '111111', {
    transport: async () => (++calls === 1 ? { ok: false, kind: 'rejected' }
                                          : { ok: false, kind: 'wrong_code', msg: 'x' }),
    refresh: async () => {},
  });
  check('갱신 후 다른 응답이면 규약 변경이 아님', r.kind !== 'contract_changed', r.kind);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
