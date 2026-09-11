// 페이지가 바뀌었는지 지켜본다.
//
// 자가진단은 **우리가 쓰는 것**이 아직 유효한지만 본다. 그래서 서버가 무언가를
// 더하는 변화는 잡지 못한다. 2026-09-04 에 출결 요약 섹션이 생겼을 때가 그랬다 —
// 기존 기능은 멀쩡했고, 사람이 우연히 발견했다. 그때 우리가 모르던 상태
// (조퇴)가 드러났다.
//
// 여기서는 본문의 클래스 토큰을 기준선과 대조해 **처음 보는 토큰**을 알린다.
// 스캔하며 이미 받은 문서를 볼 뿐이라 요청이 0회다.

import { KNOWN_MARKUP, isNoiseToken, sel } from '../config/selectors.js';
import { get, set, remove } from '../lib/storage.js';

const KEY = 'fflato.markup.v1';
const MAX_TOKENS = 40; // 한 번에 이만큼만 보관한다. 대개 몇 개다.

/** 문서 본문의 클래스 토큰 집합. */
export function collectTokens(doc) {
  const main = doc.querySelector('[role="main"]') || doc.body;
  const out = new Set();
  if (!main) return out;
  for (const el of main.querySelectorAll('*')) {
    const c = el.getAttribute && el.getAttribute('class');
    if (!c) continue;
    for (const tok of String(c).split(/\s+/)) if (tok) out.add(tok);
  }
  return out;
}

/**
 * 기준선에 없고 사용자가 확인하지도 않은 토큰을 골라낸다.
 * 사라진 토큰은 보지 않는다 — 상황에 따라 없는 것이 정상이다.
 */
export function newTokens(tokens, accepted = []) {
  const seen = new Set(accepted);
  return [...tokens]
    .filter((t) => !KNOWN_MARKUP.has(t) && !seen.has(t) && !isNoiseToken(t))
    .sort();
}

/**
 * 스캔 중에 호출한다. 새 토큰이 있으면 기록하고 돌려준다.
 *
 * **출석현황 페이지로 확인된 문서만 본다.** 로그인이 풀리면 PLATO 는 같은
 * 주소에 로그인 화면을 내주는데, 그걸 기준선과 대조하면 남의 페이지를 놓고
 * "PLATO 가 바뀌었다" 고 말하게 된다. 실제로 그렇게 헛경보가 났다.
 */
export async function watch(doc, { profile = null } = {}) {
  if (!looksLikeStatusPage(doc, profile)) {
    return { changed: false, tokens: [], firstSeen: null, skipped: 'not_status_page' };
  }
  const state = await load();
  const found = newTokens(collectTokens(doc), state.accepted);
  if (found.length === 0) return { changed: false, tokens: [], firstSeen: state.firstSeen };

  const merged = [...new Set([...state.tokens, ...found])].slice(0, MAX_TOKENS);
  const firstSeen = state.firstSeen || new Date().toISOString();
  await set(KEY, { ...state, tokens: merged, firstSeen });
  return { changed: true, tokens: merged, firstSeen };
}

/** 사용자가 확인했다고 표시. 다음부터는 알리지 않는다. */
export async function acceptChanges() {
  const state = await load();
  await set(KEY, {
    accepted: [...new Set([...state.accepted, ...state.tokens])].slice(0, 200),
    tokens: [],
    firstSeen: null,
  });
}

/**
 * 출석현황 페이지가 맞는가.
 *
 * 출결 표는 이 페이지의 정체다. 세션이 열렸든 아니든, 지나간 차시가 있든
 * 없든 항상 있다(셀렉터 required: 'always'). 반대로 로그인 화면에는 없다.
 */
export function looksLikeStatusPage(doc, profile = null) {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  // 셀렉터는 한 곳에서만 정의한다. 여기에 CSS 를 다시 적으면 PLATO 가 표
  // 클래스를 바꿀 때 두 곳이 어긋난다.
  const css = profile ? sel(profile, 'statusTable') : 'table.table-local-ubattend';
  return Boolean(doc.querySelector(css));
}

export async function pendingChanges() {
  const state = await load();
  // 저장해 둔 것 중에도 노이즈가 있을 수 있다 — 이 규칙이 생기기 전에
  // 기록된 것들이다. 지우라고 시키지 않고 읽을 때 걸러 낸다.
  const tokens = state.tokens.filter((t) => !isNoiseToken(t));
  return {
    tokens,
    firstSeen: tokens.length ? state.firstSeen : null,
    accepted: state.accepted.length,
  };
}

export async function clearMarkupWatch() {
  await remove(KEY);
}

async function load() {
  const raw = await get(KEY, null);
  return {
    tokens: Array.isArray(raw && raw.tokens) ? raw.tokens : [],
    accepted: Array.isArray(raw && raw.accepted) ? raw.accepted : [],
    firstSeen: (raw && raw.firstSeen) || null,
  };
}
