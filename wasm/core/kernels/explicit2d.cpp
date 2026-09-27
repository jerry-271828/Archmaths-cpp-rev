// ArchCore kernel "explicit2d": ports plotExplicitFunctionGL()'s point-sampling
// (plotType 'y' and 'x', called only with those two types -- the 'y3d'/'x3d'
// branches inside the original method are dead code from this call site, see
// draw()'s `if (entry.plotType === 'y' || entry.plotType === 'x')` guard) and
// recalculateParametricCache()'s 2D parametric sampling.
//
// Covers all three explicit-plot branches (identical control flow to the
// original, ported almost line-for-line so floating point operation order
// matches exactly):
//   - adaptivePlottingEnabled: variable-step walk with a central-difference
//     derivative at each valid sample (offscreen/monotonic hysteresis feeds
//     the step-size formula), _isAdaptiveBreakPoint()-based segmentation,
//     then optional adaptiveExtendEnabled segment-boundary extension.
//   - autoBreakpointDetectionEnabled: uniform-step sampling gated by
//     _isAdaptiveBreakPoint() and _isBreakPoint().
//   - naive: uniform-step sampling, connect while both endpoints are valid.
// generateQuadVertices() (thick line -> two triangles) is ported exactly for
// the `useQuads` (thickness > 1.5) case; thin output pushes raw line
// endpoints, matching the original's `else` branches.
//
// All programs are 1-argument (funcEntry.func compiled with args=['x'] for
// plotType 'y', args=['y'] for plotType 'x' -- see recompileFunctions()), so
// this uses plain per-point Program::evaluate calls (evaluateOne); the
// adaptive branch's two derivative samples (f(x+h), f(x-h)) are computed once
// per valid point and reused for both the offscreen-hysteresis tracking and
// the step-size formula, exactly like the original's two call sites (which
// recompute the identical pure values from the same x_math and h).
//
// recalculateParametricCache() ports its 2D sampling (funcX/funcY over
// [tmin,tmax], numSteps = max(2, floor(explicitPrecisionStep*100))) as one
// batched Program::evaluate call per function -- see ac_parametric_cache_run.
#include "../CoreApi.h"
#include "../ExprProgram.h"
#include "../JsMath.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace ArchMaths {
namespace Core {

namespace {

OutBuffer<float> g_vertices;
OutBuffer<double> g_points;      // flat x0,y0,x1,y1,... for plottedFunctionPoints
OutBuffer<double> g_cache;       // flat x,y pairs; (NaN,NaN) is the `null` sentinel
OutBuffer<double> g_cachePlotted;

void narrowToFloat(const std::vector<double>& src, OutBuffer<float>& dst) {
    dst.data.resize(src.size());
    for (size_t i = 0; i < src.size(); ++i) dst.data[i] = static_cast<float>(src[i]);
}

// Port of generateQuadVertices(p1x,p1y,p2x,p2y,thickness): a thickness-wide
// quad (2 triangles, 6 vertices) along the p1->p2 segment. Pushes nothing for
// a zero-length segment, matching the original's `return []`.
void generateQuadVertices(double p1x, double p1y, double p2x, double p2y,
                           double thickness, std::vector<double>& out) {
    const double dx = p2x - p1x;
    const double dy = p2y - p1y;
    const double len = std::sqrt(dx * dx + dy * dy);
    if (len == 0.0) return;
    const double nx = dx / len;
    const double ny = dy / len;
    const double halfT = thickness / 2.0;
    const double offX = -ny * halfT;
    const double offY = nx * halfT;
    out.push_back(p1x - offX); out.push_back(p1y - offY);
    out.push_back(p1x + offX); out.push_back(p1y + offY);
    out.push_back(p2x - offX); out.push_back(p2y - offY);
    out.push_back(p1x + offX); out.push_back(p1y + offY);
    out.push_back(p2x + offX); out.push_back(p2y + offY);
    out.push_back(p2x - offX); out.push_back(p2y - offY);
}

struct Pt {
    double x = 0.0, y = 0.0;
    bool valid = false;
};

inline double depOf(const Pt& p, bool isYType) { return isYType ? p.y : p.x; }
inline double indepOf(const Pt& p, bool isYType) { return isYType ? p.x : p.y; }

enum class BreakKind : uint8_t { None, Jump, Step, Invalid };

// Port of _isAdaptiveBreakPoint(points, i, dependentAxis). canvasDim is
// this.canvas.clientHeight (isYType) or clientWidth (!isYType) -- distinct
// from the cssWidth/cssHeight the caller was given (canvasContainer's rect).
BreakKind isAdaptiveBreakPoint(const std::vector<Pt>& pts, int i, bool isYType,
                                double explicitPrecisionStep, double canvasDim, double scale) {
    const int n = static_cast<int>(pts.size());
    if (i <= 1 || i >= n - 1) return BreakKind::None;
    const Pt& p_prev2 = pts[i - 2];
    const Pt& p_prev = pts[i - 1];
    const Pt& p_curr = pts[i];
    const Pt& p_next = pts[i + 1];
    if (!p_prev.valid || !p_curr.valid || !p_prev2.valid || !p_next.valid) return BreakKind::None;

    if (i < n - 2) {
        const Pt& p_post = pts[i + 2];
        if (p_post.valid) {
            const double s1 = std::fabs((depOf(p_curr, isYType) - depOf(p_prev, isYType)) /
                                         (indepOf(p_curr, isYType) - indepOf(p_prev, isYType)));
            const double s2 = std::fabs((depOf(p_next, isYType) - depOf(p_curr, isYType)) /
                                         (indepOf(p_next, isYType) - indepOf(p_curr, isYType)));
            const double s3 = std::fabs((depOf(p_post, isYType) - depOf(p_next, isYType)) /
                                         (indepOf(p_post, isYType) - indepOf(p_next, isYType)));
            const double jumpThresholdRatio = 20.0 / explicitPrecisionStep;
            if (s2 > jumpThresholdRatio * s1 && s2 > jumpThresholdRatio * s3) return BreakKind::Jump;
        }
    }

    const double value_prev2 = depOf(p_prev2, isYType);
    const double value_prev = depOf(p_prev, isYType);
    const double value_curr = depOf(p_curr, isYType);
    const double value_next = depOf(p_next, isYType);
    const double tolerance = 1e-9;
    if (std::fabs(value_prev2 - value_prev) < tolerance &&
        std::fabs(value_prev - value_curr) > tolerance &&
        std::fabs(value_curr - value_next) < tolerance) {
        return BreakKind::Step;
    }

    const double jumpThreshold = canvasDim / scale * 0.5;
    if (depOf(p_curr, isYType) * depOf(p_next, isYType) < 0 &&
        std::fabs(depOf(p_curr, isYType) - depOf(p_next, isYType)) > jumpThreshold) {
        return BreakKind::Jump;
    }

    const double ZERO_DERIVATIVE_THRESHOLD = 1e-3;
    const double slope1 = (depOf(p_prev, isYType) - depOf(p_prev2, isYType)) /
                           (indepOf(p_prev, isYType) - indepOf(p_prev2, isYType));
    const double slope2 = (depOf(p_curr, isYType) - depOf(p_prev, isYType)) /
                           (indepOf(p_curr, isYType) - indepOf(p_prev, isYType));
    const double slope3 = (depOf(p_next, isYType) - depOf(p_curr, isYType)) /
                           (indepOf(p_next, isYType) - indepOf(p_curr, isYType));
    if (std::isfinite(slope1) && std::isfinite(slope2) && std::isfinite(slope3) &&
        std::fabs(slope1) > ZERO_DERIVATIVE_THRESHOLD &&
        JsMath::sign(slope1) == JsMath::sign(slope3) &&
        JsMath::sign(slope1) != JsMath::sign(slope2)) {
        return BreakKind::Jump;
    }
    return BreakKind::None;
}

// Port of _isBreakPoint(y_next, y_curr, y_prev, y_prev2). `explicitPrecisionValue`
// is this.explicitPrecisionSlider.options.value (NOT this.explicitPrecisionStep --
// they are normally equal but the caller must pass the slider's own value to
// stay exact during the brief windows where they can diverge, e.g. the
// zoom-performance-mode step in/out before setValue() catches up).
bool isBreakPoint(double y_next, double y_curr, double y_prev, double /*y_prev2*/,
                   double scale, double explicitPrecisionValue) {
    const double bpfactor = 0.25;
    const double denom = scale * bpfactor * explicitPrecisionValue;
    const bool term1 = std::fabs(y_next - y_curr) > 500.0 / denom;
    const bool term21 = std::fabs(y_next - y_curr) > 4.0 / denom;
    const bool term22 = std::fabs(y_curr - y_prev) < 0.005 / denom;
    const bool term2 = term21 && term22;
    const bool term3 = std::fabs(y_curr - y_prev) > 500.0 / denom;
    return term1 || term2 || term3;
}

} // namespace

// axis: 0 = plotType 'y' (dependent y=f(x)), 1 = plotType 'x' (dependent x=f(y)).
// cssWidth/cssHeight: canvasContainer's client rect (what plotExplicitFunctionGL
// was called with). canvasClientWidth/Height: this.canvas.clientWidth/clientHeight,
// read independently by _isAdaptiveBreakPoint's jumpThreshold -- kept separate
// since the container and the canvas need not be pixel-identical.
// explicitPrecisionSliderValue: this.explicitPrecisionSlider.options.value (see
// isBreakPoint above). flags: pass 0 (explicit plots use the non-strict pow).
// Returns the emitted vertex FLOAT count (>=0), or -1 for an invalid/wrong-arity handle.
ARCHCORE_EXPORT(ac_explicit2d_run)
int ac_explicit2d_run(int handle, int axis,
                       double cssWidth, double cssHeight,
                       double offsetX, double offsetY, double scale,
                       double canvasClientWidth, double canvasClientHeight,
                       int adaptivePlottingEnabled, int autoBreakpointDetectionEnabled,
                       int adaptiveExtendEnabled,
                       double explicitPrecisionStep, double explicitPrecisionSliderValue,
                       double lineThicknessMath, int useQuadsFlag, int flags) {
    g_vertices.clear();
    g_points.clear();
    Program* prog = programFromHandle(handle);
    if (!prog || prog->argCount() != 1) return -1;

    const bool isYType = axis == 0;
    const bool useQuads = useQuadsFlag != 0;
    const double bufferPixels = std::max(50.0, std::max(cssWidth, cssHeight) * 0.1);
    const double pixelStep = std::max(0.005, 1.0 / explicitPrecisionStep);
    const double canvasDim = isYType ? canvasClientHeight : canvasClientWidth;

    std::vector<double> vertD;
    std::vector<double> plottedFlat;

    auto emit = [&](double x1, double y1, double x2, double y2) {
        if (useQuads) {
            generateQuadVertices(x1, y1, x2, y2, lineThicknessMath, vertD);
        } else {
            vertD.push_back(x1); vertD.push_back(y1);
            vertD.push_back(x2); vertD.push_back(y2);
        }
    };

    auto evalAt = [&](double u) { return prog->evaluateOne(&u, flags); };

    if (adaptivePlottingEnabled) {
        std::vector<Pt> collected;
        const double defaultPixelStep = pixelStep;
        const double minPixelStep = defaultPixelStep / 16.0;
        const double slopeFactor = 0.1;
        const int RESET_THRESHOLD = 30;
        int consecutiveInvalidCount = 0;
        int consecutiveOffscreenMonotonicCount = 0;
        double lastDerivativeSign = 0.0;

        const double pLimit = (isYType ? cssWidth : cssHeight) + bufferPixels;
        double p = -bufferPixels;
        while (p < pLimit) {
            const double uMath = isYType ? (p - offsetX) / scale : (offsetY - p) / scale;
            const double vMath = evalAt(uMath);
            const bool isValid = std::isfinite(vMath);
            const double ptX = isYType ? uMath : vMath;
            const double ptY = isYType ? vMath : uMath;

            const double h = 0.0001 / scale;
            double v_plus = JsMath::kNaN, v_minus = JsMath::kNaN;
            bool haveDerivative = false;

            if (isValid) {
                plottedFlat.push_back(ptX);
                plottedFlat.push_back(ptY);
                consecutiveInvalidCount = 0;

                const double screenDependent = isYType ? (offsetY - vMath * scale) : (offsetX + vMath * scale);
                const double screenLow = -bufferPixels;
                const double screenHigh = (isYType ? cssHeight : cssWidth) + bufferPixels;
                const double axisScreen = isYType ? offsetY : offsetX;
                double checkLow, checkHigh;
                if (axisScreen < screenLow) {
                    checkLow = isYType ? (offsetY - 10.0 * scale) : (offsetX + 10.0 * scale);
                    checkHigh = screenHigh;
                } else if (axisScreen > screenHigh) {
                    checkLow = screenLow;
                    checkHigh = isYType ? (offsetY + 10.0 * scale) : (offsetX - 10.0 * scale);
                } else {
                    checkLow = screenLow;
                    checkHigh = screenHigh;
                }
                const bool isOffscreen = screenDependent < checkLow || screenDependent > checkHigh;

                const double uPlusH = uMath + h;
                const double uMinusH = uMath - h;
                v_plus = evalAt(uPlusH);
                v_minus = evalAt(uMinusH);
                haveDerivative = std::isfinite(v_plus) && std::isfinite(v_minus);
                if (haveDerivative) {
                    const double sign = JsMath::sign(v_plus - v_minus);
                    if (isOffscreen && sign != 0.0 && sign == lastDerivativeSign) {
                        consecutiveOffscreenMonotonicCount++;
                    } else {
                        consecutiveOffscreenMonotonicCount = 0;
                    }
                    lastDerivativeSign = sign;
                } else {
                    consecutiveOffscreenMonotonicCount = 0;
                    lastDerivativeSign = 0.0;
                }
            } else {
                consecutiveInvalidCount++;
                consecutiveOffscreenMonotonicCount = 0;
                lastDerivativeSign = 0.0;
            }
            collected.push_back({ptX, ptY, isValid});

            double step = defaultPixelStep;
            if (consecutiveInvalidCount < RESET_THRESHOLD && consecutiveOffscreenMonotonicCount < RESET_THRESHOLD) {
                if (isValid && haveDerivative) {
                    const double derivative = (v_plus - v_minus) / (2.0 * h);
                    step = defaultPixelStep / (1.0 + slopeFactor * std::fabs(derivative));
                    step = std::max(step, minPixelStep);
                }
            }
            p += step;
        }

        std::vector<std::vector<Pt>> segments;
        std::vector<BreakKind> breakTypes;
        std::vector<Pt> current;
        const int n = static_cast<int>(collected.size());
        for (int i = 0; i < n; ++i) {
            const Pt& pt = collected[i];
            const BreakKind bt = isAdaptiveBreakPoint(collected, i, isYType, explicitPrecisionStep, canvasDim, scale);
            if (pt.valid && bt == BreakKind::None) current.push_back(pt);
            if (!pt.valid || bt != BreakKind::None || i == n - 1) {
                if (current.size() > 1) {
                    segments.push_back(current);
                    breakTypes.push_back(bt != BreakKind::None ? bt : (!pt.valid ? BreakKind::Invalid : BreakKind::None));
                }
                current.clear();
                if (pt.valid && bt != BreakKind::None) current.push_back(pt);
            }
        }

        for (size_t segIndex = 0; segIndex < segments.size(); ++segIndex) {
            std::vector<Pt>& segment = segments[segIndex];
            const bool startsWithDiscontinuity = segIndex > 0;
            const bool endsWithDiscontinuity = segIndex < segments.size() - 1;
            const BreakKind reasonForStart = segIndex > 0 ? breakTypes[segIndex - 1] : BreakKind::None;
            const BreakKind reasonForEnd = breakTypes[segIndex];

            bool canExtendStart = false;
            if (adaptiveExtendEnabled && startsWithDiscontinuity && reasonForStart != BreakKind::Step) {
                const std::vector<Pt>& prevSegment = segments[segIndex - 1];
                if (prevSegment.size() >= 2 && segment.size() >= 2) {
                    const Pt& p_prev_last = prevSegment[prevSegment.size() - 1];
                    const Pt& p_prev_penultimate = prevSegment[prevSegment.size() - 2];
                    const Pt& p_curr_first = segment[0];
                    const Pt& p_curr_second = segment[1];
                    const double leftSlope = (depOf(p_prev_last, isYType) - depOf(p_prev_penultimate, isYType)) /
                                              (indepOf(p_prev_last, isYType) - indepOf(p_prev_penultimate, isYType));
                    const double rightSlope = (depOf(p_curr_second, isYType) - depOf(p_curr_first, isYType)) /
                                               (indepOf(p_curr_second, isYType) - indepOf(p_curr_first, isYType));
                    const double valueDiff = std::fabs(depOf(p_curr_first, isYType) - depOf(p_prev_last, isYType));
                    if (std::fabs(leftSlope) > 20.0 && std::fabs(rightSlope) > 20.0 && valueDiff > 60.0) {
                        canExtendStart = true;
                    }
                }
            }

            if (canExtendStart) {
                const Pt& p_first = segment[0];
                if (isYType) {
                    const double slope_start = (segment[1].y - p_first.y) / (segment[1].x - p_first.x);
                    const double start_extension_y = (slope_start > 0) ? (offsetY - cssHeight) / scale : offsetY / scale;
                    emit(p_first.x, start_extension_y, p_first.x, p_first.y);
                } else {
                    const double slope_start = (segment[1].x - p_first.x) / (segment[1].y - p_first.y);
                    const double start_extension_x = (slope_start > 0) ? (-offsetX) / scale : (cssWidth - offsetX) / scale;
                    emit(start_extension_x, p_first.y, p_first.x, p_first.y);
                }
            }

            for (size_t i = 0; i + 1 < segment.size(); ++i) {
                emit(segment[i].x, segment[i].y, segment[i + 1].x, segment[i + 1].y);
            }

            bool canExtendEnd = false;
            if (adaptiveExtendEnabled && endsWithDiscontinuity && reasonForEnd != BreakKind::Step) {
                const std::vector<Pt>& nextSegment = segments[segIndex + 1];
                if (nextSegment.size() >= 2 && segment.size() >= 2) {
                    const Pt& p_curr_last = segment[segment.size() - 1];
                    const Pt& p_curr_penultimate = segment[segment.size() - 2];
                    const Pt& p_next_first = nextSegment[0];
                    const Pt& p_next_second = nextSegment[1];
                    const double leftSlope = (depOf(p_curr_last, isYType) - depOf(p_curr_penultimate, isYType)) /
                                              (indepOf(p_curr_last, isYType) - indepOf(p_curr_penultimate, isYType));
                    const double rightSlope = (depOf(p_next_second, isYType) - depOf(p_next_first, isYType)) /
                                               (indepOf(p_next_second, isYType) - indepOf(p_next_first, isYType));
                    const double valueDiff = std::fabs(depOf(p_next_first, isYType) - depOf(p_curr_last, isYType));
                    if (std::fabs(leftSlope) > 20.0 && std::fabs(rightSlope) > 20.0 && valueDiff > 60.0) {
                        canExtendEnd = true;
                    }
                }
            }

            if (canExtendEnd) {
                const Pt& p_last = segment[segment.size() - 1];
                if (isYType) {
                    const double slope_end = (p_last.y - segment[segment.size() - 2].y) / (p_last.x - segment[segment.size() - 2].x);
                    const double end_extension_y = (slope_end > 0) ? offsetY / scale : (offsetY - cssHeight) / scale;
                    emit(p_last.x, p_last.y, p_last.x, end_extension_y);
                } else {
                    const double slope_end = (p_last.x - segment[segment.size() - 2].x) / (p_last.y - segment[segment.size() - 2].y);
                    const double end_extension_x = (slope_end > 0) ? (cssWidth - offsetX) / scale : (-offsetX) / scale;
                    emit(p_last.x, p_last.y, end_extension_x, p_last.y);
                }
            }
        }
    } else if (autoBreakpointDetectionEnabled) {
        std::vector<Pt> collected;
        const double pLimit = (isYType ? cssWidth : cssHeight) + bufferPixels;
        for (double p = -bufferPixels; p < pLimit; p += pixelStep) {
            const double uMath = isYType ? (p - offsetX) / scale : (offsetY - p) / scale;
            const double vMath = evalAt(uMath);
            const bool valid = std::isfinite(vMath);
            const double ptX = isYType ? uMath : vMath;
            const double ptY = isYType ? vMath : uMath;
            if (valid) { plottedFlat.push_back(ptX); plottedFlat.push_back(ptY); }
            collected.push_back({ptX, ptY, valid});
        }

        for (int i = 0; i + 1 < static_cast<int>(collected.size()); ++i) {
            const Pt& pCurr = collected[i];
            const Pt& pNext = collected[i + 1];
            if (pCurr.valid && pNext.valid) {
                bool connect = true;
                if (isAdaptiveBreakPoint(collected, i, isYType, explicitPrecisionStep, canvasDim, scale) != BreakKind::None) {
                    connect = false;
                }
                if (connect && autoBreakpointDetectionEnabled && i >= 2) {
                    const Pt& pPrev = collected[i - 1];
                    const Pt& pPrev2 = collected[i - 2];
                    if (isBreakPoint(depOf(pNext, isYType), depOf(pCurr, isYType), depOf(pPrev, isYType), depOf(pPrev2, isYType),
                                      scale, explicitPrecisionSliderValue)) {
                        connect = false;
                    }
                }
                if (connect) emit(pCurr.x, pCurr.y, pNext.x, pNext.y);
            }
        }
    } else {
        bool haveLast = false;
        Pt last;
        const double pLimit = (isYType ? cssWidth : cssHeight) + bufferPixels;
        for (double p = -bufferPixels; p < pLimit; p += pixelStep) {
            const double uMath = isYType ? (p - offsetX) / scale : (offsetY - p) / scale;
            const double vMath = evalAt(uMath);
            if (std::isfinite(vMath)) {
                const double ptX = isYType ? uMath : vMath;
                const double ptY = isYType ? vMath : uMath;
                plottedFlat.push_back(ptX);
                plottedFlat.push_back(ptY);
                if (haveLast) emit(last.x, last.y, ptX, ptY);
                last = {ptX, ptY, true};
                haveLast = true;
            } else {
                haveLast = false;
            }
        }
    }

    narrowToFloat(vertD, g_vertices);
    g_points.data = std::move(plottedFlat);
    return g_vertices.size();
}

ARCHCORE_EXPORT(ac_explicit2d_vertices_ptr) float* ac_explicit2d_vertices_ptr() { return g_vertices.ptr(); }
ARCHCORE_EXPORT(ac_explicit2d_vertices_len) int ac_explicit2d_vertices_len() { return g_vertices.size(); }
ARCHCORE_EXPORT(ac_explicit2d_points_ptr) double* ac_explicit2d_points_ptr() { return g_points.ptr(); }
ARCHCORE_EXPORT(ac_explicit2d_points_len) int ac_explicit2d_points_len() { return g_points.size(); }

// ---- recalculateParametricCache: 2D parametric sampling -------------------
// handleX/handleY: programs for funcEntry.funcX/funcY (both args=['t']).
// funcZ (parametric3d only) is intentionally never evaluated: the original
// calls it and discards the result, and it is a pure function of t with no
// side effects (recompileFunctions() wraps every compiled body in its own
// try/catch returning NaN, so it cannot throw either) -- see the .cpp header
// comment and the kernel report for the full argument.
// Returns the number of cache ENTRIES (points + null sentinels), or -1 for
// invalid/wrong-arity handles.
ARCHCORE_EXPORT(ac_parametric_cache_run)
int ac_parametric_cache_run(int handleX, int handleY, double tmin, double tmax,
                             double explicitPrecisionStep, int flags) {
    g_cache.clear();
    g_cachePlotted.clear();
    Program* px = programFromHandle(handleX);
    Program* py = programFromHandle(handleY);
    if (!px || !py || px->argCount() != 1 || py->argCount() != 1) return -1;

    const double numStepsD = std::max(2.0, std::floor(explicitPrecisionStep * 100.0));
    const int numSteps = static_cast<int>(numStepsD);
    const double tStep = (tmax - tmin) / numStepsD;
    const int n = numSteps + 1;

    std::vector<double> tvals(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) tvals[static_cast<size_t>(i)] = tmin + static_cast<double>(i) * tStep;

    std::vector<double> xout(static_cast<size_t>(n));
    std::vector<double> yout(static_cast<size_t>(n));
    const double* lanesX[1] = { tvals.data() };
    const double* lanesY[1] = { tvals.data() };
    px->evaluate(lanesX, n, xout.data(), flags);
    py->evaluate(lanesY, n, yout.data(), flags);

    std::vector<double> cache;
    std::vector<double> plotted;
    bool haveAny = false;
    bool lastWasNull = false;
    for (int i = 0; i < n; ++i) {
        const double xv = xout[static_cast<size_t>(i)];
        const double yv = yout[static_cast<size_t>(i)];
        const bool valid = std::isfinite(xv) && std::isfinite(yv);
        if (valid) {
            cache.push_back(xv);
            cache.push_back(yv);
            plotted.push_back(xv);
            plotted.push_back(yv);
            haveAny = true;
            lastWasNull = false;
        } else if (haveAny && !lastWasNull) {
            cache.push_back(JsMath::kNaN);
            cache.push_back(JsMath::kNaN);
            lastWasNull = true;
        }
    }

    g_cache.data = std::move(cache);
    g_cachePlotted.data = std::move(plotted);
    return g_cache.size() / 2;
}

ARCHCORE_EXPORT(ac_parametric_cache_ptr) double* ac_parametric_cache_ptr() { return g_cache.ptr(); }
ARCHCORE_EXPORT(ac_parametric_cache_len) int ac_parametric_cache_len() { return g_cache.size(); }
ARCHCORE_EXPORT(ac_parametric_cache_plotted_ptr) double* ac_parametric_cache_plotted_ptr() { return g_cachePlotted.ptr(); }
ARCHCORE_EXPORT(ac_parametric_cache_plotted_len) int ac_parametric_cache_plotted_len() { return g_cachePlotted.size(); }

} // namespace Core
} // namespace ArchMaths
