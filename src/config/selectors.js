// PLATO 마크업에 대한 의존을 한 곳에 모아 둔다 — CSS 셀렉터와, HTML 원문에
// 거는 정규식.
//
// 각 항목은 어느 페이지(page)에서 무엇을 찾는지, 그것이 항상 존재해야 하는지
// (required)를 함께 기술한다. 이 메타데이터 덕분에 debug 페이지의 자가진단이
// 목록을 순회하며 "아직 매칭되는가"를 자동으로 검사할 수 있다.
//
// required: 'always'      — 정상 상태에서 항상 존재. 없으면 PLATO가 바뀐 것.
//           'conditional' — 상황에 따라 없을 수 있음. emptyMeans 에 이유를 적는다.

export const SELECTORS = {
  v2: {
    // --- 대시보드 ---
    courseCard: {
      page: 'home',
      css: '.ongoing-courses .my-course-list-container a.course-card',
      fallback: 'a.course-card',
      desc: '진행 중인 강좌 카드',
      required: 'always',
    },
    courseCardTitle: {
      page: 'home',
      css: '.course-info-header h5',
      desc: '강좌 카드 제목',
      required: 'always',
    },

    // --- 자율강좌 목록 (ubeclass/my.php) ---
    // 이 페이지는 자율강좌만 싣는다(실측: 교과 0개). 서버가 스스로 가르는
    // 기준이라 shortname 추측보다 확실하다.
    eclassCard: {
      page: 'eclassMy',
      css: 'a.course-card[href*="/course/view.php?id="]',
      desc: '자율강좌 카드',
      required: 'conditional',
      emptyMeans: '수강 중인 자율강좌가 없음',
    },

    // --- 인증번호 입력 (ubsmartbook/my.php) ---
    // 세션이 열려 있을 때만 서버가 렌더한다.
    //
    // 입력칸(#sb-smart-answer-key)과 타이머(#sb-smart-answer-timer)는 여기 두지
    // 않는다. 우리는 그것들을 읽지 않는다 — 제출 정보는 인라인 $.post 에서,
    // 마감 시각은 인라인 endtime 에서 가져온다. 쓰지 않는 것을 자가진단이
    // 두드리면 PLATO 가 이름만 바꿔도 헛경보가 난다.
    smartAnswerForm: {
      page: 'smartbookMy',
      css: '#sb-smart-answer-form',
      desc: '자동출결 인증번호 입력 폼',
      required: 'conditional',
      emptyMeans: '진행 중인 자동출결이 없음',
    },
    // id 가 바뀌어도 세션을 놓치지 않기 위한 그물.
    // 인증번호 칸은 구조적으로 "본문의 폼 안에 있는 숫자 입력칸" 이다.
    // 실측: 세션이 열렸을 때 본문의 input 은 이것 하나뿐이고, 없을 때는 0개다.
    smartAnswerInput: {
      page: 'smartbookMy',
      css: 'form input[inputmode="numeric"]',
      desc: '인증번호 입력칸 (폼 id 가 바뀌었을 때의 그물)',
      required: 'conditional',
      emptyMeans: '진행 중인 자동출결이 없음',
    },

    // --- 세부 출결 상태 (표 위의 요약) ---
    // 2026-09-04 에 학생 페이지에 생겼다. 상태별 집계와 함께 **전체 범례**를
    // 담고 있어, 우리 STATUS_CHIPS 가 아직 맞는지 대조할 수 있다.
    statusSummaryItem: {
      page: 'smartbookMy',
      css: '.attendance-status-list .status-item',
      desc: '세부 출결 상태 항목 (집계 + 범례)',
      required: 'conditional',
      emptyMeans: 'PLATO 가 요약 섹션을 제공하지 않음 (2026-09-03 이전에는 없었다)',
    },

    // --- 출석현황 표 ---
    statusTable: {
      page: 'smartbookMy',
      css: 'table.table-local-ubattend',
      desc: '내 출석현황 표 (수업일자 · 교시 · 출결 상태)',
      required: 'always',
    },
    statusRow: {
      page: 'smartbookMy',
      css: 'table.table-local-ubattend tbody tr',
      desc: '수업 차시 행',
      required: 'always',
    },
    statusChip: {
      page: 'smartbookMy',
      css: '[class*="csms-chips-"]',
      desc: '출결 상태 칩 (출석 / 결석 / 지각 / 기타)',
      required: 'conditional',
      emptyMeans: '아직 지나간 수업이 없음 (미도래 차시는 "-" 로만 표시된다)',
    },
  },
};

/**
 * HTML 원문에 거는 정규식.
 *
 * 셀렉터로 잡을 수 없는 것들이다. 서버가 인라인 <script> 로 심는 값이라
 * DOM 에 노드가 없다. 그래도 마크업 의존인 것은 같으므로 셀렉터와 같은
 * 자리에 두고 자가진단도 함께 받는다.
 *
 * 인증번호 폼에는 name 속성도 히든 필드도 없다. 제출에 필요한 값이 전부
 * 인라인 스크립트의 $.post 호출에 박혀 있어서, 그 호출을 통째로 읽어 쓴다.
 */
export const PATTERNS = {
  v2: {
    // 옛 형태의 마감 시각. 새 형태에서는 설정 JSON 안에 들어 있다.
    smartAnswerEndTime: {
      page: 'smartbookMy',
      re: /var\s+endtime\s*=\s*(\d{9,})/,
      desc: '출결 마감 시각 (옛 인라인 형태)',
      required: 'conditional',
      emptyMeans: '진행 중인 자동출결이 없거나, 새 AMD 형태를 쓰는 페이지',
    },
    // 제출 설정 JSON. **감싸는 함수 이름을 보지 않는다.**
    //
    // 2026-09-07 에 PLATO 가 인라인 $.post 를 AMD 모듈 호출로 바꿨다.
    //   require(['local_ubsmartbook/my'], amd => amd.smartAnswer({ ... }))
    // 보내는 내용은 그대로였고 적힌 자리만 옮겼다. 호출 형태를 정규식에 박으면
    // 그런 변화마다 코드를 고쳐야 한다. 그래서 "smartid 를 담은 JSON 객체" 로
    // 찾는다 — 실측상 세션이 열린 페이지에 정확히 하나, 없으면 0개다.
    smartAnswerConfig: {
      page: 'smartbookMy',
      re: /(\{[^{}]*"smartid"\s*:[^{}]*\})/,
      desc: '제출 설정 JSON (smartid 를 담은 객체)',
      required: 'conditional',
      emptyMeans: '진행 중인 자동출결이 없거나, 옛 인라인 형태를 쓰는 페이지',
    },
    // 2026-09-02 형태. 파라미터가 인라인 $.post 호출에 직접 박혀 있었다.
    // PLATO 가 되돌릴 수도 있으니 남겨 둔다.
    smartAnswerPost: {
      page: 'smartbookMy',
      re: /\$\.post\(\s*M\.cfg\.wwwroot\s*\+\s*'([^']+)'\s*,\s*\{([^}]*)\}/,
      desc: '제출 엔드포인트와 파라미터 (옛 인라인 $.post 호출)',
      required: 'conditional',
      emptyMeans: '진행 중인 자동출결이 없거나, 새 AMD 형태를 쓰는 페이지',
    },
  },
};

/**
 * 출결 상태 칩.
 *
 * **판정은 색상 클래스로, 표시는 서버가 준 글자로 한다.**
 * 글자("출석", "지각")는 언어 설정에 따라 바뀌므로 로직에 쓸 수 없다.
 *
 * 전체 목록은 학생 페이지의 "세부 출결 상태" 범례에서 확인했다(2026-09-04).
 * 서버가 매 페이지에 다섯 항목을 모두 실어 주므로 관측이 아니라 전수다.
 *
 *   csms-chips-blue        출석
 *   csms-chips-red         결석
 *   csms-chips-green       지각
 *   csms-chips-yellow      조퇴
 *   csms-chips-gray-light  지각 조퇴
 *
 * registered 는 "우리 응답이 서버에 반영되었는가" 다. 결석만 false 다 —
 * 지각·조퇴는 늦거나 일찍 갔을 뿐 응답 자체는 반영된 상태다.
 * 목록에 없는 칩은 null(모름) 로 두고 추측하지 않는다. 자가진단이 이 목록을
 * 페이지의 범례와 대조하므로, PLATO 가 상태를 늘리면 그때 드러난다.
 */
export const STATUS_CHIPS = {
  'csms-chips-blue': { key: 'present', tone: 'ok', registered: true },
  'csms-chips-red': { key: 'absent', tone: 'bad', registered: false },
  'csms-chips-green': { key: 'late', tone: 'warn', registered: true },
  'csms-chips-yellow': { key: 'early_leave', tone: 'warn', registered: true },
  'csms-chips-gray-light': { key: 'late_early_leave', tone: 'warn', registered: true },
};

/** 칩 클래스 하나를 뽑는다. gray-light 처럼 하이픈이 든 것도 온전히 잡는다. */
export function chipClassOf(className) {
  const all = String(className || '').match(/csms-chips-[\w-]+/g) || [];
  return all.find((c) => c in STATUS_CHIPS) || all.find((c) => c !== 'csms-chips-lg') || null;
}

/**
 * 학생 출석현황 페이지(ubsmartbook/my.php)의 본문에서 관측된 클래스 토큰.
 *
 * PLATO 는 예고 없이, 조용히, **더하는 방향으로** 바뀐다. 2026-09-04 에 요약
 * 섹션이 생겼는데 기존 기능이 깨지지 않아 자가진단도 잡지 못했다. 사람이
 * 결석 예시를 들여다보다 우연히 발견했다.
 *
 * 그래서 본문의 클래스 토큰을 기준선으로 두고, 처음 보는 토큰이 나오면 알린다.
 * 실측상 이 집합은 매우 안정적이다 — 같은 페이지를 다시 받아도, 다른 강좌를
 * 받아도 완전히 동일했다(차이 0). 반면 09-02 저장본과 비교하면 신규 25개가
 * 그대로 드러났다. 노이즈 없이 실제 변경만 잡힌다는 뜻이다.
 *
 * 세션 상태에 따라 나타나는 것(인증번호 폼의 alert/btn/form-control 등)도
 * 포함해 두었다. 그러지 않으면 출결이 처음 열릴 때 헛경보가 난다.
 *
 * 사라진 토큰은 알리지 않는다. 폼처럼 상황에 따라 없는 것이 정상이다.
 */
export const KNOWN_MARKUP = new Set([
  'alert', 'alert-info', 'attendance-guide', 'attendance-guide-progress', 'attendance-info',
  'attendance-info-body', 'attendance-info-title', 'attendance-status-list',
  'btn', 'btn-primary', 'chips', 'count', 'csms-box', 'csms-box-content', 'csms-chips',
  'csms-chips-blue', 'csms-chips-gray-light', 'csms-chips-green', 'csms-chips-lg',
  'csms-chips-red', 'csms-chips-yellow', 'd-flex', 'desc-percent', 'form-control',
  'header-header-info', 'justify-content-center', 'level-danger', 'my-userinfo-attendance-container',
  'my-userinfo-container', 'progress', 'progress-bar', 'progress-bar-keyframe',
  'progress-container', 'progress-content', 'progress-header', 'status-item',
  'svg-color', 'table', 'table-bordered', 'table-coursemos', 'table-lg', 'table-local-ubattend',
  'table-responsive', 'table-th-lg', 'text-center', 'text-truncate', 'tr-border-top',
]);

/**
 * 의미 없는 토큰 — 알리지 않는다.
 *
 * PLATO 는 Bootstrap 위에 올라가 있다. 여백을 `mt-2` 로 주거나 글씨를
 * `fw-bold` 로 굵히는 것은 화면을 다듬은 것이지 출결 구조가 바뀐 게 아니다.
 * 이런 걸 알리면 감시가 늑대소년이 되고, 정작 새 출결 상태가 생겼을 때
 * 묻힌다. 실제로 로그인 화면의 `btn-sm, fw-bold, mt-2` 가 "처음 보는 요소"
 * 로 보고됐다.
 *
 * 기준: **부트스트랩 유틸리티만** 거른다. 우리가 모르는 PLATO 고유 클래스
 * (csms-*, attendance-*, sb-* 등)는 그대로 알린다 — 그게 감시의 목적이다.
 */
const BOOTSTRAP_UTILITY = [
  /^[mp][tbsexy]?-(auto|[0-5])$/,              // 여백: mt-2, px-3, m-auto
  /^(fw|fs|fst)-[a-z0-9]+$/,                   // 글씨: fw-bold, fs-5
  /^text-(start|end|center|left|right|justify|nowrap|wrap|break|lowercase|uppercase|capitalize|muted|body|black|white|reset|decoration-none|truncate)$/,
  /^(w|h|mw|mh|vw|vh|min-vw|min-vh)-\d+$/,     // 크기: w-100
  /^(d|order|flex|align|justify)-[a-z0-9-]+$/, // 배치: d-none, flex-column
  /^(col|row|g|gx|gy|offset)(-[a-z0-9]+)*$/,   // 그리드
  /^btn-(sm|lg|block|link|outline-[a-z]+|secondary|success|danger|warning|info|light|dark)$/,
  /^(rounded|border|shadow|bg|position|top|bottom|start|end|float|overflow|opacity|gap|visually)-[a-z0-9-]+$/,
  /^(fade|show|collapse|collapsing|active|disabled|sr-only|clearfix|small|lead)$/,
];

/** 화면 변경 감시에서 무시할 토큰인가. */
export function isNoiseToken(token) {
  return BOOTSTRAP_UTILITY.some((re) => re.test(token));
}

/** 셀렉터 CSS 문자열을 꺼낸다. 없으면 throw — 오타를 조용히 넘기지 않는다. */
export function sel(profile, key) {
  const spec = SELECTORS[profile.id] && SELECTORS[profile.id][key];
  if (!spec) throw new Error(`${profile.id} 프로파일에 '${key}' 셀렉터가 없습니다.`);
  return spec.css;
}

/** 정규식을 꺼낸다. 없으면 throw. */
export function pattern(profile, key) {
  const spec = PATTERNS[profile.id] && PATTERNS[profile.id][key];
  if (!spec) throw new Error(`${profile.id} 프로파일에 '${key}' 패턴이 없습니다.`);
  return spec.re;
}

/** 자가진단용 전체 스펙. */
export function specsFor(profile) {
  return Object.entries(SELECTORS[profile.id] || {}).map(([key, spec]) => ({ key, ...spec }));
}
export function patternsFor(profile) {
  return Object.entries(PATTERNS[profile.id] || {}).map(([key, spec]) => ({ key, ...spec }));
}
