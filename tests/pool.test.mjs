import { mapPool } from '../src/lib/pool.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS ' : 'FAIL ') + label.padEnd(42) + JSON.stringify(got) + (ok ? '' : ` (기대 ${JSON.stringify(want)})`));
  ok ? pass++ : fail++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 순서 보존
{
  const { results } = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
    await sleep(n === 1 ? 30 : 1); // 첫 항목을 일부러 늦게 끝냄
    return n * 10;
  });
  check('결과가 입력 순서를 유지', results.map((r) => r.value), [10, 20, 30, 40, 50]);
}

// 동시 실행 상한
{
  const { peak } = await mapPool([1, 2, 3, 4, 5, 6, 7], 2, async () => { await sleep(10); });
  check('동시 실행이 상한을 넘지 않음 (limit=2)', peak, 2);
}
{
  const { peak } = await mapPool([1, 2, 3], 10, async () => { await sleep(5); });
  check('항목보다 상한이 크면 항목 수만큼만', peak, 3);
}

// 실패 격리
{
  const { results } = await mapPool([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('망함');
    return n;
  });
  check('한 항목이 실패해도 나머지는 진행', results.map((r) => (r.error ? 'ERR' : r.value)), [1, 'ERR', 3]);
}

// 빈 입력
{
  const { results, peak } = await mapPool([], 3, async () => 1);
  check('빈 입력', [results.length, peak], [0, 0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
