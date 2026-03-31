(async function () {
  'use strict';

  const app = document.getElementById('app');
  let sessions = [];
  let timerInterval = null;

  function render() {
    // 타이머 정리
    if (timerInterval) clearInterval(timerInterval);

    if (sessions.length === 0) {
      app.innerHTML = `
        <div class="no-sessions">현재 활성화된 출결이 없습니다</div>
        <button class="refresh-btn" id="refresh">새로고침</button>
      `;
      document.getElementById('refresh').addEventListener('click', () => scan());
      return;
    }

    app.innerHTML = sessions.map((s, i) => `
      <div class="course-item" data-index="${i}">
        <div class="course-name" title="${s.courseName}">${s.courseName}</div>
        <div class="course-time">남은 시간: <span class="timer" data-index="${i}">${PLATO.getRemainingTime(s)}</span></div>
        <div class="input-row">
          <input type="text" class="auth-input" data-index="${i}" placeholder="인증번호" maxlength="6" inputmode="numeric">
          <button class="submit-btn" data-index="${i}">출석</button>
        </div>
        <div class="result-slot" data-index="${i}"></div>
      </div>
    `).join('') + '<button class="refresh-btn" id="refresh">새로고침</button>';

    // 타이머 업데이트
    timerInterval = setInterval(() => {
      document.querySelectorAll('.timer').forEach(el => {
        const idx = parseInt(el.dataset.index, 10);
        if (sessions[idx]) el.textContent = PLATO.getRemainingTime(sessions[idx]);
      });
    }, 1000);

    // 출석 제출
    document.querySelectorAll('.submit-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index, 10);
        const input = document.querySelector(`.auth-input[data-index="${idx}"]`);
        const slot = document.querySelector(`.result-slot[data-index="${idx}"]`);
        const authkey = input.value.trim();

        if (!authkey) {
          slot.innerHTML = '<div class="result error">인증번호를 입력해주세요</div>';
          return;
        }

        btn.disabled = true;
        btn.textContent = '...';

        try {
          const result = await PLATO.submitAttendance(sessions[idx], authkey);
          slot.innerHTML = `<div class="result ${result.success ? 'success' : 'error'}">${result.message}</div>`;
          if (result.success) {
            btn.style.display = 'none';
            input.style.display = 'none';
          }
        } catch (err) {
          slot.innerHTML = `<div class="result error">오류: ${err.message}</div>`;
        }

        btn.disabled = false;
        btn.textContent = '출석';
      });
    });

    // Enter키
    document.querySelectorAll('.auth-input').forEach(input => {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          document.querySelector(`.submit-btn[data-index="${input.dataset.index}"]`).click();
        }
      });
    });

    document.getElementById('refresh').addEventListener('click', () => scan());

    // 첫 번째 입력 필드에 포커스
    const firstInput = document.querySelector('.auth-input');
    if (firstInput) firstInput.focus();
  }

  function renderError(message, hint) {
    app.innerHTML = `
      <div class="result error" style="margin:12px 0">${message}</div>
      ${hint ? `<div style="text-align:center;font-size:11px;color:#888;margin-bottom:8px">${hint}</div>` : ''}
      <button class="refresh-btn" id="refresh">새로고침</button>
    `;
    document.getElementById('refresh').addEventListener('click', () => scan());
  }

  async function scan() {
    app.innerHTML = '<div class="status"><span class="spinner"></span> 출결 세션 검색 중...</div>';
    try {
      const result = await PLATO.scanActiveSessions();
      sessions = result.sessions;
    } catch (err) {
      sessions = [];
      const msg = err.message;

      if (msg.includes('연결할 수 없습니다') || msg.includes('네트워크')) {
        renderError(msg, 'Wi-Fi 또는 인터넷 연결을 확인해주세요.');
      } else if (msg.includes('로그인')) {
        renderError(msg, '<a href="https://plato.pusan.ac.kr" target="_blank" style="color:#1a3a5c">PLATO 로그인 페이지 열기</a>');
      } else if (msg.includes('교과 과목이 없습니다')) {
        renderError(msg, '현재 학기에 수강 중인 교과 과목이 있는지 확인해주세요.');
      } else {
        renderError(msg);
      }
      return;
    }
    render();
  }

  scan();
})();
