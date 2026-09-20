# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Configure and build
mkdir -p build && cd build
cmake ..
make -j$(nproc)

# Release build with optimizations
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j$(nproc)

# Run the application
./ArchMaths

# WebAssembly build (Qt 6.5.3 wasm_singlethread + Emscripten 3.1.25)
# See web/README.md; the script also patches the embedded font for CJK support.
bash build-wasm.sh
```

Requires C++17, Qt5/Qt6 (with OpenGLWidgets for Qt6), and OpenGL ES 2.0 (or desktop OpenGL on non-Android).

## Architecture

ArchMaths is a Qt-based graphing calculator with OpenGL rendering. All code is in the `ArchMaths` namespace.

### Core Components

**Math Engine** (`include/math/`, `src/math/`)
- `Tokenizer` → `ExpressionParser` → `ExpressionEvaluator` pipeline
- `MathTypes.h` defines shared types: `Token`, `ExprNode` (AST), `PlotEntry`, `Color` (HSB), `Point2D/3D`
- Supports explicit (y=f(x)), implicit (f(x,y)=0), parametric, and polar plots

**Geometry** (`include/geometry/`, `src/geometry/`)
- `GeometryObject` base class with `Point`, `Line`, `Circle` implementations
- `GeometryManager` handles object lifecycle

**Rendering** (`include/rendering/`, `src/rendering/`)
- `GLCanvas` (QOpenGLWidget) handles all OpenGL rendering
- Compiles expression ASTs to GLSL for GPU-accelerated implicit function rendering
- Supports pan/zoom with coordinate transformation

**UI** (`include/ui/`, `src/ui/`)
- `MainWindow` orchestrates parsing, evaluation, and rendering
- `SidePanel` contains expression entries
- `EntryWidget` for individual expressions with `ParameterSlider` for variables

### Data Flow

1. User enters expression in `EntryWidget`
2. `MainWindow::onEntryChanged` triggers parsing via `ExpressionParser`
3. Variables extracted, `ParameterSlider` widgets created for non-standard variables
4. `ExpressionEvaluator` computes plot points (or GLSL generated for implicit)
5. `GLCanvas` renders via OpenGL
