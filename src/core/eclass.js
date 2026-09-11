// 자율강좌 목록.
//
// PLATO 는 자율강좌만 싣는 페이지를 따로 제공한다 (/local/ubeclass/my.php).
// **서버가 스스로 가르는 기준**이므로, shortname 이 해시처럼 생겼는지 보는
// 추측보다 확실하다. 실측에서 교과 과목은 한 건도 섞이지 않았다.
//
// 신 대시보드에는 구분 표시가 없다. 구 시스템에는 li.course-label-r(교과) /
// li.course-label-cms-e(자율) 클래스가 있었지만 개편되며 사라졌다.
//
// 이 목록이 없으면(요청 실패 등) 조용히 빈 목록을 돌려준다. 그러면 출석부
// 유무로 가리는 기존 경로가 그대로 동작한다 — 느릴 뿐 틀리지 않는다.

import { url } from '../config/endpoints.js';
import { sel } from '../config/selectors.js';
import { fetchPage } from './http.js';
import { parseDocument } from '../lib/dom.js';
import { get, set, remove } from '../lib/storage.js';

const KEY = 'fflato.eclass.v1';
const STALE_HOURS = 24;

/** 자율강좌 ID 집합. 캐시가 살아 있으면 요청하지 않는다. */
export async function getSelfCourseIds(session, { force = false } = {}) {
  if (!force) {
    const cached = await get(KEY, null);
    if (cached && Array.isArray(cached.ids)) {
      const age = Date.now() - Date.parse(cached.fetchedAt);
      if (age >= 0 && age < STALE_HOURS * 3600_000) {
        return { ids: new Set(cached.ids), fromCache: true, fetchedAt: cached.fetchedAt };
      }
    }
  }

  try {
    const page = await fetchPage(url(session.profile, 'eclassMy'));
    if (page.isLoginPage) {
      const err = new Error('PLATO 로그인이 풀렸습니다.');
      err.kind = 'not_logged_in';
      throw err;
    }
    if (!page.ok) return { ids: new Set(), fromCache: false, failed: `HTTP ${page.status}` };

    const ids = parseSelfCourseIds(parseDocument(page.html), session.profile);
    await set(KEY, { ids: [...ids], fetchedAt: new Date().toISOString() });
    return { ids, fromCache: false, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (err.kind === 'not_logged_in') throw err;
    // 목록을 못 받아도 치명적이지 않다. 출석부 유무로 가리는 경로가 남아 있다.
    return { ids: new Set(), fromCache: false, failed: err.message };
  }
}

export function parseSelfCourseIds(doc, profile) {
  const ids = new Set();
  for (const a of doc.querySelectorAll(sel(profile, 'eclassCard'))) {
    const m = (a.getAttribute('href') || '').match(/\/course\/view\.php\?id=(\d+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

export async function clearSelfCourses() {
  await remove(KEY);
}

export const SELF_LIST_LIFETIME = { hours: STALE_HOURS, label: `${STALE_HOURS}시간` };
