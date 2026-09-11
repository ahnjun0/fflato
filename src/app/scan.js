// 팝업과 debug 페이지가 공유하는 흐름.
//
// 순서가 중요하다. 시간표를 먼저 확보하고 스캔한다.
// 시간표 페이지는 194KB, 감지 페이지는 275KB 다. 시간표를 먼저 받아 두면
// 첫 실행에서도 1.31MB + 275KB 로 끝나서, 전량 스캔(1.9MB)보다 싸다.
// 그 뒤로는 캐시가 있으니 보통 275KB 한 번이다.

import { openSession, forgetSession } from '../core/session.js';
import { getCourses } from '../core/courses.js';
import { getSelfCourseIds } from '../core/eclass.js';
import {
  ensureSchedule, currentSlotOf, readSlotStatus, todaySlotsOf,
  refreshFromDocument, summarizeSchedule,
} from '../core/schedule.js';
import { scanOrdered, fetchCoursePage } from '../core/attendance.js';
import { submitAttendance } from '../core/submit.js';
import { markAttended } from '../core/attended.js';
import { saveCapture } from '../core/capture.js';
import { watch as watchMarkup } from '../core/markup-watch.js';

/**
 * @param options.onProgress  { phase, done, total, label } 을 받는다.
 *   phase: 'session' | 'courses' | 'schedule' | 'scan'
 *   화면에 그대로 쓸 수 있는 형태로 넘긴다. 호출부가 로그 문자열을 되파싱하지
 *   않도록 하기 위한 것이다.
 */
export async function runScan(options = {}) {
  const {
    capture = false, full = false,
    onLog = () => {}, onProgress = () => {}, concurrency = 2,
  } = options;

  onProgress({ phase: 'session', done: 0, total: 0, label: 'PLATO 연결 확인 중' });
  onLog('info', 'PLATO 연결 및 로그인 확인 중...');
  const session = await openSession();
  onLog('info', `연결 OK (${session.profile.label}) · sesskey ${session.fromCache ? '캐시 사용' : '신규 취득'}`);

  onProgress({ phase: 'courses', done: 0, total: 0, label: '수강 과목 확인 중' });
  let courses;
  try {
    courses = await getCourses(session);
  } catch (err) {
    // 캐시해 둔 sesskey 가 더는 쓸모없다. 다음 시도에서 새로 받게 한다.
    if (err.kind === 'not_logged_in') await forgetSession();
    if (err.details) onLog('error', `과목 목록 실패: ${err.details.join(' / ')}`);
    throw err;
  }
  onLog('info', `수강 과목 ${courses.length}개: ${courses.map((c) => c.displayName).join(', ')}`);

  // 자율강좌는 자동출결이 열릴 수 없다. 서버가 제공하는 목록으로 먼저 걸러
  // 시간표조차 받지 않는다. 목록을 못 받으면 걸러지지 않을 뿐이고,
  // 그때는 출석부 유무로 가리는 경로가 그대로 동작한다.
  const self = await getSelfCourseIds(session);
  const target = courses.filter((c) => !self.ids.has(c.id));
  const selfCourses = courses.filter((c) => self.ids.has(c.id));
  if (selfCourses.length > 0) {
    onLog('info', `자율강좌 ${selfCourses.length}개 제외: ${selfCourses.map((c) => c.displayName).join(', ')}`
      + (self.fromCache ? ' (캐시)' : ''));
  }
  if (self.failed) {
    onLog('error', `자율강좌 목록을 받지 못했습니다 (${self.failed}) — 출석부 유무로 가립니다`);
  }

  const scheduleResult = await ensureSchedule(session, target, {
    concurrency,
    onProgress: (done, total) => {
      onProgress({ phase: 'schedule', done, total, label: '수업 시간표 가져오는 중' });
      onLog('schedule', `시간표 수집 ${done}/${total}`);
    },
  });
  const schedule = scheduleResult.courses;
  const fetched = scheduleResult.fetched;

  if (fetched.length > 0) {
    onLog('info', `시간표 ${fetched.length}과목 신규 수집 (이후 캐시 사용)`);
  } else if (scheduleResult.cachedAt) {
    onLog('info', `시간표 캐시 사용 (${scheduleResult.cachedAt})`);
  }
  if (scheduleResult.failed && scheduleResult.failed.length > 0) {
    const why = [...new Set(scheduleResult.failed.map((f) => f.reason))].join(' / ');
    onLog('error',
      `시간표 수집 실패 ${scheduleResult.failed.length}과목 — ${why} (다음 실행에서 재시도)`);
  }

  const result = await scanOrdered(session, target, {
    schedule,
    capture,
    concurrency,
    full,
    onProgress: (done, total, entry) => {
      const step = entry.steps[entry.steps.length - 1];
      onProgress({ phase: 'scan', done, total, label: entry.name });
      onLog('scan', `[${done}/${total}] ${entry.name}: ${step ? step.result : '?'}`);
    },
  });

  for (const [i, tier] of result.plan.entries()) {
    onLog('plan', `${i + 1}단계 ${tier.tier}: ${tier.count}과목 조회 → ${tier.found}건 발견`);
  }
  if (result.skippedNoLedger.length > 0) {
    onLog('plan', `건너뜀(출석부 없는 강좌): ${result.skippedNoLedger.join(', ')}`);
  }
  if (result.notScanned.length > 0) {
    onLog('plan', `조회하지 않음(찾아서 멈춤): ${result.notScanned.join(', ')}`);
  }
  onLog('info', `스캔 완료: ${result.active.length}건 / 요청 ${result.requestCount}회`);
  for (const f of result.failed) {
    onLog('error', `조회 실패: ${f.name} — ${f.reason} (세션이 열려 있었을 수 있습니다)`);
  }

  // 조회 도중 로그인이 풀렸다면 "출결 없음" 이 아니다. 화면이 로그인 안내를
  // 띄우도록 그대로 올려보낸다.
  const loggedOut = [...result.failed, ...(scheduleResult.failed || [])]
    .some((f) => f.kind === 'not_logged_in');
  if (loggedOut) {
    await forgetSession();
    const err = new Error('PLATO 로그인이 풀렸습니다.');
    err.kind = 'not_logged_in';
    throw err;
  }

  // 캡처 모드: 제출하지 않고 모달 구조만 남긴다.
  if (capture) {
    for (const active of result.active) {
      // 세션 객체를 통째로 넘긴다. 필드를 손으로 옮겨 적으면 새 필드를
      // 더할 때마다 빠뜨린다 — 실제로 readerId / detectedBy / assumed 가
      // 그렇게 누락되어, 잘 읽고도 "제출 정보를 읽지 못함" 으로 보였다.
      await saveCapture(active, active.course && active.course.displayName);
    }
    if (result.active.length > 0) onLog('info', `캡처 ${result.active.length}건 저장 (제출하지 않음)`);
  }

  // 조회한 강좌는 방금 받은 문서로 캐시를 갱신한다. 추가 요청이 없다.
  const fresh = { ...schedule };
  const scannedIds = new Set(result.log.filter((e) => e.page && e.page.doc).map((e) => e.courseId));
  const scannedCount = result.log.filter((e) => e.bytes).length;
  if (result.unrecognized.length > 0) {
    onLog('error', `페이지를 알아보지 못한 강좌 ${result.unrecognized.length}개: `
      + result.unrecognized.map((u) => u.name).join(', '));
  }

  // 이미 받은 문서로 마크업 변화를 살핀다. 요청이 늘지 않는다.
  // 자가진단은 "우리가 쓰는 것" 만 보므로, 서버가 더하는 변화는 여기서 잡는다.
  let markup = { changed: false, tokens: [] };
  const sample = result.log.find((e) => e.page && e.page.doc);
  if (sample) {
    try {
      markup = await watchMarkup(sample.page.doc, { profile: session.profile });
      if (markup.skipped) {
        // 출석현황 페이지가 아니면 대조하지 않는다. 조용히 넘기면 감시가
        // 왜 아무 말도 없는지 알 수 없으니 로그에는 남긴다.
        onLog('info', '화면 변경 감시: 출석현황 페이지가 아니어서 건너뜀');
      } else if (markup.changed) {
        // 개발자 신호다. 사용자에게는 알리지 않는다 — 출결은 잘 되고 있을 수 있다.
        onLog('info', `화면에 처음 보는 요소: ${markup.tokens.join(', ')} (debug 에서 확인)`);
      }
    } catch { /* 감시 실패가 출결을 막지는 않는다 */ }
  }
  for (const entry of result.log) {
    if (!entry.page || !entry.page.doc) continue;
    try {
      fresh[entry.courseId] = await refreshFromDocument(session.profile, entry.courseId, entry.page.doc);
    } catch { /* 캐시 갱신 실패는 조회 결과에 영향을 주지 않는다 */ }
  }

  return {
    session, courses: target, allCourses: courses, schedule: fresh,
    scheduleFetched: fetched, scheduleResult,
    // 실패한 것은 "확인했다" 고 세지 않는다.
    checkedCount: result.log.length - result.failed.length,
    // 오늘 출결: **이번 스캔에서 받은 문서**에서 읽는다. 값이 항상 최신이지만
    // 조회한 과목만 담긴다 (찾아서 멈추면 나머지는 비어 있다).
    todayStatus: collectTodayStatus(session.profile, result.log, target, fresh),
    // 누적 출결: 조회한 과목은 방금 받은 값, 나머지는 캐시다. 어느 쪽인지
    // 화면이 구분해 보여줄 수 있게 fresh 를 함께 준다.
    summary: summarizeSchedule(fresh, target).map((row) => ({
      ...row,
      fresh: scannedIds.has(row.courseId),
    })),
    selfCourses: selfCourses.map((c) => c.id),
    markup,
    // 조회한 강좌를 하나도 알아보지 못했다면 화면 구조가 바뀐 것이다.
    // 이것만 사용자에게 알린다 — 사용자가 할 수 있는 일이 "기다리기" 뿐이라도,
    // 출결이 없는 것인지 우리가 못 보는 것인지는 알아야 한다.
    structureBroken:
      scannedCount > 0 && result.unrecognized.length === scannedCount,
    ...result,
  };
}

/**
 * 조회한 페이지에서 오늘 차시의 출결 상태를 함께 읽는다.
 *
 * 추가 요청이 없다 — 세션을 찾으려고 이미 받아 온 문서를 다시 볼 뿐이다.
 * 출석/결석뿐 아니라 지각·조퇴처럼 우리가 클래스를 모르는 상태도 서버가
 * 쓴 글자 그대로 담는다. 판정에는 쓰지 않고 보여주기만 한다.
 */
function collectTodayStatus(profile, log, courses, schedule, now = new Date()) {
  const byId = new Map(courses.map((c) => [c.id, c]));
  const out = [];
  for (const entry of log) {
    if (!entry.page || !entry.page.doc) continue;
    for (const slot of todaySlotsOf(schedule, entry.courseId, now)) {
      const status = readSlotStatus(entry.page.doc, profile, slot);
      if (!status.text || status.text === '-') continue;
      const course = byId.get(entry.courseId);
      out.push({
        courseId: entry.courseId,
        name: (course && course.displayName) || entry.name,
        slot,
        chip: status.chip,
        text: status.text,
        tone: status.tone,
        key: status.key,
        registered: status.registered,
      });
    }
  }
  return out;
}

/**
 * 제출하고, 성공하면 서버 화면에서 실제로 출석이 됐는지 한 번 더 확인한다.
 *
 * ok:true 만 믿지 않는 이유는 비대칭 때문이다. 확인을 건너뛰어 아낄 수 있는
 * 것은 요청 하나지만, 출석이 안 됐는데 됐다고 믿으면 그 과목을 다시 보지
 * 않아서 출결을 놓친다. 특히 시간표 캐시가 낡아 오늘 차시가 실제보다 적게
 * 잡혀 있으면 남은 차시를 통째로 건너뛰게 된다.
 *
 * 확인에 실패하면 기록은 남기되 '미확인' 으로 둔다. 그 과목은 계속 조회
 * 대상에 남으므로, 최악의 경우 요청이 하나 늘 뿐이다.
 *
 * now 는 어느 차시에 대한 출석인지 고르는 데 쓴다. 테스트에서만 넘긴다.
 */
export async function submit(context, active, authkey, options = {}) {
  const { now = new Date(), verify = verifyAttendance } = options;

  const result = await submitAttendance(context.session, active, authkey);
  if (!result.ok) return result;

  const slot = currentSlotOf(context.schedule, active.courseId, now) || null;
  const verification = slot
    ? await verify(context.session, active.courseId, slot)
    : { verified: false, reason: '어느 차시인지 알 수 없음' };

  await markAttended(active.courseId, slot, now, verification);

  return { ...result, slot, verification };
}

/**
 * 제출 후 강좌 페이지를 다시 받아 그 차시가 출석으로 바뀌었는지 본다.
 *
 * 칩의 색상 클래스로 판별한다 — 글자는 언어 설정에 따라 바뀐다.
 * 아는 값이 아니면 성공으로 읽지 않는다.
 */
export async function verifyAttendance(session, courseId, slot) {
  try {
    const page = await fetchCoursePage(session, courseId);
    const status = readSlotStatus(page.doc, session.profile, slot);
    // registered 는 "우리 응답이 반영되었는가" 다. 지각도 응답은 반영된 것이라
    // true 지만, 화면에는 서버가 쓴 글자를 그대로 보여준다.
    if (status.registered === true) {
      return { verified: true, chip: status.chip, text: status.text, key: status.key, tone: status.tone };
    }
    return {
      verified: false,
      chip: status.chip,
      text: status.text,
      key: status.key,
      tone: status.tone,
      reason: status.chip
        ? `응답이 반영된 상태가 아닙니다 (${status.chip})`
        : '해당 차시의 상태를 찾지 못했습니다',
    };
  } catch (err) {
    return { verified: false, chip: null, text: '', reason: err.message };
  }
}
