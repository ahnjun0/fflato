// chrome.storage.local 얇은 래퍼.
//
// 확장 밖(테스트, 페이지 콘솔)에서는 chrome.storage 가 없다. 그럴 때는
// 메모리로 대체해 호출부가 분기하지 않게 한다.
//
// localStorage 는 쓰지 않는다 — 사용자가 인터넷 사용 기록을 지울 때 함께
// 지워질 수 있다. storage.sync 도 쓰지 않는다 (출석 기록이 벤더 동기화
// 서버로 올라간다). 자세한 이유는 docs/packaging.md 참고.

const memory = new Map();

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

export async function get(key, fallback = null) {
  if (!hasChromeStorage()) return memory.has(key) ? memory.get(key) : fallback;
  const got = await chrome.storage.local.get(key);
  return key in got ? got[key] : fallback;
}

export async function set(key, value) {
  if (!hasChromeStorage()) { memory.set(key, value); return; }
  await chrome.storage.local.set({ [key]: value });
}

export async function remove(key) {
  if (!hasChromeStorage()) { memory.delete(key); return; }
  await chrome.storage.local.remove(key);
}

/**
 * 저장소가 정말로 살아 있는지 확인한다.
 *
 * chrome.storage 가 없으면 메모리로 조용히 넘어가는데, 그러면 팝업을 닫는
 * 순간 전부 사라진다. 캐시가 계속 안 먹는 것처럼 보이면 여기부터 본다.
 */
export async function diagnose() {
  const backend = hasChromeStorage() ? 'chrome.storage.local' : 'memory (팝업을 닫으면 사라짐)';
  const probe = `fflato.probe.${Date.now()}`;
  let roundTrip = null;
  let error = null;
  try {
    await set(probe, { ok: true, at: Date.now() });
    const back = await get(probe, null);
    roundTrip = Boolean(back && back.ok);
    await remove(probe);
  } catch (err) {
    error = err.message;
  }

  let keys = [];
  let bytes = null;
  if (hasChromeStorage()) {
    try {
      const all = await chrome.storage.local.get(null);
      keys = Object.keys(all);
      bytes = JSON.stringify(all).length;
    } catch (err) {
      error = error || err.message;
    }
  } else {
    keys = [...memory.keys()];
  }

  return { backend, persistent: hasChromeStorage(), roundTrip, keys, bytes, error };
}
