// 수강 과목 목록.
//
// 구 버전은 대시보드 HTML에서 `.front-box-course li.course-label-r` 를 긁었다.
// 테마 마크업이 바뀌면 그대로 깨지고, 실제로 2026-09 개편 때 깨졌다.
// 또 대시보드가 드물게 강좌 목록 없이 내려오는 것을 관측한 적이 있다.
//
// 그래서 Moodle 표준 AJAX 웹서비스를 1순위로 쓴다. 쿠키 + sesskey 로 열리고,
// 테마와 무관하며, 구조화된 데이터를 준다. 웹서비스가 실패할 때만 DOM 으로 물러난다.

import { url } from '../config/endpoints.js';
import { sel } from '../config/selectors.js';
import { callWebService, fetchPage } from './http.js';
import { refreshSesskey } from './session.js';
import { parseDocument, normalize } from '../lib/dom.js';

const TIMELINE_METHOD = 'core_course_get_enrolled_courses_by_timeline_classification';

// 교과 과목의 shortname 에 붙는 학수번호 패턴.
//   예) "과목다 (2026-0000, AA2222222_003)"
const ACADEMIC_CODE = /\((\d{4})-(\d+),\s*([A-Za-z0-9]+)_(\d+)\)\s*$/;

// 자율강좌는 해시 이름을 갖는다. 이관 접미사(_mig####)는 붙어 있기도 하고
// 없기도 하다 — 2026-09-01 에 "..._mig4392" 였던 강좌가 이틀 뒤 접미사 없이
// 바뀌어 있었다. 접미사를 필수로 보면 판별이 조용히 빗나간다.
//   "fedcba9876543210fedcba9876543210"
//   "fedcba9876543210fedcba9876543210_mig4392"
const MIGRATED_HASH = /^[0-9a-f]{16,}(_mig\d+)?$/i;

// 앞의 것부터 시도하고, 실패하거나 빈 목록이면 다음으로 넘어간다.
const DEFAULT_PROVIDERS = [fromWebService, fromDashboard];

/**
 * 수강 중인 과목 목록.
 * @returns [{ id, name, displayName, shortname, section, category, kind, source }]
 *   kind: 'academic' | 'self' | 'unknown'
 */
export async function getCourses(session, options = {}) {
  const { providers = DEFAULT_PROVIDERS } = options;

  let courses = [];
  const failures = [];

  for (const provider of providers) {
    try {
      const got = await provider(session);
      if (got && got.length > 0) {
        courses = got;
        break;
      }
      failures.push(`${provider.name}: 빈 목록`);
    } catch (err) {
      // 로그인이 풀린 것이면 다음 경로를 시도할 이유가 없다. 대시보드도
      // 로그인 페이지를 돌려줄 뿐이고, 사용자에게 할 말은 이미 정해져 있다.
      if (err.kind === 'not_logged_in') throw err;
      failures.push(`${provider.name}: ${err.message}`);
    }
  }

  if (courses.length === 0) {
    // 내부 실패 내역은 화면에 늘어놓지 않는다. 사용자가 할 수 있는 일이 없다.
    // 원인은 details 에 담아 debug 페이지에서만 보이게 한다.
    const err = new Error('수강 중인 과목을 찾지 못했습니다. PLATO 로그인 상태를 확인해주세요.');
    err.kind = 'no_courses';
    err.details = failures;
    throw err;
  }

  return selectCourses(courses);
}

/**
 * 조회 대상 강좌.
 *
 * **이름으로 빼지 않는다.** shortname 이 해시처럼 보인다고 자율강좌라 단정하면,
 * 그렇게 생긴 교과 과목이 하나라도 있을 때 그 과목의 출결을 영영 놓친다.
 * 이름은 바뀌기도 한다 — 2026-09-01 에 "..._mig4392" 였던 강좌가 이틀 뒤
 * 접미사 없는 해시가 되어 있었다.
 *
 * 제외는 서버가 실제로 보여주는 것(출석부 표의 유무)으로만 한다. 한 번 받아
 * 보면 확정되고, 그 뒤로는 조회하지 않는다 (schedule.js 의 hasAttendanceLedger).
 * kind 는 순서와 표시에만 쓴다.
 */
export function selectCourses(courses) {
  return courses;
}

const TIMELINE_ARGS = { classification: 'inprogress', limit: 0, offset: 0, sort: 'fullname' };

/**
 * 1순위: Moodle AJAX 웹서비스.
 *
 * 캐시한 sesskey 를 쓰다가 만료되면 서버가 errorcode "invalidsesskey" 를 준다.
 * 그때만 홈페이지를 받아 갱신하고 한 번 재시도한다. 미리 확인하지 않는 이유는
 * 확인 자체가 요청 하나이기 때문이다.
 */
async function fromWebService(session) {
  let data;
  try {
    data = await callWebService(session.profile, session.sesskey, TIMELINE_METHOD, TIMELINE_ARGS);
  } catch (err) {
    if (err.errorcode !== 'invalidsesskey') throw err;
    await refreshSesskey(session);
    data = await callWebService(session.profile, session.sesskey, TIMELINE_METHOD, TIMELINE_ARGS);
  }

  const list = (data && data.courses) || [];
  return list.map((c) => build({
    id: String(c.id),
    fullname: c.fullname,
    shortname: c.shortname,
    category: c.coursecategory,
    source: 'webservice',
  }));
}

/** 2순위: 대시보드 DOM. 웹서비스가 실패했을 때만 쓴다. */
async function fromDashboard(session) {
  const { profile } = session;
  const page = await fetchPage(url(profile, 'home'));
  const doc = parseDocument(page.html);

  const cards = doc.querySelectorAll(sel(profile, 'courseCard'));
  const out = [];
  const seen = new Set();

  for (const card of cards) {
    const link = card.matches('a[href]') ? card : card.querySelector('a[href]');
    const href = link && link.getAttribute('href');
    const match = href && href.match(/\/course\/view\.php\?id=(\d+)/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);

    const titleEl = card.querySelector(sel(profile, 'courseCardTitle'));
    out.push(build({
      id: match[1],
      fullname: titleEl ? normalize(titleEl.textContent) : `과목 ${match[1]}`,
      shortname: '',
      source: 'dashboard',
    }));
  }
  return out;
}

/** 원본 필드에서 표시용 이름과 교과/자율 구분을 만든다. */
/**
 * shortname 으로 교과/자율을 가른다.
 *
 * 화면에 보이는 한국어 배지("자율강좌" / "교과과정")로도 구분할 수 있지만 쓰지
 * 않는다. PLATO 는 한국어·영어·중국어를 지원하므로 언어를 바꾸면 깨진다.
 * shortname 의 학수번호는 언어와 무관하다.
 *
 * 판별이 안 되면 'unknown' 으로 두고 스캔 대상에 남긴다 — 요청 하나가 더 드는
 * 것이 놓치는 것보다 낫다. 그렇게 남은 강좌도 한 번 조회해 보면 출석부 유무로
 * 확정되므로(schedule.js 의 hasAttendanceLedger) 계속 조회되지는 않는다.
 */
export function classifyShortname(shortname) {
  const sn = String(shortname || '');
  if (ACADEMIC_CODE.test(sn)) return 'academic';
  if (MIGRATED_HASH.test(sn)) return 'self';
  return 'unknown';
}

function build({ id, fullname, shortname, category, source }) {
  const name = cleanName(fullname);
  const code = shortname && shortname.match(ACADEMIC_CODE);
  const kind = classifyShortname(shortname);
  const section = code ? code[4] : null; // 분반 (예: "062")

  return {
    id,
    name,
    // 같은 과목의 다른 분반을 구분할 수 있게 대시보드와 같은 형태로 보여준다.
    displayName: section ? `${name} (${section})` : name,
    shortname: shortname || '',
    section,
    category: category || '',
    kind,
    source,
  };
}

/** "(1학기)", 꼬리의 NEW 배지 등 표시용 군더더기를 턴다. */
function cleanName(raw) {
  return normalize(raw || '')
    .replace(/\s*\(\d+학기\)\s*/g, ' ')
    .replace(/\s*NEW\s*$/i, '')
    .trim();
}
