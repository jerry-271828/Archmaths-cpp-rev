#!/bin/bash
# Sequential browser-suite driver: runs in-page tests against a chosen tab and
# records JSON results. Usage:
#   bash wasm/tests/browser/run-suite.sh <tabId|urlSubstring> [test ...]
set -u
cd "$(dirname "$0")/../../.."
TAB="$1"; shift
TESTS="$@"
for t in $TESTS; do
    log=~/tmp/suite-$t.log
    echo "=== $t $(date +%H:%M:%S)" | tee "$log"
    node wasm/tests/browser/cdp.js run "$TAB" "wasm/tests/browser/$t.js" 3600000 >> "$log" 2>&1
    echo "EXIT=$?" >> "$log"
    tail -c 300 "$log" | tr '\n' ' '; echo
done
echo "SUITE DONE $(date +%H:%M:%S)"
