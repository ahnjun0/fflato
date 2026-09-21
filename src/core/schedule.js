// 수업 시간표 캐시.
//
// 감지용 페이지(ubattend/my.php)는 275KB 다. 7과목을 매번 훑으면 팝업 한 번에
// 1.9MB 다. 학교 서버에 그럴 이유가 없다.
//
// 시간표는 가벼운 쪽(ubsmartbook/my.php, 194KB)에만 있고 거의 바뀌지 않는다.
// 한 번 받아 캐시해 두고 **어느 과목부터 볼지 정하는 데** 쓴다.
//
// ⚠ 필터가 아니라 순서다. 보강은 시간표에 없을 수 있다 (다른 요일 보강,
//   교수님이 원래 차시에 기록하는 경우). 시간표에 없는 수업이 실재하므로
//   "오늘 수업 없음" 을 "볼 필요 없음" 으로 해석하면 출결을 놓친다.
//   scanOrdered 는 결국 전부 커버하고, 순서로 이득을 얻는다.
//
// 낡은 캐시는 순서를 나쁘게 할 뿐 결과를 바꾸지 않는다.

import { url } from '../config/endpoints.js';
import { sel, STATUS_CHIPS, chipClassOf } from '../config/selectors.js';
import { fetchPage } from './http.js';
import { parseDocument, normalize } from '../lib/dom.js';
import { mapPool } from '../lib/pool.js';
import { get, set, remove } from '../lib/storage.js';

const KEY = 'fflato.schedule.v2';

// 차시가 있는 강좌는 오래 캐시해도 된다. 조회 순서를 정하는 데만 쓰면
// 낡아도 결과가 달라지지 않는다 (못 찾으면 결국 전부 조회한다).
const STALE_DAYS = 14;

// 다만 같은 항목이 누적 출결 표시에도 쓰인다. 여기서는 낡음이 곧 오표시다 —
// 결석·지각은 나중에 출석인정이나 교수님 정정으로 **바뀔 수 있는 값**이라,
// 14일을 믿으면 이미 출석으로 정정된 것을 2주 동안 결석이라고 말하게 된다.
// 그래서 바뀔 수 있는 기록을 담은 항목만 짧게 믿는다. 비용은 해당 과목당
// 이틀에 요청 한 번이고, 결석이 있는 과목에만 든다.
const REVISABLE_STALE_DAYS = 2;

// 차시가 **없는** 강좌는 짧게만 믿는다. 이건 조회 대상에서 빼는 근거라
// 틀리면 출결을 통째로 놓친다. 학기 초에 교수님이 출석부를 아직 만들지
// 않았을 수 있고, 그러면 하루 뒤에는 생긴다.
const EMPTY_STALE_HOURS = 12;

// 수업 시작 전후로 잡는 창. 교수님이 늦게 열거나 수업이 길어질 수 있으니
// 넉넉하게 둔다. 놓치는 비용이 요청 한 번보다 훨씬 크다.
const BEFORE_MS = 20 * 60 * 1000;
const AFTER_MS = 120 * 60 * 1000;

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})$/;
const TIME = /^(\d{1,2}):(\d{2})$/;

/**
 * 한 강좌의 출석현황 표를 행 단위로 뽑는다.
 *   [{ slot: "2026-09-01 10:30", status: "-" }, ...]
 *
 * 출결의 단위는 하루가 아니라 이 표의 한 행(수업일자 + 교시)이다.
 * 연강이면 같은 날짜에 두 행이 생긴다.
 *
 * status 는 표시용 글자, chip 은 판정용 색상 클래스다. 글자는 언어 설정에
 * 따라 바뀌므로 로직에 쓰지 않는다.
 */
function parseSchedule(doc, profile) {
  const rows = doc.querySelectorAll(sel(profile, 'statusRow'));
  const out = [];
  for (const row of rows) {
    const cells = [...row.children].map((c) => normalize(c.textContent));
    if (cells.length < 2) continue;
    if (!DATE_TIME.test(cells[0]) || !TIME.test(cells[1])) continue;
    // 칩 클래스까지 담는다. 상태 요약을 이 캐시만으로 계산할 수 있어
    // 벤더 페이지(273KB)를 받지 않아도 된다.
    const chipEl = row.children[2] && row.children[2].querySelector(sel(profile, 'statusChip'));
    out.push({
      slot: `${cells[0]} ${cells[1]}`,
      status: cells[2] ?? '',
      chip: chipEl ? chipClassOf(chipEl.className) : null,
    });
  }
  return out;
}

/**
 * 한 차시의 출결 상태를 페이지에서 읽는다.
 *
 * 글자가 아니라 칩의 색상 클래스로 판별한다 — 글자는 언어 설정에 따라 바뀐다.
 * 아는 칩이 아니면 registered=null(모름) 이다. 모르는 것을 반영됨으로 읽지 않는다.
 *
 * @returns {{ registered: boolean|null, key: string|null, tone: string,
 *             chip: string|null, text: string }}
 */
export function readSlotStatus(doc, profile, slot) {
  const rows = doc.querySelectorAll(sel(profile, 'statusRow'));
  for (const row of rows) {
    const cells = [...row.children];
    if (cells.length < 3) continue;
    const rowSlot = `${normalize(cells[0].textContent)} ${normalize(cells[1].textContent)}`;
    if (rowSlot !== slot) continue;

    const chipEl = cells[2].querySelector(sel(profile, 'statusChip'));
    const chip = chipEl ? chipClassOf(chipEl.className) : null;
    const known = chip ? STATUS_CHIPS[chip] : null;

    return {
      registered: known ? known.registered : null,
      key: known ? known.key : null,
      tone: known ? known.tone : 'neutral',
      chip,
      text: normalize(cells[2].textContent),
    };
  }
  return { registered: null, key: null, tone: 'neutral', chip: null, text: '' };
}

/**
 * 이 강좌에 출석부가 있는가.
 *
 * 자율강좌는 ubsmartbook/my.php 에 출결 표 자체가 렌더되지 않는다(실측).
 * 한 번 받아 보면 확정적으로 알 수 있으므로, 이름 규칙에 기대지 않고
 * 이걸로 조회 대상에서 뺀다.
 *
 *   undefined  아직 안 받아 봄 → 조회한다
 *   []         받아 봤고 차시가 없음 → 출석부 없는 강좌
 *   [...]      차시 있음 → 조회한다
 *
 * 나중에 차시가 생기면 캐시가 갱신되면서 자동으로 되돌아온다.
 */
export function hasAttendanceLedger(schedule, courseId) {
  // 캐시 자체가 없으면 "출석부 없음" 이 아니라 "모름" 이다.
  // 이 둘을 뭉개면 첫 실행에서 전 과목을 제외해 버린다.
  if (!schedule) return null;
  const entry = schedule[courseId];
  if (entry === undefined) return null;

  // 표가 없다고 서버가 보여준 경우에만 "없음" 이다.
  // 행이 0개인 것만으로는 단정하지 않는다 — 파서 문제일 수 있다.
  if (entry.table === false) return false;
  if (Array.isArray(entry.rows) && entry.rows.length > 0) return true;
  return null;
}

/**
 * 출석부 표가 페이지에 있는가.
 *
 * "행이 0개" 와 "표 자체가 없음" 은 다르다. 앞의 것은 파서가 못 읽었을
 * 수도 있고, 그 경우까지 "출석부 없는 강좌" 로 보면 날짜 형식이 바뀌는
 * 순간 전 과목을 조회 대상에서 빼 버린다.
 * 제외는 표가 정말 없을 때만 한다.
 */
export function hasLedgerTable(doc, profile) {
  return Boolean(doc.querySelector(sel(profile, 'statusTable')));
}

/**
 * 캐시 항목에서 차시 목록을 꺼낸다.
 *
 * 항목은 { rows, table } 이다. table 은 "출석부 표가 페이지에 있었는가" 로,
 * 조회 대상에서 빼는 근거다. rows 만으로 판단하지 않는 이유는 파서가 못 읽은
 * 경우와 정말 없는 경우를 구분해야 하기 때문이다.
 */
export function rowsOf(schedule, courseId) {
  const entry = schedule && schedule[courseId];
  if (!entry) return [];
  return Array.isArray(entry.rows) ? entry.rows : [];
}

/** 한 강좌의 오늘 차시들. ["2026-09-01 10:30", ...] */
export function todaySlotsOf(schedule, courseId, now = new Date()) {
  const today = localDate(now);
  return rowsOf(schedule, courseId).map((r) => r.slot).filter((s) => s.startsWith(today));
}

/** 지금 시간창에 걸리는 차시 중 가장 가까운 것. 없으면 null. */
export function currentSlotOf(schedule, courseId, now = new Date()) {
  const slots = todaySlotsOf(schedule, courseId, now).filter((s) => withinWindow(s, now));
  if (slots.length === 0) return null;
  return slots.reduce((best, s) =>
    Math.abs(now - parseSlot(s)) < Math.abs(now - parseSlot(best)) ? s : best);
}

/**
 * 캐시를 읽는다. 강좌별로 언제 받았는지 따로 본다.
 *
 * 차시가 없는 강좌는 12시간만 믿는다. 그 판정이 "이 강좌는 아예 보지 않는다"
 * 의 근거라서, 틀리면 출결을 놓친다. 차시가 있는 강좌는 순서를 정하는 데만
 * 쓰이므로 14일까지 둔다.
 */
/**
 * 이 캐시 항목을 얼마나 믿을 것인가.
 *
 * 기준은 "틀렸을 때 무슨 일이 생기는가" 다.
 *   차시 없음      → 조회 대상에서 빼는 근거다. 틀리면 출결을 통째로 놓친다.
 *   결석/지각 있음 → 누적 출결에 그대로 보인다. 서버에서 정정되면 오표시다.
 *   그 밖          → 순서를 정하는 데만 쓴다. 낡아도 결과가 같다.
 */
export function lifetimeOf(entry) {
  const rows = (entry && entry.rows) || [];
  if (rows.length === 0) return EMPTY_STALE_HOURS * 3600_000;
  if (rows.some(isRevisable)) return REVISABLE_STALE_DAYS * 86400_000;
  return STALE_DAYS * 86400_000;
}

/** 나중에 바뀔 수 있는 기록인가 — 출석으로 정정될 수 있는 상태. */
function isRevisable(row) {
  const info = STATUS_CHIPS[row && row.chip];
  return Boolean(info) && info.key !== 'present';
}

export async function loadSchedule() {
  const cached = await get(KEY, null);
  if (!cached || !cached.courses) return null;

  const now = Date.now();
  const courses = {};
  for (const [id, entry] of Object.entries(cached.courses)) {
    if (!entry || !Array.isArray(entry.rows)) continue;
    // 형태가 불완전한 항목(옛 버전이 남긴 것)은 없는 셈 친다. 그래야 다시 받아
    // table 을 채운다. 이걸 안 하면 "모름" 상태로 굳어 매번 조회하게 된다.
    if (typeof entry.table !== 'boolean') continue;
    const age = now - Date.parse(entry.fetchedAt);
    if (!(age >= 0)) continue;
    const limit = lifetimeOf(entry);
    if (age > limit) continue; // 만료된 것은 없는 셈 치고 다시 받는다
    courses[id] = { rows: entry.rows, table: entry.table !== false, summary: entry.summary || null };
  }
  return { fetchedAt: cached.fetchedAt, courses, raw: cached.courses };
}

/**
 * 캐시에 없는 강좌만 받아 온다. 이미 있는 것은 건드리지 않는다.
 * @returns { courses, fetched: string[] }  fetched 는 이번에 새로 받은 강좌 ID
 */
export async function ensureSchedule(session, courses, options = {}) {
  const { concurrency = 2, onProgress = () => {} } = options;
  const cached = (await loadSchedule()) || { courses: {} };

  // 수강정정으로 빠진 강좌의 캐시는 버린다. 남겨 두면 저장소만 늘고,
  // 나중에 같은 ID 가 다른 강좌에 재사용되면 잘못된 일정을 쓰게 된다.
  const enrolled = new Set(courses.map((c) => c.id));
  for (const id of Object.keys(cached.courses)) {
    if (!enrolled.has(id)) delete cached.courses[id];
  }

  const missing = courses.filter((c) => !cached.courses[c.id]);

  if (missing.length === 0) {
    return { courses: cached.courses, fetched: [], dropped: [], cachedAt: cached.fetchedAt || null };
  }

  // 받기 전에 알린다. 이걸 끝난 뒤에 알리면 몇 초 동안 화면이 멈춘 것처럼 보인다.
  onProgress(0, missing.length);

  // 만료된 항목도 남겨 두었다가 새로 받은 것으로 덮는다.
  const stored = {};
  for (const [id, e] of Object.entries(cached.raw || {})) {
    if (enrolled.has(id)) stored[id] = e;
  }
  const merged = { ...cached.courses };
  let done = 0;
  const failed = [];
  const at = new Date().toISOString();

  await mapPool(missing, concurrency, async (course) => {
    try {
      const page = await fetchPage(url(session.profile, 'smartbookMy', { id: course.id }));
      if (page.isLoginPage) {
        failed.push({ id: course.id, reason: 'PLATO 로그인이 풀렸습니다.', kind: 'not_logged_in' });
      } else if (page.ok) {
        const doc = parseDocument(page.html);
        const rows = parseSchedule(doc, session.profile);
        const table = hasLedgerTable(doc, session.profile);
        const summary = parseStatusSummary(doc, session.profile);
        merged[course.id] = { rows, table, summary };
        stored[course.id] = { rows, table, summary, fetchedAt: at };
      } else {
        failed.push({ id: course.id, reason: `HTTP ${page.status}` });
      }
    } catch (err) {
      // 이유를 버리지 않는다. 셀렉터 이름 오타 하나로 전 과목이 실패했는데
      // 로그에 "실패" 만 남아 원인을 찾는 데 오래 걸렸다.
      failed.push({ id: course.id, reason: err.message });
    }
    onProgress(++done, missing.length);
  });

  await set(KEY, { fetchedAt: at, courses: stored });

  // 실패한 강좌는 저장되지 않으므로 다음 실행에서 다시 시도한다.
  // 매번 재시도가 반복된다면 그 강좌의 페이지에 문제가 있는 것이다.
  return {
    courses: merged,
    fetched: missing.map((c) => c.id).filter((id) => !failed.some((f) => f.id === id)),
    failed,
    cachedAt: cached.fetchedAt || null,
  };
}

/**
 * 페이지의 "세부 출결 상태" 요약을 읽는다.
 *
 * 서버가 직접 센 값이라 우리가 표를 세는 것보다 정확하고, 조퇴·지각조퇴처럼
 * 표에서 구분하기 어려운 것도 들어 있다. 같은 페이지에 있으므로 추가 요청이 없다.
 *
 * 항목 하나는 "1 결석" 처럼 숫자와 라벨이 붙어 있고, 칩 클래스가 종류를 가른다.
 * 칩이 없는 항목은 아직 도래하지 않은 차시다.
 *
 * @returns {{ counts: {chip: n}, legend: {chip: label}, notYet: number } | null}
 */
export function parseStatusSummary(doc, profile) {
  let items;
  try {
    items = doc.querySelectorAll(sel(profile, 'statusSummaryItem'));
  } catch {
    return null;
  }
  if (!items || items.length === 0) return null;

  const counts = {};
  const legend = {};
  let notYet = 0;

  for (const item of items) {
    const text = normalize(item.textContent);
    const m = text.match(/^(\d+)\s*(.*)$/);
    if (!m) continue;
    const n = Number(m[1]);
    const label = m[2].trim();

    const chipEl = item.querySelector(sel(profile, 'statusChip'));
    const chip = chipEl ? chipClassOf(chipEl.className) : null;
    if (!chip) { notYet += n; continue; }

    counts[chip] = n;
    legend[chip] = label;
  }
  return Object.keys(counts).length > 0 ? { counts, legend, notYet } : null;
}

/**
 * 한 강좌의 출결 요약.
 *
 * 벤더 페이지에는 서버가 계산한 카운트가 있지만(.attendance-status-list),
 * 그걸 쓰려면 273KB 를 더 받아야 한다. 같은 값을 우리가 이미 가진 표에서
 * 세면 요청이 0이다.
 *
 * 미도래 차시(칩 없음)는 세지 않는다. 아는 칩이 아니면 unknown 이다.
 */
export function summarizeRows(rows, serverSummary = null) {
  // 서버가 센 값이 있으면 그걸 쓴다. 우리가 표를 세는 것보다 정확하고
  // 조퇴·지각조퇴처럼 구분이 까다로운 것도 들어 있다.
  if (serverSummary) {
    const counts = { present: 0, late: 0, absent: 0, early_leave: 0, late_early_leave: 0, unknown: 0 };
    let recorded = 0;
    for (const [chip, n] of Object.entries(serverSummary.counts)) {
      const known = STATUS_CHIPS[chip];
      counts[known ? known.key : 'unknown'] += n;
      recorded += n;
    }
    return { ...counts, recorded, total: recorded + serverSummary.notYet, source: 'server' };
  }
  return countRows(rows);
}

function countRows(rows) {
  const counts = { present: 0, late: 0, absent: 0, early_leave: 0, late_early_leave: 0, unknown: 0 };
  let recorded = 0;
  for (const r of rows || []) {
    if (!r.chip) continue; // 아직 도래하지 않은 차시
    recorded += 1;
    const known = STATUS_CHIPS[r.chip];
    counts[known ? known.key : 'unknown'] += 1;
  }
  return { ...counts, recorded, total: (rows || []).length, source: 'rows' };
}

/** 여러 강좌의 요약. 기록이 있는 강좌만 돌려준다. */
export function summarizeSchedule(schedule, courses) {
  const out = [];
  for (const course of courses || []) {
    const entry = schedule && schedule[course.id];
    const rows = rowsOf(schedule, course.id);
    if (rows.length === 0) continue;
    const counts = summarizeRows(rows, entry && entry.summary);
    if (counts.recorded === 0) continue;
    out.push({
      courseId: course.id,
      name: course.displayName || course.name,
      // 언제 받은 값인지. 이번에 조회하지 않은 과목은 화면이 이걸로
      // "며칠 전 기록" 이라고 밝힌다 — "이전" 만으로는 얼마나 낡았는지 모른다.
      fetchedAt: (entry && entry.fetchedAt) || null,
      ...counts,
    });
  }
  return out;
}

/**
 * 이미 받아 온 문서로 한 강좌의 캐시를 갱신한다.
 *
 * 스캔하느라 어차피 받은 페이지다. 추가 요청 없이 출결 상태를 최신으로
 * 유지할 수 있어, 요약이 낡지 않는다.
 */
export async function refreshFromDocument(profile, courseId, doc) {
  const rows = parseSchedule(doc, profile);
  const table = hasLedgerTable(doc, profile);
  const summary = parseStatusSummary(doc, profile);
  const raw = await get(KEY, null);
  const stored = (raw && raw.courses) || {};
  const at = new Date().toISOString();
  stored[String(courseId)] = { rows, table, summary, fetchedAt: at };
  await set(KEY, { fetchedAt: at, courses: stored });
  return { rows, table, summary };
}

/** 시간표 캐시를 지운다. 다음 실행에서 전부 다시 받는다. */
export async function clearSchedule() {
  await remove(KEY);
}

/** 캐시 수명. 화면에 그대로 보여주기 위해 노출한다. */
export const CACHE_LIFETIME = {
  withRows: { days: STALE_DAYS, label: `${STALE_DAYS}일` },
  revisable: { days: REVISABLE_STALE_DAYS, label: `${REVISABLE_STALE_DAYS}일` },
  empty: { hours: EMPTY_STALE_HOURS, label: `${EMPTY_STALE_HOURS}시간` },
};

/** 저장소에 실제로 무엇이 들어 있는지. 진단용. */
export async function scheduleDiagnostics() {
  const raw = await get(KEY, null);
  if (!raw) return { present: false };
  const stored = raw.courses || {};
  const now = Date.now();
  const rows = Object.entries(stored).map(([id, e]) => {
    const n = (e && e.rows ? e.rows : []).length;
    const ageH = e && e.fetchedAt ? Math.round((now - Date.parse(e.fetchedAt)) / 3600_000) : null;
    const limitH = Math.round(lifetimeOf(e) / 3600_000);
    return {
      id, rows: n, table: e ? e.table !== false : null,
      ageHours: ageH, expired: ageH === null || ageH > limitH, limitHours: limitH,
    };
  });
  return {
    present: true,
    fetchedAt: raw.fetchedAt,
    courses: rows,
    bytes: JSON.stringify(raw).length,
    emptyStaleHours: EMPTY_STALE_HOURS,
  };
}

/**
 * 지금 시점에서 어느 강좌를 **먼저** 봐야 하는지 나눈다.
 * 셋 다 결국 보게 된다. 순서를 정할 뿐이다.
 *
 *   now      수업 시간창 안 — 여기서 대부분 끝난다
 *   today    오늘 수업이 있으나 시간창 밖
 *   other    오늘 시간표에 없음 — 보강일 수 있으므로 마지막에 본다
 *
 * 시간표를 모르는 강좌는 now 에 넣는다. 모르면 먼저 보는 쪽이 안전하다.
 */
export function tierCourses(courses, schedule, now = new Date()) {
  const today = localDate(now);
  const tiers = { now: [], today: [], other: [] };

  for (const course of courses) {
    if (!(schedule && schedule[course.id])) {
      // 시간표를 모르는 강좌는 먼저 본다 — 모르면 보는 쪽이 안전하다.
      // 다만 이름이 자율강좌 꼴이면 맨 나중으로 미룬다. 이름으로 **빼지는**
      // 않되(교과가 그렇게 생겼을 수 있다) 우선순위는 낮춰도 된다.
      // 한 번 조회하면 출석부 유무로 확정되어 그 뒤로는 아예 빠진다.
      (course.kind === 'self' ? tiers.other : tiers.now).push(course);
      continue;
    }

    const todaySlots = rowsOf(schedule, course.id).map((r) => r.slot).filter((s) => s.startsWith(today));
    if (todaySlots.length === 0) { tiers.other.push(course); continue; }

    const inWindow = todaySlots.some((s) => withinWindow(s, now));
    if (inWindow) {
      // 지금 시각에 가장 가까운 수업일수록 먼저 본다. 창을 넉넉히 잡아 두어
      // 앞 교시가 함께 걸리는 경우가 있는데, 그때 순서가 의미를 갖는다.
      tiers.now.push({ ...course, _distance: nearestDistance(todaySlots, now) });
    } else {
      tiers.today.push(course);
    }
  }
  tiers.now.sort((a, b) => a._distance - b._distance);
  tiers.now = tiers.now.map(({ _distance, ...c }) => c);
  return tiers;
}

/** 오늘 수업들 중 now 에 가장 가까운 시작 시각까지의 거리(ms). */
function nearestDistance(slots, now) {
  const t = now.getTime();
  return Math.min(...slots.map((s) => {
    const start = parseSlot(s);
    return start === null ? Infinity : Math.abs(t - start);
  }));
}

/** "YYYY-MM-DD HH:MM" 이 now 기준 시간창 안인가. */
export function withinWindow(slot, now = new Date(), before = BEFORE_MS, after = AFTER_MS) {
  const start = parseSlot(slot);
  if (start === null) return false;
  const t = now.getTime();
  return t >= start - before && t <= start + after;
}

// PLATO 가 적는 시각은 전부 한국 시간이다. 서머타임이 없어 UTC+9 로 고정이다.
const KST_OFFSET_MS = 9 * 3600_000;

function parseSlot(slot) {
  const m = String(slot).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/);
  if (!m) return null;
  // **기기의 시간대가 아니라 한국 시간으로 해석한다.** 수업 시각은 서버가
  // 한국 시간으로 적은 것이라, 교환학생이 해외에서 열거나 Windows 시간대가
  // 잘못 잡힌 기기에서 열어도 같은 순간을 가리켜야 한다. new Date(y, m, d, ...)
  // 는 기기 시간대로 해석하므로 쓰지 않는다.
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - KST_OFFSET_MS;
}

/** 이 순간이 한국에서 며칠인가 — "YYYY-MM-DD". */
export function kstDate(d) {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`;
}

const localDate = kstDate;
