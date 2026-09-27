// ArchCore kernel "implicit2d": per-block 2D implicit curve/inequality
// rasterization via marching squares. Port of
// ArchEngine.processSingleBlockForImplicit (arch-current.html).
//
// The JS adapter (wasm/js/kernels/implicit2d.js) resolves a compiled Program
// per active implicit-family function (ArchCore.programFor), fills grid
// samples for any function that must stay on the JS path ("hybrid") directly
// into the wasm value buffer below, then calls ac_implicit2d_run() once. This
// file evaluates the remaining ("wasm-eligible") functions' grids in batch
// and runs the identical marching-squares/fill algorithm the page's JS uses,
// writing segments and fill triangles to growable output buffers the
// adapter reads back.

#include "../CoreApi.h"
#include "../JsMath.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace ArchMaths {
namespace Core {
namespace {

// Plot-type / sign codes; must match the encoding in
// wasm/js/kernels/implicit2d.js exactly.
enum PlotTypeCode : int32_t { kImplicit = 0, kImplicit3D = 1, kX3D = 2, kY3D = 3 };
enum SignCode : int32_t { kEq = 0, kGe = 1, kLe = 2, kGt = 3, kLt = 4 };

struct Pt {
    double x;
    double y;
};

constexpr double kLerpEpsilon = 1e-9;
constexpr double kFillEpsilon = 1e-9;

inline bool isFin(double v) { return JsMath::isFinite(v); }

// lerp(c1,c2,v1,v2): NaN when the corners are (near-)equal, matching the
// page's `Math.abs(v1-v2)<epsilon` guard against dividing by ~0.
inline double lerp(double c1, double c2, double v1, double v2) {
    if (std::fabs(v1 - v2) < kLerpEpsilon) return JsMath::kNaN;
    return c1 + (c2 - c1) * (0.0 - v1) / (v2 - v1);
}

// ---- per-call state (persisted across calls only to reuse allocations) ----
std::vector<double> g_values;   // [funcIdx][iy][ix], iy=0 is math-top row
std::vector<double> g_zeros;    // reusable zero lane for unused z args
int g_nFuncs = 0;
int g_numPoints1D = 0;

OutBuffer<double> g_segCoords;      // 4 doubles per emitted segment
OutBuffer<int32_t> g_segFunc;       // 1 per segment: local function index
// Fill triangles, tagged per-triangle (not pre-grouped) so the JS adapter can
// replay them into engine.implicitFillData (a Map, keyed by original entry
// index) in the SAME chronological insertion order the original JS produces
// -- a function's key is created the first time ANY cell yields a triangle
// for it, interleaved with every other active function in raster-scan order.
OutBuffer<double> g_fillCoords;     // 6 doubles per emitted triangle
OutBuffer<int32_t> g_fillFunc;      // 1 per triangle: local function index

inline size_t gridN() { return static_cast<size_t>(g_numPoints1D) * static_cast<size_t>(g_numPoints1D); }

inline double valueAt(int funcIdx, int ix, int iy) {
    return g_values[static_cast<size_t>(funcIdx) * gridN() + static_cast<size_t>(iy) * g_numPoints1D + ix];
}
inline double valueAtChecked(int funcIdx, int ix, int iy) {
    if (ix < 0 || ix >= g_numPoints1D || iy < 0 || iy >= g_numPoints1D) return JsMath::kNaN;
    return valueAt(funcIdx, ix, iy);
}

void addTri(int32_t funcIdx, const Pt& p1, const Pt& p2, const Pt& p3) {
    if (!isFin(p1.x) || !isFin(p1.y) || !isFin(p2.x) || !isFin(p2.y) || !isFin(p3.x) || !isFin(p3.y)) return;
    g_fillCoords.data.push_back(p1.x); g_fillCoords.data.push_back(p1.y);
    g_fillCoords.data.push_back(p2.x); g_fillCoords.data.push_back(p2.y);
    g_fillCoords.data.push_back(p3.x); g_fillCoords.data.push_back(p3.y);
    g_fillFunc.data.push_back(funcIdx);
}
void addQuad(int32_t funcIdx, const Pt& p1, const Pt& p2, const Pt& p3, const Pt& p4) {
    addTri(funcIdx, p1, p2, p3);
    addTri(funcIdx, p1, p3, p4);
}

} // namespace
} // namespace Core
} // namespace ArchMaths

using namespace ArchMaths::Core;
namespace JsMath = ArchMaths::JsMath;

// Allocates (and NaN-fills) the per-block sample buffer:
// nFuncs * numPoints1D * numPoints1D doubles, laid out [funcIdx][iy][ix].
// The JS adapter writes "hybrid" (non-wasm-eligible) functions' slices here
// before calling ac_implicit2d_run(); ac_implicit2d_run() fills the rest.
ARCHCORE_EXPORT(ac_implicit2d_values_ptr) double* ac_implicit2d_values_ptr(int nFuncs, int numPoints1D) {
    if (nFuncs < 0) nFuncs = 0;
    if (numPoints1D < 1) numPoints1D = 1;
    g_nFuncs = nFuncs;
    g_numPoints1D = numPoints1D;
    const size_t size = static_cast<size_t>(nFuncs) * static_cast<size_t>(numPoints1D) * static_cast<size_t>(numPoints1D);
    g_values.assign(size, JsMath::kNaN);
    return g_values.empty() ? nullptr : g_values.data();
}

// Evaluates every wasm-eligible function's grid slice (handles[f] > 0) and
// runs the marching-squares outline + fill pass over the whole buffer.
// handles/plotTypes/signs are nFuncs-length int32 arrays (plotTypes/signs
// encodings above); flags is normally ArchCore.FLAG_STRICT_POW. Returns 0 on
// a shape mismatch (caller should then fall back to the JS path).
ARCHCORE_EXPORT(ac_implicit2d_run) int ac_implicit2d_run(
    int nFuncs, int numPoints1D,
    double subCellStepMath, double cellMinXMath, double cellMaxYMath,
    double unitStep, double scale, double implicitPrecisionStep,
    int autoBreakpointDetectionEnabled,
    const int32_t* handles, const int32_t* plotTypes, const int32_t* signs,
    int flags) {
    if (nFuncs != g_nFuncs || numPoints1D != g_numPoints1D) return 0;
    if (nFuncs <= 0 || numPoints1D < 2 || !handles || !plotTypes || !signs) return 0;

    const int implictjump = numPoints1D - 1;
    const size_t gN = gridN();

    std::vector<double> xs(static_cast<size_t>(numPoints1D)), ys(static_cast<size_t>(numPoints1D));
    for (int i = 0; i < numPoints1D; ++i) {
        xs[static_cast<size_t>(i)] = cellMinXMath + i * subCellStepMath;
        ys[static_cast<size_t>(i)] = cellMaxYMath - i * subCellStepMath;
    }
    if (g_zeros.size() < gN) g_zeros.assign(gN, 0.0);

    // ---- fill wasm-eligible slices (hybrid slices were pre-filled by JS) ----
    std::vector<double> xLane, yLane, rowOrCol;
    for (int f = 0; f < nFuncs; ++f) {
        const int handle = handles[f];
        if (handle <= 0) continue;
        Program* p = programFromHandle(handle);
        if (!p) continue; // shouldn't happen; leave whatever's already there.
        double* slice = g_values.data() + static_cast<size_t>(f) * gN;
        const int plotType = plotTypes[f];
        if (plotType == kX3D) {
            // value(ix,iy) = x(ix) - f(0, y(iy), 0); f depends only on y.
            rowOrCol.assign(static_cast<size_t>(numPoints1D), 0.0);
            const double* lanes[3] = {g_zeros.data(), ys.data(), g_zeros.data()};
            p->evaluate(lanes, numPoints1D, rowOrCol.data(), flags);
            for (int iy = 0; iy < numPoints1D; ++iy) {
                const double val = rowOrCol[static_cast<size_t>(iy)];
                for (int ix = 0; ix < numPoints1D; ++ix) {
                    const double v = xs[static_cast<size_t>(ix)] - val;
                    slice[static_cast<size_t>(iy) * numPoints1D + ix] = isFin(v) ? v : JsMath::kNaN;
                }
            }
        } else if (plotType == kY3D) {
            // value(ix,iy) = y(iy) - f(x(ix), 0, 0); f depends only on x.
            rowOrCol.assign(static_cast<size_t>(numPoints1D), 0.0);
            const double* lanes[3] = {xs.data(), g_zeros.data(), g_zeros.data()};
            p->evaluate(lanes, numPoints1D, rowOrCol.data(), flags);
            for (int iy = 0; iy < numPoints1D; ++iy) {
                const double vy = ys[static_cast<size_t>(iy)];
                for (int ix = 0; ix < numPoints1D; ++ix) {
                    const double v = vy - rowOrCol[static_cast<size_t>(ix)];
                    slice[static_cast<size_t>(iy) * numPoints1D + ix] = isFin(v) ? v : JsMath::kNaN;
                }
            }
        } else {
            // kImplicit (2-arg f(x,y)) or kImplicit3D/z (3-arg f(x,y,0)).
            if (xLane.size() < gN) { xLane.resize(gN); yLane.resize(gN); }
            for (int iy = 0; iy < numPoints1D; ++iy) {
                for (int ix = 0; ix < numPoints1D; ++ix) {
                    const size_t idx = static_cast<size_t>(iy) * numPoints1D + ix;
                    xLane[idx] = xs[static_cast<size_t>(ix)];
                    yLane[idx] = ys[static_cast<size_t>(iy)];
                }
            }
            const double* lanes[3] = {xLane.data(), yLane.data(), g_zeros.data()};
            p->evaluate(lanes, static_cast<int>(gN), slice, flags);
            for (size_t i = 0; i < gN; ++i) {
                if (!isFin(slice[i])) slice[i] = JsMath::kNaN;
            }
        }
    }

    // ---- marching squares ----
    g_segCoords.clear();
    g_segFunc.clear();
    g_fillCoords.clear();
    g_fillFunc.clear();

    const double scaleRatio = 100.0 / scale;
    const double dynFactor = scaleRatio > 1.0 ? scaleRatio * scaleRatio : scaleRatio;
    const bool autoBreak = autoBreakpointDetectionEnabled != 0;

    for (int iy_cell = 0; iy_cell < implictjump; ++iy_cell) {
        const double sub_y_top = cellMaxYMath - iy_cell * subCellStepMath;
        const double sub_y_bottom = sub_y_top - subCellStepMath;
        for (int ix_cell = 0; ix_cell < implictjump; ++ix_cell) {
            const double sub_x0 = cellMinXMath + ix_cell * subCellStepMath;
            const double sub_x1 = sub_x0 + subCellStepMath;

            for (int funcIdx = 0; funcIdx < nFuncs; ++funcIdx) {
                const double v00 = valueAt(funcIdx, ix_cell, iy_cell);
                const double v10 = valueAt(funcIdx, ix_cell + 1, iy_cell);
                const double v01 = valueAt(funcIdx, ix_cell, iy_cell + 1);
                const double v11 = valueAt(funcIdx, ix_cell + 1, iy_cell + 1);
                if (!isFin(v00) || !isFin(v10) || !isFin(v01) || !isFin(v11)) continue;

                const Pt pA{lerp(sub_x0, sub_x1, v00, v10), sub_y_top};
                const Pt pB{sub_x1, lerp(sub_y_top, sub_y_bottom, v10, v11)};
                const Pt pC{lerp(sub_x0, sub_x1, v01, v11), sub_y_bottom};
                const Pt pD{sub_x0, lerp(sub_y_top, sub_y_bottom, v00, v01)};
                const Pt c00{sub_x0, sub_y_top};
                const Pt c10{sub_x1, sub_y_top};
                const Pt c11{sub_x1, sub_y_bottom};
                const Pt c01{sub_x0, sub_y_bottom};

                int outlineIndex = 0;
                if (v00 < 0) outlineIndex |= 1;
                if (v10 < 0) outlineIndex |= 2;
                if (v11 < 0) outlineIndex |= 4;
                if (v01 < 0) outlineIndex |= 8;

                const int plotType = plotTypes[funcIdx];
                // effectiveSign is forced to '=' for the 3D-residual overlay
                // plot types regardless of the entry's configured sign.
                const int effSign = (plotType != kImplicit) ? static_cast<int>(kEq) : signs[funcIdx];

                if ((effSign == kEq || effSign == kGe || effSign == kLe) && outlineIndex != 0 && outlineIndex != 15) {
                    bool skipOutline = false;
                    if (autoBreak) {
                        const double sum_c = std::fabs(v01) + std::fabs(v11) + std::fabs(v00) + std::fabs(v10);
                        const double vo0 = valueAtChecked(funcIdx, ix_cell, iy_cell + 2);
                        const double vo1 = valueAtChecked(funcIdx, ix_cell + 1, iy_cell + 2);
                        const double vo2 = valueAtChecked(funcIdx, ix_cell, iy_cell - 1);
                        const double vo3 = valueAtChecked(funcIdx, ix_cell + 1, iy_cell - 1);
                        if (isFin(vo0) && isFin(vo1) && isFin(vo2) && isFin(vo3)) {
                            const double sumOuter = std::fabs(vo0) + std::fabs(vo1) + std::fabs(vo2) + std::fabs(vo3);
                            if (sumOuter > sum_c * 4.0 ||
                                sum_c > implicitPrecisionStep * implicitPrecisionStep * unitStep * 0.2 * dynFactor) {
                                skipOutline = true;
                            }
                        }
                        const double minAbs = std::min({std::fabs(v00), std::fabs(v10), std::fabs(v11), std::fabs(v01)});
                        const double maxDiff = std::max({std::fabs(v00 - v10), std::fabs(v01 - v11), std::fabs(v00 - v01), std::fabs(v10 - v11)});
                        const bool isStepLike = std::fabs(v00 - v10) < 1e-5 || std::fabs(v01 - v11) < 1e-5 ||
                                                 std::fabs(v00 - v01) < 1e-5 || std::fabs(v10 - v11) < 1e-5;
                        if (minAbs > 0.04 * dynFactor && (maxDiff >= 0.7 * dynFactor || (isStepLike && maxDiff >= 0.2))) {
                            skipOutline = true;
                        }
                    }
                    if (!skipOutline) {
                        auto addSegment = [&](const Pt& p1, const Pt& p2) {
                            if (isFin(p1.x) && isFin(p1.y) && isFin(p2.x) && isFin(p2.y)) {
                                g_segCoords.data.push_back(p1.x);
                                g_segCoords.data.push_back(p1.y);
                                g_segCoords.data.push_back(p2.x);
                                g_segCoords.data.push_back(p2.y);
                                g_segFunc.data.push_back(funcIdx);
                            }
                        };
                        switch (outlineIndex) {
                            case 1: case 14: addSegment(pD, pA); break;
                            case 2: case 13: addSegment(pA, pB); break;
                            case 3: case 12: addSegment(pD, pB); break;
                            case 4: case 11: addSegment(pB, pC); break;
                            case 5: addSegment(pD, pA); addSegment(pB, pC); break;
                            case 6: case 9: addSegment(pA, pC); break;
                            case 7: case 8: addSegment(pD, pC); break;
                            case 10: addSegment(pA, pB); addSegment(pD, pC); break;
                            default: break;
                        }
                    }
                }

                {
                    const bool fillPositive = (effSign == kGt || effSign == kGe);
                    auto test = [&](double v) -> bool {
                        if (effSign == kEq) return std::fabs(v) < kFillEpsilon;
                        if (fillPositive) return effSign == kGt ? (v > kFillEpsilon) : (v >= -kFillEpsilon);
                        return effSign == kLt ? (v < -kFillEpsilon) : (v <= kFillEpsilon);
                    };
                    int fillCase = 0;
                    if (test(v00)) fillCase |= 1;
                    if (test(v10)) fillCase |= 2;
                    if (test(v11)) fillCase |= 4;
                    if (test(v01)) fillCase |= 8;

                    bool skipFill = (effSign == kEq) ? (fillCase != 15) : (fillCase == 0 || fillCase == 5 || fillCase == 10);
                    if (!skipFill) {
                        switch (fillCase) {
                            case 1: addTri(funcIdx, c00, pA, pD); break;
                            case 2: addTri(funcIdx, pA, c10, pB); break;
                            case 3: addQuad(funcIdx, c00, c10, pB, pD); break;
                            case 4: addTri(funcIdx, pB, c11, pC); break;
                            case 6: addQuad(funcIdx, c10, c11, pC, pA); break;
                            case 7: addTri(funcIdx, c00, c10, pD); addTri(funcIdx, c10, c11, pD); addTri(funcIdx, c11, pC, pD); break;
                            case 8: addTri(funcIdx, pD, c01, pC); break;
                            case 9: addQuad(funcIdx, c01, c00, pA, pC); break;
                            case 11: addTri(funcIdx, c00, c10, pB); addTri(funcIdx, c00, pB, pC); addTri(funcIdx, c00, pC, c01); break;
                            case 12: addQuad(funcIdx, c01, c11, pB, pD); break;
                            case 13: addTri(funcIdx, c01, c11, pB); addTri(funcIdx, c01, pB, pA); addTri(funcIdx, c01, pA, c00); break;
                            case 14: addTri(funcIdx, c10, c11, c01); addTri(funcIdx, c10, c01, pD); addTri(funcIdx, c10, pD, pA); break;
                            case 15: addQuad(funcIdx, c00, c10, c11, c01); break;
                            default: break;
                        }
                    }
                }
            }
        }
    }

    return 1;
}

ARCHCORE_EXPORT(ac_implicit2d_seg_count) int ac_implicit2d_seg_count() { return g_segFunc.size(); }
ARCHCORE_EXPORT(ac_implicit2d_seg_coords_ptr) double* ac_implicit2d_seg_coords_ptr() { return g_segCoords.ptr(); }
ARCHCORE_EXPORT(ac_implicit2d_seg_func_ptr) int32_t* ac_implicit2d_seg_func_ptr() { return g_segFunc.ptr(); }
ARCHCORE_EXPORT(ac_implicit2d_fill_count) int ac_implicit2d_fill_count() { return g_fillFunc.size(); }
ARCHCORE_EXPORT(ac_implicit2d_fill_coords_ptr) double* ac_implicit2d_fill_coords_ptr() { return g_fillCoords.ptr(); }
ARCHCORE_EXPORT(ac_implicit2d_fill_func_ptr) int32_t* ac_implicit2d_fill_func_ptr() { return g_fillFunc.ptr(); }
