// ArchCore kernel "surface3d": ports recalculate3D()'s two flat-shaded,
// non-marching-cubes 3D geometry blocks:
//
//  - ac_surface3d_run:  the true 3D explicit surface block (plotType 'z',
//    'x3d', 'y3d'): a (resolution+1)^2 grid of {x,y,z} points where one
//    coordinate is solved from the other two via entry.func, triangulated
//    with checkConnect()/checkJump() discontinuity gating (only active when
//    autoBreakpointDetectionEnabled), then given per-triangle flat
//    cross-product normals (degenerate -> (0,0,1)).
//  - ac_ribbon3d_run: the explicit-curve-extrusion ("ribbon") block: a 2D
//    y=f(x) or x=f(y) curve extended into a 3D ribbon along the previously
//    unused axis. Same grid/triangle/normal shape, but with NO discontinuity
//    gating (the original block only checks point existence).
//
// Both are called from inside recalculate3D(), which installs the strict-pow
// wrapper for its entire pass, so callers must pass flags=kFlagStrictPow.
#include "../CoreApi.h"
#include "../ExprProgram.h"
#include "../JsMath.h"

#include <cmath>
#include <cstdint>
#include <vector>

namespace ArchMaths {
namespace Core {

namespace {

OutBuffer<float> g_surfaceVertices;
OutBuffer<float> g_surfaceNormals;
OutBuffer<float> g_ribbonVertices;
OutBuffer<float> g_ribbonNormals;

// Appends one flat cross-product normal per 9-double (3-vertex) triangle in
// vertD, pushed 3x (once per vertex) -- mirrors the page's post-hoc normal
// pass over its plain (still-double) `vertices` JS array; only the final
// upload narrows to Float32Array, which narrowToFloat() below replicates.
void computeFlatNormals(const std::vector<double>& vertD, std::vector<double>& normD) {
    normD.clear();
    normD.reserve(vertD.size());
    for (size_t k = 0; k + 8 < vertD.size(); k += 9) {
        const double ax = vertD[k], ay = vertD[k + 1], az = vertD[k + 2];
        const double ux = vertD[k + 3] - ax, uy = vertD[k + 4] - ay, uz = vertD[k + 5] - az;
        const double vx = vertD[k + 6] - ax, vy = vertD[k + 7] - ay, vz = vertD[k + 8] - az;
        double nx = uy * vz - uz * vy;
        double ny = uz * vx - ux * vz;
        double nz = ux * vy - uy * vx;
        const double len = std::sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0.0) { nx /= len; ny /= len; nz /= len; } else { nx = 0.0; ny = 0.0; nz = 1.0; }
        for (int r = 0; r < 3; ++r) { normD.push_back(nx); normD.push_back(ny); normD.push_back(nz); }
    }
}

// (float)double, matching `new Float32Array(doubleArray)` element-wise.
void narrowToFloat(const std::vector<double>& src, OutBuffer<float>& dst) {
    dst.data.resize(src.size());
    for (size_t i = 0; i < src.size(); ++i) dst.data[i] = static_cast<float>(src[i]);
}

} // namespace

// ---- explicit surface: z=f(x,y), x3d, y3d ---------------------------------
// depAxis: 0 => plotType 'z' (dependent z, literal 0 passed as z arg),
//          1 => 'x3d' (dependent x, literal 0 passed as x arg),
//          2 => 'y3d' (dependent y, literal 0 passed as y arg).
// autoBreak: engine.autoBreakpointDetectionEnabled (0/1).
// flags: pass kFlagStrictPow (recalculate3D's whole-pass pow wrapper).
// Returns the emitted vertex count (>=0), or -1 if the handle is invalid.
ARCHCORE_EXPORT(ac_surface3d_run)
int ac_surface3d_run(int handle, int depAxis, int resolution, double range,
                      double offsetX, double offsetY, double scale,
                      int autoBreak, double explicitPrecisionStep, int flags) {
    g_surfaceVertices.clear();
    g_surfaceNormals.clear();
    Program* prog = programFromHandle(handle);
    if (!prog || resolution < 1) return -1;

    const int N = resolution + 1;
    const int n = N * N;
    const double step = (range * 2.0) / resolution;

    // Lane values (math-space x/y/z args to entry.func), row-major idx=i*N+j
    // exactly like the JS grid[] array. The "solved for" axis gets a literal
    // 0, matching entry.func(x_math, y_math, 0, ...) etc. in the original.
    std::vector<double> laneX(static_cast<size_t>(n));
    std::vector<double> laneY(static_cast<size_t>(n));
    std::vector<double> laneZ(static_cast<size_t>(n));
    for (int i = 0; i <= resolution; ++i) {
        const double u_screen = -range + i * step;
        for (int j = 0; j <= resolution; ++j) {
            const double v_screen = -range + j * step;
            const int idx = i * N + j;
            if (depAxis == 0) {
                laneX[idx] = (u_screen + offsetX) * scale;
                laneY[idx] = (v_screen + offsetY) * scale;
                laneZ[idx] = 0.0;
            } else if (depAxis == 1) {
                laneX[idx] = 0.0;
                laneY[idx] = (u_screen + offsetY) * scale;
                laneZ[idx] = v_screen * scale;
            } else {
                laneX[idx] = (u_screen + offsetX) * scale;
                laneY[idx] = 0.0;
                laneZ[idx] = v_screen * scale;
            }
        }
    }

    std::vector<double> out(static_cast<size_t>(n));
    const double* lanes[3] = {
        prog->usesArg(0) ? laneX.data() : nullptr,
        prog->usesArg(1) ? laneY.data() : nullptr,
        prog->usesArg(2) ? laneZ.data() : nullptr,
    };
    prog->evaluate(lanes, n, out.data(), flags);

    // Screen-space grid points + validity (Number.isFinite on all 3 coords).
    std::vector<double> gx(static_cast<size_t>(n));
    std::vector<double> gy(static_cast<size_t>(n));
    std::vector<double> gz(static_cast<size_t>(n));
    std::vector<uint8_t> valid(static_cast<size_t>(n));
    for (int i = 0; i <= resolution; ++i) {
        const double u_screen = -range + i * step;
        for (int j = 0; j <= resolution; ++j) {
            const double v_screen = -range + j * step;
            const int idx = i * N + j;
            double x_screen, y_screen, z_screen;
            if (depAxis == 0) {
                x_screen = u_screen;
                y_screen = v_screen;
                z_screen = out[idx] / scale;
            } else if (depAxis == 1) {
                y_screen = u_screen;
                z_screen = v_screen;
                x_screen = out[idx] / scale - offsetX;
            } else {
                x_screen = u_screen;
                z_screen = v_screen;
                y_screen = out[idx] / scale - offsetY;
            }
            const bool ok = std::isfinite(x_screen) && std::isfinite(y_screen) && std::isfinite(z_screen);
            valid[idx] = ok ? 1 : 0;
            gx[idx] = x_screen;
            gy[idx] = y_screen;
            gz[idx] = z_screen;
        }
    }

    const std::vector<double>& dep = (depAxis == 0) ? gz : (depAxis == 1 ? gx : gy);
    const bool heuristics = autoBreak != 0;

    auto checkConnect = [&](int ia, int ib) -> bool {
        if (!heuristics) return true;
        const double diff = std::fabs(dep[ia] - dep[ib]);
        return !(diff / step > 20.0 * explicitPrecisionStep);
    };
    auto checkJump = [&](int i, int j, int nextI, int nextJ) -> bool {
        if (!heuristics) return true;
        const int idx = i * N + j;
        const int nIdx = nextI * N + nextJ;
        if (!valid[idx] || !valid[nIdx]) return true;
        const double curr = dep[idx];
        const double next = dep[nIdx];
        const double jump = std::fabs(curr - next);
        if (jump > 0.05) {
            int prevIdx = -1, postIdx = -1;
            if (nextI > i) {
                prevIdx = (i > 0) ? (i - 1) * N + j : -1;
                postIdx = (nextI < resolution) ? (nextI + 1) * N + j : -1;
            } else {
                prevIdx = (j > 0) ? i * N + (j - 1) : -1;
                postIdx = (nextJ < resolution) ? i * N + (nextJ + 1) : -1;
            }
            const bool hasPrev = prevIdx != -1 && valid[prevIdx];
            const bool hasPost = postIdx != -1 && valid[postIdx];
            if (jump > 10.0) {
                const double side1Slope = hasPrev ? std::fabs(curr - dep[prevIdx]) : 0.0;
                const double side2Slope = hasPost ? std::fabs(next - dep[postIdx]) : 0.0;
                if (side1Slope < 0.1 && side2Slope < 0.1) return false;
            }
            if (hasPrev && hasPost) {
                const bool isStep = std::fabs(curr - dep[prevIdx]) < 1e-7 &&
                                     std::fabs(next - dep[postIdx]) < 1e-7;
                if (isStep) return false;
            }
        }
        return true;
    };

    std::vector<double> vertD;
    vertD.reserve(static_cast<size_t>(resolution) * static_cast<size_t>(resolution) * 18u);
    auto push = [&](int idx) {
        vertD.push_back(gx[idx]);
        vertD.push_back(gy[idx]);
        vertD.push_back(gz[idx]);
    };

    for (int i = 0; i < resolution; ++i) {
        for (int j = 0; j < resolution; ++j) {
            const int idx = i * N + j;
            const int i1 = idx, i2 = idx + 1, i3 = idx + N, i4 = idx + N + 1;
            const bool p1 = valid[i1] != 0, p2 = valid[i2] != 0, p3 = valid[i3] != 0, p4 = valid[i4] != 0;

            const bool c12 = p1 && p2 && checkConnect(i1, i2) && checkJump(i, j, i, j + 1);
            const bool c13 = p1 && p3 && checkConnect(i1, i3) && checkJump(i, j, i + 1, j);
            const bool c24 = p2 && p4 && checkConnect(i2, i4) && checkJump(i, j + 1, i + 1, j + 1);
            const bool c34 = p3 && p4 && checkConnect(i3, i4) && checkJump(i + 1, j, i + 1, j + 1);
            const bool c23 = p2 && p3 && checkConnect(i2, i3);

            if (p1 && p2 && p3 && c12 && c13 && c23) { push(i1); push(i3); push(i2); }
            if (p2 && p3 && p4 && c24 && c34 && c23) { push(i2); push(i3); push(i4); }
        }
    }

    std::vector<double> normD;
    computeFlatNormals(vertD, normD);
    narrowToFloat(vertD, g_surfaceVertices);
    narrowToFloat(normD, g_surfaceNormals);
    return g_surfaceVertices.size() / 3;
}

ARCHCORE_EXPORT(ac_surface3d_vertices_ptr) float* ac_surface3d_vertices_ptr() { return g_surfaceVertices.ptr(); }
ARCHCORE_EXPORT(ac_surface3d_vertices_len) int ac_surface3d_vertices_len() { return g_surfaceVertices.size(); }
ARCHCORE_EXPORT(ac_surface3d_normals_ptr) float* ac_surface3d_normals_ptr() { return g_surfaceNormals.ptr(); }
ARCHCORE_EXPORT(ac_surface3d_normals_len) int ac_surface3d_normals_len() { return g_surfaceNormals.size(); }

// ---- explicit-curve extrusion ("ribbon"): 2D y=f(x)/x=f(y) extended to 3D -
// axis: 0 => plotType 'y' (curve is a function of x; ribbon spans y,z),
//       1 => plotType 'x' (curve is a function of y; ribbon spans x,z).
// No discontinuity gating in the original block -- only point-existence
// checks (p1&&p2&&p3 / p2&&p3&&p4).
ARCHCORE_EXPORT(ac_ribbon3d_run)
int ac_ribbon3d_run(int handle, int axis, int resolution, double range,
                     double offsetX, double offsetY, double scale, int flags) {
    g_ribbonVertices.clear();
    g_ribbonNormals.clear();
    Program* prog = programFromHandle(handle);
    if (!prog || resolution < 1) return -1;

    const int N = resolution + 1;
    const int n = N * N;
    const double step = (range * 2.0) / resolution;

    std::vector<double> lane(static_cast<size_t>(n));
    for (int i = 0; i <= resolution; ++i) {
        const double u_screen = -range + i * step;
        const double v = (axis == 0) ? (u_screen + offsetX) * scale : (u_screen + offsetY) * scale;
        for (int j = 0; j <= resolution; ++j) lane[i * N + j] = v;
    }

    std::vector<double> out(static_cast<size_t>(n));
    const double* lanes[1] = { lane.data() };
    prog->evaluate(lanes, n, out.data(), flags);

    std::vector<double> gx(static_cast<size_t>(n));
    std::vector<double> gy(static_cast<size_t>(n));
    std::vector<double> gz(static_cast<size_t>(n));
    std::vector<uint8_t> valid(static_cast<size_t>(n));
    for (int i = 0; i <= resolution; ++i) {
        const double u_screen = -range + i * step;
        for (int j = 0; j <= resolution; ++j) {
            const double v_screen = -range + j * step;
            const int idx = i * N + j;
            double x_screen, y_screen;
            const double z_screen = v_screen;
            if (axis == 0) {
                x_screen = u_screen;
                y_screen = out[idx] / scale - offsetY;
            } else {
                y_screen = u_screen;
                x_screen = out[idx] / scale - offsetX;
            }
            const bool ok = std::isfinite(x_screen) && std::isfinite(y_screen) && std::isfinite(z_screen);
            valid[idx] = ok ? 1 : 0;
            gx[idx] = x_screen;
            gy[idx] = y_screen;
            gz[idx] = z_screen;
        }
    }

    std::vector<double> vertD;
    vertD.reserve(static_cast<size_t>(resolution) * static_cast<size_t>(resolution) * 18u);
    auto push = [&](int idx) {
        vertD.push_back(gx[idx]);
        vertD.push_back(gy[idx]);
        vertD.push_back(gz[idx]);
    };
    for (int i = 0; i < resolution; ++i) {
        for (int j = 0; j < resolution; ++j) {
            const int idx = i * N + j;
            const int i1 = idx, i2 = idx + 1, i3 = idx + N, i4 = idx + N + 1;
            const bool p1 = valid[i1] != 0, p2 = valid[i2] != 0, p3 = valid[i3] != 0, p4 = valid[i4] != 0;
            if (p1 && p2 && p3) { push(i1); push(i3); push(i2); }
            if (p2 && p3 && p4) { push(i2); push(i3); push(i4); }
        }
    }

    std::vector<double> normD;
    computeFlatNormals(vertD, normD);
    narrowToFloat(vertD, g_ribbonVertices);
    narrowToFloat(normD, g_ribbonNormals);
    return g_ribbonVertices.size() / 3;
}

ARCHCORE_EXPORT(ac_ribbon3d_vertices_ptr) float* ac_ribbon3d_vertices_ptr() { return g_ribbonVertices.ptr(); }
ARCHCORE_EXPORT(ac_ribbon3d_vertices_len) int ac_ribbon3d_vertices_len() { return g_ribbonVertices.size(); }
ARCHCORE_EXPORT(ac_ribbon3d_normals_ptr) float* ac_ribbon3d_normals_ptr() { return g_ribbonNormals.ptr(); }
ARCHCORE_EXPORT(ac_ribbon3d_normals_len) int ac_ribbon3d_normals_len() { return g_ribbonNormals.size(); }

} // namespace Core
} // namespace ArchMaths
