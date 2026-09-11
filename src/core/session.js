// 세션 계층: 어떤 PLATO에 붙었는지, 로그인은 되어 있는지, sesskey는 무엇인지.
//
// 구 버전은 `.front-box-course` 존재 여부로 로그인을 판별했다. 테마 마크업에
// 의존하는 취약한 검사였다. 신 버전은 M.cfg 를 근거로 삼는다 — 모든 Moodle
// 페이지에 있고, 미로그인 상태에서는 sesskey가 비어 있다.

import { profileForHost, profileForConfig, url } from '../config/endpoints.js';
import { fetchPage } from './http.js';
import { get, set, remove } from '../lib/storage.js';

// sesskey 는 Moodle 세션이 살아 있는 동안 그대로다 (M.cfg.sessiontimeout 은 7200초).
// 그런데 이걸 얻으려고 홈페이지를 받으면 1067ms 가 든다 — 10글자를 받자고
// 수업 중 경로의 68% 를 쓰는 셈이다. 그래서 캐시한다.
//
// 캐시가 낡았는지 미리 확인하지 않는다. 확인하려면 또 요청해야 하기 때문이다.
// 대신 실제로 쓸 때 서버가 알려주는 신호로 판별한다:
//   웹서비스  → errorcode "invalidsesskey"
//   action.php → HTTP 200 에 빈 본문
// 그때 홈페이지를 받아 갱신하고 한 번 재시도한다.
const SESSION_KEY = 'fflato.session.v1';
const MAX_AGE_MS = 60 * 60 * 1000;

// 밖에서는 err.kind 로 구분한다. 클래스 자체를 내보내지 않는 이유는
// 호출부가 import 없이도 분기할 수 있게 하기 위해서다.
class NotLoggedInError extends Error {
  constructor(profile) {
    super('PLATO에 로그인되어 있지 않습니다. 먼저 로그인해주세요.');
    this.name = 'NotLoggedInError';
    this.kind = 'not_logged_in';
    this.profile = profile;
  }
}

class ProfileMismatchError extends Error {
  constructor(expected, actual) {
    super(
      `PLATO 구조가 예상과 다릅니다. (기대: ${expected}, 실제: ${actual || '판별 불가'}) ` +
      '확장 프로그램 업데이트가 필요할 수 있습니다.'
    );
    this.name = 'ProfileMismatchError';
    this.kind = 'plato_changed';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * 세션을 연다. 반환: { profile, sesskey, cfg, themeMatched }
 *
 * host를 넘기면 그 서버로, 생략하면 신 PLATO로 붙는다.
 * strict=true 면 테마 지문이 프로파일과 어긋날 때 throw 한다.
 * allowCached=false 면 캐시를 무시하고 홈페이지를 받는다.
 */
export async function openSession({ host, strict = true, allowCached = true } = {}) {
  const profile = profileForHost(host || new URL(profileForHost().base).host);

  if (allowCached) {
    const cached = await get(SESSION_KEY, null);
    if (cached && cached.profileId === profile.id && cached.sesskey) {
      const age = Date.now() - (cached.at || 0);
      if (age >= 0 && age < MAX_AGE_MS) {
        return {
          profile,
          sesskey: cached.sesskey,
          cfg: null,
          themeMatched: cached.themeMatched !== false,
          fromCache: true,
        };
      }
    }
  }

  return fetchSession(profile, strict);
}

async function fetchSession(profile, strict) {
  const page = await fetchPage(url(profile, 'home'));

  if (!page.ok) {
    throw new Error(`PLATO 서버 오류 (HTTP ${page.status})`);
  }

  const cfg = page.cfg;
  if (!cfg) {
    throw new Error(
      'PLATO 페이지에서 설정 정보(M.cfg)를 찾지 못했습니다. PLATO가 변경되었을 수 있습니다.'
    );
  }
  if (!cfg.sesskey) {
    throw new NotLoggedInError(profile);
  }

  // 테마 지문으로 프로파일을 교차 검증한다.
  const detected = profileForConfig(cfg);
  if (strict && detected && detected.id !== profile.id) {
    throw new ProfileMismatchError(profile.id, detected.id);
  }

  // 지문이 아예 안 잡히면(새 테마) 경고만 남기고 진행한다.
  const themeMatched = Boolean(detected && detected.id === profile.id);

  await set(SESSION_KEY, {
    profileId: profile.id,
    sesskey: cfg.sesskey,
    themeMatched,
    at: Date.now(),
  });

  return { profile, sesskey: cfg.sesskey, cfg, themeMatched, fromCache: false };
}

/** 캐시된 sesskey 가 거부됐을 때. 홈페이지를 받아 갱신한다. */
export async function refreshSesskey(session) {
  const fresh = await fetchSession(session.profile, false);
  session.sesskey = fresh.sesskey;
  session.cfg = fresh.cfg;
  session.fromCache = false;
  return session.sesskey;
}

export async function forgetSession() {
  await remove(SESSION_KEY);
}
