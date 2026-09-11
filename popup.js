import { runScan, submit } from './src/app/scan.js';
import { getRemainingTime, isExpired } from './src/core/attendance.js';
import { profileForHost, loginUrl, courseStatusUrl } from './src/config/endpoints.js';
import { rowsOf, kstDate } from './src/core/schedule.js';

const LOGIN_URL = loginUrl(profileForHost());
const PLATO_HOME = profileForHost().base;

// 제목의 "PLATO" 를 홈으로 보낸다. 주소는 프로파일에서 가져온다 —
// HTML 에 박아 두면 호스트가 두 곳에 적히게 된다.
{
  const link = document.getElementById('plato-home');
  if (link) {
    link.href = PLATO_HOME;
    link.title = 'PLATO 홈 열기';
  }
}

/** 과목 이름을 그 과목 출석현황으로 가는 링크로. 새 탭이라 추가 권한이 없다. */
const courseLink = (courseId, name) =>
  `<a class="status-name" href="${esc(courseStatusUrl(profileForHost(), courseId))}"
      target="_blank" rel="noopener" title="${esc(name)} 출석현황 열기">${esc(name)}</a>`;

const app = document.getElementById('app');
let context = null;
let sessions = [];
let timer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render() {
  if (timer) { clearInterval(timer); timer = null; }

  if (sessions.length === 0) {
    // "없다" 만 말하면 제대로 찾아본 것인지 알 수 없다. 몇 과목을 봤는지 알려준다.
    const n = context && context.checkedCount;
    app.innerHTML = `
      <div class="no-sessions">
        진행 중인 출결이 없습니다
        ${n ? `<div class="no-sessions-sub">${n}개 과목을 확인했어요</div>` : ''}
        <div class="no-sessions-sub">${esc(todaySummary())}</div>
      </div>
      ${structureBrokenHTML()}
      ${failedHTML()}
      ${todayStatusHTML()}
      ${summaryHTML()}
      <button class="refresh-btn" id="refresh">다시 확인</button>
    `;
    bindRefresh();
    return;
  }

  const notScanned = (context && context.notScanned) || [];

  app.innerHTML = sessions.map((s, i) => `
    <div class="course-item" data-index="${i}">
      <div class="course-name" title="${esc(s.course && s.course.displayName)}">${esc(s.course && s.course.displayName)}</div>
      <div class="course-time">남은 시간: <span class="timer" data-index="${i}">${getRemainingTime(s)}</span></div>
      <div class="timer-note"></div>
      ${s.complete ? '' : `<div class="result error">출결 폼을 읽지 못했습니다<br>
        <a href="${esc(courseStatusUrl(profileForHost(), s.courseId))}" target="_blank" rel="noopener">
          PLATO에서 바로 입력하기</a></div>`}
      <div class="input-row">
        <input type="text" class="auth-input" data-index="${i}" placeholder="인증번호" maxlength="10" inputmode="numeric" ${s.complete ? '' : 'disabled'}>
        <button class="submit-btn" data-index="${i}" ${s.complete ? '' : 'disabled'}>출석</button>
      </div>
      <div class="result-slot" data-index="${i}"></div>
    </div>
  `).join('')
    // 하나를 찾으면 거기서 멈춘다. 같은 시각에 다른 과목의 출결이 열려 있을
    // 수도 있으므로(보강 등), 안 본 과목이 있으면 그 사실을 알리고
    // 마저 볼 수 있게 한다.
    + structureBrokenHTML()
    + failedHTML()
    + todayStatusHTML()
    + summaryHTML()
    + (notScanned.length > 0 ? `
      <div class="notice">
        ${notScanned.length}개 과목은 아직 확인하지 않았어요
        <button class="link-btn" id="scan-all">전부 확인하기</button>
      </div>` : '')
    + '<button class="refresh-btn" id="refresh">새로고침</button>';

  timer = setInterval(tick, 1000);
  bindSubmit();
  bindRefresh();
  const all = document.getElementById('scan-all');
  if (all) all.addEventListener('click', () => scan({ full: true }));

  const first = app.querySelector('.auth-input:not([disabled])');
  if (first) first.focus();
}

/**
 * endTime 은 절대 시각이라 팝업을 닫았다 열어도 어긋나지 않는다.
 *
 * 마감이 지나도 **입력을 막지 않는다.** 기준이 사용자 기기의 시계라서,
 * 시계가 몇 분 빠르면 살아 있는 세션을 잠가 버린다. 정말 끝났다면 서버가
 * error:'ended' 로 알려 주고 그때 막으면 된다 — 놓치는 것보다 헛시도 한 번이 낫다.
 */
function tick() {
  app.querySelectorAll('.timer').forEach((el) => {
    const s = sessions[Number(el.dataset.index)];
    if (!s) return;
    if (isExpired(s)) {
      el.textContent = '마감 시각 지남';
      el.classList.add('timer-over');
      const note = el.closest('.course-item').querySelector('.timer-note');
      if (note) note.textContent = '기기 시계 기준입니다. 그래도 한 번 시도해볼 수 있어요.';
    } else {
      el.textContent = getRemainingTime(s);
    }
  });
}

function bindSubmit() {
  app.querySelectorAll('.submit-btn').forEach((btn) => {
    btn.addEventListener('click', () => doSubmit(Number(btn.dataset.index)));
  });
  app.querySelectorAll('.auth-input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSubmit(Number(input.dataset.index));
    });
  });
}

function bindRefresh() {
  const btn = document.getElementById('refresh');
  if (btn) btn.addEventListener('click', () => scan());
}

/**
 * 오늘 출결 현황. 스캔하면서 이미 받아 온 페이지에서 읽은 것이라 추가 요청이 없다.
 *
 * 출석/결석만 있는 것이 아니다 — 지각·조퇴 같은 상태도 있고, 그중에는 우리가
 * 색상 클래스를 모르는 것도 있다. 판정에 쓰지 않고 **서버가 쓴 글자 그대로**
 * 보여준다. 출석이 아닌 것은 눈에 띄게 한다.
 */
function todayStatusHTML() {
  const rows = (context && context.todayStatus) || [];
  if (rows.length === 0) return '';
  const partial = ((context && context.notScanned) || []).length;
  return `
    <div class="status-box">
      <div class="status-head">오늘 출결
        <span class="muted">· 방금 조회한 ${context.checkedCount}개 과목 기준</span></div>
      ${rows.map((r) => `
        <div class="status-row">
          ${courseLink(r.courseId, r.name)}
          <span class="status-chip tone-${esc(r.tone || 'neutral')}">${esc(r.text)}</span>
        </div>`).join('')}
    </div>`;
}

/**
 * 화면 구조가 바뀌어 아무것도 알아보지 못했을 때.
 *
 * 마크업이 조금 바뀐 것은 알리지 않는다 — 사용자가 할 일이 없고, 출결은 잘
 * 되고 있을 수 있다. 그건 debug 페이지에서 개발자가 볼 신호다.
 *
 * 다만 **아무것도 알아보지 못한 경우**는 다르다. "출결이 없다" 와 "우리가 못
 * 본다" 는 사용자에게 전혀 다른 상황이고, 뒤엣것이면 PLATO 에서 직접 해야 한다.
 */
function structureBrokenHTML() {
  if (!context || !context.structureBroken) return '';
  return `
    <div class="result error" style="margin-top:8px">
      PLATO 화면이 바뀌어 출결을 확인할 수 없습니다<br>
      <span class="muted">FFlato 업데이트를 기다려주세요. 그때까지는
      <a href="${PLATO_HOME}" target="_blank" rel="noopener">PLATO에서 직접</a>
      진행해주세요.</span>
    </div>`;
}

/**
 * 조회에 실패한 과목.
 *
 * 실패를 "세션 없음" 과 같이 취급하면, 출결이 열려 있었는데 못 본 경우를
 * 사용자가 알 길이 없다. 눈에 띄게 알리고 다시 시도할 수 있게 한다.
 */
function failedHTML() {
  const rows = (context && context.failed) || [];
  if (rows.length === 0) return '';
  return `
    <div class="result error" style="margin-top:8px">
      ${rows.length}개 과목을 확인하지 못했습니다<br>
      <span class="muted">${esc(rows.map((r) => r.name).join(', '))}</span><br>
      출결이 열려 있을 수 있으니 다시 확인해주세요.
    </div>`;
}

/**
 * 조회하지 않은 과목의 기록이 얼마나 오래된 것인지.
 *
 * "이전" 이라고만 쓰면 사용자는 그게 무슨 뜻인지 알 수 없다. 출결이 열린
 * 과목을 찾으면 스캔을 멈추므로 나머지 과목은 저장해 둔 값을 보여주는데,
 * 그게 어제 것인지 열흘 전 것인지에 따라 신뢰도가 다르다.
 */
function recordAge(fetchedAt) {
  const at = fetchedAt ? new Date(fetchedAt).getTime() : NaN;
  if (!Number.isFinite(at)) return '저장된 기록';
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return '오늘 기록';
  if (days === 1) return '어제 기록';
  return `${days}일 전 기록`;
}

/**
 * 누적 출결 경고. 결석이나 지각이 있을 때만 한 줄로 알린다.
 *
 * 벤더 페이지에는 서버가 계산한 요약이 있지만 273KB 를 더 받아야 한다.
 * 같은 값을 이미 가진 표에서 세므로 추가 요청이 없다.
 */
function summaryHTML() {
  const rows = ((context && context.summary) || []).filter((r) => r.absent > 0 || r.late > 0);
  if (rows.length === 0) return '';
  return `
    <div class="status-box">
      <div class="status-head">누적 출결</div>
      ${rows.map((r) => `
        <div class="status-row">
          ${courseLink(r.courseId, r.name)}
          <span class="summary-counts">
            ${r.absent ? `<b class="tone-bad">결석 ${r.absent}</b>` : ''}
            ${r.late ? `<b class="tone-warn">지각 ${r.late}</b>` : ''}
            <span class="muted">/ ${r.recorded}회</span>
            ${r.fresh ? '' : `<span class="muted" title="이번 스캔에서 이 과목은 조회하지 않았습니다. 저장해 둔 기록을 보여줍니다.">· ${esc(recordAge(r.fetchedAt))}</span>`}
          </span>
        </div>`).join('')}
    </div>`;
}

/**
 * 오늘 수업이 있는 과목. 아무것도 못 찾았을 때 무엇을 봤는지 보이게 한다.
 *
 * **모르는 것을 "없다" 고 말하지 않는다.** 시간표를 아직 받지 못한 강좌가
 * 하나라도 있으면 "오늘은 수업이 없는 날" 이라고 단정할 수 없다.
 */
function todaySummary() {
  if (!context || !context.courses) return '';
  // "오늘" 은 기기가 아니라 한국 기준이다. 시간표의 날짜가 한국 시간이라서다.
  const key = kstDate(new Date());

  const withClass = [];
  let unknown = 0;
  for (const c of context.courses) {
    const rows = rowsOf(context.schedule, c.id);
    if (rows.length === 0) {
      // 시간표를 모르는 강좌. 출석부가 없는 강좌일 수도, 아직 못 받은 것일 수도.
      if (!(context.skippedNoLedger || []).includes(c.id)) unknown += 1;
      continue;
    }
    if (rows.some((r) => r.slot.startsWith(key))) withClass.push(c.displayName);
  }

  if (withClass.length > 0) return `오늘 수업: ${withClass.join(', ')}`;
  if (unknown > 0) return '시간표를 아직 받지 못한 과목이 있어요';
  return '시간표상 오늘은 수업이 없어요';
}

async function doSubmit(index) {
  const item = app.querySelector(`.course-item[data-index="${index}"]`);
  const input = item.querySelector('.auth-input');
  const btn = item.querySelector('.submit-btn');
  const slot = item.querySelector('.result-slot');
  const code = input.value.trim();

  if (!code) {
    slot.innerHTML = '<div class="result error">인증번호를 입력해주세요</div>';
    return;
  }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '...';

  let result;
  try {
    result = await submit(context, sessions[index], code);
  } catch (err) {
    result = { ok: false, message: `오류: ${err.message}` };
  }

  if (result.ok) {
    // 제출 성공만으로 끝내지 않는다. 서버 화면에서 실제로 출석이 됐는지
    // 확인한 결과를 함께 보여준다. 확인이 안 되면 직접 보시도록 안내한다.
    const v = result.verification || {};
    const seen = v.text ? ` · 서버 표시: <b>${esc(v.text)}</b>` : '';
    if (v.verified && v.key === 'present') {
      slot.innerHTML = `<div class="result success">출석 완료 · 확인됨</div>`;
    } else if (v.verified) {
      // 응답은 반영됐지만 출석이 아닌 상태 (지각 등). 결과를 그대로 알린다.
      slot.innerHTML = `<div class="result warn">응답이 반영되었습니다${seen}<br>
        <a href="${PLATO_HOME}" target="_blank" rel="noopener">PLATO에서 직접 확인하기</a></div>`;
    } else if (v.text) {
      // 지각처럼 우리가 클래스를 모르는 상태일 수 있다. 추측해서 성공이라
      // 말하지 않고, 서버가 쓴 글자를 그대로 보여준 뒤 직접 보시게 한다.
      slot.innerHTML = `<div class="result warn">출석 요청을 보냈습니다${seen}<br>
        <a href="${PLATO_HOME}" target="_blank" rel="noopener">PLATO에서 직접 확인하기</a></div>`;
    } else {
      slot.innerHTML = `<div class="result warn">출석 요청은 보냈지만 확인하지 못했습니다<br>
        <a href="${PLATO_HOME}" target="_blank" rel="noopener">PLATO에서 직접 확인하기</a></div>`;
    }
  } else if (result.kind === 'contract_changed') {
    // 우리 요청이 더는 받아들여지지 않는다. 인증번호를 더 눌러 봐야 소용없으니
    // 막다른 길 대신 직접 입력할 수 있는 화면으로 한 번에 보낸다.
    slot.innerHTML = `<div class="result error">${esc(result.message)}<br>
      <a href="${esc(courseStatusUrl(profileForHost(), sessions[index].courseId))}"
         target="_blank" rel="noopener">PLATO에서 바로 입력하기</a></div>`;
  } else {
    slot.innerHTML = `<div class="result error">${esc(result.message)}</div>`;
  }

  if (result.ok) {
    input.style.display = 'none';
    btn.style.display = 'none';
  } else if (result.kind === 'ended' || result.kind === 'contract_changed') {
    // 자동출결이 끝났다. 더 눌러 봐야 소용없다.
    input.disabled = true;
    btn.disabled = true;
    btn.textContent = label;
  } else {
    btn.disabled = false;
    btn.textContent = label;
    input.select();
  }
}

function renderError(message, hint) {
  app.innerHTML = `
    <div class="result error" style="margin:12px 0">${esc(message)}</div>
    ${hint ? `<div style="text-align:center;font-size:11px;color:#888;margin-bottom:8px">${esc(hint)}</div>` : ''}
    <button class="refresh-btn" id="refresh">다시 시도</button>
  `;
  bindRefresh();
}

/**
 * 로그인이 필요한 상태.
 *
 * 오류로 취급하지 않는다. 사용자가 뭘 잘못한 게 아니고 할 일이 분명하다 —
 * 로그인하고 돌아오면 된다. 그 한 걸음을 버튼으로 만들어 준다.
 */
function renderLoginNeeded() {
  app.innerHTML = `
    <div class="login-box">
      <div class="login-title">PLATO 로그인이 필요합니다</div>
      <div class="login-desc">로그인한 뒤 이 창을 다시 열어주세요.</div>
      <a class="login-btn" href="${LOGIN_URL}" target="_blank" rel="noopener">PLATO 로그인하기</a>
      <button class="refresh-btn" id="refresh">로그인했어요, 다시 확인</button>
    </div>
  `;
  bindRefresh();
}

/**
 * 진행 상황. 단계 번호나 내부 용어 대신 "무엇을 하는 중인지" 와
 * "몇 개 중 몇 개인지" 만 보여준다.
 */
function progress({ label, detail = '', done = 0, total = 0, note = '' }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  app.innerHTML = `
    <div class="progress-box">
      <div class="progress-label"><span class="spinner"></span> ${esc(label)}</div>
      ${detail ? `<div class="progress-detail">${esc(detail)}${total > 0 ? ` · ${done}/${total}` : ''}</div>` : ''}
      ${total > 0 ? `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
      ${note ? `<div class="progress-note">${esc(note)}</div>` : ''}
    </div>`;
}

async function scan({ full = false } = {}) {
  progress({ label: full ? '모든 과목을 확인하는 중' : 'PLATO에 연결하는 중' });
  try {
    // 세션이 없으면 결국 전 과목을 조회하므로 몇 초가 걸린다(보강 대응).
    // 멈춘 것처럼 보이지 않게, 그리고 무엇을 하는 중인지 알 수 있게 보여준다.
    context = await runScan({
      full,
      onProgress: ({ phase, done, total, label }) => {
        if (phase === 'session') progress({ label: 'PLATO에 연결하는 중' });
        else if (phase === 'courses') progress({ label: '수강 과목을 불러오는 중' });
        else if (phase === 'schedule') {
          progress({
            label: '수업 시간표를 가져오는 중',
            detail: '과목', done, total,
            note: '처음 한 번만 걸립니다. 다음부터는 생략돼요.',
          });
        } else if (phase === 'scan') {
          progress({ label: '출결이 열린 과목을 찾는 중', detail: label, done, total });
        }
      },
    });
    sessions = context.active;
  } catch (err) {
    sessions = [];
    // 오류 메시지 문자열을 뒤지지 않는다. 문구만 바뀌어도 분기가 깨진다.
    if (err.kind === 'not_logged_in' || err.kind === 'no_courses') {
      renderLoginNeeded();
      return;
    }
    const hint = {
      network: 'Wi-Fi 또는 인터넷 연결을 확인해주세요.',
      plato_changed: 'PLATO가 변경되었을 수 있습니다. 확장 프로그램 업데이트를 확인해주세요.',
    }[err.kind];
    renderError(err.message, hint);
    return;
  }
  render();
}

scan();
