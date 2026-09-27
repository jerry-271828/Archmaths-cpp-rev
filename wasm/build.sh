#!/bin/bash
# Builds the standalone ArchMaths compute core (no Qt) to WebAssembly and,
# with --embed, inlines it into arch-current.html.
#
# Toolchain: `zig c++` (wasm32-wasi + libc++). Set ZIG=/path/to/zig, or put
# zig on PATH (pip install ziglang provides `python3 -m ziglang`).
#
# Usage: [ARCHCORE_HTML=page.html] bash wasm/build.sh [--embed] [--no-simd]
#
# Environment:
#   ARCHCORE_KERNELS  space-separated kernel names (wasm/core/kernels/<name>.cpp,
#                     wasm/js/kernels/<name>.js) to include; default: all
#   ARCHCORE_OUT_DIR  output directory (default wasm/dist)
#   ARCHCORE_HTML     page to embed into; required with --embed, so a build
#                     never rewrites a page by accident (to update the real
#                     page: ARCHCORE_HTML=arch-current.html)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${ARCHCORE_OUT_DIR:-$SCRIPT_DIR/dist}"
HTML="${ARCHCORE_HTML:-}"

EMBED=0
SIMD_FLAG="-msimd128"
for arg in "$@"; do
    case "$arg" in
        --embed) EMBED=1 ;;
        --no-simd) SIMD_FLAG="" ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done
if [ "$EMBED" = 1 ] && [ -z "$HTML" ]; then
    echo "Error: --embed needs ARCHCORE_HTML=<page.html> (e.g. ARCHCORE_HTML=arch-current.html)" >&2
    exit 2
fi
mkdir -p "$OUT_DIR"

if [ -n "${ZIG:-}" ]; then
    ZIG_CMD=("$ZIG")
elif command -v zig >/dev/null 2>&1; then
    ZIG_CMD=(zig)
elif python3 -c "import ziglang" >/dev/null 2>&1; then
    ZIG_CMD=(python3 -m ziglang)
else
    echo "Error: zig not found. Install with 'pip install ziglang' or set ZIG=/path/to/zig" >&2
    exit 1
fi

SOURCES=(
    "$ROOT/src/math/Tokenizer.cpp"
    "$ROOT/src/math/ExpressionParser.cpp"
    "$SCRIPT_DIR"/core/*.cpp
)
if [ -n "${ARCHCORE_KERNELS:-}" ]; then
    for name in $ARCHCORE_KERNELS; do
        SOURCES+=("$SCRIPT_DIR/core/kernels/$name.cpp")
    done
else
    for f in "$SCRIPT_DIR"/core/kernels/*.cpp; do
        [ -e "$f" ] && SOURCES+=("$f")
    done
fi

"${ZIG_CMD[@]}" c++ -target wasm32-wasi -mexec-model=reactor \
    -std=c++17 -O3 $SIMD_FLAG -fno-exceptions -fno-rtti \
    -DARCHMATHS_NO_PARSER_TRACE -Wno-nullability-completeness \
    -I"$ROOT/include" -I"$SCRIPT_DIR/core" -I"$SCRIPT_DIR/core/kernels" \
    -Wl,--strip-all -Wl,-z,stack-size=1048576 \
    "${SOURCES[@]}" -o "$OUT_DIR/archcore.wasm"

echo "Built $OUT_DIR/archcore.wasm ($(wc -c < "$OUT_DIR/archcore.wasm") bytes)"

if [ "$EMBED" = 1 ]; then
    python3 "$SCRIPT_DIR/embed.py" "$OUT_DIR/archcore.wasm" "$HTML"
fi
