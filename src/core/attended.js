// 출석 완료 기록.
//
// 출결의 단위는 **차시**다 — 출석현황 표의 한 행(수업일자 + 교시). 하루가
// 아니다. 연강이면 같은 날 두 번 출결이 열리므로, "오늘 출석했음" 으로
// 건너뛰면 2교시를 통째로 놓친다. 그래서 (강좌, 차시) 로 기록한다.
//
// 서버의 출석현황에 의존하지 않는 이유: 구 버전의 "출석했는데 목록에 계속
// 뜬다" 버그는 파싱 결함이 아니라 현황 반영 지연이었다. 저장해 둔 그 시점의
// HTML 을 파서에 다시 넣으면 정상 판정이 나온다. 스캔 순간에는 아직 ○ 가
// 없었을 뿐이다.
//
// 제출이 code 100 을 돌려준 순간이 가장 확실한 근거다. 그걸 로컬에 남긴다.
// 부수 효과로 현황 페이지를 따로 받지 않아도 되어 요청이 하나 준다.

import { get, set, remove } from '../lib/storage.js';

const KEY = 'fflato.attended.v1';
const KEEP_DAYS = 30;

/**
 * 출석 성공을 기록한다.
 *
 * @param slot "YYYY-MM-DD HH:MM" — 출석현황 표의 그 행. 모르면 null.
 * @param verification { verified, chip, text } — 제출 후 서버 화면에서 확인한 결과.
 *   확인하지 못했으면 verified=false 로 남긴다. 기록은 남기되 건너뛰기
 *   근거로는 쓰지 않는다.
 */
export async function markAttended(courseId, slot, now = new Date(), verification = {}) {
  const list = await loadAll();
  const id = String(courseId);
  const entry = {
    courseId: id,
    slot: slot ?? null,
    at: now.toISOString(),
    verified: verification.verified === true,
    chip: verification.chip ?? null,
    statusText: verification.text ?? null,
  };
  const i = list.findIndex((e) => e.courseId === id && e.slot === slot);
  if (i === -1) list.push(entry);
  else list[i] = entry;
  await set(KEY, prune(list, now));
}

/**
 * 이 강좌에서 출석이 확인된 차시들. 화면 표시용이다.
 *
 * ⚠ 이 기록으로 스캔을 건너뛰지 않는다. 한 차시에 자동출결이 여러 회차
 * 열릴 수 있기 때문이다. 구 시스템의 실제 기록:
 *
 *   회차 1  2026-07-01 12:03~12:04  미응답
 *   회차 2  2026-07-01 16:43~16:46  응답
 *   최종 출결: 지각
 *
 * 한 회차만 응답하면 순수 OR 로 출석이 되는 것이 아니라 등급이 내려간다.
 * 1회차를 출석했다고 그 과목을 그만 보면 2회차를 놓치고 지각이 된다.
 * 아끼는 것은 요청 하나고 잃는 것은 학점이다.
 */
export async function verifiedSlots(courseId) {
  const id = String(courseId);
  return new Set(
    (await loadAll()).filter((e) => e.courseId === id && e.slot && e.verified).map((e) => e.slot)
  );
}

export async function listAttended() {
  return loadAll();
}

export async function clearAttended() {
  await remove(KEY);
}

async function loadAll() {
  const list = await get(KEY, []);
  return Array.isArray(list) ? list : [];
}

/** 오래된 기록은 버린다. 무한히 쌓을 이유가 없다. */
export function prune(list, now = new Date()) {
  const cutoff = now.getTime() - KEEP_DAYS * 86400_000;
  return list.filter((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) ? t >= cutoff : true;
  });
}

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
