import { getRemainingTime, isExpired } from '../src/core/attendance.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  console.log((ok ? 'PASS ' : 'FAIL ') + label.padEnd(46) + got + (ok ? '' : ` (기대 ${want})`));
  ok ? pass++ : fail++;
};

const NOW = 1_800_000_000_000;          // 고정 시각 (ms)
const nowSec = Math.floor(NOW / 1000);
const at = (sec) => ({ endTime: nowSec + sec });

check('10분 남음', getRemainingTime(at(600), NOW), '10:00');
check('1분 5초 남음', getRemainingTime(at(65), NOW), '01:05');
check('9초 남음 (0 패딩)', getRemainingTime(at(9), NOW), '00:09');
check('이미 지남 → 00:00', getRemainingTime(at(-120), NOW), '00:00');
check('endTime 없음 → --:--', getRemainingTime({ endTime: null }, NOW), '--:--');
check('세션 자체가 없음 → --:--', getRemainingTime(null, NOW), '--:--');

check('만료 판정: 남음', isExpired(at(10), NOW), 'false');
check('만료 판정: 지남', isExpired(at(-1), NOW), 'true');
check('만료 판정: 정확히 0초', isExpired(at(0), NOW), 'true');
check('endTime 없으면 만료로 보지 않음', isExpired({ endTime: null }, NOW), 'false');

// 절대 시각이라 팝업을 닫았다 열어도 어긋나지 않는다 (구 버전 data-duration 회귀 방지)
const s = at(600);
check('30초 뒤에 다시 읽어도 정확', getRemainingTime(s, NOW + 30_000), '09:30');
check('5분 뒤에 다시 읽어도 정확', getRemainingTime(s, NOW + 300_000), '05:00');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
