#pragma once

// Registry for ports of the page's built-in "advanced" functions
// (ADVANCED_FUNCTION_DEFINITIONS: gamma, erf, zeta, ...). `pow` is handled by
// the VM directly. Implementations live in core/kernels/advfuncs.cpp; builds
// without it fall back to the weak default that knows no functions, and the
// page then keeps those expressions on its JS path.

namespace ArchMaths {
namespace Core {

struct AdvancedFunction {
    const char* name;
    int arity;                                  // 1..3
    double (*fn1)(double);
    double (*fn2)(double, double);
    double (*fn3)(double, double, double);
};

// Returns nullptr for unknown names. `name` excludes the "adv." prefix.
const AdvancedFunction* findAdvancedFunction(const char* name);

// Enumeration of every registered name (used by the CalcJs tokenizer to
// split advanced function calls before the constant pass). Builds without
// core/kernels/advfuncs.cpp get an empty list.
int advancedFunctionCount();
const char* advancedFunctionNameAt(int index);

} // namespace Core
} // namespace ArchMaths
