// 활성 출결 세션 감지.
//
// 세션이 열려 있으면 ubsmartbook/my.php 에 인증번호 입력 폼이 렌더된다.
//
//   <form id="sb-smart-answer-form">
//     <input id="sb-smart-answer-key" ...>   ← name 속성이 없다
//   </form>
//
// 폼에 name 도 히든 필드도 없어서 직렬화할 것이 없다. 제출에 필요한 값은
// 전부 인라인 스크립트의 $.post 호출에 박혀 있다:
//
//   $.post(M.cfg.wwwroot + '/local/ubsmartbook/action.php',
//          { id: 1001, action: 'smartanswer', sesskey: M.cfg.sesskey,
//            smartid: 12345, authkey: authkey })
//
// 그래서 그 호출을 통째로 읽어 URL 과 파라미터를 그대로 가져온다. 이름을
// 하드코딩하지 않으므로 PLATO 가 파라미터를 하나 더 붙여도 따라간다.
//
// 요청은 강좌당 한 번이다. 이 한 페이지에 세션 유무 · 수업 일정 · 출결 상태가
// 모두 있다.

import { url } from '../config/endpoints.js';
import { sel, pattern } from '../config/selectors.js';
import { fetchPage } from './http.js';
import { parseDocument } from '../lib/dom.js';
import { mapPool } from '../lib/pool.js';
import { tierCourses, hasAttendanceLedger, hasLedgerTable } from './schedule.js';

// $.post 페이로드에서 런타임 값은 건너뛴다 — 제출할 때 우리가 채운다.
const RUNTIME_FIELDS = new Set(['sesskey', 'authkey']);

/** 강좌 페이지를 한 번 받아 온다. 세션 감지와 출석 현황이 이 응답 하나를 공유한다. */
export async function fetchCoursePage(session, courseId) {
  const target = url(session.profile, 'smartbookMy', { id: courseId });
  const page = await fetchPage(target);
  if (page.isLoginPage) {
    // "폼이 없다" 가 아니라 "로그인이 풀렸다" 다. 이 둘을 뭉개면 출결을 놓친다.
    const err = new Error('PLATO 로그인이 풀렸습니다.');
    err.kind = 'not_logged_in';
    throw err;
  }
  if (!page.ok) {
    throw new Error(`출결 페이지를 불러오지 못했습니다 (HTTP ${page.status})`);
  }
  return { ...page, doc: parseDocument(page.html), courseId: String(courseId) };
}

/**
 * 받아 온 페이지에서 활성 세션을 찾는다. 없으면 null.
 *
 * 제출 정보를 어디서 읽을지는 PLATO 가 바꾼다. 규약(보내는 내용)은 그대로인데
 * 적혀 있는 자리만 옮긴다. 그래서 읽는 방법을 여러 개 두고 차례로 시도한다.
 *
 *   2026-09-02  인라인  $.post(wwwroot + '/local/…/action.php', { id, action, … })
 *   2026-09-07  AMD    require(['local_ubsmartbook/my'], amd =>
 *                        amd.smartAnswer({ endtime, courseid, smartid, actionurl, … }))
 *
 * complete=false 는 "폼은 있는데 제출 정보를 못 읽음" — 새 형태가 또 나왔다는
 * 뜻이다. 추측으로 메우지 않고 그대로 보고해 사용자가 PLATO 에서 직접 하게 한다.
 */
export function parseSession(profile, page, { capture = false } = {}) {
  const { doc, html, courseId } = page;

  // 폼 id 를 먼저 보고, 없으면 구조로 찾는다. id 는 PLATO 가 바꿀 수 있고,
  // 그때 "세션 없음" 으로 읽으면 출결을 조용히 놓친다.
  let detectedBy = 'form';
  let form = doc.querySelector(sel(profile, 'smartAnswerForm'));
  if (!form) {
    const input = doc.querySelector(sel(profile, 'smartAnswerInput'));
    if (input) {
      form = input.closest('form') || input;
      detectedBy = 'input';
    }
  }
  if (!form) return null;

  const base = {
    courseId,
    detectedBy,
    fetchedAt: Date.now(),
    capturedHtml: capture ? (form.closest('.alert, div') || form).outerHTML : null,
  };

  for (const read of READERS) {
    const got = read(profile, html, courseId);
    if (got) return { ...base, ...got, complete: true };
  }

  return {
    ...base,
    action: null,
    fields: {},
    endTime: null,
    complete: false,
    reason: '인증번호 폼은 있으나 제출 정보를 읽지 못했습니다.',
  };
}

/**
 * 설정 JSON 에서 읽는다. **감싸는 함수 이름을 보지 않는다.**
 *
 * 2026-09-07 에 인라인 $.post 가 AMD 모듈 호출로 바뀌었을 때, 호출 형태를
 * 정규식에 박아 두었던 탓에 제출 정보를 읽지 못했다. 이제는 smartid 를 담은
 * JSON 객체를 찾으므로 감싸는 쪽이 또 바뀌어도 따라간다.
 *
 * action 파라미터 값("smartanswer")은 페이지가 아니라 모듈 안에 있다.
 * 읽을 수 없으므로 프로파일 상수로 채운다 — 그러라고 남겨 둔 값이다.
 */
function readConfig(profile, html) {
  const m = html.match(pattern(profile, 'smartAnswerConfig'));
  if (!m) return null;

  let cfg;
  try {
    cfg = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!cfg || !cfg.actionurl || cfg.smartid === undefined) return null;

  const fields = { smartid: String(cfg.smartid) };
  if (cfg.courseid !== undefined) fields.id = String(cfg.courseid);
  fields[profile.typeParam] = profile.actions.submitAttendance;

  return {
    action: new URL(cfg.actionurl, profile.base).toString(),
    fields,
    endTime: Number(cfg.endtime) || null,
    // action 값은 페이지에 없어서 상수로 채웠다. 캡처 대조표가 이 사실을
    // 드러내야 한다 — 그러지 않으면 상수를 상수와 비교하며 "일치" 라고 한다.
    assumed: [profile.typeParam],
    readerId: 'config',
  };
}

/** 옛 형태: 인라인 $.post 호출에 파라미터가 직접 박혀 있다. */
function readInlinePost(profile, html) {
  const m = html.match(pattern(profile, 'smartAnswerPost'));
  if (!m) return null;
  const t = html.match(pattern(profile, 'smartAnswerEndTime'));
  return {
    action: new URL(m[1], profile.base).toString(),
    fields: parsePayload(m[2]),
    endTime: t ? Number(t[1]) : null,
    assumed: [],
    readerId: 'inline',
  };
}

const READERS = [readConfig, readInlinePost];

/**
 * `{ id: 6552, action: 'smartanswer', sesskey: M.cfg.sesskey, smartid: 377 }`
 * 형태의 객체 리터럴에서 상수 값만 뽑는다.
 *
 * sesskey / authkey 는 런타임 변수라 값이 없다. 제출할 때 우리가 채운다.
 */
export function parsePayload(literal) {
  const out = {};
  for (const m of literal.matchAll(/([A-Za-z_]\w*)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+))/g)) {
    const [, key, sq, dq, num] = m;
    if (RUNTIME_FIELDS.has(key)) continue;
    out[key] = sq ?? dq ?? num;
  }
  return out;
}

/** 남은 시간 문자열. endTime 은 절대 유닉스초다. */
export function getRemainingTime(activeSession, now = Date.now()) {
  if (!activeSession || !activeSession.endTime) return '--:--';
  const remaining = Math.max(0, activeSession.endTime - Math.floor(now / 1000));
  const min = Math.floor(remaining / 60);
  const sec = remaining % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function isExpired(activeSession, now = Date.now()) {
  if (!activeSession || !activeSession.endTime) return false;
  return activeSession.endTime <= Math.floor(now / 1000);
}

/**
 * 시간표를 **순서**로 쓴다. 필터가 아니다.
 *
 * 지금 수업 중인 과목부터 보고, 세션을 찾으면 거기서 멈춘다. 못 찾으면 오늘
 * 수업이 있는 나머지를, 그래도 없으면 남은 전부를 본다. 결국 다 커버한다.
 *
 * 처음에는 시간표를 필터로 썼다가 되돌렸다. 보강 때문이다 —
 *   · 수업 없는 날(토요일 등) 보강
 *   · 다른 요일 보강 (화요일 수업을 수요일에)
 *   · 교수님이 보강을 원래 차시에 기록하면 시간표 표에는 나타나지도 않는다
 * 시간표에 없는 수업이 실재하므로 시간표는 신뢰할 수 있는 필터가 못 된다.
 * 놓치는 비용은 요청 몇 개와 비교가 되지 않는다.
 *
 * 순서만으로도 얻는 것은 크다. 출결이 실제로 열려 있을 때 —
 * 이 확장을 쓰는 바로 그 순간 — 보통 첫 요청에서 끝난다.
 *
 * 부수 효과로 캐시가 낡아도 안전해졌다. 낡은 시간표는 순서를 나쁘게 할 뿐
 * 결과를 바꾸지 않는다.
 *
 * 출석을 마친 과목도 계속 본다. 한 차시에 자동출결이 여러 회차 열릴 수 있고,
 * 한 회차를 놓치면 등급이 내려간다 (구 시스템 실측: 1회차 미응답 + 2회차 응답
 * → 최종 지각). 조회를 건너뛰어 아끼는 것은 요청 하나고 잃는 것은 학점이다.
 *
 * 출석부가 없는 강좌만 뺀다. 그쪽은 애초에 출결이 열릴 수 없다.
 */
export async function scanOrdered(session, courses, options = {}) {
  const { schedule = null, now = new Date(), full = false, ...rest } = options;

  const noLedger = [];
  const eligible = [];
  for (const course of courses) {
    // 출석부가 없는 강좌(자율강좌 등)는 볼 이유가 없다. 한 번 받아 본 결과로만
    // 판단하므로, 아직 모르는 강좌는 그대로 조회한다.
    if (hasAttendanceLedger(schedule, course.id) === false) noLedger.push(course);
    else eligible.push(course);
  }

  const tiers = tierCourses(eligible, schedule, now);
  const merged = { active: [], log: [], failed: [], unrecognized: [], requestCount: 0, peakConcurrency: 0 };
  const plan = [];
  let stoppedAt = null;

  // 진행 상황은 단계별이 아니라 **전체 기준**으로 보고한다. 단계는 우리 사정이지
  // 사용자에게 보여줄 것이 아니다. (1/3) 뒤에 (1/1) 이 나오면 이해할 수 없다.
  const total = eligible.length;
  let scanned = 0;
  const { onProgress: report = () => {}, ...scanOpts } = rest;

  for (const name of ['now', 'today', 'other']) {
    const group = tiers[name];
    if (group.length === 0) continue;

    const result = await scanCourses(session, group, {
      ...scanOpts,
      onProgress: (_done, _groupTotal, entry) => report(++scanned, total, entry),
    });
    plan.push({ tier: name, count: group.length, found: result.active.length });
    merged.active.push(...result.active);
    merged.log.push(...result.log);
    merged.requestCount += result.requestCount;
    merged.failed.push(...result.failed);
    merged.unrecognized.push(...result.unrecognized);
    merged.peakConcurrency = Math.max(merged.peakConcurrency, result.peakConcurrency);

    // 실패한 강좌가 있으면 "못 찾았다" 고 단정할 수 없다. 다음 단계도 본다.
    // 찾았으면 보통 여기서 멈춘다. 다만 같은 시각에 다른 과목의 출결이
    // 열려 있을 수 있어(보강 등) 무엇을 안 봤는지 호출부에 알려준다.
    // full=true 면 끝까지 본다.
    if (!full && merged.active.length > 0) {
      stoppedAt = name;
      break;
    }
  }

  // 조기 종료로 보지 못한 과목들. 화면이 이 사실을 사용자에게 알리고,
  // 원하면 full 로 다시 부를 수 있게 한다.
  const seen = new Set(merged.log.map((e) => e.courseId));
  const notScanned = eligible.filter((c) => !seen.has(c.id)).map((c) => c.id);

  return {
    ...merged,
    plan,
    stoppedAt,
    notScanned,
    skippedNoLedger: noLedger.map((c) => c.id),
  };
}

/**
 * 주어진 강좌들을 훑는다. 강좌당 요청 1회, 동시 요청은 concurrency 개까지.
 *
 * 페이지가 275KB 라 한꺼번에 던지면 불필요한 버스트가 된다.
 * 구 버전의 Promise.allSettled 전량 병렬을 의도적으로 버렸다.
 */
async function scanCourses(session, courses, options = {}) {
  const { concurrency = 2, capture = false, onProgress = () => {} } = options;

  const { load = fetchCoursePage } = options;
  let done = 0;

  const { results, peak } = await mapPool(courses, concurrency, async (course) => {
    const entry = { courseId: course.id, name: course.displayName || course.name, steps: [] };
    try {
      const page = await load(session, course.id);
      entry.bytes = page.html.length;
      entry.steps.push({ step: 'fetch', result: 'ok' });

      // 이 페이지를 우리가 알아볼 수 있었나. 출석부 표나 인증번호 폼 중
      // 하나라도 찾았으면 인식한 것이다. 둘 다 없으면 구조가 바뀌었을 수 있다.
      const found = parseSession(session.profile, page, { capture });
      entry.recognized = hasLedgerTable(page.doc, session.profile) || Boolean(found);
      if (!found) {
        entry.steps.push({ step: 'detect', result: 'no_session' });
      } else if (!found.complete) {
        entry.steps.push({ step: 'detect', result: 'incomplete', reason: found.reason });
        entry.session = { ...found, course };
      } else {
        entry.steps.push({ step: 'detect', result: 'active', fields: Object.keys(found.fields) });
        entry.session = { ...found, course };
      }
      entry.page = page; // Phase 4 의 출석 현황 파싱이 이 응답을 재사용한다.
    } catch (err) {
      entry.steps.push({ step: 'error', result: err.message, kind: err.kind });
    }
    onProgress(++done, courses.length, entry);
    return entry;
  });

  // mapPool 이 순서를 보존하므로 따로 정렬하지 않는다.
  const log = results.map((r) => r.value).filter(Boolean);
  const active = log.map((e) => e.session).filter(Boolean);

  // 조회에 실패한 강좌는 "세션 없음" 이 아니다. 세션이 열려 있었는데 우리가
  // 못 본 것일 수 있다. 조용히 성공한 척하지 않고 따로 돌려준다.
  const failed = log
    .filter((e) => e.steps.some((st) => st.step === 'error'))
    .map((e) => {
      const st = e.steps.find((x) => x.step === 'error') || {};
      return { courseId: e.courseId, name: e.name, reason: st.result, kind: st.kind };
    });

  // 조회는 됐는데 무엇도 알아보지 못한 강좌들. 하나둘이면 그 강좌 사정일 수
  // 있지만 전부라면 화면 구조가 바뀐 것이다.
  const unrecognized = log
    .filter((e) => e.bytes && e.recognized === false)
    .map((e) => ({ courseId: e.courseId, name: e.name }));

  return { active, log, failed, unrecognized, peakConcurrency: peak, requestCount: log.length };
}
