#!/bin/sh
# 의존성 없는 테스트 러너. node 만 있으면 된다.
set -e
cd "$(dirname "$0")/.."
echo "--- 구문 검사 ---"
for f in $(find src tests tools -name '*.js' -o -name '*.mjs'); do node --check "$f"; done
echo "OK"
echo "--- 단위 테스트 ---"
for t in tests/*.test.mjs; do echo "[$t]"; node "$t"; done

# 시간표는 한국 시간이고 사용자의 기기는 아닐 수 있다. 다른 시간대에서도
# 같은 결과가 나와야 한다 — 한 번은 한국에서 멀리 떨어진 곳으로 돌린다.
echo "--- 시간대 독립성 (TZ=America/New_York) ---"
for t in tests/*.test.mjs; do TZ=America/New_York node "$t" > /dev/null || { echo "FAIL under TZ=America/New_York: $t"; TZ=America/New_York node "$t" | grep '^FAIL'; exit 1; }; done
echo "OK"
