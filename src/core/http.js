// PLATO 통신 계층.
//
// 신 시스템은 theme_coursemos/CsmsFetch 규약을 쓴다:
//   - multipart FormData 로 POST
//   - X-Requested-With: XMLHttpRequest 헤더
//   - sesskey 자동 첨부
//   - 응답은 항상 JSON { code, msg, ... }, code 는 100/300/310/399
// 이 파일은 그 규약을 그대로 옮긴 것이다.

import { extractMoodleConfig, extractTitle } from '../lib/dom.js';

const DEFAULT_TIMEOUT = 15000;

// 로그인이 풀렸을 때 Moodle 웹서비스가 주는 오류코드들.
// 사람이 읽는 문구가 아니라 코드라 언어 설정과 무관하다.
const NOT_LOGGED_IN_CODES = new Set([
  'servicerequireslogin',
  'requireloginerror',
  'notloggedin',
  'sessionerroruser',
]);

export function isNotLoggedInCode(code) {
  return NOT_LOGGED_IN_CODES.has(String(code));
}

/** 화면이 메시지 문자열을 뒤져 분기하지 않도록 오류에 kind 를 단다. */
function tagged(message, kind) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

/** 쿠키를 실어 보내는 fetch. 확장 컨텍스트에서는 credentials를 명시해야 한다. */
async function platoFetch(url, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { credentials: 'include', signal: controller.signal, ...rest });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw tagged(`요청 시간 초과 (${Math.round(timeout / 1000)}초)`, 'network');
    }
    throw tagged(
      err.message.includes('Failed to fetch')
        ? 'PLATO 서버에 연결할 수 없습니다. 네트워크를 확인해주세요.'
        : `네트워크 오류: ${err.message}`,
      'network'
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTML을 문자열로 받아온다. M.cfg / title 도 함께 뽑아 둔다.
 *
 * 로그인이 풀리면 Moodle 은 로그인 페이지로 리다이렉트하는데, fetch 가 따라가서
 * **HTTP 200** 으로 돌아온다(라이브 확인). 그 페이지에도 sesskey 가 들어 있어서
 * 값만 보고는 구분되지 않는다. 최종 URL 경로로 판별한다 — 언어 설정과 무관하다.
 *
 * 이걸 구분하지 않으면 "인증번호 폼이 없다 → 출결 없음" 으로 읽어, 로그아웃된
 * 상태에서 출결이 열려 있어도 없다고 말하게 된다.
 */
export async function fetchPage(url) {
  const res = await platoFetch(url);
  const html = await res.text();
  let isLoginPage = false;
  try {
    isLoginPage = new URL(res.url).pathname.startsWith('/login/');
  } catch { /* 상대 URL 등은 판별하지 않는다 */ }

  return {
    ok: res.ok,
    status: res.status,
    url: res.url,
    isLoginPage,
    html,
    cfg: extractMoodleConfig(html),
    title: extractTitle(html),
  };
}

/**
 * ubsmartbook/action.php 호출.
 *
 * 페이지의 인라인 스크립트가 jQuery `$.post` 를 쓰므로 본문은
 * application/x-www-form-urlencoded 다. 응답은 { ok, error } JSON.
 *
 * 필수 파라미터(action, id, sesskey)가 빠지거나 sesskey 가 틀리면 서버는
 * JSON 이 아니라 404 HTML 을 돌려준다 (라이브 확인). 그 경우를 구분해야
 * "세션 만료" 를 "확장 업데이트 필요" 로 잘못 안내하지 않는다.
 */
export async function actionPost(profile, actionUrl, fields, sesskey) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v !== undefined && v !== null) body.append(k, String(v));
  }
  if (!body.has('sesskey')) {
    if (!sesskey) throw tagged('sesskey가 없습니다. 먼저 세션을 확인하세요.', 'no_sesskey');
    body.append('sesskey', sesskey);
  }

  const res = await platoFetch(actionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  });

  const text = await res.text();

  if (!res.ok || !text.trim().startsWith('{')) {
    // 404 HTML. sesskey 만료가 가장 흔하고, 경로나 필수 파라미터가 바뀌었을
    // 수도 있다. 어느 쪽이든 한 번 재취득해 보는 것이 맞다.
    return { ok: false, kind: 'rejected', msg: '세션이 만료되었거나 요청이 거부되었습니다.', raw: null };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      kind: 'non_json',
      msg: 'PLATO 응답 형식이 바뀌었습니다.',
      raw: text.slice(0, 500),
    };
  }

  if (json.ok) return { ok: true, kind: 'success', msg: '', raw: json };

  const error = String(json.error ?? '');
  return {
    ok: false,
    kind: error === profile.endedError ? 'ended' : 'failure',
    msg: error,
    raw: json,
  };
}

/** Moodle 표준 AJAX 웹서비스 호출. 대시보드 스크래핑을 대체한다. */
export async function callWebService(profile, sesskey, methodname, args) {
  const url = new URL(profile.paths.ajaxService, profile.base);
  url.searchParams.set('sesskey', sesskey);
  url.searchParams.set('info', methodname);

  const res = await platoFetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ index: 0, methodname, args }]),
  });

  if (!res.ok) throw new Error(`웹서비스 오류 (HTTP ${res.status})`);

  const payload = await res.json();
  const first = payload && payload[0];
  if (!first) throw new Error('웹서비스가 빈 응답을 반환했습니다.');
  if (first.error) {
    const code = (first.exception && first.exception.errorcode) || 'unknown';
    // 캐시한 sesskey 가 만료되면 여기로 온다. 호출부가 갱신 후 재시도할 수 있게
    // errorcode 를 그대로 실어 보낸다.
    const err = isNotLoggedInCode(code)
      ? new Error('PLATO에 로그인되어 있지 않습니다.')
      : new Error(`웹서비스 실패 (${code})`);
    err.errorcode = code;
    if (isNotLoggedInCode(code)) err.kind = 'not_logged_in';
    throw err;
  }
  return first.data;
}

function toFormData(obj) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null) fd.append(k, String(v));
  }
  return fd;
}
