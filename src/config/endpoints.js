// PLATO 엔드포인트 프로파일.
//
// 학생 출결은 부산대가 얹은 local/ubsmartbook 이 담당한다.
// local/ubattend 는 같은 화면을 쓰는 벤더(교수자) 모듈이고, 학생 인증번호
// 입력과는 무관하다 — 처음에 ubattend 의 자바스크립트 번들만 보고 그쪽으로
// 구현했다가 실제 출결에서 아무것도 감지하지 못했다. 두 플러그인을 헷갈리지 말 것.
//
// 프로파일 구조를 유지하는 이유는 themeName 지문 때문이다.
// PLATO 가 또 바뀌면 openSession 이 그 자리에서 알아차린다.

export const PROFILE_ID = 'v2';

const PROFILE_V2 = {
  id: PROFILE_ID,
  label: '신 PLATO (Moodle 4.5 / local_ubsmartbook)',
  hosts: ['plato.pusan.ac.kr'],
  base: 'https://plato.pusan.ac.kr',

  paths: {
    home: '/',
    login: '/login/index.php',
    courseView: '/course/view.php',
    ajaxService: '/lib/ajax/service.php',
    // 학생용 출석현황. 인증번호 폼 · 수업 일정 · 출결 상태가 모두 이 한 페이지에 있다.
    smartbookMy: '/local/ubsmartbook/my.php',
    // 자율강좌 목록. 서버가 스스로 가르는 기준이라 이름 추측보다 확실하다.
    eclassMy: '/local/ubeclass/my.php',
    smartbookAction: '/local/ubsmartbook/action.php',
  },

  // action.php 의 action 파라미터 값. 평소에는 페이지에 박힌 값을 읽어 쓰고,
  // 이 값은 폴백 및 자가진단용이다. 쓰는 것만 둔다 — 이 목록이 곧 요청 수다.
  actions: {
    submitAttendance: 'smartanswer',
  },
  typeParam: 'action',

  // 응답은 { ok: true } 또는 { ok: false, error: "<code>", remain?: n } 다.
  // error 는 서버가 코드처럼 쓰는 값이다. PLATO 의 AMD 핸들러(2026-09-16,
  // local_ubsmartbook/my)가 아는 코드는 셋이고, 모르는 코드는 wrong 으로 취급한다.
  // 각 코드의 사용자 문구는 페이지의 설정 JSON(msgWrong 등)에 실려 온다 —
  // 서버가 언어에 맞춰 준 것이라 우리가 적어 두는 것보다 낫다.
  errorCodes: {
    ended: 'ended',        // 자동출결 종료 (인라인 JS 와 AMD 양쪽에서 확인)
    wrong_key: 'wrong_key', // 인증번호 불일치 (실측 2026-09-16). remain 을 함께 준다
    exceeded: 'exceeded',  // 시도 횟수 초과 (AMD 핸들러에서 확인)
  },
  // 설정 JSON 의 문구 키. 코드 → 키.
  messageKeys: { success: 'msgSuccess', wrong_key: 'msgWrong', ended: 'msgEnded', exceeded: 'msgExceeded' },

  themeName: 'coursemos',
};

const PROFILES = [PROFILE_V2];

/** 호스트명으로 프로파일을 고른다. 모르는 호스트는 신 PLATO로 가정. */
export function profileForHost(host) {
  return PROFILES.find((p) => p.hosts.includes(host)) || PROFILE_V2;
}

/** M.cfg 로부터 프로파일을 교차 검증한다. 불일치하면 null. */
export function profileForConfig(cfg) {
  if (!cfg || !cfg.theme) return null;
  return PROFILES.find((p) => p.themeName === cfg.theme) || null;
}

/** 로그인 페이지. 로그인을 마치면 원래 보던 곳으로 돌아온다. */
export function loginUrl(profile) {
  return url(profile, 'login', { loginredirect: 1 });
}

/** 한 강좌의 출석현황 페이지. 화면에서 "자세히 보기" 링크로 쓴다. */
export function courseStatusUrl(profile, courseId) {
  return url(profile, 'smartbookMy', { id: courseId });
}

/** 프로파일 + path 키 + 쿼리로 절대 URL을 만든다. */
export function url(profile, pathKey, params) {
  const path = profile.paths[pathKey];
  if (!path) throw new Error(`${profile.id} 프로파일에 '${pathKey}' 경로가 없습니다.`);
  const u = new URL(path, profile.base);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}
