// 동시 실행 개수를 제한하는 map.
//
// my.php 는 275KB 다. 7과목을 Promise.all 로 한꺼번에 던지면 2MB 를 동시에
// 요청하는 셈이 된다. 구 버전이 그렇게 하고 있었고, 페이지가 6배 무거워진
// 지금은 그대로 두면 안 된다.

/**
 * items 를 fn 으로 매핑하되 동시에 limit 개까지만 실행한다.
 * 결과는 items 순서를 유지한다. fn 이 던지면 그 항목만 { error } 로 담긴다.
 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let peak = 0;
  let running = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      running++;
      peak = Math.max(peak, running);
      try {
        results[i] = { value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { error };
      } finally {
        running--;
      }
    }
  };

  await Promise.all(Array.from({ length: size }, worker));
  return { results, peak };
}
