(async function () {
  'use strict';

  const logArea = document.getElementById('log-area');
  const btnScan = document.getElementById('btn-scan');
  const btnClearLog = document.getElementById('btn-clear-log');

  function appendLog(tag, message) {
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const isError = tag === 'error';
    logArea.textContent += `[${time}] [${tag}] ${message}\n`;
    if (isError) {
      // 에러 줄에 색상을 입히기 위해 innerHTML 대신 scroll만 처리
    }
    logArea.scrollTop = logArea.scrollHeight;
  }

  function renderCourses(courses) {
    const card = document.getElementById('courses-card');
    const body = document.getElementById('courses-body');
    const count = document.getElementById('courses-count');

    card.style.display = '';
    count.textContent = `${courses.length}개`;

    body.innerHTML = `<table>
      <thead><tr><th>과목 ID</th><th>과목명</th><th>링크</th></tr></thead>
      <tbody>${courses.map(c => `
        <tr>
          <td><code>${c.id}</code></td>
          <td>${c.name}</td>
          <td>
            <a href="https://plato.pusan.ac.kr/course/view.php?id=${c.id}" target="_blank">과목 홈</a>
            &nbsp;|&nbsp;
            <a href="https://plato.pusan.ac.kr/local/ubattendance/autoattendance.php?id=${c.id}" target="_blank">출결 페이지</a>
            &nbsp;|&nbsp;
            <a href="https://plato.pusan.ac.kr/local/ubattendance/my_status.php?id=${c.id}" target="_blank">출석 현황</a>
          </td>
        </tr>
      `).join('')}</tbody>
    </table>`;
  }

  function stepTagHTML(step) {
    const map = {
      'active_session': ['활성', 'step-active'],
      'already_attended': ['출석완료', 'step-attended'],
      'not_attended': ['미출석', 'step-active'],
      'no_auth_form': ['폼없음', 'step-skip'],
      'auth_form_found': ['폼발견', 'step-active'],
    };
    const [label, cls] = map[step] || [step, 'step-skip'];
    return `<span class="step-tag ${cls}">${label}</span>`;
  }

  function renderDetail(scanLog) {
    const card = document.getElementById('detail-card');
    const body = document.getElementById('detail-body');
    const count = document.getElementById('detail-count');

    card.style.display = '';
    const entries = scanLog.activeSessions || [];
    count.textContent = `${entries.length}개 과목 검사`;

    if (entries.length === 0) {
      body.innerHTML = '<p style="color:#aaa;text-align:center;padding:8px">스캔 결과 없음</p>';
      return;
    }

    body.innerHTML = `<table>
      <thead><tr><th>과목</th><th>단계별 결과</th></tr></thead>
      <tbody>${entries.map(e => `
        <tr>
          <td>
            <strong>${e.name || e.courseId}</strong><br>
            <code style="font-size:10px;color:#888">ID: ${e.courseId}</code>
          </td>
          <td>${(e.steps || []).map(s => {
            let detail = stepTagHTML(s.result);
            if (s.autoid) detail += ` <code style="font-size:10px">autoid=${s.autoid}</code>`;
            if (s.duration) detail += ` <code style="font-size:10px">${Math.floor(s.duration/60)}분${s.duration%60}초</code>`;
            return `<div style="margin:2px 0"><code style="font-size:10px;color:#888">${s.step}:</code> ${detail}</div>`;
          }).join('')}</td>
        </tr>
      `).join('')}</tbody>
    </table>`;
  }

  function renderActiveSessions(sessions) {
    const card = document.getElementById('active-card');
    const body = document.getElementById('active-body');
    const count = document.getElementById('active-count');

    card.style.display = '';
    count.textContent = `${sessions.length}개`;

    if (sessions.length === 0) {
      body.innerHTML = '<p style="color:#aaa;text-align:center;padding:8px">활성 출결 세션 없음</p>';
      return;
    }

    body.innerHTML = `<table>
      <thead><tr><th>과목명</th><th>autoid</th><th>sesskey</th><th>남은 시간</th><th>페이지 링크</th></tr></thead>
      <tbody>${sessions.map(s => `
        <tr>
          <td><strong>${s.courseName}</strong><br><code style="font-size:10px;color:#888">ID: ${s.courseId}</code></td>
          <td><code>${s.autoid || '-'}</code></td>
          <td><code>${s.sesskey || '-'}</code></td>
          <td class="session-timer" data-fetched="${s.fetchedAt}" data-duration="${s.duration || 0}">${PLATO.getRemainingTime(s)}</td>
          <td>
            <a href="${s.attendanceUrl}" target="_blank">출결 페이지</a><br>
            <a href="${s.statusUrl}" target="_blank">출석 현황</a>
          </td>
        </tr>
      `).join('')}</tbody>
    </table>`;

    // 타이머 업데이트
    setInterval(() => {
      document.querySelectorAll('.session-timer').forEach(el => {
        const fetchedAt = parseInt(el.dataset.fetched, 10);
        const duration = parseInt(el.dataset.duration, 10);
        if (!duration) return;
        const elapsed = Math.floor((Date.now() - fetchedAt) / 1000);
        const remaining = Math.max(0, duration - elapsed);
        const min = Math.floor(remaining / 60);
        const sec = remaining % 60;
        el.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      });
    }, 1000);
  }

  function renderAbsences(scanLog) {
    const card = document.getElementById('absence-card');
    const body = document.getElementById('absence-body');
    const count = document.getElementById('absence-count');

    // scanLog.activeSessions 각 항목의 absences를 모아서 표시
    const entries = (scanLog.activeSessions || [])
      .filter(e => e.absences && e.absences.length > 0);

    const totalAbsences = entries.reduce((sum, e) => sum + e.absences.length, 0);

    card.style.display = '';
    count.textContent = `${totalAbsences}건`;

    if (totalAbsences === 0) {
      body.innerHTML = '<p style="color:#aaa;text-align:center;padding:8px">결석 기록 없음</p>';
      return;
    }

    body.innerHTML = `<table>
      <thead><tr><th>과목명</th><th>결석 날짜</th><th>교시</th></tr></thead>
      <tbody>${entries.flatMap(e =>
        e.absences.map((a, i) => `
          <tr>
            ${i === 0 ? `<td rowspan="${e.absences.length}"><strong>${e.name || e.courseId}</strong></td>` : ''}
            <td style="color:#c0392b;font-weight:600">${a.date}</td>
            <td>${a.period}</td>
          </tr>
        `)
      ).join('')}</tbody>
    </table>`;
  }

  async function runScan() {
    btnScan.disabled = true;
    btnScan.textContent = '스캔 중...';

    // 카드 숨기기
    document.getElementById('courses-card').style.display = 'none';
    document.getElementById('detail-card').style.display = 'none';
    document.getElementById('active-card').style.display = 'none';
    document.getElementById('absence-card').style.display = 'none';

    logArea.textContent = '';
    appendLog('info', '========== 새 스캔 시작 ==========');

    try {
      // 1) 연결 확인 + 과목 목록 (getCourses 내부에서 checkConnection 호출)
      appendLog('info', 'PLATO 서버 연결 및 로그인 상태 확인 중...');
      let courses;
      try {
        courses = await PLATO.getCourses();
      } catch (connErr) {
        appendLog('error', connErr.message);
        btnScan.disabled = false;
        btnScan.textContent = '스캔 실행';
        return;
      }
      appendLog('info', 'PLATO 연결 OK, 로그인 상태 확인 완료');
      appendLog('info', `${courses.length}개 교과 과목 발견: ${courses.map(c => c.name).join(', ')}`);
      renderCourses(courses);

      // 2) 전체 스캔
      appendLog('info', '각 과목의 출결 상태 확인 중...');
      const result = await PLATO.scanActiveSessions((tag, msg) => appendLog(tag, msg));

      // 3) 결과 렌더링
      renderDetail(result.log);
      renderActiveSessions(result.sessions);
      renderAbsences(result.log);

      appendLog('info', `스캔 완료: ${result.sessions.length}개 활성 세션 발견`);

      if (result.log.error) {
        appendLog('error', result.log.error);
      }
    } catch (err) {
      appendLog('error', `스캔 실패: ${err.message}`);
    }

    btnScan.disabled = false;
    btnScan.textContent = '스캔 실행';
  }

  btnScan.addEventListener('click', runScan);
  btnClearLog.addEventListener('click', () => { logArea.textContent = ''; });
})();
