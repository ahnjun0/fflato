// 시간표 캐시의 수명과 형태.
//
// 실제로 났던 문제: 캐시에 table 정보가 없는 옛 항목이 "모름" 으로 굳어,
// 자율강좌가 매번 다시 조회됐다. 항목이 이미 있으니 다시 받지도 않아
// 영원히 갱신되지 않았다.
import {
  loadSchedule, hasAttendanceLedger, scheduleDiagnostics, clearSchedule, CACHE_LIFETIME,
} from '../src/core/schedule.js';
import { set, remove } from '../src/lib/storage.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(52) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const KEY = 'fflato.schedule.v2';
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const seed = (courses) => set(KEY, { fetchedAt: new Date().toISOString(), courses });
const row = { slot: '2026-09-01 10:30', chip: null };

// --- 형태가 불완전한 옛 항목은 다시 받게 한다 ---
{
  await seed({
    OLD: { rows: [], fetchedAt: hoursAgo(1) },                 // table 없음
    NEW: { rows: [], table: false, fetchedAt: hoursAgo(1) },
  });
  const s = await loadSchedule();
  check('table 이 없는 옛 항목은 캐시에서 빠진다', !('OLD' in s.courses), Object.keys(s.courses).join());
  check('  → 다시 받아 table 을 채우게 된다 (모름으로 굳지 않음)',
    hasAttendanceLedger(s.courses, 'OLD') === null);
  check('형태가 온전한 항목은 유지', s.courses.NEW && s.courses.NEW.table === false);
  check('  → 조회 대상에서 제외', hasAttendanceLedger(s.courses, 'NEW') === false);
}

// --- 출석부 없는 강좌는 짧게만 믿는다 ---
{
  await seed({
    FRESH: { rows: [], table: false, fetchedAt: hoursAgo(1) },
    STALE: { rows: [], table: false, fetchedAt: hoursAgo(24) },
  });
  const s = await loadSchedule();
  check('12시간 안쪽이면 유지', 'FRESH' in s.courses);
  check('12시간 넘으면 다시 확인한다', !('STALE' in s.courses),
    '출석부가 나중에 생길 수 있다');
}

// --- 차시가 있는 강좌는 오래 믿어도 된다 ---
{
  await seed({
    A: { rows: [row], table: true, fetchedAt: hoursAgo(24 * 10) },
    B: { rows: [row], table: true, fetchedAt: hoursAgo(24 * 20) },
  });
  const s = await loadSchedule();
  check('10일 된 차시 정보는 유지 (순서 정하는 데만 씀)', 'A' in s.courses);
  check('14일 넘으면 다시 받는다', !('B' in s.courses));
}

// --- 진단 정보의 형태 (debug 페이지가 이 모양을 가정한다) ---
{
  await seed({
    A: { rows: [row], table: true, fetchedAt: hoursAgo(2) },
    Z: { rows: [], table: false, fetchedAt: hoursAgo(2) },
  });
  const d = await scheduleDiagnostics();
  check('present', d.present === true);
  check('courses 배열', Array.isArray(d.courses) && d.courses.length === 2);
  const keys = Object.keys(d.courses[0]).sort().join();
  check('  항목 필드', keys === 'ageHours,expired,id,limitHours,rows,table', keys);
  check('emptyStaleHours 노출', typeof d.emptyStaleHours === 'number');
  check('bytes', typeof d.bytes === 'number');
  await remove(KEY);
  check('캐시 없으면 present=false', (await scheduleDiagnostics()).present === false);
}

// --- 수동으로 지우기 ---
{
  await seed({ A: { rows: [row], table: true, fetchedAt: hoursAgo(1) } });
  check('지우기 전에는 있다', (await loadSchedule()) !== null);
  await clearSchedule();
  check('clearSchedule 후에는 없다', (await loadSchedule()) === null);
}

// --- 바뀔 수 있는 기록은 짧게만 믿는다 ---
{
  // 결석은 출석인정이나 교수님 정정으로 출석이 될 수 있다. 14일을 믿으면
  // 이미 정정된 것을 2주 동안 결석이라고 보여준다.
  const absentRow = { slot: '2026-09-01 10:30', chip: 'csms-chips-red' };
  const presentRow = { slot: '2026-09-01 10:30', chip: 'csms-chips-blue' };
  await seed({
    ABSENT: { rows: [absentRow], table: true, fetchedAt: hoursAgo(3 * 24) },
    LATE: { rows: [{ ...absentRow, chip: 'csms-chips-green' }], table: true, fetchedAt: hoursAgo(3 * 24) },
    PRESENT: { rows: [presentRow], table: true, fetchedAt: hoursAgo(3 * 24) },
    PLAIN: { rows: [row], table: true, fetchedAt: hoursAgo(3 * 24) },
  });
  const c = (await loadSchedule()).courses;
  check('3일 된 결석 기록은 만료 → 다시 받는다', !('ABSENT' in c), Object.keys(c).join());
  check('  지각도 같다', !('LATE' in c));
  check('  출석만 있으면 그대로 믿는다', 'PRESENT' in c);
  check('  상태가 없는 차시도 그대로', 'PLAIN' in c);
}
{
  // 다만 하루밖에 안 됐으면 다시 받지 않는다 — 매번 조회하면 트래픽만 는다.
  await seed({
    ABSENT: { rows: [{ slot: '2026-09-01 10:30', chip: 'csms-chips-red' }], table: true,
              fetchedAt: hoursAgo(20) },
  });
  check('하루 된 결석 기록은 그대로 쓴다', 'ABSENT' in (await loadSchedule()).courses);
}

// --- 수명 값이 화면에 노출된다 ---
{
  check('차시 있는 강좌 수명', CACHE_LIFETIME.withRows.days === 14, CACHE_LIFETIME.withRows.label);
  check('출석부 없는 강좌 수명', CACHE_LIFETIME.empty.hours === 12, CACHE_LIFETIME.empty.label);
  check('정정될 수 있는 기록 수명', CACHE_LIFETIME.revisable.days === 2, CACHE_LIFETIME.revisable.label);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
