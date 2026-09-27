// Kernel "advfuncs": C++ ports of the page's built-in ADVANCED_FUNCTION_DEFINITIONS
// (arch-current.html), implementing findAdvancedFunction() from AdvancedRegistry.h
// as a strong definition that overrides ExprProgram.cpp's weak default.
//
// Every function below is a statement-by-statement translation of the matching
// bodyJsString: same literals (copied via a round-trip-safe decimal dump of the
// page's own parsed array literals, so digits are bit-for-bit what the page's
// `new Function(...)` would see), same branches, same operation order. Because
// AdvancedFunction::fn1/2/3 only ever receive already-numeric double arguments
// (the VM's lanes), `Number(x)` on those arguments is the identity and is
// skipped; JsMath.h supplies JS-exact isNaN/isFinite/pow so libm/std edge cases
// (NaN exponents, etc.) can't diverge from V8.
//
// `pow` (the target of `^`) is out of scope here: ExprProgram.cpp already
// special-cases "adv.pow" to Fn::AdvPow / JsMath::advancedPow, matching the
// page's ADVANCED_FUNCTION_DEFINITIONS entry named "pow" directly (see
// JsMath::advancedPow's doc comment).
//
// Nothing here was skipped: every other ADVANCED_FUNCTION_DEFINITIONS entry
// (gamma, erf, erfc, elliptice, elliptick, sign, sgn, heaviside, fresnels,
// fresnelc, psi, lambertw, ltw, li, zeta, sinintegral, cosintegral,
// expintegral, range, llim, ulim) is a pure scalar function of 1-3 numeric
// arguments with no randomness and no external state, so all of them port.
// A few pairs are byte-identical JS bodies (sign/sgn, lambertw/ltw) or embed
// an identical helper (gamma's Lanczos core is copy-pasted verbatim into
// psi's and zeta's local `calculateGamma`; li's and expintegral's local `Ei`
// are identical); those share one C++ implementation below instead of being
// duplicated, which cannot change any result since the shared code is a pure
// function of its argument.

#include "AdvancedRegistry.h"
#include "JsMath.h"

#include <cmath>
#include <cstring>

namespace ArchMaths {
namespace Core {
namespace {

using JsMath::isFinite;
using JsMath::isNaN;
using JsMath::kInf;
using JsMath::kNaN;

// Math.PI / Math.LN2 as the page's transpiled bodies see them (some bodies
// spell out the digits, some write Math.PI / Math.LN2; both are this value).
constexpr double kPI = 3.141592653589793;
constexpr double kLN2 = 0.6931471805599453;

// Shared 14-point Gauss-Legendre-ish node/weight tables ("intList1"/"intList2"
// in erf, erfc, elliptice, elliptick, li, sinintegral, cosintegral,
// expintegral -- byte-identical in every one of those bodies).
constexpr double kQuadX[14] = {
    0.9862838086968123, 0.9284348836635736, 0.827201315069765, 0.6872929048116855,
    0.5152486363581541, 0.31911236892788974, 0.10805494870734365, -0.10805494870734365,
    -0.31911236892788974, -0.5152486363581541, -0.6872929048116855, -0.827201315069765,
    -0.9284348836635736, -0.9862838086968123,
};
constexpr double kQuadW[14] = {
    0.035119460331752, 0.08015808715976036, 0.12151857068790316, 0.15720316715819357,
    0.18553839747793788, 0.20519846372129574, 0.21526385346315768, 0.21526385346315768,
    0.20519846372129574, 0.18553839747793788, 0.15720316715819357, 0.12151857068790316,
    0.08015808715976036, 0.035119460331752,
};

// Shared 27-point node/weight tables ("intList5"/"intList6" in fresnels and
// fresnelc -- byte-identical in both bodies).
constexpr double kFresnelX[27] = {
    0.0, -0.11833633389852105, 0.11833633389852105, -0.23501148310291814, 0.23501148310291814,
    -0.3483875819890287, 0.3483875819890287, -0.4568730756140824, 0.4568730756140824,
    -0.5589450609425611, 0.5589450609425611, -0.6531706636968095, 0.6531706636968095,
    -0.7382271498464599, 0.7382271498464599, -0.8129204868958123, 0.8129204868958123,
    -0.8762020862145224, 0.8762020862145224, -0.9271834587251158, 0.9271834587251158,
    -0.9651484024508189, 0.9651484024508189, -0.9895609637285506, 0.9895609637285506,
    -1.0, 1.0,
};
constexpr double kFresnelW[27] = {
    0.11861397766276303, 0.11778143658595616, 0.11778143658595616, 0.11529550025465198,
    0.11529550025465198, 0.11119106525743704, 0.11119106525743704, 0.10552574782125301,
    0.10552574782125301, 0.09837907458595276, 0.09837907458595276, 0.08985136525929056,
    0.08985136525929056, 0.08006232197053846, 0.08006232197053846, 0.06914934236004328,
    0.06914934236004328, 0.05726556968016273, 0.05726556968016273, 0.0445776579330617,
    0.0445776579330617, 0.03126295173520238, 0.03126295173520238, 0.01750197487606558,
    0.01750197487606558, 0.002849002849002849, 0.002849002849002849,
};

// zeta's "intList3" (0.5 < input < 1 polynomial) and "intList4" (1 <= input < 6
// polynomial), copied the same way.
constexpr double kZetaSmall[26] = {
    -3767.072952023442, 20718.90129135377, -54269.39501789772, 89585.70443085504,
    -104281.52005300076, 90823.15550356735, -61337.285025504374, 32857.273840367445,
    -14173.106302993425, 4967.164806127217, -1424.318629211626, 332.98503571319685,
    -65.1540800052316, 9.05528272984255, -2.2783842147956217, -0.8693337028533477,
    -1.010605698722239, -0.9993276868338765, -1.0000323885287514, -1.000000132160679,
    -1.0000019707696068, -0.9998792989880363, -1.0007851944824477, -1.0031782279542623,
    -0.9189385332046728, -0.5,
};
constexpr double kZetaLarge[34] = {
    1.3083048186768758e-24, -1.7999869864062488e-22, 1.1931012369756042e-20, -5.075180222352139e-19,
    1.5570752325465378e-17, -3.6713955155400828e-16, 6.922805756662876e-15, -1.0725610525682801e-13,
    1.3922618091090791e-12, -1.5364814246219453e-11, 1.457956408564051e-10, -1.2001975969275128e-9,
    8.633561918653008e-9, -5.4594868401656444e-8, 3.0503075328141797e-7, -0.0000015125434905810207,
    0.000006684076591078297, -0.000026431136828897945, 0.00009393159806725267, -0.00030149203693227597,
    0.0008792353824119747, -0.0023471823395646687, 0.005789968439669779, -0.013349584800389789,
    0.029149267728612187, -0.06110256079651455, 0.12443817580896012, -0.24813667949159626,
    0.4850643618996288, -0.922280483654018, 1.6692184480209624, -2.7428447125055806,
    3.6757500000505674, -1.9999996917015266,
};

// ---- gamma (Lanczos approximation). Shared verbatim by gamma(), psi()'s
// local calculateGamma(), and zeta()'s local calculateGamma(). ----
double gammaCore(double numInputGamma) {
    if (isNaN(numInputGamma)) return kNaN;
    if (numInputGamma <= 0.0 && numInputGamma == std::floor(numInputGamma)) return kInf;

    double count0;
    if (numInputGamma < 0.5) {
        double inputtemp = 1.0 - numInputGamma;
        if (inputtemp <= 0.0 && inputtemp == std::floor(inputtemp)) {
            if (inputtemp <= 0.0 && std::floor(inputtemp) == inputtemp) {
                return kNaN;
            }
        }
        double gammaOfInputtemp = 2.5066282746310002 *
            std::exp((inputtemp - 0.5) * std::log(inputtemp + 6.5)) *
            std::exp(-inputtemp - 6.5) *
            (0.99999999999980993 +
             676.5203681218851 / inputtemp -
             1259.1392167224028 / (inputtemp + 1) +
             771.32342877765313 / (inputtemp + 2) -
             176.61502916214059 / (inputtemp + 3) +
             12.507343278686905 / (inputtemp + 4) -
             0.13857109526572012 / (inputtemp + 5) +
             0.0000099843695780195716 / (inputtemp + 6) +
             0.00000015056327351493116 / (inputtemp + 7));

        double sinOfPiInput = std::sin(kPI * numInputGamma);

        if (std::fabs(sinOfPiInput) < 1e-15) {
            return kInf;
        }
        if (std::fabs(gammaOfInputtemp) < 1e-15 && std::fabs(sinOfPiInput) < 1e-15) {
            return kNaN;
        }

        count0 = kPI / (gammaOfInputtemp * sinOfPiInput);
    } else {
        double inputtemp = numInputGamma;
        count0 = 2.5066282746310002 * std::exp((inputtemp - 0.5) * std::log(inputtemp + 6.5)) * std::exp(0.0 - inputtemp - 6.5) * (0.99999999999980993 + 676.5203681218851 / inputtemp -
            1259.1392167224028 / (inputtemp + 1) +
            771.32342877765313 / (inputtemp + 2) -
            176.61502916214059 / (inputtemp + 3) +
            12.507343278686905 / (inputtemp + 4) -
            0.13857109526572012 / (inputtemp + 5) +
            0.0000099843695780195716 / (inputtemp + 6) +
            0.00000015056327351493116 / (inputtemp + 7));
    }

    if (!isFinite(count0)) {
        if (numInputGamma <= 0.0 && numInputGamma == std::floor(numInputGamma)) {
            return kInf;
        }
        return kNaN;
    }
    if (std::fabs(count0) < 1e-15) {
        count0 = 0.0;
    }
    return count0;
}

double fnGamma(double input) { return gammaCore(input); }

// ---- erf / erfc: identical quadrature, different final combination. ----
double erfRam4205(double numInput) {
    if (isNaN(numInput)) return kNaN;
    double ram41 = 0.0;
    for (int i = 0; i < 14; i++) {
        double ram4205 = 0.5 * std::atan(numInput) * (1.0 + kQuadX[i]);
        double ram42 = std::tan(ram4205);
        ram41 += kQuadW[i] * std::exp(-ram42 * ram42) * (1.0 + std::tan(ram4205) * std::tan(ram4205));
    }
    return ram41 * 0.5 * std::atan(numInput);
}

double fnErf(double input) {
    // (No isNaN(ram4205) re-check here: the JS body never re-checks either,
    // and erfRam4205 already returns NaN immediately for NaN input and cannot
    // produce NaN from any non-NaN finite/infinite input given its bounded
    // intermediate values, so the check was provably dead. Removed to keep
    // this a literal, line-for-line port of the original body.)
    return 1.12837916709551257 * erfRam4205(input);
}

double fnErfc(double input) {
    // (Same dead-recheck removal as fnErf above -- the JS body never re-checks
    // isNaN after the loop either.)
    return 1.0 - 1.12837916709551257 * erfRam4205(input);
}

// ---- elliptice / elliptick ----
double fnElliptice(double numInput) {
    if (isNaN(numInput)) return kNaN;
    double ram41 = 0.0;
    for (int i = 0; i < 14; i++) {
        double ram42 = 0.5 * ((kQuadX[i] + 1.0) * 1.5707963267948966);
        double s = numInput * std::sin(ram42);
        ram41 += kQuadW[i] * 0.7853981633974483 * std::sqrt(1.0 - s * s);
    }
    return ram41;
}

double fnElliptick(double numInput) {
    if (isNaN(numInput)) return kNaN;
    double ram41 = 0.0;
    for (int i = 0; i < 14; i++) {
        double ram42 = 0.5 * ((kQuadX[i] + 1.0) * 1.5707963267948966);
        double s = numInput * std::sin(ram42);
        ram41 += kQuadW[i] * 0.7853981633974483 / std::sqrt(1.0 - s * s);
    }
    return ram41;
}

// ---- sign / sgn (byte-identical bodies) / heaviside ----
double fnSign(double input) {
    if (isNaN(input)) return kNaN;
    if (input < 0.0) return -1.0;
    if (input > 0.0) return 1.0;
    return 0.0;
}

double fnHeaviside(double input) {
    if (isNaN(input)) return kNaN;
    if (input > 0.0) return 1.0;
    return 0.0;
}

// ---- fresnels / fresnelc ----
// NOTE: sfnintsub's and cfnintsub's polynomial constants are copied exactly
// as printed in the page (e.g. sfnintsub's 0.0967546032995985 vs cfnintsub's
// 0.096754603299598 really are different doubles, ~36 ULP apart -- confirmed
// against the live bodyJsString, not "corrected").
double sfnintsub(double x) {
    if (x > 4.59) {
        double x4 = x * x * x * x;
        double polyA = (((x4 * (-0.318309886183791) + 0.0967546032995985) * x4 - 0.343115182520605) * x4 + 3.44171880544581);
        double polyB = (((x4 * (-0.101321183642338) + 0.153989733820265) * x4 - 0.982952592264580) * x4 + 14.2419305760949);
        return polyA / std::exp(13.0 * std::log(x)) * std::cos(1.5707963267948966 * x * x)
            + 0.5
            + polyB / std::exp(15.0 * std::log(x)) * std::sin(1.5707963267948966 * x * x);
    }
    double ram41 = 0.0;
    for (int i = 0; i < 27; i++) {
        double ram42 = 0.5 * ((kFresnelX[i] + 1.0) * x);
        ram41 += kFresnelW[i] * 0.5 * x * std::sin(ram42 * ram42 * 1.5707963267948966);
    }
    return ram41;
}

double fnFresnels(double numInput) {
    if (isNaN(numInput)) return kNaN;
    if (numInput > 10000000.0) return 0.5;
    if (numInput < -10000000.0) return -0.5;
    if (numInput < 0.0) return -sfnintsub(-numInput);
    return sfnintsub(numInput);
}

double cfnintsub(double x) {
    if (x > 4.59) {
        double x4 = x * x * x * x;
        double polyA = (((x4 * (-0.101321183642338) + 0.153989733820265) * x4 - 0.98295259226458) * x4 + 14.2419305760949);
        double polyB = (((x4 * 0.318309886183791 - 0.096754603299598) * x4 + 0.343115182520605) * x4 - 3.44171880544581);
        return polyA / std::exp(15.0 * std::log(x)) * std::cos(1.5707963267948966 * x * x)
            + 0.5
            + polyB / std::exp(13.0 * std::log(x)) * std::sin(1.5707963267948966 * x * x);
    }
    double ram41 = 0.0;
    for (int i = 0; i < 27; i++) {
        double ram42 = 0.5 * ((kFresnelX[i] + 1.0) * x);
        ram41 += kFresnelW[i] * 0.5 * x * std::cos(ram42 * ram42 * 1.5707963267948966);
    }
    return ram41;
}

double fnFresnelc(double numInput) {
    if (isNaN(numInput)) return kNaN;
    if (numInput > 10000000.0) return 0.5;
    if (numInput < -10000000.0) return -0.5;
    if (numInput < 0.0) return -cfnintsub(-numInput);
    return cfnintsub(numInput);
}

// ---- psi (digamma via central-difference of log(gammaCore)) ----
//
// INTENTIONALLY NOT REGISTERED in kFunctions below (see the comment there).
// This is a faithful, statement-by-statement port of the page's body and is
// numerically fine as C++; it is excluded from wasm acceleration because the
// central difference with h=1e-7 amplifies ordinary last-ULP libm disagreement
// between this build's exp/log/sin and V8's by ~5,000,000x (h's own -13 to
// -14 decade), which the engine's differential probe (wasm/js/archcore.js
// verifyProgram, 24 FIXED sample points) cannot reliably catch for every
// expression shape -- only for ones whose probe samples happen to land near a
// value where wasm and JS already disagree. Shifted/scaled arguments (e.g.
// psi(x+50), psi(x-3)) routinely evade all 24 fixed points and were measured
// live to pass verification while differing from JS by up to ~1.3e-7 relative
// -- see wasm/tests/advfuncs-diff.mjs and wasm/tests/browser/advfuncs.js for
// the regression checks that pin this down. Kept here, unused, as a faithful
// reference translation and in case a future core-side fix (e.g. JS-exact
// exp/log/sin in JsMath.h, or a probe that samples near each program's own
// argument range instead of 24 fixed points -- both [CORE] changes) makes it
// safe to re-enable.
[[maybe_unused]] double fnPsi(double numInput) {
    if (isNaN(numInput)) return kNaN;
    // Dead in the original (a negative dividend's JS `%` can never exceed 1),
    // reproduced anyway for fidelity.
    if (numInput < 0.0 && std::fmod(numInput, 2.0) > 1.0) return kNaN;
    double ram48 = std::log(gammaCore(numInput + 0.0000001));
    double ram49 = std::log(gammaCore(numInput - 0.0000001));
    double ram50 = (ram48 - ram49) / 0.0000002;
    return ram50;
}

// ---- lambertw / ltw (byte-identical bodies) ----
double lambertwCore(double numInput) {
    if (isNaN(numInput)) return kNaN;
    if (numInput < -0.3698) return kNaN;
    double ram48 = 0.0;
    if (numInput > 1.0) {
        ram48 = std::log(0.367879441171 + std::sqrt(0.735758882343 * (0.367879441171 + numInput)) + 0.30406826609 * (0.367879441171 + numInput));
    } else if (numInput <= 0.0) {
        ram48 = 0.5;
    } else {
        ram48 = 0.5 * std::exp(std::log(numInput) / 3.0);
    }
    for (int i = 0; i < 6; i++) {
        if (numInput > 1.0) {
            ram48 = ram48 - (ram48 * std::log(ram48) - numInput) / (std::log(ram48) + 1.0);
        } else {
            ram48 = ram48 - (ram48 * std::exp(ram48) - numInput) / (std::exp(ram48) * (ram48 + 1.0));
        }
    }
    if (numInput > 1.0) {
        ram48 = std::log(ram48);
    }
    return ram48;
}

double fnLambertw(double input) { return lambertwCore(input); }
double fnLtw(double input) { return lambertwCore(input); }

// ---- li / expintegral: share the local Ei() helper (byte-identical in both
// bodies, up to trailing whitespace). ----
double eiCore(double numericInput) {
    if (isNaN(numericInput)) return kNaN;
    if (numericInput == 0.0) return -kInf;

    double ram41 = 0.0;
    double ram39, ram40;
    if (numericInput < 0.0) {
        ram39 = 1.5707963266948965;
        ram40 = std::atan(-numericInput);
        for (int i = 0; i < 14; i++) {
            double ram42 = 0.5 * (ram39 + ram40 + (ram39 - ram40) * kQuadX[i]);
            ram41 += kQuadW[i] * std::exp(-std::tan(ram42)) / std::tan(ram42) * (ram39 - ram40) / 2.0 * (1.0 + std::tan(ram42) * std::tan(ram42));
        }
        ram41 = -ram41;
    } else {
        ram39 = -0.09966865249116204;
        ram40 = std::atan(-numericInput);
        for (int i = 0; i < 14; i++) {
            double ram42 = 0.5 * (ram39 + ram40 + (ram39 - ram40) * kQuadX[i]);
            ram41 += kQuadW[i] * std::exp(-std::tan(ram42)) / std::tan(ram42) * (ram39 - ram40) / 2.0 * (1.0 + std::tan(ram42) * std::tan(ram42));
        }
        ram41 = -1.62281281396928 - ram41;
    }
    return ram41;
}

double fnLi(double numInput) {
    if (isNaN(numInput)) return kNaN;
    if (numInput < 1.0) {
        double ram41 = 0.0;
        for (int i = 0; i < 14; i++) {
            double ram42 = std::tan(0.5 * ((kQuadX[i] + 1.0) * std::atan(numInput)));
            ram41 += kQuadW[i] / std::log(ram42) * (1.0 + ram42 * ram42);
        }
        return ram41 * 0.5 * std::atan(numInput);
    }
    return eiCore(std::log(numInput));
}

double fnExpintegral(double numInput) {
    return eiCore(numInput);
}

// ---- sinintegral (Si, recurses once for negative input) ----
double siCore(double numericInput) {
    if (isNaN(numericInput)) return kNaN;
    double ram41;
    if (numericInput < 0.0) {
        double ram4105 = siCore(-numericInput);
        ram41 = -ram4105;
    } else if (numericInput > 21.991148575128552) {
        ram41 = kPI / 2.0 +
            std::sin(numericInput) * (
                -1.0 / JsMath::pow(numericInput, 2.0) +
                6.0 / JsMath::pow(numericInput, 4.0) -
                120.0 / JsMath::pow(numericInput, 6.0) +
                5040.0 / JsMath::pow(numericInput, 8.0)
            ) +
            std::cos(numericInput) * (
                -1.0 / numericInput +
                2.0 / JsMath::pow(numericInput, 3.0) -
                24.0 / JsMath::pow(numericInput, 5.0) +
                720.0 / JsMath::pow(numericInput, 7.0)
            );
    } else {
        ram41 = 0.0;
        for (int i = 0; i < 14; i++) {
            double ram42 = 0.5 * (numericInput + numericInput * kQuadX[i]);
            if (ram42 == 0.0) {
                ram41 += kQuadW[i] * numericInput / 2.0;
            } else {
                ram41 += kQuadW[i] * 0.5 * numericInput * std::sin(ram42) / ram42;
            }
        }
    }
    return ram41;
}

double fnSinintegral(double input) { return siCore(input); }

// ---- cosintegral (Ci, NaN for negative input, no recursion) ----
double ciCore(double numericInput) {
    if (isNaN(numericInput)) return kNaN;
    if (numericInput < 0.0) return kNaN;
    double ram41;
    if (numericInput > 21.991148575128552) {
        ram41 =
            std::cos(numericInput) * (
                -1.0 / JsMath::pow(numericInput, 2.0) +
                6.0 / JsMath::pow(numericInput, 4.0) -
                120.0 / JsMath::pow(numericInput, 6.0) +
                5040.0 / JsMath::pow(numericInput, 8.0)
            ) -
            std::sin(numericInput) * (
                -1.0 / numericInput +
                2.0 / JsMath::pow(numericInput, 3.0) -
                24.0 / JsMath::pow(numericInput, 5.0) +
                720.0 / JsMath::pow(numericInput, 7.0)
            );
    } else {
        ram41 = 0.0;
        for (int i = 0; i < 14; i++) {
            double ram42 = 0.5 * (numericInput + numericInput * kQuadX[i]);
            if (ram42 == 0.0) {
                ram41 += kQuadW[i] * numericInput / 2.0;
            } else {
                ram41 += kQuadW[i] * 0.5 * numericInput * (std::cos(ram42) - 1.0) / ram42;
            }
        }
        ram41 += std::log(numericInput);
        ram41 += 0.577215664901532;
    }
    return ram41;
}

double fnCosintegral(double input) { return ciCore(input); }

// ---- zeta (recurses at most one level deep: input<0 -> 1-input>1 (terminal);
// 0.5<input<1 -> 1-input in (0,0.5) (terminal, polynomial branch)). ----
double zetaCore(double input) {
    if (input == 1.0) return kInf;

    double ram48;
    if (input < 0.0) {
        double oneMinusInput = 1.0 - input;
        double ramzeta = gammaCore(oneMinusInput);
        double term_2pi_pow_s_minus_1 = std::exp(std::log(2.0 * kPI) * (input - 1.0));
        double sin_pi_s_div_2 = std::cos((1.0 - input) * (kPI / 2.0));
        double reflectionFactor = 2.0 * ramzeta * sin_pi_s_div_2 * term_2pi_pow_s_minus_1;

        double zetaOneMinusInput = zetaCore(oneMinusInput);
        ram48 = zetaOneMinusInput * reflectionFactor;
        return ram48;
    }
    if (input < 1.0) {
        if (input > 0.5) {
            double oneMinusInput = 1.0 - input;
            double zetaOneMinusInput = zetaCore(oneMinusInput);
            double ramzeta = gammaCore(oneMinusInput);

            double factor_2_s_pi_s_minus_1 = std::exp(kLN2 * input + std::log(kPI) * (input - 1.0));
            double sin_pi_s_div_2 = std::sin(input * (kPI / 2.0));

            ram48 = factor_2_s_pi_s_minus_1 * ramzeta * zetaOneMinusInput * sin_pi_s_div_2;
            return ram48;
        }
        ram48 = kZetaSmall[0];
        for (int i = 1; i < 26; i++) {
            ram48 = ram48 * input + kZetaSmall[i];
        }
        return ram48;
    }
    if (input < 6.0) {
        ram48 = kZetaLarge[0];
        for (int i = 1; i < 34; i++) {
            ram48 = ram48 * input + kZetaLarge[i];
        }
        ram48 = 1.0 / ram48;
        return ram48;
    }
    double ram51 = 0.0;
    double ram46 = 1.0;
    double ram37 = 1.0;
    double limit = std::ceil(75.0 / input) + 2.0;
    for (double i = 1.0; i < limit; i += 1.0) {
        ram51 += ram37 / JsMath::pow(ram46, input);
        ram46 += 1.0;
        ram37 = -ram37;
    }
    ram48 = ram51 / (1.0 - JsMath::pow(2.0, 1.0 - input));
    return ram48;
}

double fnZeta(double input) { return zetaCore(input); }

// ---- range / llim / ulim ----
double fnRange(double x, double m, double n) {
    if (x < m || x > n) return kNaN;
    return 0.0;
}

double fnLlim(double x, double n) {
    if (x < n) return kNaN;
    return 0.0;
}

double fnUlim(double x, double n) {
    if (x > n) return kNaN;
    return 0.0;
}

constexpr AdvancedFunction kFunctions[] = {
    {"gamma", 1, fnGamma, nullptr, nullptr},
    {"erf", 1, fnErf, nullptr, nullptr},
    {"erfc", 1, fnErfc, nullptr, nullptr},
    {"elliptice", 1, fnElliptice, nullptr, nullptr},
    {"elliptick", 1, fnElliptick, nullptr, nullptr},
    {"sign", 1, fnSign, nullptr, nullptr},
    {"sgn", 1, fnSign, nullptr, nullptr},
    {"heaviside", 1, fnHeaviside, nullptr, nullptr},
    {"fresnels", 1, fnFresnels, nullptr, nullptr},
    {"fresnelc", 1, fnFresnelc, nullptr, nullptr},
    // "psi" deliberately omitted: see the comment on fnPsi above. Compiling
    // any expression containing adv.psi now fails in ExprProgram::lower()
    // ("unsupported function: adv.psi"), so programFor() deterministically
    // and unconditionally returns null for it -- guaranteeing the correct
    // JS-path result instead of depending on the runtime probe's 24 fixed
    // sample points, which do not cover every shifted/scaled argument.
    {"lambertw", 1, fnLambertw, nullptr, nullptr},
    {"ltw", 1, fnLtw, nullptr, nullptr},
    {"li", 1, fnLi, nullptr, nullptr},
    {"zeta", 1, fnZeta, nullptr, nullptr},
    {"sinintegral", 1, fnSinintegral, nullptr, nullptr},
    {"cosintegral", 1, fnCosintegral, nullptr, nullptr},
    {"expintegral", 1, fnExpintegral, nullptr, nullptr},
    {"llim", 2, nullptr, fnLlim, nullptr},
    {"ulim", 2, nullptr, fnUlim, nullptr},
    {"range", 3, nullptr, nullptr, fnRange},
};

} // namespace

const AdvancedFunction* findAdvancedFunction(const char* name) {
    if (!name) return nullptr;
    for (const AdvancedFunction& f : kFunctions) {
        if (std::strcmp(f.name, name) == 0) return &f;
    }
    return nullptr;
}

int advancedFunctionCount() { return static_cast<int>(sizeof(kFunctions) / sizeof(kFunctions[0])); }

const char* advancedFunctionNameAt(int index) {
    if (index < 0 || index >= advancedFunctionCount()) return nullptr;
    return kFunctions[index].name;
}

} // namespace Core
} // namespace ArchMaths
