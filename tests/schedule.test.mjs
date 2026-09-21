import { kstDate, tierCourses, withinWindow } from '../src/core/schedule.js';
import { prune } from '../src/core/attended.js';
import { todaySlotsOf, currentSlotOf, summarizeRows, summarizeSchedule } from '../src/core/schedule.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(48) + (detail ?? ''));
  cond ? pass++ : fail++;
};

// 실제 시간표에서 가져온 형태
const row = (slot) => ({ slot, status: '-', chip: null });
const entry = (slots, table = true) => ({ rows: slots.map(row), table });
const SCHEDULE = {
  '1001': entry(['2026-09-01 10:30', '2026-09-03 10:30']), // 과목가 화/목 10:30
  '1002': entry(['2026-09-01 09:00', '2026-09-03 09:00']), // 과목나 화/목 09:00
  '1003': entry(['2026-09-02 18:30']),                     // 과목다 수 18:30
  '1004': entry(['2026-09-04 16:30']),                     // 과목라 금 16:30
};
const C = (id) => ({ id, name: id });
const ALL = ['1001', '1002', '1003', '1004'].map(C);
const kst = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h, mi) - 9 * 3600_000); // 한국 시간
const at = (s) => { const m = s.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/); return kst(+m[1], +m[2]-1, +m[3], +m[4], +m[5]); };
const ids = (l) => l.map((c) => c.id).join(',');

// --- 시간창 ---
check('수업 시작 정각 → 창 안', withinWindow('2026-09-01 10:30', at('2026-09-01 10:30')));
check('시작 15분 전 → 창 안', withinWindow('2026-09-01 10:30', at('2026-09-01 10:15')));
check('시작 30분 전 → 창 밖', !withinWindow('2026-09-01 10:30', at('2026-09-01 10:00')));
check('시작 90분 후 → 창 안 (수업 중)', withinWindow('2026-09-01 10:30', at('2026-09-01 12:00')));
check('시작 3시간 후 → 창 밖', !withinWindow('2026-09-01 10:30', at('2026-09-01 13:30')));
check('다른 날 같은 시각 → 창 밖', !withinWindow('2026-09-01 10:30', at('2026-09-02 10:30')));

// --- 단계 분류 ---
{
  const t = tierCourses(ALL, SCHEDULE, at('2026-09-01 10:40')); // 컴구 10:30 수업 중, AI 09:00 은 창 끝자락
  check('창이 겹치면 둘 다 now', ids(t.now) === '1001,1002', ids(t.now));
  check('가까운 수업이 먼저', t.now[0].id === '1001', t.now[0].id);
  check('겹칠 때 today 는 비어 있음', t.today.length === 0);
  check('오늘 수업 없는 과목은 other', ids(t.other) === '1003,1004', ids(t.other));
}
{
  const t = tierCourses(ALL, SCHEDULE, at('2026-09-01 09:30')); // AI 수업 중, 과목가는 1시간 뒤
  check('09:30 → 과목나만 now', ids(t.now) === '1002', ids(t.now));
  check('09:30 → 과목가는 20분 전이 아니라 today', ids(t.today) === '1001', ids(t.today));
}
{
  const t = tierCourses(ALL, SCHEDULE, at('2026-09-01 10:10')); // 컴구 20분 전
  check('시작 20분 전이면 now 에 포함', t.now.some((c) => c.id === '1001'), ids(t.now));
  check('_distance 는 결과에 남지 않음', t.now.every((c) => !('_distance' in c)));
}
{
  const t = tierCourses(ALL, SCHEDULE, at('2026-09-05 12:00')); // 토요일
  check('수업 없는 날엔 자동 스캔 대상 0', t.now.length === 0 && t.today.length === 0, `now=${t.now.length} today=${t.today.length}`);
  check('전부 other 로 (수동 검사 대상)', t.other.length === 4);
}
{
  const t = tierCourses([...ALL, C('9999')], SCHEDULE, at('2026-09-05 12:00'));
  check('시간표를 모르는 과목은 now (모르면 보는 쪽)', ids(t.now) === '9999', ids(t.now));
}
{
  const t = tierCourses(ALL, null, at('2026-09-05 12:00'));
  check('캐시가 아예 없으면 전부 now (안전 폴백)', t.now.length === 4 && t.other.length === 0);
}

// --- 절감량 ---
{
  const PAGE_KB = 275;
  const days = ['2026-09-01 10:40', '2026-09-02 18:40', '2026-09-04 16:40'];
  const scanned = days.map((d) => tierCourses(ALL, SCHEDULE, at(d)).now.length);
  const before = ALL.length * days.length;
  const after = scanned.reduce((a, b) => a + b, 0);
  check('스캔 대상이 과목 수보다 훨씬 적음', scanned.every((n) => n <= 2), JSON.stringify(scanned));
  console.log(`     → 3회 팝업: ${before}요청 ${(before*PAGE_KB/1024).toFixed(1)}MB → ${after}요청 ${(after*PAGE_KB/1024).toFixed(1)}MB (${Math.round((1-after/before)*100)}% 감소)`);
}

// --- 차시 조회 ---
{
  check('오늘 차시만 뽑음', todaySlotsOf(SCHEDULE, '1001', at('2026-09-01 08:00')).join() === '2026-09-01 10:30');
  check('오늘 수업 없으면 빈 배열', todaySlotsOf(SCHEDULE, '1003', at('2026-09-01 08:00')).length === 0);
  check('시간표 없는 과목은 빈 배열', todaySlotsOf(SCHEDULE, '9999', at('2026-09-01 08:00')).length === 0);
  check('창 안의 차시를 집어냄', currentSlotOf(SCHEDULE, '1001', at('2026-09-01 10:40')) === '2026-09-01 10:30');
  check('창 밖이면 null', currentSlotOf(SCHEDULE, '1001', at('2026-09-01 08:00')) === null);
}
{
  // 연강: 같은 날 두 차시
  const S = { X: entry(['2026-09-01 10:30', '2026-09-01 12:00']) };
  check('연강이면 오늘 차시 2개', todaySlotsOf(S, 'X', at('2026-09-01 10:40')).length === 2);
  check('연강에서 가까운 차시를 고름', currentSlotOf(S, 'X', at('2026-09-01 12:10')) === '2026-09-01 12:00');
}

// --- 오래된 출석 기록 정리 ---
{
  const now = new Date('2026-09-01T12:00:00+09:00');
  const kept = prune([
    { courseId: '1', slot: '2026-08-31 10:30', at: '2026-08-31T10:00:00.000Z' },
    { courseId: '2', slot: '2026-07-01 10:30', at: '2026-07-01T10:00:00.000Z' },
    { courseId: '3', slot: null, at: 'not-a-date' },
  ], now);
  check('30일 지난 기록은 버림', !kept.some((e) => e.courseId === '2'), JSON.stringify(kept.map(e=>e.courseId)));
  check('최근 기록은 유지', kept.some((e) => e.courseId === '1'));
  check('날짜를 못 읽는 기록은 남김 (섣불리 지우지 않음)', kept.some((e) => e.courseId === '3'));
}

// --- 출결 요약 (벤더 페이지 없이 우리가 계산) ---
{
  const r = (chip) => ({ slot: '2026-09-01 10:30', status: '', chip });
  const rows = [
    r('csms-chips-blue'), r('csms-chips-blue'), r('csms-chips-blue'),
    r('csms-chips-green'),
    r('csms-chips-red'), r('csms-chips-red'),
    r('csms-chips-yellow'),
    r('csms-chips-purple'),   // 모르는 칩
    r(null), r(null),         // 아직 도래하지 않은 차시
  ];
  const c = summarizeRows(rows);
  check('출석 집계', c.present === 3, String(c.present));
  check('지각 집계', c.late === 1, String(c.late));
  check('결석 집계', c.absent === 2, String(c.absent));
  check('조퇴 집계', c.early_leave === 1, String(c.early_leave));
  check('모르는 칩은 unknown', c.unknown === 1, String(c.unknown));
  check('미도래 차시는 세지 않음', c.recorded === 8, `recorded=${c.recorded}`);
  check('전체 차시 수는 별도로', c.total === 10, String(c.total));
  check('빈 입력', summarizeRows([]).recorded === 0 && summarizeRows(null).recorded === 0);
}
{
  const S = {
    A: { rows: [{ slot: '2026-09-01 10:30', chip: 'csms-chips-red' }], table: true,
         fetchedAt: '2026-09-01T00:00:00.000Z' },
    B: { rows: [{ slot: '2026-09-01 09:00', chip: null }], table: true }, // 기록 없음 → 제외
    C: { rows: [], table: false },                                        // 출석부 없음 → 제외
  };
  const list = summarizeSchedule(S, [
    { id: 'A', displayName: '과목가' }, { id: 'B', displayName: '과목나' },
    { id: 'C', displayName: '자율' }, { id: 'D', displayName: '캐시없음' },
  ]);
  check('기록이 있는 과목만', list.map((x) => x.courseId).join() === 'A', list.map((x) => x.courseId).join());
  check('  이름을 함께', list[0].name === '과목가');
  // 이번에 조회하지 않은 과목은 화면이 "며칠 전 기록" 이라고 밝혀야 한다.
  check('  언제 받은 값인지 함께', list[0].fetchedAt === '2026-09-01T00:00:00.000Z', String(list[0].fetchedAt));
}

// --- 시간표는 기기 시간대가 아니라 한국 시간이다 ---
{
  // 2026-09-01 10:30 KST 는 01:30Z 다. 어느 시간대의 기기에서 열어도 같아야 한다.
  // (tests/run.sh 를 TZ=America/New_York 등으로 돌려 검증한다.)
  check('KST 10:30 슬롯은 01:30Z 에 창 안', withinWindow('2026-09-01 10:30', new Date('2026-09-01T01:30:00Z')));
  check('  같은 숫자의 UTC 10:30 은 창 밖', !withinWindow('2026-09-01 10:30', new Date('2026-09-01T10:30:00Z')));
  check('한국 날짜: 23:30Z 는 이미 다음 날', kstDate(new Date('2026-09-01T23:30:00Z')) === '2026-09-02',
    kstDate(new Date('2026-09-01T23:30:00Z')));
  check('  14:59Z 는 아직 같은 날', kstDate(new Date('2026-09-01T14:59:00Z')) === '2026-09-01');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
