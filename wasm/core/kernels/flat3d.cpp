// ArchCore kernel "flat3d": the remaining field-sampling geometry generators
// inside recalculate3D() that are not covered by the "surface3d" (explicit
// surface + ribbon extrusion) or "mc3d" (volumetric marching cubes) kernels:
//
//  - ac_flat3d_slice_run:    entry.sliceAxis !== 'none' -- an axis-aligned
//    slice through a 3D field (z / x3d / y3d / implicit3d), rendered as a 2D
//    marching-squares OUTLINE over a (mcRes+1)^2 grid, no clamping, 8-case
//    switch. Output: line vertices only (this.cache3D.lines).
//  - ac_flat3d_implicit_run: a 2D implicit curve/inequality (plotType
//    'implicit') shown flat at z=0 while in 3D mode (overlayDrawingEnabled).
//    Same marching-squares grid, producing BOTH an outline (lines, with the
//    autoBreakpointDetection skipOutline heuristic) and, for relational
//    signs, a filled region (triangles with hardcoded normal (0,0,1)).
//  - ac_flat3d_parametric_run / ac_flat3d_xy_run: the parametric/parametric3d
//    curve block and the plain x/y curve-shown-flat-at-z=0 block. Single pass
//    of numSteps+1 samples, connecting consecutive finite/in-range points
//    into line segments (thin GL_LINES pairs or thick screen-space quads).
//
// All four reuse the page's pushSegment()/pushSliceSegment() thick-line
// vertex expansion (see pushSegment() below) and getOffset2D() edge
// interpolation (1e-9 flatness threshold, 0.5 fallback, clamped to [0,1]),
// copied verbatim from the corresponding inline closures in arch-current.html.
//
// Exactness notes (see KERNEL_GUIDE.md):
//  - The 2D marching-squares blocks do NOT clamp sampled values to
//    [-1e6,1e6] (unlike the 3D marching-cubes blocks in mc3d.cpp) -- only an
//    isfinite check, matching Number.isFinite(val) ? val : NaN.
//  - Grid values are stored as float (the JS side uses a Float32Array), so
//    corner values used for sqIdx classification / edge interpolation carry
//    the JS's float32 rounding.
//  - mcRes formula for both 2D marching-squares blocks is
//    max(10, min(200, floor(250/implicitPrecisionStep))) -- a different
//    cap/multiplier than the volumetric blocks' 200/160.
//  - Slices of implicit3d/z/x3d/y3d fields (ac_flat3d_slice_run) all use the
//    same 3-arg (x,y,z) compiled entry.func; for z/x3d/y3d the sampled value
//    is entry.func(...) MINUS the literal math coordinate that plotType
//    solves for (entry.func gets a literal 0 in that argument slot), exactly
//    mirroring the page's residual formulation.
#include "../CoreApi.h"
#include "../ExprProgram.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace ArchMaths {
namespace Core {namespace {

using std::vector;

// Sign codes for the flat-implicit block; shared convention with
// wasm/core/kernels/implicit2d.cpp (excludes it is not linked, so redefined
// here rather than shared, per KERNEL_GUIDE.md's "do not edit shared files").
enum SignCode : int { kEq = 0, kGe = 1, kLe = 2, kGt = 3, kLt = 4 };

inline double getOffset2D(double v1, double v2) {
    const double delta = v2 - v1;
    if (std::fabs(delta) < 1e-9) return 0.5;
    double t = (0.0 - v1) / delta;
    if (t < 0.0) t = 0.0;
    else if (t > 1.0) t = 1.0;
    return t;
}

// Appends one segment in the page's pushSegment()/pushSliceSegment() vertex
// layout: 6 floats (x1,y1,z1,x2,y2,z2) when thin; when thick, 6 vertex
// records of 7 floats each (pos xyz, other-endpoint xyz, side +-1) forming
// two screen-space-expanded triangles, in this exact record order:
//   (p1,p2,+1) (p2,p1,+1) (p1,p2,-1) | (p1,p2,-1) (p2,p1,+1) (p2,p1,-1)
void pushSegment(vector<double>& out, bool thick,
                  double x1, double y1, double z1,
                  double x2, double y2, double z2) {
    if (!thick) {
        out.push_back(x1); out.push_back(y1); out.push_back(z1);
        out.push_back(x2); out.push_back(y2); out.push_back(z2);
        return;
    }
    auto rec = [&](double ax, double ay, double az, double bx, double by, double bz, double side) {
        out.push_back(ax); out.push_back(ay); out.push_back(az);
        out.push_back(bx); out.push_back(by); out.push_back(bz);
        out.push_back(side);
    };
    rec(x1, y1, z1, x2, y2, z2, 1.0);
    rec(x2, y2, z2, x1, y1, z1, 1.0);
    rec(x1, y1, z1, x2, y2, z2, -1.0);
    rec(x1, y1, z1, x2, y2, z2, -1.0);
    rec(x2, y2, z2, x1, y1, z1, 1.0);
    rec(x2, y2, z2, x1, y1, z1, -1.0);
}

void narrowToFloat(const vector<double>& src, OutBuffer<float>& dst) {
    dst.data.resize(src.size());
    for (size_t i = 0; i < src.size(); ++i) dst.data[i] = static_cast<float>(src[i]);
}

OutBuffer<float> g_sliceVerts;
OutBuffer<float> g_implicitLines;
OutBuffer<float> g_implicitFillVerts;
OutBuffer<float> g_implicitFillNorms;
OutBuffer<float> g_paramVerts;
OutBuffer<float> g_xyVerts;

}  // namespace

// ---- sliceAxis marching-squares outline (entry.sliceAxis !== 'none') ------
// plotTypeCode: 0='z' (func(x,y,0)-z), 1='x3d' (func(0,y,z)-x),
//               2='y3d' (func(x,0,z)-y), 3='implicit3d' (func(x,y,z), no
//               subtraction). sliceAxisCode: 0='x', 1='y', 2='z'.
// Returns the emitted float count (>=0), or -1 if the handle is invalid.
ARCHCORE_EXPORT(ac_flat3d_slice_run)
int ac_flat3d_slice_run(int handle, int plotTypeCode, int mcRes, double range,
                         double offsetX, double offsetY, double scale,
                         int sliceAxisCode, double sliceVal,
                         int useThickLines, int flags) {
    g_sliceVerts.clear();
    Program* prog = programFromHandle(handle);
    if (!prog || mcRes < 1) return -1;

    const int N = mcRes + 1;
    const long long total = static_cast<long long>(N) * N;
    const double step = (range * 2.0) / mcRes;

    vector<double> laneX(static_cast<size_t>(total));
    vector<double> laneY(static_cast<size_t>(total));
    vector<double> laneZ(static_cast<size_t>(total));
    long long idx = 0;
    for (int v = 0; v <= mcRes; ++v) {
        const double fv_screen = -range + v * step;
        const double fv_math = fv_screen * scale;
        for (int u = 0; u <= mcRes; ++u) {
            const double fu_screen = -range + u * step;
            const double fu_math = fu_screen * scale;
            double x_math, y_math, z_math;
            if (sliceAxisCode == 0) {       // axis === 'x'
                x_math = sliceVal;
                y_math = fu_math + offsetY * scale;
                z_math = fv_math;
            } else if (sliceAxisCode == 1) { // axis === 'y'
                x_math = fu_math + offsetX * scale;
                y_math = sliceVal;
                z_math = fv_math;
            } else {                         // axis === 'z'
                x_math = fu_math + offsetX * scale;
                y_math = fv_math + offsetY * scale;
                z_math = sliceVal;
            }
            laneX[static_cast<size_t>(idx)] = x_math;
            laneY[static_cast<size_t>(idx)] = y_math;
            laneZ[static_cast<size_t>(idx)] = z_math;
            ++idx;
        }
    }

    // z/x3d/y3d pass a literal 0 in the arg slot they solve for; implicit3d
    // passes all three real coordinates.
    vector<double> zeroLane;
    const double* argX = laneX.data();
    const double* argY = laneY.data();
    const double* argZ = laneZ.data();
    if (plotTypeCode == 0) {
        zeroLane.assign(static_cast<size_t>(total), 0.0);
        argZ = zeroLane.data();
    } else if (plotTypeCode == 1) {
        zeroLane.assign(static_cast<size_t>(total), 0.0);
        argX = zeroLane.data();
    } else if (plotTypeCode == 2) {
        zeroLane.assign(static_cast<size_t>(total), 0.0);
        argY = zeroLane.data();
    }
    vector<double> out(static_cast<size_t>(total));
    const double* lanes[3] = {argX, argY, argZ};
    prog->evaluate(lanes, static_cast<int>(total), out.data(), flags);

    vector<float> values(static_cast<size_t>(total));
    for (long long i = 0; i < total; ++i) {
        double val = out[static_cast<size_t>(i)];
        if (plotTypeCode == 0) val -= laneZ[static_cast<size_t>(i)];
        else if (plotTypeCode == 1) val -= laneX[static_cast<size_t>(i)];
        else if (plotTypeCode == 2) val -= laneY[static_cast<size_t>(i)];
        values[static_cast<size_t>(i)] =
            std::isfinite(val) ? static_cast<float>(val) : std::numeric_limits<float>::quiet_NaN();
    }

    const double k_screen = sliceVal / scale;
    vector<double> lineVerts;
    const bool thick = useThickLines != 0;

    auto emit = [&](double u1, double v1, double u2, double v2) {
        double s1x, s1y, s1z, s2x, s2y, s2z;
        if (sliceAxisCode == 0) {
            s1x = k_screen - offsetX; s1y = u1; s1z = v1;
            s2x = k_screen - offsetX; s2y = u2; s2z = v2;
        } else if (sliceAxisCode == 1) {
            s1x = u1; s1y = k_screen - offsetY; s1z = v1;
            s2x = u2; s2y = k_screen - offsetY; s2z = v2;
        } else {
            s1x = u1; s1y = v1; s1z = k_screen;
            s2x = u2; s2y = v2; s2z = k_screen;
        }
        pushSegment(lineVerts, thick, s1x, s1y, s1z, s2x, s2y, s2z);
    };

    for (int v = 0; v < mcRes; ++v) {
        for (int u = 0; u < mcRes; ++u) {
            const int cidx = u + v * N;
            const double v0 = values[static_cast<size_t>(cidx)];
            const double v1 = values[static_cast<size_t>(cidx + 1)];
            const double v2 = values[static_cast<size_t>(cidx + 1 + N)];
            const double v3 = values[static_cast<size_t>(cidx + N)];
            if (std::isnan(v0) || std::isnan(v1) || std::isnan(v2) || std::isnan(v3)) continue;

            int sqIdx = 0;
            if (v0 < 0) sqIdx |= 8;
            if (v1 < 0) sqIdx |= 4;
            if (v2 < 0) sqIdx |= 2;
            if (v3 < 0) sqIdx |= 1;
            if (sqIdx == 0 || sqIdx == 15) continue;

            const double fu = -range + u * step, fv = -range + v * step;
            const double pTu = fu + step * getOffset2D(v0, v1), pTv = fv;
            const double pRu = fu + step, pRv = fv + step * getOffset2D(v1, v2);
            const double pBu = fu + step * getOffset2D(v3, v2), pBv = fv + step;
            const double pLu = fu, pLv = fv + step * getOffset2D(v0, v3);

            switch (sqIdx) {
                case 1: case 14: emit(pLu, pLv, pBu, pBv); break;
                case 2: case 13: emit(pBu, pBv, pRu, pRv); break;
                case 3: case 12: emit(pLu, pLv, pRu, pRv); break;
                case 4: case 11: emit(pTu, pTv, pRu, pRv); break;
                case 5: emit(pTu, pTv, pLu, pLv); emit(pBu, pBv, pRu, pRv); break;
                case 6: case 9: emit(pTu, pTv, pBu, pBv); break;
                case 7: case 8: emit(pTu, pTv, pLu, pLv); break;
                case 10: emit(pTu, pTv, pRu, pRv); emit(pBu, pBv, pLu, pLv); break;
                default: break;
            }
        }
    }

    narrowToFloat(lineVerts, g_sliceVerts);
    return g_sliceVerts.size();
}

ARCHCORE_EXPORT(ac_flat3d_slice_verts_ptr) float* ac_flat3d_slice_verts_ptr() { return g_sliceVerts.ptr(); }
ARCHCORE_EXPORT(ac_flat3d_slice_verts_len) int ac_flat3d_slice_verts_len() { return g_sliceVerts.size(); }

// ---- flat 2D-implicit overlay at z=0 (plotType 'implicit', shown in 3D) ---
// signCode: SignCode above, from entry.sign || '='.
// Returns 1 on success, -1 if the handle is invalid.
ARCHCORE_EXPORT(ac_flat3d_implicit_run)
int ac_flat3d_implicit_run(int handle, int mcRes, double range,
                            double offsetX, double offsetY, double scale,
                            int signCode, int autoBreak, int useThickLines, int flags) {
    g_implicitLines.clear();
    g_implicitFillVerts.clear();
    g_implicitFillNorms.clear();
    Program* prog = programFromHandle(handle);
    if (!prog || mcRes < 1) return -1;

    const int N = mcRes + 1;
    const long long total = static_cast<long long>(N) * N;
    const double step = (range * 2.0) / mcRes;

    vector<double> laneX(static_cast<size_t>(total));
    vector<double> laneY(static_cast<size_t>(total));
    long long idx = 0;
    for (int y = 0; y <= mcRes; ++y) {
        const double fy_screen = -range + y * step;
        const double fy_math = (fy_screen + offsetY) * scale;
        for (int x = 0; x <= mcRes; ++x) {
            const double fx_screen = -range + x * step;
            const double fx_math = (fx_screen + offsetX) * scale;
            laneX[static_cast<size_t>(idx)] = fx_math;
            laneY[static_cast<size_t>(idx)] = fy_math;
            ++idx;
        }
    }
    vector<double> out(static_cast<size_t>(total));
    const double* lanes[2] = {laneX.data(), laneY.data()};
    prog->evaluate(lanes, static_cast<int>(total), out.data(), flags);

    vector<float> values(static_cast<size_t>(total));
    for (long long i = 0; i < total; ++i) {
        const double v = out[static_cast<size_t>(i)];
        values[static_cast<size_t>(i)] =
            std::isfinite(v) ? static_cast<float>(v) : std::numeric_limits<float>::quiet_NaN();
    }

    const bool thick = useThickLines != 0;
    const bool eqLike = (signCode == kEq || signCode == kGe || signCode == kLe);
    const bool fillPositive = (signCode == kGt || signCode == kGe);
    constexpr double kFillEpsilon = 1e-9;
    auto test = [&](double v) -> bool {
        if (signCode == kEq) return std::fabs(v) < kFillEpsilon;
        if (fillPositive) return signCode == kGt ? (v > kFillEpsilon) : (v >= -kFillEpsilon);
        return signCode == kLt ? (v < -kFillEpsilon) : (v <= kFillEpsilon);
    };

    vector<double> lineVerts;
    vector<double> fillVerts;

    for (int y = 0; y < mcRes; ++y) {
        for (int x = 0; x < mcRes; ++x) {
            const int cidx = x + y * N;
            const double v0 = values[static_cast<size_t>(cidx)];
            const double v1 = values[static_cast<size_t>(cidx + 1)];
            const double v2 = values[static_cast<size_t>(cidx + 1 + N)];
            const double v3 = values[static_cast<size_t>(cidx + N)];
            if (std::isnan(v0) || std::isnan(v1) || std::isnan(v2) || std::isnan(v3)) continue;

            const double fx = -range + x * step, fy = -range + y * step;
            const double pTx = fx + step * getOffset2D(v0, v1), pTy = fy;
            const double pRx = fx + step, pRy = fy + step * getOffset2D(v1, v2);
            const double pBx = fx + step * getOffset2D(v3, v2), pBy = fy + step;
            const double pLx = fx, pLy = fy + step * getOffset2D(v0, v3);

            int sqIdx = 0;
            if (v0 < 0) sqIdx |= 8;
            if (v1 < 0) sqIdx |= 4;
            if (v2 < 0) sqIdx |= 2;
            if (v3 < 0) sqIdx |= 1;

            if (eqLike && sqIdx != 0 && sqIdx != 15) {
                bool skipOutline = false;
                if (autoBreak) {
                    const double minAbs = std::min({std::fabs(v0), std::fabs(v1), std::fabs(v2), std::fabs(v3)});
                    const double maxDiff = std::max({std::fabs(v0 - v1), std::fabs(v3 - v2), std::fabs(v0 - v3), std::fabs(v1 - v2)});
                    if (minAbs > 0.01 && maxDiff >= 0.5) skipOutline = true;
                }
                if (!skipOutline) {
                    switch (sqIdx) {
                        case 1: case 14: pushSegment(lineVerts, thick, pLx, pLy, 0.0, pBx, pBy, 0.0); break;
                        case 2: case 13: pushSegment(lineVerts, thick, pBx, pBy, 0.0, pRx, pRy, 0.0); break;
                        case 3: case 12: pushSegment(lineVerts, thick, pLx, pLy, 0.0, pRx, pRy, 0.0); break;
                        case 4: case 11: pushSegment(lineVerts, thick, pTx, pTy, 0.0, pRx, pRy, 0.0); break;
                        case 5:
                            pushSegment(lineVerts, thick, pTx, pTy, 0.0, pLx, pLy, 0.0);
                            pushSegment(lineVerts, thick, pBx, pBy, 0.0, pRx, pRy, 0.0);
                            break;
                        case 6: case 9: pushSegment(lineVerts, thick, pTx, pTy, 0.0, pBx, pBy, 0.0); break;
                        case 7: case 8: pushSegment(lineVerts, thick, pTx, pTy, 0.0, pLx, pLy, 0.0); break;
                        case 10:
                            pushSegment(lineVerts, thick, pTx, pTy, 0.0, pRx, pRy, 0.0);
                            pushSegment(lineVerts, thick, pBx, pBy, 0.0, pLx, pLy, 0.0);
                            break;
                        default: break;
                    }
                }
            }

            int fillCase = 0;
            if (test(v0)) fillCase |= 1;
            if (test(v1)) fillCase |= 2;
            if (test(v2)) fillCase |= 4;
            if (test(v3)) fillCase |= 8;

            const bool skipFill = (signCode == kEq) ? (fillCase != 15)
                                                     : (fillCase == 0 || fillCase == 5 || fillCase == 10);
            if (skipFill) continue;

            const double c00x = fx, c00y = fy;
            const double c10x = fx + step, c10y = fy;
            const double c11x = fx + step, c11y = fy + step;
            const double c01x = fx, c01y = fy + step;
            auto addTri = [&](double ax, double ay, double bx, double by, double cx, double cy) {
                fillVerts.push_back(ax); fillVerts.push_back(ay); fillVerts.push_back(0.0);
                fillVerts.push_back(bx); fillVerts.push_back(by); fillVerts.push_back(0.0);
                fillVerts.push_back(cx); fillVerts.push_back(cy); fillVerts.push_back(0.0);
            };
            auto addQuad = [&](double ax, double ay, double bx, double by, double cx, double cy, double dx, double dy) {
                addTri(ax, ay, bx, by, cx, cy);
                addTri(ax, ay, cx, cy, dx, dy);
            };

            switch (fillCase) {
                case 1: addTri(c00x, c00y, pTx, pTy, pLx, pLy); break;
                case 2: addTri(pTx, pTy, c10x, c10y, pRx, pRy); break;
                case 3: addQuad(c00x, c00y, c10x, c10y, pRx, pRy, pLx, pLy); break;
                case 4: addTri(pRx, pRy, c11x, c11y, pBx, pBy); break;
                case 6: addQuad(c10x, c10y, c11x, c11y, pBx, pBy, pTx, pTy); break;
                case 7:
                    addTri(c00x, c00y, c10x, c10y, pLx, pLy);
                    addTri(c10x, c10y, c11x, c11y, pLx, pLy);
                    addTri(c11x, c11y, pBx, pBy, pLx, pLy);
                    break;
                case 8: addTri(pLx, pLy, c01x, c01y, pBx, pBy); break;
                case 9: addQuad(c01x, c01y, c00x, c00y, pTx, pTy, pBx, pBy); break;
                case 11:
                    addTri(c00x, c00y, c10x, c10y, pRx, pRy);
                    addTri(c00x, c00y, pRx, pRy, pBx, pBy);
                    addTri(c00x, c00y, pBx, pBy, c01x, c01y);
                    break;
                case 12: addQuad(c01x, c01y, c11x, c11y, pRx, pRy, pLx, pLy); break;
                case 13:
                    addTri(c01x, c01y, c11x, c11y, pRx, pRy);
                    addTri(c01x, c01y, pRx, pRy, pTx, pTy);
                    addTri(c01x, c01y, pTx, pTy, c00x, c00y);
                    break;
                case 14:
                    addTri(c10x, c10y, c11x, c11y, c01x, c01y);
                    addTri(c10x, c10y, c01x, c01y, pLx, pLy);
                    addTri(c10x, c10y, pLx, pLy, pTx, pTy);
                    break;
                case 15: addQuad(c00x, c00y, c10x, c10y, c11x, c11y, c01x, c01y); break;
                default: break;
            }
        }
    }

    narrowToFloat(lineVerts, g_implicitLines);
    narrowToFloat(fillVerts, g_implicitFillVerts);
    vector<float> norms(fillVerts.size(), 0.0f);
    for (size_t i = 2; i < norms.size(); i += 3) norms[i] = 1.0f;
    g_implicitFillNorms.data = std::move(norms);
    return 1;
}

ARCHCORE_EXPORT(ac_flat3d_implicit_lines_ptr) float* ac_flat3d_implicit_lines_ptr() { return g_implicitLines.ptr(); }
ARCHCORE_EXPORT(ac_flat3d_implicit_lines_len) int ac_flat3d_implicit_lines_len() { return g_implicitLines.size(); }
ARCHCORE_EXPORT(ac_flat3d_implicit_fill_verts_ptr) float* ac_flat3d_implicit_fill_verts_ptr() { return g_implicitFillVerts.ptr(); }
ARCHCORE_EXPORT(ac_flat3d_implicit_fill_verts_len) int ac_flat3d_implicit_fill_verts_len() { return g_implicitFillVerts.size(); }
ARCHCORE_EXPORT(ac_flat3d_implicit_fill_norms_ptr) float* ac_flat3d_implicit_fill_norms_ptr() { return g_implicitFillNorms.ptr(); }
ARCHCORE_EXPORT(ac_flat3d_implicit_fill_norms_len) int ac_flat3d_implicit_fill_norms_len() { return g_implicitFillNorms.size(); }

// ---- parametric / parametric3d curve, flat line block ---------------------
// handleZ: 0 for plotType 'parametric' (z forced to 0); a valid funcZ program
// handle for 'parametric3d'.
ARCHCORE_EXPORT(ac_flat3d_parametric_run)
int ac_flat3d_parametric_run(int handleX, int handleY, int handleZ,
                              int numSteps, double tmin, double tmax,
                              double range, double offsetX, double offsetY,
                              double scale, int useThickLines, int flags) {
    g_paramVerts.clear();
    Program* px = programFromHandle(handleX);
    Program* py = programFromHandle(handleY);
    Program* pz = handleZ ? programFromHandle(handleZ) : nullptr;
    if (!px || !py || (handleZ != 0 && !pz) || numSteps < 0) return -1;

    const int n = numSteps + 1;
    const double tStep = (tmax - tmin) / numSteps;
    vector<double> tvals(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) tvals[static_cast<size_t>(i)] = tmin + i * tStep;

    vector<double> xs(static_cast<size_t>(n)), ys(static_cast<size_t>(n)), zs(static_cast<size_t>(n));
    const double* lanesT[1] = {tvals.data()};
    px->evaluate(lanesT, n, xs.data(), flags);
    py->evaluate(lanesT, n, ys.data(), flags);
    if (pz) pz->evaluate(lanesT, n, zs.data(), flags);
    else std::fill(zs.begin(), zs.end(), 0.0);

    vector<double> lineVerts;
    const bool thick = useThickLines != 0;
    bool haveLast = false;
    double lastX = 0, lastY = 0, lastZ = 0;
    for (int i = 0; i < n; ++i) {
        const double x_math = xs[static_cast<size_t>(i)];
        const double y_math = ys[static_cast<size_t>(i)];
        const double z_math = zs[static_cast<size_t>(i)];
        const bool finite = std::isfinite(x_math) && std::isfinite(y_math) && std::isfinite(z_math);
        if (finite) {
            const double cx = x_math / scale - offsetX;
            const double cy = y_math / scale - offsetY;
            const double cz = z_math / scale;
            if (std::fabs(cx) <= range && std::fabs(cy) <= range && std::fabs(cz) <= range) {
                if (haveLast) pushSegment(lineVerts, thick, lastX, lastY, lastZ, cx, cy, cz);
                lastX = cx; lastY = cy; lastZ = cz; haveLast = true;
            } else {
                haveLast = false;
            }
        } else {
            haveLast = false;
        }
    }
    narrowToFloat(lineVerts, g_paramVerts);
    return g_paramVerts.size();
}

ARCHCORE_EXPORT(ac_flat3d_parametric_verts_ptr) float* ac_flat3d_parametric_verts_ptr() { return g_paramVerts.ptr(); }
ARCHCORE_EXPORT(ac_flat3d_parametric_verts_len) int ac_flat3d_parametric_verts_len() { return g_paramVerts.size(); }

// ---- plain x/y curve shown flat at z=0 -------------------------------------
// isYType: 1 for plotType 'y' (y=f(x)), 0 for plotType 'x' (x=f(y)).
ARCHCORE_EXPORT(ac_flat3d_xy_run)
int ac_flat3d_xy_run(int handle, int isYType, int numSteps, double range,
                      double offsetX, double offsetY, double scale,
                      int useThickLines, int flags) {
    g_xyVerts.clear();
    Program* prog = programFromHandle(handle);
    if (!prog || numSteps < 0) return -1;

    const int n = numSteps + 1;
    const double step = (range * 2.0) / numSteps;

    vector<double> lane(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
        const double val1 = -range + i * step;
        lane[static_cast<size_t>(i)] = isYType ? (val1 + offsetX) * scale : (val1 + offsetY) * scale;
    }
    vector<double> out(static_cast<size_t>(n));
    const double* lanes[1] = {lane.data()};
    prog->evaluate(lanes, n, out.data(), flags);

    vector<double> lineVerts;
    const bool thick = useThickLines != 0;
    bool haveLast = false;
    double lastX = 0, lastY = 0;
    for (int i = 0; i < n; ++i) {
        double x_math, y_math;
        if (isYType) { x_math = lane[static_cast<size_t>(i)]; y_math = out[static_cast<size_t>(i)]; }
        else { y_math = lane[static_cast<size_t>(i)]; x_math = out[static_cast<size_t>(i)]; }
        const bool finite = std::isfinite(x_math) && std::isfinite(y_math);
        if (finite) {
            const double cx = x_math / scale - offsetX;
            const double cy = y_math / scale - offsetY;
            if (std::fabs(cx) <= range && std::fabs(cy) <= range) {
                if (haveLast) pushSegment(lineVerts, thick, lastX, lastY, 0.0, cx, cy, 0.0);
                lastX = cx; lastY = cy; haveLast = true;
            } else {
                haveLast = false;
            }
        } else {
            haveLast = false;
        }
    }
    narrowToFloat(lineVerts, g_xyVerts);
    return g_xyVerts.size();
}

ARCHCORE_EXPORT(ac_flat3d_xy_verts_ptr) float* ac_flat3d_xy_verts_ptr() { return g_xyVerts.ptr(); }
ARCHCORE_EXPORT(ac_flat3d_xy_verts_len) int ac_flat3d_xy_verts_len() { return g_xyVerts.size(); }

}  // namespace Core
}  // namespace ArchMaths
