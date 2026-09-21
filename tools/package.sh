#!/bin/sh
# 웹스토어 업로드용 zip 을 만든다.
# manifest.json 이 zip 루트에 있어야 하고, .git / docs / tools / tests 는 들어가면 안 된다.
set -e
cd "$(dirname "$0")/.."
./tests/run.sh >/dev/null
VERSION=$(node -p "require('./manifest.json').version")
OUT="fflato-$VERSION.zip"
rm -f "$OUT"
zip -r -q "$OUT" \
  manifest.json popup.html popup.js debug.html debug.js src icon48.png icon128.png LICENSE README.md \
  -x '*.DS_Store'
echo "$OUT"
unzip -Z1 "$OUT" | sed 's/^/  /'
echo
BAD=$(unzip -Z1 "$OUT" | grep -E '^(\.git|docs|tools|tests)/' || true)
if [ -n "$BAD" ]; then echo "제외 대상이 포함되었습니다:"; echo "$BAD"; exit 1; fi
unzip -Z1 "$OUT" | grep -qx 'manifest.json' || { echo "manifest.json 이 zip 루트에 없습니다."; exit 1; }
echo "OK — manifest.json 이 루트에 있고 제외 대상이 없습니다."
