// 출결 제출.
//
// 요청 본문은 감지 단계에서 페이지의 $.post 호출에서 읽어 둔 파라미터를 그대로
// 쓰고, sesskey 와 authkey 만 채운다. 파라미터 이름을 하드코딩하지 않는다.
//
//   POST /local/ubsmartbook/action.php   (x-www-form-urlencoded)
//     action=smartanswer  id=<courseid>  smartid=<n>  sesskey=<...>  authkey=<입력>
//   → { ok: true } | { ok: false, error: "..." }

import { actionPost } from './http.js';
import { refreshSesskey } from './session.js';
import { url } from '../config/endpoints.js';

const AUTHKEY_FIELD = 'authkey';

/**
 * @param options  transport/refresh 는 테스트에서 갈아 끼우기 위한 것
 * @returns {{ ok, kind, message }}
 */
export async function submitAttendance(session, active, authkey, options = {}) {
  const { transport = actionPost, refresh = refreshSesskey } = options;

  const code = String(authkey ?? '').trim();
  if (!code) {
    return { ok: false, kind: 'empty_input', message: '인증번호를 입력해주세요.' };
  }
  if (!active || !active.action) {
    return {
      ok: false,
      kind: 'no_session',
      message: '출결 세션 정보가 없습니다. 새로고침 후 다시 시도해주세요.',
    };
  }

  let result = await post(session, active, code, { transport });

  // 서버가 JSON 대신 404 를 준 경우다. sesskey 만료가 가장 흔하다.
  // 인증번호 시도로 세지 않으므로 여기서만 자동 재시도가 정당하다.
  // 인증번호가 틀린 경우(ok:false + error)는 절대 재시도하지 않는다.
  if (result.kind === 'rejected') {
    try {
      const before = session.sesskey;
      await refresh(session);
      // sesskey 가 그대로라면 404 의 원인은 sesskey 가 아니다. 그런데도 다시
      // 보내면 같은 인증번호를 두 번 제출하게 된다 — 틀린 번호였다면 시도
      // 횟수를 두 번 쓰는 셈이다. 틀린 번호가 404 로 오는지는 관측한 적이
      // 없으므로(PLATO 코드상 200 JSON 이 맞다), 확인될 때까지 이쪽이 안전하다.
      if (session.sesskey === before) {
        result = { ...result, kind: 'contract_changed' };
      } else {
        result = await post(session, active, code, { retried: true, transport });
        // 방금 받은 sesskey 로도 거부됐다면 세션 만료가 아니다. 엔드포인트나
        // action 이름이 바뀐 쪽이 훨씬 그럴듯하다 — action 값은 페이지에서
        // 읽을 수 없어 우리가 상수로 채우는 유일한 값이다.
        if (result.kind === 'rejected') result = { ...result, kind: 'contract_changed' };
      }
    } catch (err) {
      return { ok: false, kind: 'not_logged_in', message: err.message };
    }
  }

  return interpretResult(result);
}

function post(session, active, code, { retried = false, transport = actionPost } = {}) {
  const fields = { ...active.fields };
  fields[AUTHKEY_FIELD] = code;
  if (retried || !fields.sesskey) fields.sesskey = session.sesskey;

  // 페이지에서 읽지 못했을 때만 프로파일 상수로 메운다.
  const target = active.action || url(session.profile, 'smartbookAction');
  if (!fields[session.profile.typeParam]) {
    fields[session.profile.typeParam] = session.profile.actions.submitAttendance;
  }
  if (!fields.id && active.courseId) fields.id = active.courseId;

  return transport(session.profile, target, fields, session.sesskey);
}

/**
 * 응답을 화면에 그대로 쓸 수 있는 형태로 옮긴다.
 *
 * 틀린 인증번호의 판정은 PLATO 자체 화면과 같은 규칙이다 (실측, 2026-09-01
 * 페이지의 인라인 핸들러):
 *   ok:true             → 출석 처리
 *   error === 'ended'   → 자동출결 종료
 *   그 밖의 ok:false     → "인증번호가 일치하지 않습니다"
 * PLATO 도 서버의 error 문구를 화면에 쓰지 않는다. 우리도 문구를 보고 판정하지
 * 않는다 — 서버가 무엇을 적어 보내든, 언어 설정이 무엇이든 같은 결과다.
 * 서버 문구는 detail 로만 남겨 debug 에서 볼 수 있게 한다.
 */
export function interpretResult(res) {
  if (res.ok) return { ok: true, kind: 'success', message: '출석 완료!' };

  const message = {
    ended: '자동출결이 종료되었습니다.',
    rejected: '세션이 만료되었습니다. 새로고침 후 다시 시도해주세요.',
    contract_changed: 'PLATO 제출 방식이 바뀐 것 같습니다. 확장 프로그램 업데이트가 필요합니다.',
    non_json: 'PLATO 응답 형식이 바뀌었습니다. 확장 프로그램 업데이트가 필요합니다.',
    no_sesskey: '로그인 정보를 확인할 수 없습니다. PLATO에 다시 로그인해주세요.',
  }[res.kind] || '인증번호가 일치하지 않습니다.';

  return { ok: false, kind: res.kind || 'failure', message, detail: res.msg || null };
}
