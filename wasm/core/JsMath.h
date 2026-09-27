#pragma once

// JavaScript-exact numeric semantics for the web front-end's compiled
// expressions. Every function here mirrors what the page's JS would compute,
// including NaN/Infinity/signed-zero edge cases, so the wasm core and the JS
// fallback path agree.

#include <cmath>
#include <cstdint>
#include <limits>

namespace ArchMaths {
namespace JsMath {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

inline bool isNaN(double v) { return v != v; }
inline bool isFinite(double v) { return v - v == 0.0; }

// Math.round: nearest integer, ties toward +Infinity, preserves -0.
inline double round(double x) {
    if (!isFinite(x) || x == 0.0) return x;
    if (x > 0.0 && x < 0.5) return 0.0;
    if (x < 0.0 && x >= -0.5) return -0.0;
    double r = std::floor(x);
    return (x - r >= 0.5) ? r + 1.0 : r;
}

// Math.sign
inline double sign(double x) {
    if (x > 0.0) return 1.0;
    if (x < 0.0) return -1.0;
    return x; // NaN, +0, -0
}

// Math.max / Math.min (binary; n-ary calls fold left, which is exact).
inline double max(double a, double b) {
    if (isNaN(a) || isNaN(b)) return kNaN;
    if (a == 0.0 && b == 0.0) return std::signbit(a) ? b : a;
    return a > b ? a : b;
}
inline double min(double a, double b) {
    if (isNaN(a) || isNaN(b)) return kNaN;
    if (a == 0.0 && b == 0.0) return std::signbit(a) ? a : b;
    return a < b ? a : b;
}

// Math.pow / the ** operator. Differs from C pow for NaN exponents and for
// |base| == 1 with infinite exponents.
inline double pow(double base, double exponent) {
    if (isNaN(exponent)) return kNaN;
    if (exponent == 0.0) return 1.0;
    if (std::fabs(base) == 1.0 && std::isinf(exponent)) return kNaN;
    return std::pow(base, exponent);
}

inline double atan2(double y, double x) { return std::atan2(y, x); }

// Math.hypot with two arguments. V8 implements hypot as max *
// sqrt(sum((x/max)^2)) (scaled, NOT the correctly-rounded std::hypot), and
// the two can differ by 1-2 ulp. That difference is invisible to most
// consumers but gets amplified without bound by acos(cos) for (anti)parallel
// vectors (geometry 'angle'), so this must match V8 bit-for-bit.
inline double hypot(double a, double b) {
    if (std::isinf(a) || std::isinf(b)) return kInf;
    if (isNaN(a) || isNaN(b)) return kNaN;
    const double aa = std::fabs(a), bb = std::fabs(b);
    const double mx = aa > bb ? aa : bb;
    if (mx == 0.0) return 0.0;
    const double d1 = a / mx;
    const double d2 = b / mx;
    const double sum = d1 * d1 + d2 * d2;
    return mx * std::sqrt(sum);
}

// JS `%` (same sign rules as C fmod).
inline double mod(double a, double b) { return std::fmod(a, b); }

// Port of the page's built-in advanced function `pow` (the target of `^`).
// Positive bases use exp(log(b)*e) exactly as the JS does; negative bases
// accept integer exponents and rationals with an odd denominator <= 25.
inline double advancedPow(double base, double exp1) {
    if (base > 0.0) {
        return std::exp(std::log(base) * exp1);
    }
    if (base == 0.0) {
        if (exp1 > 0.0) return 0.0;
        if (exp1 == 0.0) return 1.0;
        return kNaN;
    }
    // base < 0 or NaN
    if (JsMath::round(exp1) == exp1) {
        double result = JsMath::pow(std::fabs(base), exp1);
        if (std::fabs(std::fmod(exp1, 2.0)) == 1.0) {
            result = 0.0 - result;
        }
        return result;
    }

    const double absExp = std::fabs(exp1);
    const double MAX_DENOM = 25.0;
    const double EPSILON = 1e-9;
    double n = 0.0;
    double d = 0.0;
    bool found = false;
    double h1 = 1.0, k1 = 0.0;
    double h2 = 0.0, k2 = 1.0;
    double b = absExp;
    for (int i = 0; i < 20; i++) {
        double a = std::floor(b);
        double h = a * h1 + h2;
        double k = a * k1 + k2;
        if (k > MAX_DENOM) {
            break;
        }
        if (std::fabs(absExp - h / k) < EPSILON) {
            n = h;
            d = k;
            found = true;
            break;
        }
        h2 = h1; k2 = k1;
        h1 = h; k1 = k;
        if (std::fabs(b - a) < 1e-15) break;
        b = 1.0 / (b - a);
    }

    if (found && std::fmod(d, 2.0) != 0.0) {
        double result = std::exp(std::log(std::fabs(base)) * exp1);
        if (std::fmod(n, 2.0) != 0.0) {
            result = 0.0 - result;
        }
        return result;
    }
    return kNaN;
}

// The wrapper recalculate3D()/processSingleBlockForImplicit() install around
// `pow`: negative bases with a non-integer exponent yield NaN.
inline double advancedPowStrict(double a, double b) {
    if (a < 0.0 && std::fabs(b - JsMath::round(b)) > 1e-10) return kNaN;
    return advancedPow(a, b);
}

} // namespace JsMath
} // namespace ArchMaths
