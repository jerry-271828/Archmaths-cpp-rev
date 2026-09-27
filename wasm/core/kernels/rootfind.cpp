// Kernel "rootfind": numerical root solving for the page's
// name=root[expr,var,init] variable entries.
//
// Line-by-line port of the root branch of ArchEngine.recalculateVariableValues
// (arch-current.html, the `if (entry.isRootFinding) { ... }` block): the
// caller compiles f(rootVar) through ac_calc_compile with rootVar as the
// single lane arg and every other variable as a parameter (ac_set_params),
// then calls ac_root_run(handle, x0) with the evaluated init expression.
// All arithmetic below mirrors the page's JS operation-for-operation
// (same operand order, same IEEE-754 doubles, same NaN comparison behavior),
// and f itself is the same compiled expression the page evaluates point by
// point, so results match the page bit-for-bit up to the JS<->wasm libm
// noise inside f — which the JS adapter's first-use probe gates on.
//
// NaN is returned for unknown/released handles, programs whose arity is not
// exactly one arg (the root variable), and non-finite x0 — the same NaN the
// page produces in those situations.

#include "../CoreApi.h"
#include "../JsMath.h"

#include <cmath>

namespace ArchMaths {
namespace Core {
namespace {

using JsMath::isFinite;
using JsMath::kNaN;

} // namespace
} // namespace Core
} // namespace ArchMaths

using namespace ArchMaths::Core;

// One f(rootVar) evaluation at an arbitrary point; rootVar is lane arg 0.
static inline double evalRootF(Program* p, double v) {
    return p->evaluateOne(&v, 0);
}

ARCHCORE_EXPORT(ac_root_run) double ac_root_run(int handle, double x0) {
    Program* p = programFromHandle(handle);
    if (!p || p->argCount() != 1 || !isFinite(x0)) return kNaN;

    double x = x0;
    const double y0 = evalRootF(p, x0);
    bool found = false;

    if (std::fabs(y0) < 1e-3) {
        x = x0;
        found = true;
    } else {
        double step = 0.1;
        const int maxSteps = 1000;
        for (int i = 1; i <= maxSteps; i++) {
            const double xL = x0 - static_cast<double>(i) * step;
            const double yL = evalRootF(p, xL);
            if (isFinite(yL) && yL * y0 <= 0) { x = xL; found = true; break; }
            const double xR = x0 + static_cast<double>(i) * step;
            const double yR = evalRootF(p, xR);
            if (isFinite(yR) && yR * y0 <= 0) { x = xR; found = true; break; }

            if (i > 100) step = 0.5;
        }
    }

    if (!found) return kNaN;

    const double currentStep = (std::fabs(x - x0) > 100 * 0.1) ? 0.5 : 0.1;
    double low = x;
    double high = (x < x0) ? x + currentStep : x - currentStep;

    if (evalRootF(p, low) * evalRootF(p, high) > 0) {
        // Newton refinement (up to 5 steps, central-difference derivative).
        for (int j = 0; j < 5; j++) {
            const double y = evalRootF(p, x);
            if (std::fabs(y) < 1e-3) break;
            const double dy = (evalRootF(p, x + 1e-4) - evalRootF(p, x - 1e-4)) / 2e-4;
            if (std::fabs(dy) < 1e-9) break;
            x = x - y / dy;
        }
    } else {
        // Bisection refinement (up to 15 steps).
        for (int j = 0; j < 15; j++) {
            const double mid = (low + high) / 2;
            const double fMid = evalRootF(p, mid);
            if (std::fabs(high - low) < 1e-3 || std::fabs(fMid) < 1e-3) break;
            if (evalRootF(p, low) * fMid <= 0) high = mid; else low = mid;
        }
        x = (low + high) / 2;
    }
    return x;
}
