import { runScan } from './src/app/scan.js';
import { openSession } from './src/core/session.js';
import { getCourses } from './src/core/courses.js';
import { runHealthCheck } from './src/core/health.js';
import { listCaptures, clearCaptures, compareWithAssumptions } from './src/core/capture.js';

/** 대조표 상태별 표시. 'ok 아니면 다름' 으로 뭉치지 않는다. */
const CHECK_CHIP = {
  ok:   ['OK', 'badge-green'],
  skip: ['미확인', 'badge-gray'],
  info: ['정보', 'badge-blue'],
  bad:  ['다름', 'badge-red'],
};
import {
  loadSchedule, scheduleDiagnostics, summarizeSchedule, clearSchedule, CACHE_LIFETIME,
} from './src/core/schedule.js';
import { diagnose } from './src/lib/storage.js';
import { pendingChanges, acceptChanges } from './src/core/markup-watch.js';
import { listAttended, clearAttended } from './src/core/attended.js';
import { forgetSession } from './src/core/session.js';
import { profileForHost, loginUrl } from './src/config/endpoints.js';

const logArea = document.getElementById('log-area');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kb = (n) => `${Math.round(n / 1024)}KB`;

/** 표 마크업이 여덟 군데 흩어져 있어 한 곳으로 모은다. */
const table = (headers, rows) =>
  `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
  `<tbody>${rows.join('')}</tbody></table>`;
const cell = (...cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const chip = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;
const empty = (text) => `<p style="color:#aaa;text-align:center;padding:8px">${esc(text)}</p>`;

/** 로그인이 풀린 것은 오류가 아니라 안내다. 할 일이 분명하므로 링크를 준다. */
function reportError(err) {
  if (err.kind === 'not_logged_in' || err.kind === 'no_courses') {
    log('error', err.message);
    log('info', `로그인 페이지: ${loginUrl(profileForHost())}`);
    if (err.details) log('info', `원인: ${err.details.join(' / ')}`);
    return;
  }
  log('error', err.message);
  if (err.details) log('info', `원인: ${err.details.join(' / ')}`);
}

function log(tag, message) {
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  logArea.textContent += `[${time}] [${tag}] ${message}\n`;
  logArea.scrollTop = logArea.scrollHeight;
}

function card(id, html) {
  const el = document.getElementById(id);
  el.style.display = '';
  el.querySelector('.card-body').innerHTML = html;
}

function badge(el, text, cls = 'badge-gray') {
  const b = document.querySelector(el);
  if (b) { b.textContent = text; b.className = `badge ${cls}`; }
}

// ---------- 스캔 ----------
async function runScanUI(capture) {
  setBusy(true);
  logArea.textContent = '';
  log('info', capture ? '===== 캡처 모드 스캔 (제출하지 않음) =====' : '===== 스캔 시작 =====');

  try {
    const r = await runScan({ capture, onLog: log });

    card('plan-card', `
      ${table(['단계', '조회 과목 수', '발견'],
        r.plan.map((p) => cell(`<code>${esc(p.tier)}</code>`, p.count, `${p.found}건`)))}
      <p style="margin-top:8px;font-size:12px;color:#666">
        총 요청 <strong>${r.requestCount}회</strong> ·
        전송량 <strong>${kb(r.log.reduce((a, e) => a + (e.bytes || 0), 0))}</strong> ·
        최대 동시 ${r.peakConcurrency} ·
        제외 ${(r.selfCourses || []).length}과목 (자율강좌) ·
        건너뜀 ${r.skippedNoLedger.length}과목${r.skippedNoLedger.length ? ' (출석부 없음)' : ''}${
          r.notScanned.length ? ` · 미조회 ${r.notScanned.length}과목 (찾아서 멈춤)` : ''}
        ${r.scheduleFetched.length ? ` · 시간표 신규 ${r.scheduleFetched.length}과목` : ''}
      </p>
      <p style="font-size:11px;color:#888">
        자율강좌는 서버가 제공하는 목록(/local/ubeclass/my.php)으로 먼저 제외합니다 — 시간표도 받지 않습니다.
        <br>단계는 필터가 아니라 순서입니다. 찾으면 멈추고, 못 찾으면 결국 전부 조회합니다(보강 대응).
        ${r.notScanned.length ? `<br>같은 시각에 다른 과목의 출결이 열려 있을 수 있어, 팝업은 미조회 과목이
        있으면 <strong>전부 확인하기</strong> 를 제공합니다.` : ''}
      </p>`);
    badge('#plan-count', `${r.requestCount}요청`, 'badge-blue');

    card('detail-card', table(['과목', '결과', '크기'], r.log.map((e) => cell(
      `<strong>${esc(e.name)}</strong><br><code style="font-size:10px;color:#888">ID ${esc(e.courseId)}</code>`,
      e.steps.map((st) => `<div><code style="font-size:10px;color:#888">${esc(st.step)}:</code> ${stepTag(st)}</div>`).join(''),
      e.bytes ? kb(e.bytes) : '-'))));
    badge('#detail-count', `${r.log.length}과목`);

    card('active-card', r.active.length === 0
      ? empty('활성 출결 세션 없음')
      : table(['과목', '감지', '완전성', 'action', '필드', '종료'], r.active.map((a) => cell(
          `<strong>${esc(a.course && a.course.displayName)}</strong>`,
          a.detectedBy === 'input'
            ? chip('입력칸 (폼 id 변경?)', 'badge-blue')
            : chip('폼 id', 'badge-green'),
          a.complete ? chip('완전', 'badge-green') : `${chip('불완전', 'badge-red')}<br><small>${esc(a.reason)}</small>`,
          `<code style="font-size:10px">${esc(a.action)}</code>`,
          `<code style="font-size:10px">${esc(Object.keys(a.fields).sort().join(', ') || '-')}</code>`,
          a.endTime ? new Date(a.endTime * 1000).toLocaleTimeString('ko-KR') : '-'))));
    badge('#active-count', `${r.active.length}건`, r.active.length ? 'badge-green' : 'badge-gray');

    if (r.summary && r.summary.length > 0) {
      card('summary-card', `
        ${table(['과목', '기록', '출석', '지각', '결석', '기타', '모름'], r.summary.map((x) => cell(
          esc(x.name), x.recorded, x.present, x.late, x.absent, x.other, x.unknown)))}
        <p style="font-size:11px;color:#888;margin-top:6px">
          벤더 페이지(273KB)의 서버 계산 요약 대신, 조회하며 이미 받은 표에서 직접 셉니다 — 추가 요청 없음.
        </p>`);
      badge('#summary-count', `${r.summary.length}과목`, 'badge-blue');
    }

    await refreshState();
  } catch (err) {
    reportError(err);
  }
  setBusy(false);
}

function stepTag(s) {
  const map = {
    ok: ['수신', 'step-active'], active: ['세션 발견', 'step-active'],
    no_session: ['세션 없음', 'step-skip'], incomplete: ['불완전', 'step-attended'],
  };
  const [label, cls] = map[s.result] || [s.result, 'step-error'];
  return `<span class="step-tag ${cls}">${esc(label)}</span>${s.reason ? ` <small>${esc(s.reason)}</small>` : ''}`;
}

// ---------- 헬스체크 ----------
async function runHealthUI() {
  setBusy(true);
  log('info', '===== 자가진단 =====');
  try {
    const session = await openSession();
    const courses = await getCourses(session);

    // 검사 대상은 **출석부가 있는** 강좌라야 한다. 자율강좌를 고르면 표가 없는
    // 것이 정상인데 자가진단이 "깨졌다" 고 보고한다. 캐시에서 차시가 있는
    // 강좌를 먼저 고르고, 없으면 목록의 첫 강좌로 물러난다.
    const sched = await loadSchedule();
    const withLedger = sched && courses.find((c) => {
      const e = sched.courses[c.id];
      return e && e.table !== false && (e.rows || []).length > 0;
    });
    const subject = withLedger || courses[0];
    if (subject) log('info', `검사 대상 강좌: ${subject.displayName || subject.id}` +
      (withLedger ? '' : ' (출석부가 있는 강좌를 찾지 못해 첫 강좌를 씁니다)'));

    const report = await runHealthCheck(session, subject && subject.id, subject && (subject.displayName || subject.id));

    const SEL_BADGE = { ok: 'badge-green', fallback: 'badge-blue', empty: 'badge-gray', broken: 'badge-red', skipped: 'badge-gray' };
    const ACT_BADGE = { ok: 'badge-green', missing: 'badge-red', unusable: 'badge-red', skipped: 'badge-gray' };

    const rows = report.selectors.map((sp) => cell(
      `<code>${esc(sp.key)}</code><br><small style="color:#888">${esc(sp.desc)}</small>`,
      `<code style="font-size:10px">${esc(sp.css)}</code>`,
      `${chip(sp.verdict, SEL_BADGE[sp.verdict])} ${sp.count ?? '-'}`,
      `<small>${esc(sp.verdict === 'empty' ? (sp.emptyMeans || '') : (sp.verdict === 'fallback' ? '대체 셀렉터 사용' : ''))}</small>`));

    const actions = report.actions.map((a) => cell(
      `<code>${esc(a.action || a.key)}</code>`,
      chip(a.verdict, ACT_BADGE[a.verdict]),
      `<small>${esc(a.note || (a.msg || '').split('\n')[0])}</small>`));

    card('health-card', `
      <p style="margin-bottom:10px">
        ${chip(report.healthy ? '정상' : '이상', report.healthy ? 'badge-green' : 'badge-red')}
        ${report.subjectName ? `<span style="color:#888;font-size:11px">검사 대상: ${esc(report.subjectName)}</span> · ` : ''}
        ${esc(report.profileLabel)} · 테마 지문 ${report.themeMatched ? '일치' : '불일치'} ·
        페이지 ${report.pages.map((p) => `${p.page}(${p.bytes ? kb(p.bytes) : p.status})`).join(' ')}
      </p>
      ${table(['셀렉터', 'CSS', '결과', '비고'], rows)}
      <p style="margin:10px 0 4px;font-weight:600;font-size:12px">출결 상태 범례 대조</p>
      ${report.legend && report.legend.available
        ? `${table(['칩 클래스', '서버 표시', '우리 목록'],
            Object.entries(report.legend.legend).map(([c, label]) => cell(
              `<code style="font-size:10px">${esc(c)}</code>`, esc(label),
              report.legend.unknown.includes(c) ? chip('모르는 상태', 'badge-red') : chip('알고 있음', 'badge-green'))))}
           ${report.legend.extra.length
             ? `<p style="font-size:11px;color:#888">서버에 없는데 우리 목록에만 있는 것: <code>${esc(report.legend.extra.join(', '))}</code></p>`
             : ''}`
        : '<p style="font-size:11px;color:#888">이 페이지에 요약 섹션이 없습니다 (2026-09-03 이전 형태)</p>'}

      <p style="margin:10px 0 4px;font-weight:600;font-size:12px">action.php 등록 확인</p>
      ${table(['액션', '결과', '서버 응답'], actions)}
      <p style="font-size:11px;color:#888;margin-top:6px">
        쓰는 액션만 확인합니다. 목록이 곧 요청 수입니다(현재 ${report.actions.length + 1}회).
      </p>`);
    badge('#health-status', report.healthy ? '정상' : '이상', report.healthy ? 'badge-green' : 'badge-red');
    log('info', `자가진단: ${report.healthy ? '정상' : '이상 발견'} — ${JSON.stringify(report.summary)}`);
  } catch (err) {
    reportError(err);
  }
  setBusy(false);
}

// ---------- 상태(캡처 / 시간표 / 출석 기록) ----------
async function refreshState() {
  const session = { profile: (await openSession().catch(() => null))?.profile };

  const captures = await listCaptures();
  card('capture-card', captures.length === 0
    ? `${empty('캡처 없음')}
       <p style="font-size:11px;color:#888">
         첫 실제 출결 세션에서 <strong>캡처 모드 스캔</strong>을 누르면, 제출하지 않고 모달 구조만 저장합니다.
         시도 횟수를 쓰지 않으므로 출석은 PLATO 화면에서 평소대로 하시면 됩니다.
       </p>`
    : `<p style="font-size:11px;color:#856404;background:#fff3cd;padding:6px 8px;border-radius:5px;margin-bottom:10px">
         <strong>지난 세션의 기록입니다.</strong> 그 시점에 무엇을 읽었는지 남긴 것이라,
         이후 코드를 고쳤다면 지금 상태와 다를 수 있습니다. 다음 자동출결에서 다시 캡처해 확인하세요.
         <button class="btn" id="btn-clear-captures" style="margin-left:6px">캡처만 지우기</button>
       </p>` + captures.map((c) => {
        const rows = session.profile ? compareWithAssumptions(c, session.profile) : [];
        return `<div style="margin-bottom:12px">
          <strong>${esc(c.courseName || c.courseId)}</strong>
          <small style="color:#888"> ${esc(c.capturedAt)}</small>
          ${c.readerId ? chip(`읽은 방법: ${c.readerId}`, 'badge-blue') : chip('제출 정보를 읽지 못함', 'badge-red')}
          ${table(['항목', '기대', '실제', ''], rows.map((r) => cell(
            esc(r.label) + (r.note
              ? `<br><small style="color:#888;font-weight:400">${esc(r.note)}</small>` : ''),
            `<code style="font-size:10px">${esc(r.expected)}</code>`,
            `<code style="font-size:10px">${esc(r.actual)}</code>`,
            chip(...(CHECK_CHIP[r.state] || CHECK_CHIP.bad)))))}
          ${rows.some((r) => r.state === 'bad')
            ? `<div style="font-size:11px;color:#a00;margin-top:4px">기대와 다른 항목이 있습니다. 제출 규약이 바뀌었을 수 있습니다.</div>`
            : ''}
          <details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;color:#666">모달 HTML</summary>
          <pre style="font-size:10px;overflow:auto;max-height:220px;background:#f8f8f8;padding:8px">${esc(c.html || '(없음)')}</pre></details>
        </div>`;
      }).join(''));
  badge('#capture-count', `${captures.length}건`, captures.length ? 'badge-blue' : 'badge-gray');
  const cc = document.getElementById('btn-clear-captures');
  if (cc) cc.addEventListener('click', async () => {
    await clearCaptures();
    log('info', '캡처를 지웠습니다. (출석 기록은 유지)');
    await refreshState();
  });

  const sched = await loadSchedule();
  const attended = await listAttended();
  const statuses = {};
  if (sched) {
    for (const entry of Object.values(sched.courses)) {
      for (const r of (entry && entry.rows) || []) {
        const k = r.chip || r.status || '-';
        statuses[k] = (statuses[k] || 0) + 1;
      }
    }
  }

  const markup = await pendingChanges();
  card('markup-card', markup.tokens.length === 0
    ? `<p style="color:#888;font-size:12px">처음 보는 요소 없음. 확인 완료로 표시된 것 ${markup.accepted}개.</p>`
    : `<p style="font-size:12px">처음 보는 요소 ${markup.tokens.length}개
         <span style="color:#888">· 처음 관측 ${esc(markup.firstSeen || '')}</span></p>
       <p><code style="font-size:11px">${esc(markup.tokens.join(', '))}</code></p>
       <p style="font-size:11px;color:#888">
         PLATO 가 화면에 무언가를 더했습니다. 우리가 모르는 출결 상태가 생겼을 수도 있으니
         위의 <strong>출결 상태 범례 대조</strong> 를 함께 보세요.
       </p>
       <button class="btn" id="btn-accept-markup">확인했음</button>`);
  badge('#markup-count', markup.tokens.length ? `${markup.tokens.length}개` : '없음',
    markup.tokens.length ? 'badge-red' : 'badge-green');
  const acc = document.getElementById('btn-accept-markup');
  if (acc) acc.addEventListener('click', async () => {
    await acceptChanges();
    log('info', '화면 변경을 확인 완료로 표시했습니다.');
    await refreshState();
  });

  const store = await diagnose();
  const schedDiag = await scheduleDiagnostics();
  card('storage-card', `
    <table><tbody>
      <tr><td>저장 방식</td><td><span class="badge ${store.persistent ? 'badge-green' : 'badge-red'}">${esc(store.backend)}</span></td></tr>
      <tr><td>쓰기·읽기 왕복</td><td><span class="badge ${store.roundTrip ? 'badge-green' : 'badge-red'}">${store.roundTrip ? '성공' : '실패'}</span>${store.error ? ` <small>${esc(store.error)}</small>` : ''}</td></tr>
      <tr><td>저장된 키</td><td><code>${esc(store.keys.join(', ') || '(없음)')}</code></td></tr>
      <tr><td>총 크기</td><td>${store.bytes != null ? `${store.bytes}B` : '-'}</td></tr>
      <tr><td>시간표 캐시</td><td>${schedDiag.present
        ? `${schedDiag.courses.length}과목 · ${schedDiag.bytes}B`
        : '<span class="badge badge-red">없음</span>'}</td></tr>
    </tbody></table>
    ${store.persistent ? '' : `<p style="font-size:11px;color:#721c24;margin-top:8px">
      chrome.storage 를 쓸 수 없어 메모리로 동작 중입니다. 팝업을 닫으면 시간표와 sesskey 캐시가
      사라지므로 매번 다시 받습니다. manifest 의 <code>permissions: ["storage"]</code> 를 확인하고
      chrome://extensions 에서 확장을 <strong>새로고침</strong>해 주세요.</p>`}`);

  card('state-card', `
    <p style="font-size:12px"><strong>시간표 캐시</strong> ${schedDiag.present ? `${schedDiag.courses.length}과목` : '없음'}
    </p>
    <p style="font-size:11px;color:#888;margin:-4px 0 8px">
      수명 — 차시가 있는 강좌 <strong>${CACHE_LIFETIME.withRows.label}</strong>,
      결석·지각이 있는 강좌 <strong>${CACHE_LIFETIME.revisable.label}</strong>(정정될 수 있어 짧게),
      출석부가 없는 강좌 <strong>${CACHE_LIFETIME.empty.label}</strong>.
      조회한 강좌는 그때 받은 문서로 갱신되므로 사실상 만료되지 않습니다.
      수강하지 않게 된 강좌는 다음 실행에서 자동으로 빠집니다.
    </p>
    ${sched ? `<p style="font-size:11px;color:#888">수집 당시 출결 상태 분포: <code>${esc(JSON.stringify(statuses))}</code>
       — 참고용입니다. 건너뛰기 판정에는 쓰지 않습니다. 자동출결이 진행 중인 순간에는
       아직 응답하지 않은 차시가 <code>결석</code> 으로 표시되므로, 이 값으로 판단하면
       바로 그때 그 과목을 건너뛰게 됩니다. 판정은 제출 성공 기록으로만 합니다.</p>` : ''}
    ${schedDiag.present ? table(['과목 ID', '출석부', '차시 수', '받은 지', '만료', '다음 수업'],
      schedDiag.courses.map((e) => {
        const rows = (sched && sched.courses[e.id] && sched.courses[e.id].rows) || [];
        const next = rows.map((r) => r.slot).filter((x) => x >= nowSlot()).sort()[0];
        return cell(
          `<code>${esc(e.id)}</code>`,
          e.table === false ? chip('없음 → 조회 안 함', 'badge-gray') : chip('있음', 'badge-green'),
          e.rows,
          e.ageHours === null ? '-' : `${e.ageHours}시간`,
          e.expired ? chip('만료', 'badge-red') : chip('유효', 'badge-green'),
          esc(next || '-'));
      })) : ''}
    <p style="font-size:12px;margin-top:10px">
      <strong>이 확장으로 제출해 성공한 기록</strong> ${attended.length}건
      ${attended.length === 0 ? '<span style="color:#888;font-size:11px">— 아직 이 확장으로 제출한 적이 없습니다</span>' : ''}
    </p>
    ${attended.length ? table(['과목 ID', '차시', '확인', '관측 상태', '시각'], attended.map((a) => cell(
      `<code>${esc(a.courseId)}</code>`,
      esc(a.slot || '(차시 미상)'),
      a.verified ? chip('확인됨', 'badge-green') : chip('미확인', 'badge-red'),
      a.chip ? `<code style="font-size:10px">${esc(a.chip)}</code> ${esc(a.statusText || '')}` : '-',
      `<small>${esc(a.at)}</small>`))) : ''}
    <p style="font-size:11px;color:#888;margin-top:6px">
      <strong>표시용 기록입니다.</strong> 조회 대상을 줄이는 데는 쓰지 않습니다 —
      한 차시에 자동출결이 여러 회차 열릴 수 있고, 한 회차를 놓치면 등급이 내려갑니다
      (구 시스템 실측: 1회차 미응답 + 2회차 응답 → 최종 <strong>지각</strong>).
      그래서 출석을 마친 과목도 계속 조회합니다.
    </p>`);
}

function nowSlot() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 00:00`;
}

function setBusy(busy) {
  document.querySelectorAll('.toolbar button').forEach((b) => { b.disabled = busy; });
}

document.getElementById('btn-scan').addEventListener('click', () => runScanUI(false));
document.getElementById('btn-capture').addEventListener('click', () => runScanUI(true));
document.getElementById('btn-health').addEventListener('click', runHealthUI);
document.getElementById('btn-clear-log').addEventListener('click', () => { logArea.textContent = ''; });
document.getElementById('btn-clear-session').addEventListener('click', async () => {
  await forgetSession();
  log('info', 'sesskey 캐시를 지웠습니다. 다음 실행에서 홈페이지를 한 번 받아 새로 얻습니다.');
  await refreshState();
});
document.getElementById('btn-clear-schedule').addEventListener('click', async () => {
  await clearSchedule();
  log('info', '시간표 캐시를 지웠습니다. 다음 실행에서 전 과목을 다시 받습니다 (과목당 194KB).');
  await refreshState();
});
document.getElementById('btn-clear-records').addEventListener('click', async () => {
  await clearCaptures();
  await clearAttended();
  log('info', '캡처와 출석 기록을 지웠습니다.');
  await refreshState();
});

refreshState().catch((err) => reportError(err));
