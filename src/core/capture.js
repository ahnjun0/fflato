// 캡처 모드.
//
// 활성 출결 세션이 열려야만 볼 수 있는 것들이 아직 남아 있다 — 모달이 실제로
// 어느 페이지에 렌더되는지, 폼의 히든 필드가 정확히 무엇인지. 첫 수업 때
// 그걸 확인하되, 시도 횟수를 소모하거나 결석 위험을 지지 않기 위해
// **제출하지 않고 관찰만 한다.**
//
// 저장하는 것은 서버가 보낸 것뿐이다. 사용자가 입력한 인증번호는 절대 남기지 않는다.

import { get, set, remove } from '../lib/storage.js';

const KEY = 'fflato.captures';
const MAX_ENTRIES = 5;
const MAX_HTML = 20000;

/** 절대 저장하지 않을 필드 — 사용자가 입력하는 값. */
const NEVER_STORE = new Set(['authkey']);

/**
 * @param session parseSession() 결과를 통째로 넘긴다.
 *   필드를 골라 옮기지 않는다 — 새 필드를 더할 때마다 빠뜨리게 된다.
 */
export async function saveCapture(session, courseName = null) {
  const list = await listCaptures();
  list.unshift(sanitize({ ...session, courseName }));
  await set(KEY, list.slice(0, MAX_ENTRIES));
}

export async function listCaptures() {
  const list = await get(KEY, []);
  return Array.isArray(list) ? list : [];
}

export async function clearCaptures() {
  await remove(KEY);
}

/**
 * 저장 전에 손질한다.
 * - 사용자 입력 필드는 값을 비우고 이름만 남긴다 (구조 파악에는 이름이면 충분).
 * - 모달 HTML 은 길이를 자른다.
 */
export function sanitize(entry) {
  const fields = {};
  for (const [name, value] of Object.entries(entry.fields || {})) {
    fields[name] = NEVER_STORE.has(name) ? '' : value;
  }

  return {
    capturedAt: new Date().toISOString(),
    courseId: entry.courseId ?? null,
    courseName: entry.courseName ?? null,
    pageUrl: entry.pageUrl ?? null,
    action: entry.action ?? null,
    fieldNames: Object.keys(fields).sort(),
    fields,
    endTime: entry.endTime ?? null,
    complete: entry.complete ?? null,
    reason: entry.reason ?? null,
    // 어느 방법으로 읽었는지, 어떤 값을 페이지가 아니라 상수로 채웠는지.
    // 이게 없으면 대조표가 상수를 상수와 비교하며 "일치" 라고 한다.
    readerId: entry.readerId ?? null,
    detectedBy: entry.detectedBy ?? null,
    assumed: Array.isArray(entry.assumed) ? entry.assumed : [],
    html: typeof entry.capturedHtml === 'string'
      ? entry.capturedHtml.slice(0, MAX_HTML)
      : null,
    htmlTruncated: typeof entry.capturedHtml === 'string' && entry.capturedHtml.length > MAX_HTML,
  };
}

/**
 * 대조 결과의 세 가지 상태.
 *
 * ok / bad 두 가지로만 나누면, 확인할 방법이 없는 값도 "다름" 으로 보인다.
 * 실제로는 값이 같고 대조가 성립하지 않을 뿐인데 고장처럼 읽힌다.
 */
export const CHECK_OK = 'ok';               // 페이지에서 읽은 값이 기대와 같다
export const CHECK_UNVERIFIABLE = 'skip';   // 대조할 근거가 없다 (상수로 채운 값)
export const CHECK_INFO = 'info';           // 판정 대상이 아니고 참고용이다
export const CHECK_BAD = 'bad';             // 기대와 다르다

/**
 * 캡처 결과가 우리 가정과 맞는지 대조한다.
 * 첫 수업 때 이 결과만 보면 제출을 켜도 되는지 판단할 수 있다.
 *
 * 각 행은 `state` 를 갖는다. `ok` 는 하위 호환을 위해 남기지만,
 * 화면은 `state` 를 봐야 한다 — `ok === false` 가 곧 이상은 아니다.
 */
export function compareWithAssumptions(capture, profile) {
  const expectedAction = new URL(profile.paths.smartbookAction, profile.base).toString();
  const typeParam = profile.typeParam;

  return [
    {
      label: 'action URL',
      expected: expectedAction,
      actual: capture.action,
      ok: capture.action === expectedAction,
    },
    (() => {
      const assumed = (capture.assumed || []).includes(typeParam);
      const value = capture.fields[typeParam] ?? '(없음)';
      const matches = capture.fields[typeParam] === profile.actions.submitAttendance;
      return {
        label: `${typeParam} 값`,
        expected: profile.actions.submitAttendance,
        actual: assumed ? `${value} (페이지에 없어 상수로 채움)` : value,
        // 상수로 채운 값은 대조의 의미가 없다. 확인했다고 표시하지도,
        // 틀렸다고 표시하지도 않는다 — 확인할 방법이 없다고 말한다.
        state: assumed ? CHECK_UNVERIFIABLE : (matches ? CHECK_OK : CHECK_BAD),
        ok: !assumed && matches,
        note: assumed
          ? '페이지가 이 값을 싣지 않아 우리가 채웁니다. 실제 확인은 제출 성공 여부로 갈립니다.'
          : null,
      };
    })(),
    {
      label: '읽은 방법',
      expected: '설정 JSON 또는 인라인',
      actual: `${capture.readerId || '(못 읽음)'} · 세션 감지 ${capture.detectedBy || '-'}`,
      ok: Boolean(capture.readerId),
    },
    {
      label: 'smartid',
      expected: '존재',
      actual: capture.fields.smartid ?? '없음',
      ok: 'smartid' in capture.fields,
    },
    {
      label: 'id (강좌)',
      expected: capture.courseId ?? '(모름)',
      actual: capture.fields.id ?? '없음',
      ok: capture.fields.id != null,
    },
    (() => {
      const extra = capture.fieldNames.filter(
        (n) => !['smartid', 'id', typeParam].includes(n)
      );
      return {
        label: '예상 밖 필드',
        expected: '없음',
        actual: extra.join(', ') || '없음',
        // 있어도 읽은 필드를 그대로 보내므로 문제되지 않는다. 정보로만 표시.
        state: extra.length ? CHECK_INFO : CHECK_OK,
        ok: true,
      };
    })(),
  ].map((row) => ({ state: row.ok ? CHECK_OK : CHECK_BAD, note: null, ...row }));
}
