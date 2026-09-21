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

  return interpretResult(result, active.messages || {});
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
 * 규칙은 PLATO 의 AMD 핸들러(2026-09-16, local_ubsmartbook/my)와 같다:
 *   ok:true              → 출석 처리
 *   error 'ended'        → 자동출결 종료
 *   error 'exceeded'     → 시도 횟수 초과 (남은 횟수 0)
 *   error 'wrong_key'    → 불일치. remain 에 남은 횟수가 실려 온다
 *   그 밖의 error        → PLATO 도 "불일치" 로 취급한다
 *
 * 문구는 페이지 설정 JSON 이 준 것(messages)을 우선 쓴다. 서버가 언어에 맞춰
 * 준 것이라 우리가 적어 둔 한국어보다 낫다. 없으면 우리 문구로.
 *
 * 모르는 코드는 PLATO 처럼 "불일치" 로 말하되, 서버 응답을 뒤에 붙인다.
 * PLATO 가 새 코드를 더했을 때 사용자가 단서를 잃지 않게 — 2.0.0 이 서버
 * 코드를 그대로 내보내 화면에 wrong_key 가 떴던 것과, 코드를 숨겨 엉뚱한 번호를
 * 다시 넣게 하는 것 사이의 절충이다.
 */
export function interpretResult(res, messages = {}) {
  if (res.ok) return { ok: true, kind: 'success', message: messages.success || '출석 완료!' };

  const ours = {
    ended: '자동출결이 종료되었습니다.',
    wrong_key: '인증번호가 일치하지 않습니다.',
    exceeded: '인증번호 시도 횟수를 초과했습니다.',
    rejected: '세션이 만료되었습니다. 새로고침 후 다시 시도해주세요.',
    contract_changed: 'PLATO 제출 방식이 바뀐 것 같습니다. 확장 프로그램 업데이트가 필요합니다.',
    non_json: 'PLATO 응답 형식이 바뀌었습니다. 확장 프로그램 업데이트가 필요합니다.',
    no_sesskey: '로그인 정보를 확인할 수 없습니다. PLATO에 다시 로그인해주세요.',
  };
  const kind = res.kind || 'failure';
  const detail = res.msg || null;
  const remain = typeof res.remain === 'number' ? res.remain : null;

  let message = messages[kind] || ours[kind];
  if (!message) {
    // 모르는 코드
    message = messages.wrong_key || ours.wrong_key;
    if (detail) message += ` (서버 응답: ${detail})`;
  }
  if (kind === 'wrong_key' && remain !== null) message += ` 남은 시도 ${remain}회.`;

  return { ok: false, kind, message, detail, remain };
}
