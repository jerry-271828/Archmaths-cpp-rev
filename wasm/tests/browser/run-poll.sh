#!/bin/bash
# Fire-and-poll test runner: robust against the bridge dropping the
# Runtime.evaluate response under load. Usage: run-poll.sh <testfile> <name>
set -u
cd /storage/Users/currentUser/test1/Archmaths-cpp-rev
T="wasm/tests/browser/$1.js"; NAME="$2"
TAB="8123/arch-current.html"
mkdir -p build/regr
# wrapper: store result on window, resolve immediately
{
  echo 'window.__testResult = undefined; ('
  cat "$T"
  echo ').then(r => { window.__testResult = { ok: true, value: r }; }, e => { window.__testResult = { ok: false, error: String(e && e.stack || e) }; }), "started";'
} > build/regr/wrap-$NAME.js
echo "== fire $NAME $(date +%H:%M:%S)"
node wasm/tests/browser/cdp.js run "$TAB" build/regr/wrap-$NAME.js 60000 | tail -1
cat > build/regr/poll-$NAME.js <<'POLL'
(async () => window.__testResult
    ? { done: true, result: window.__testResult }
    : { done: false })()
POLL
for i in $(seq 1 120); do
  sleep 15
  OUT=$(node wasm/tests/browser/cdp.js run "$TAB" build/regr/poll-$NAME.js 25000 2>/dev/null)
  if echo "$OUT" | grep -q '"done": *true'; then
    echo "$OUT" > build/regr/result-$NAME.json
    echo "== $NAME DONE $(date +%H:%M:%S) (poll $i)"
    echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']; v=d.get('value') or {}; print('ok:', d.get('ok'), ' mismatches:', len(v.get('mismatches') or v.get('issues') or []), ' summary:', v.get('summary'))" 2>/dev/null || echo "$OUT" | head -c 300
    exit 0
  fi
done
echo "== $NAME POLL-TIMEOUT $(date +%H:%M:%S)"
exit 2
