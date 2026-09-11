// HTML 파싱 유틸.
//
// ⚠ MV3 서비스 워커에는 DOMParser가 없다. 백그라운드 스캔(Phase 5)을 붙이려면
//    HTML 파싱이 워커 안에서 돌아가면 안 된다. 그래서 파싱 진입점을 여기 하나로
//    모아 두고, 워커에서는 offscreen 문서로 우회하도록 나중에 이 파일만 고친다.
//    문자열 기반 유틸(extractMoodleConfig 등)은 어디서든 동작한다.

function hasDomParser() {
  return typeof DOMParser !== 'undefined';
}

/** HTML 문자열을 Document로. DOMParser가 없는 컨텍스트에서는 명확히 실패한다. */
export function parseDocument(html) {
  if (!hasDomParser()) {
    throw new Error(
      'DOMParser를 쓸 수 없는 컨텍스트입니다. (MV3 서비스 워커) ' +
      'offscreen 문서를 경유하도록 src/lib/dom.js를 확장하세요.'
    );
  }
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * Moodle 페이지에 인라인으로 박혀 있는 `M.cfg = { ... };` 에서 필요한 값만 뽑는다.
 *
 * 객체 전체를 파싱하지 않는다. 우리가 쓰는 것은 sesskey 와 theme 두 개뿐이고,
 * 둘 다 평범한 문자열 필드다. `M.cfg =` 이후로 범위를 좁혀 찾으므로 페이지의
 * 다른 JSON 과 섞이지 않는다.
 */
export function extractMoodleConfig(html) {
  const marker = html.indexOf('M.cfg =');
  if (marker === -1) return null;
  const scope = html.slice(marker, marker + 4000);
  const pick = (key) => {
    const m = scope.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
    return m ? m[1] : null;
  };
  const theme = pick('theme');
  const sesskey = pick('sesskey');
  return theme || sesskey ? { theme, sesskey } : null;
}

/** 페이지 제목. 로그인 페이지 판별 등에 쓴다. */
export function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : '';
}

/** 공백 정규화 — 테이블 셀 텍스트 비교용. */
export function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}
