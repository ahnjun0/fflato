const PLATO = (() => {
  'use strict';

  const BASE_URL = 'https://plato.pusan.ac.kr';
  const ATTENDANCE_CHECK_URL = `${BASE_URL}/local/ubattendance/autoattendance.php`;
  const ATTENDANCE_STATUS_URL = `${BASE_URL}/local/ubattendance/my_status.php`;
  const ATTENDANCE_SUBMIT_URL = `${BASE_URL}/local/ubattendance/user_action.php`;

  // --- fetch wrapper (extension context → credentials: 'include') ---
  async function platoFetch(url, options = {}) {
    return fetch(url, { credentials: 'include', ...options });
  }

  // --- PLATO 연결 및 로그인 상태 확인 ---
  // 반환: { ok, status, html, doc } 또는 throw
  async function checkConnection() {
    let res;
    try {
      res = await platoFetch(BASE_URL);
    } catch (err) {
      throw new Error(
        err.message.includes('Failed to fetch')
          ? 'PLATO 서버에 연결할 수 없습니다. 네트워크를 확인해주세요.'
          : `네트워크 오류: ${err.message}`
      );
    }

    if (!res.ok) {
      throw new Error(`PLATO 서버 오류 (HTTP ${res.status})`);
    }

    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 로그인 페이지로 리다이렉트된 경우 감지
    const isLoginPage =
      !!doc.querySelector('#login, input[name="username"], .login-form, .loginbox') ||
      !!doc.querySelector('form#login') ||
      (doc.title && doc.title.includes('로그인'));

    if (isLoginPage) {
      throw new Error('PLATO에 로그인되어 있지 않습니다. 먼저 로그인해주세요.');
    }

    // 나의강좌 섹션이 있는지 확인 (정상 메인페이지인지)
    const myCoursesBox = doc.querySelector('.front-box-course');
    if (!myCoursesBox) {
      throw new Error('PLATO 메인페이지를 정상적으로 불러오지 못했습니다. 로그인 상태를 확인해주세요.');
    }

    return { html, doc, myCoursesBox };
  }

  // --- 메인페이지에서 수강 과목 ID + 이름 추출 ---
  // "나의강좌" 섹션(.front-box-course)의 교과 과목만 추출
  // 자율강좌(course-label-cms-e), 교수·학습, 지정강좌 등은 제외
  async function getCourses() {
    const { myCoursesBox } = await checkConnection();

    const courses = [];
    const seen = new Set();

    // "나의강좌" 섹션 내 교과 과목만 선택 (course-label-r = 교과, course-label-cms-e = 자율강좌)
    const items = myCoursesBox.querySelectorAll('li.course-label-r');
    for (const item of items) {
      const link = item.querySelector('a[href*="/course/view.php?id="]');
      if (!link) continue;
      const match = link.href.match(/\/course\/view\.php\?id=(\d+)/);
      if (!match || seen.has(match[1])) continue;
      seen.add(match[1]);

      const titleEl = item.querySelector('.course-title h3');
      let name = titleEl ? titleEl.textContent.trim() : `과목 ${match[1]}`;
      // "(1학기)" 등 학기 표시 제거
      name = name.replace(/\s*\([\d]+학기\)\s*/, '').replace(/\s*NEW\s*$/, '').trim();

      courses.push({ id: match[1], name });
    }

    if (courses.length === 0) {
      throw new Error('등록된 교과 과목이 없습니다.');
    }

    return courses;
  }

  // --- 출결 페이지에서 활성 세션 정보 추출 ---
  function parseAttendancePage(html, courseId) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const authkeyInput = doc.querySelector('input[name="authkey"]');
    if (!authkeyInput) return null;

    const autoidInput = doc.querySelector('input[name="autoid"]');
    const sesskeyInput = doc.querySelector('input[name="sesskey"]');
    const durationEl = doc.querySelector('.help-time[data-duration]');

    let courseName = '';
    const breadcrumbs = doc.querySelectorAll('.breadcrumb-item a');
    for (const bc of breadcrumbs) {
      if (bc.href && bc.href.includes('/course/view.php')) {
        courseName = bc.textContent.trim();
        break;
      }
    }
    if (!courseName) {
      const titleTag = doc.querySelector('title');
      if (titleTag) courseName = titleTag.textContent.split(':')[0].trim();
    }

    const autoid = autoidInput ? autoidInput.value : null;

    return {
      courseId,
      courseName: courseName || `과목 ${courseId}`,
      autoid,
      sesskey: sesskeyInput ? sesskeyInput.value : null,
      duration: durationEl ? parseInt(durationEl.getAttribute('data-duration'), 10) : null,
      fetchedAt: Date.now(),
      attendanceUrl: `${ATTENDANCE_CHECK_URL}?id=${courseId}` + (autoid ? `&autoid=${autoid}` : ''),
      statusUrl: `${ATTENDANCE_STATUS_URL}?id=${courseId}`,
    };
  }

  // --- 출석 현황 파싱 (출석 여부 + 결석 목록) ---
  // 반환: { attendedToday, absences: [{ date, period }] }
  async function getAttendanceStatus(courseId) {
    const result = { attendedToday: false, absences: [] };
    try {
      const res = await platoFetch(`${ATTENDANCE_STATUS_URL}?id=${courseId}`);
      if (!res.ok) return result;
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      const rows = doc.querySelectorAll('.attendance_my tbody tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) continue;

        const dateCell = row.querySelector('.week_name');
        if (!dateCell) continue;
        const date = dateCell.textContent.trim();
        const period = cells[1] ? cells[1].textContent.trim() : '';

        // 출석 칸 (index 2): ○가 있으면 출석
        const attendCell = cells[2];
        const absentCell = cells[3];

        // 오늘 날짜 출석 확인
        if (date.includes(todayStr) && attendCell && attendCell.textContent.includes('\u25CB')) {
          result.attendedToday = true;
        }

        // 결석 확인: 결석 칸에 내용이 있고, 빈 칸(&nbsp;)이 아닌 경우
        if (absentCell) {
          const absentText = absentCell.textContent.trim();
          if (absentText && absentText !== '') {
            result.absences.push({ date, period });
          }
        }
      }
      return result;
    } catch {
      return result;
    }
  }

  // --- 활성 출결 세션 스캔 (디버그 로그 포함) ---
  async function scanActiveSessions(onLog) {
    const log = onLog || (() => {});
    const scanLog = { startedAt: new Date().toISOString(), courses: [], activeSessions: [] };

    log('scan_start', '스캔 시작: 메인페이지에서 과목 목록 가져오는 중...');

    let courses;
    try {
      courses = await getCourses();
    } catch (err) {
      log('error', err.message);
      throw err;
    }

    log('courses_found', `${courses.length}개 과목 발견`);
    scanLog.courses = courses;

    const sessions = [];

    const results = await Promise.allSettled(
      courses.map(async (course) => {
        const courseLog = { courseId: course.id, name: course.name, steps: [] };

        // 1) 출결 페이지 fetch
        try {
          const res = await platoFetch(`${ATTENDANCE_CHECK_URL}?id=${course.id}`);
          if (!res.ok) {
            courseLog.steps.push({ step: 'fetch_attendance', result: `HTTP ${res.status}` });
            return courseLog;
          }
          const html = await res.text();
          const session = parseAttendancePage(html, course.id);

          if (!session) {
            courseLog.steps.push({ step: 'parse', result: 'no_auth_form' });
            return courseLog;
          }

          courseLog.steps.push({ step: 'parse', result: 'auth_form_found', autoid: session.autoid, duration: session.duration });

          // 2) 출석 현황 확인 (출석 여부 + 결석 목록)
          const status = await getAttendanceStatus(course.id);
          const alreadyDone = status.attendedToday;
          courseLog.absences = status.absences;
          courseLog.steps.push({ step: 'check_status', result: alreadyDone ? 'already_attended' : 'not_attended' });

          if (alreadyDone) return courseLog;

          session.courseName = course.name || session.courseName;
          sessions.push(session);
          courseLog.steps.push({ step: 'result', result: 'active_session' });
          return courseLog;
        } catch (err) {
          courseLog.steps.push({ step: 'error', result: err.message });
          return courseLog;
        }
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        scanLog.activeSessions.push(r.value);
      }
    }

    log('scan_done', `스캔 완료: ${sessions.length}개 활성 세션`);
    scanLog.finishedAt = new Date().toISOString();

    return { sessions, log: scanLog };
  }

  // --- 출결 제출 ---
  async function submitAttendance(session, authkey) {
    const formData = new URLSearchParams();
    formData.append('type', 'auto_attendance_user');
    formData.append('id', session.courseId);
    formData.append('autoid', session.autoid);
    formData.append('sesskey', session.sesskey);
    formData.append('authkey', authkey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let res;
    try {
      res = await platoFetch(ATTENDANCE_SUBMIT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        return { success: false, message: '요청 시간 초과 (15초)' };
      }
      return { success: false, message: `네트워크 오류: ${err.message}` };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      return { success: false, message: `서버 오류 (HTTP ${res.status})` };
    }

    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    if (doc.querySelector('#login, input[name="username"], .login-form')) {
      return { success: false, message: '로그인이 만료되었습니다. 다시 로그인해주세요.' };
    }

    // alert() 호출 감지 (예: "인증번호가 일치하지 않습니다")
    const alertMatch = html.match(/alert\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (alertMatch) {
      return { success: false, message: alertMatch[1] };
    }

    // DOM 에러 요소 감지
    const errorEl = doc.querySelector('.alert-danger, .error, .notifyproblem');
    if (errorEl) {
      return { success: false, message: errorEl.textContent.trim() };
    }

    // 응답에 인증번호 폼이 그대로 남아있으면 실패로 간주
    if (doc.querySelector('input[name="authkey"]')) {
      return { success: false, message: '출석 처리에 실패했습니다. 인증번호를 확인해주세요.' };
    }

    return { success: true, message: '출석 완료!' };
  }

  // --- 남은 시간 계산 ---
  function getRemainingTime(session) {
    if (!session.duration) return '--:--';
    const elapsed = Math.floor((Date.now() - session.fetchedAt) / 1000);
    const remaining = Math.max(0, session.duration - elapsed);
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  return { checkConnection, getCourses, scanActiveSessions, submitAttendance, getRemainingTime, BASE_URL };
})();
