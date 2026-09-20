#!/bin/bash
set -e

# ArchMaths WebAssembly Build Script
# Prerequisites:
#   1. Emscripten 3.1.25: https://emscripten.org/docs/getting_started/downloads.html
#   2. Matching Qt 6.5.3 desktop and wasm_singlethread installations.

# Configuration - adjust these paths when using a local SDK installation.
EMSDK_PATH="${EMSDK_PATH:-${EMSDK:-$HOME/emsdk}}"
QT_WASM_PATH="${QT_WASM_PATH:-$HOME/Qt/6.5.3/wasm_singlethread}"
QT_HOST_PATH="${QT_HOST_PATH:-$HOME/Qt/6.5.3/gcc_64}"

# Validate paths
if [ ! -f "$EMSDK_PATH/emsdk_env.sh" ]; then
    echo "Error: Emscripten SDK not found at $EMSDK_PATH"
    echo "Set EMSDK_PATH environment variable or install from:"
    echo "  git clone https://github.com/emscripten-core/emsdk.git"
    echo "  cd emsdk && ./emsdk install 3.1.25 && ./emsdk activate 3.1.25"
    exit 1
fi

if [ ! -d "$QT_WASM_PATH" ]; then
    echo "Error: Qt6 WebAssembly not found at $QT_WASM_PATH"
    echo "Set QT_WASM_PATH environment variable or install with:"
    echo "  pip install aqtinstall"
    echo "  aqt install-qt linux desktop 6.5.3 wasm_singlethread -O \"\$HOME/Qt\""
    echo "  aqt install-qt linux desktop 6.5.3 gcc_64 -O \"\$HOME/Qt\""
    exit 1
fi

if [ ! -x "$QT_WASM_PATH/bin/qt-cmake" ]; then
    echo "Error: Qt WebAssembly qt-cmake not found at $QT_WASM_PATH/bin/qt-cmake"
    exit 1
fi

if [ ! -d "$QT_HOST_PATH" ]; then
    echo "Error: Qt host installation not found at $QT_HOST_PATH"
    echo "Set QT_HOST_PATH to the matching Qt 6.5.3 desktop installation."
    exit 1
fi

# Source Emscripten environment
source "$EMSDK_PATH/emsdk_env.sh"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build
echo "Building ArchMaths for WebAssembly..."
BUILD_DIR="$SCRIPT_DIR/build-wasm"
mkdir -p "$BUILD_DIR"

"$QT_WASM_PATH/bin/qt-cmake" -S "$SCRIPT_DIR" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="$QT_WASM_PATH" \
    -DQT_HOST_PATH="$QT_HOST_PATH"

cmake --build "$BUILD_DIR" --parallel "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

echo ""
echo "Build complete! Output files:"
DIST_DIR="$BUILD_DIR/dist"
mkdir -p "$DIST_DIR"
cp "$BUILD_DIR/ArchMaths.html" "$DIST_DIR/index.html"
cp "$BUILD_DIR/ArchMaths.js" "$DIST_DIR/ArchMaths.js"
cp "$BUILD_DIR/ArchMaths.wasm" "$DIST_DIR/ArchMaths.wasm"
cp "$BUILD_DIR/qtloader.js" "$DIST_DIR/qtloader.js"

# Replace the embedded DejaVuSans.ttf resource with our subset font so that
# Chinese text and math symbols render on the web. Qt 6.5 wasm only loads
# fonts synchronously from its embedded resources, and its asynchronous
# Local Font Access path never invalidates the fallback cache, so patching
# the binary is the only reliable route. See web/patch-wasm-font.py.
python3 "$SCRIPT_DIR/web/patch-wasm-font.py" \
    "$DIST_DIR/ArchMaths.wasm" "$SCRIPT_DIR/web/fonts/DejaVuSans-subset.ttf"

if [ -f "$BUILD_DIR/qtlogo.svg" ]; then
    cp "$BUILD_DIR/qtlogo.svg" "$DIST_DIR/qtlogo.svg"
fi

ls -lh "$DIST_DIR/index.html" "$DIST_DIR/ArchMaths.js" \
    "$DIST_DIR/ArchMaths.wasm" "$DIST_DIR/qtloader.js"

echo ""
echo "To deploy, copy these files to your web server:"
echo "  - $DIST_DIR/index.html"
echo "  - $DIST_DIR/ArchMaths.js"
echo "  - $DIST_DIR/ArchMaths.wasm"
echo "  - $DIST_DIR/qtloader.js"
echo ""
echo "Run locally: python3 -m http.server --directory \"$DIST_DIR\" 8000"
echo "Open http://localhost:8000 (opening index.html as a file will not work)."
echo "For a multithreaded Qt build, also configure these headers:"
echo "  Cross-Origin-Opener-Policy: same-origin"
echo "  Cross-Origin-Embedder-Policy: require-corp"
