// 셀렉터 · 엔드포인트 자가진단.
//
// PLATO는 예고 없이 바뀐다. 2026-09 개편 때는 출결 플러그인이 통째로 교체됐고,
// 확장은 수업 당일에야 조용히 실패했다. 이 모듈은 "무엇이 아직 유효한가"를
// 확장 스스로 검사해 그런 상황을 미리 드러낸다.
//
// 두 종류를 검사한다:
//   1) 마크업 의존 — selectors.js 의 셀렉터와 정규식을 실제 페이지에 대조
//   2) 액션 이름    — action.php 가 "[X] 으로 등록된 함수가 없습니다" 를 돌려주는지
//
// 2번은 PLATO 자신이 제공하는 오라클이다. 미등록 함수와 등록된 함수의 응답이
// 달라서, 파라미터를 채우지 않고도 이름의 유효성만 확인할 수 있다.
// 판별은 메시지 문구가 아니라 응답에 [액션이름] 이 박혀 있는지로 한다 —
// PLATO 는 한국어·영어·중국어를 지원하고 문구는 언어마다 다르다.

import { url } from '../config/endpoints.js';
import { specsFor, patternsFor, STATUS_CHIPS } from '../config/selectors.js';
import { parseStatusSummary } from './schedule.js';
import { fetchPage, actionPost } from './http.js';
import { parseDocument } from '../lib/dom.js';

/**
 * @param session openSession() 결과
 * @param courseId 강좌별 페이지를 검사할 때 쓸 강좌 ID (없으면 해당 항목은 건너뜀)
 */
export async function runHealthCheck(session, courseId, subjectName = null) {
  const { profile } = session;
  const specs = specsFor(profile);
  const patterns = patternsFor(profile);

  // 페이지별로 한 번씩만 받아 온다.
  const pages = [...new Set([...specs, ...patterns].map((s) => s.page))];
  const docs = {};
  const htmls = {};
  const pageResults = [];

  for (const pageKey of pages) {
    const needsCourse = pageKey !== 'home';
    if (needsCourse && !courseId) {
      pageResults.push({ page: pageKey, status: 'skipped', reason: '강좌 ID가 없어 건너뜀' });
      continue;
    }
    try {
      const target = url(profile, pageKey, needsCourse ? { id: courseId } : null);
      const page = await fetchPage(target);
      docs[pageKey] = parseDocument(page.html);
      htmls[pageKey] = page.html;
      pageResults.push({
        page: pageKey,
        status: page.ok ? 'ok' : 'error',
        httpStatus: page.status,
        bytes: page.html.length,
        title: page.title,
      });
    } catch (err) {
      pageResults.push({ page: pageKey, status: 'error', reason: err.message });
    }
  }

  const selectorResults = specs.map((spec) => {
    const doc = docs[spec.page];
    if (!doc) {
      return { ...spec, verdict: 'skipped', count: null };
    }
    let count = doc.querySelectorAll(spec.css).length;
    let usedFallback = false;
    if (count === 0 && spec.fallback) {
      count = doc.querySelectorAll(spec.fallback).length;
      usedFallback = count > 0;
    }
    const verdict = count > 0
      ? (usedFallback ? 'fallback' : 'ok')
      : (spec.required === 'always' ? 'broken' : 'empty');
    return { ...spec, verdict, count, usedFallback };
  });

  // 정규식도 같은 기준으로 판정한다. 셀렉터와 성격이 같은 의존이다.
  const patternResults = patterns.map((spec) => {
    const html = htmls[spec.page];
    if (html === undefined) return { ...spec, verdict: 'skipped', count: null, css: String(spec.re) };
    const count = (html.match(new RegExp(spec.re.source, 'g')) || []).length;
    return {
      ...spec,
      css: String(spec.re),
      count,
      verdict: count > 0 ? 'ok' : (spec.required === 'always' ? 'broken' : 'empty'),
    };
  });
  selectorResults.push(...patternResults);

  // 서버가 페이지에 싣는 출결 상태 범례를 우리 목록과 대조한다.
  // 2026-09-04 에 PLATO 가 "조퇴" 를 추가했는데 우리 목록에는 없었다.
  // 그런 변화를 다음부터는 여기서 잡는다.
  const legendResult = checkStatusLegend(docs.smartbookMy, profile);

  const actionResults = await checkActions(session, courseId);

  const broken = selectorResults.filter((r) => r.verdict === 'broken');
  const legendDrift = legendResult.unknown.length > 0;
  const missingActions = actionResults.filter((r) => r.verdict === 'missing');
  // 오라클 자체가 못 쓰게 된 것도 고장이다. 조용히 통과시키면 검사의 의미가 없다.
  const unusableActions = actionResults.filter((r) => r.verdict === 'unusable');

  return {
    profile: profile.id,
    profileLabel: profile.label,
    subjectName,
    themeMatched: session.themeMatched,
    checkedAt: new Date().toISOString(),
    pages: pageResults,
    selectors: selectorResults,
    actions: actionResults,
    legend: legendResult,
    healthy:
      broken.length === 0 &&
      !legendDrift &&
      missingActions.length === 0 &&
      unusableActions.length === 0 &&
      session.themeMatched,
    summary: {
      selectorsOk: selectorResults.filter((r) => r.verdict === 'ok' || r.verdict === 'fallback').length,
      selectorsBroken: broken.length,
      selectorsEmpty: selectorResults.filter((r) => r.verdict === 'empty').length,
      actionsOk: actionResults.filter((r) => r.verdict === 'ok').length,
      actionsMissing: missingActions.length,
      actionsUnusable: unusableActions.length,
      legendUnknown: legendResult.unknown.length,
      actionsSkipped: actionResults.filter((r) => r.verdict === 'skipped').length,
    },
  };
}

/**
 * 페이지의 출결 상태 범례와 우리 목록(STATUS_CHIPS)을 대조한다.
 *
 * 서버가 "세부 출결 상태" 에 모든 종류를 실어 주므로, 우리가 모르는 상태가
 * 생기면 여기서 바로 드러난다. 반대로 우리 목록에만 있고 서버에 없는 것도
 * 알려 준다 — 지워도 되는지 판단할 근거가 된다.
 */
function checkStatusLegend(doc, profile) {
  if (!doc) return { available: false, unknown: [], extra: [], legend: {} };

  const summary = parseStatusSummary(doc, profile);
  if (!summary) return { available: false, unknown: [], extra: [], legend: {} };

  const serverChips = Object.keys(summary.legend);
  const unknown = serverChips.filter((c) => !(c in STATUS_CHIPS));
  const extra = Object.keys(STATUS_CHIPS).filter((c) => !serverChips.includes(c));
  return { available: true, legend: summary.legend, unknown, extra };
}

/**
 * action.php 의 액션 이름이 아직 살아 있는지 확인한다.
 *
 * 오라클: 필수 파라미터(action, id, sesskey)가 갖춰지면
 *   · 알려진 액션  → 200 JSON  { ok:false, error:"필수 매개변수 (smartid) 누락" }
 *   · 모르는 액션  → 404 HTML
 * JSON 이 오느냐 아니냐로 판별하므로 서버 메시지 문구에 의존하지 않는다.
 * PLATO 는 한국어·영어·중국어를 지원하고 문구는 언어마다 다르다.
 *
 * ⚠ id 는 생략할 수 없다. 없으면 액션 이름을 보기도 전에 404 가 온다.
 */
async function checkActions(session, courseId) {
  const { profile, sesskey } = session;
  if (!profile.paths.smartbookAction) return [];
  if (!courseId) {
    return [{
      key: '__oracle__',
      action: '(액션 확인)',
      verdict: 'skipped',
      note: '강좌 ID가 없어 건너뜀. action.php는 id 없이는 404를 돌려준다.',
    }];
  }

  const actionUrl = url(profile, 'smartbookAction');
  const base = { id: courseId };
  const SENTINEL = 'fflatoHealthCheckProbe';

  // 오라클 자체가 동작하는지 먼저 본다. 존재할 리 없는 액션은 404여야 한다.
  const sentinel = await actionPost(
    profile, actionUrl, { ...base, [profile.typeParam]: SENTINEL }, sesskey
  );
  if (sentinel.kind !== 'rejected') {
    return [{
      key: '__oracle__',
      action: '(액션 확인)',
      verdict: 'unusable',
      note: `모르는 액션이 404가 아니라 ${sentinel.kind} 로 응답했습니다. action.php 규약이 바뀌었을 수 있습니다.`,
      sentinelName: SENTINEL,
      msg: sentinel.msg,
    }];
  }

  const results = [];
  for (const [key, action] of Object.entries(profile.actions)) {
    // 파라미터를 일부러 채우지 않는다. 이름의 유효성만 보면 되고,
    // 그래야 어떤 상태도 바꾸지 않는다.
    const res = await actionPost(profile, actionUrl, { ...base, [profile.typeParam]: action }, sesskey);
    results.push({
      key,
      action,
      // JSON 이 왔다 = 라우팅됨 = 액션이 살아 있다.
      verdict: res.kind === 'rejected' ? 'missing' : 'ok',
      msg: res.msg,
    });
  }
  return results;
}
