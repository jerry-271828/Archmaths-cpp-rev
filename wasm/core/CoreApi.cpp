#include "CoreApi.h"

#include "CalcJsCompiler.h"

#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>

namespace ArchMaths {
namespace Core {

namespace {
std::vector<std::unique_ptr<Program>> g_programs;
std::vector<int> g_freeHandles;
std::string g_lastError;
std::vector<double> g_laneScratch;
} // namespace

Program* programFromHandle(int handle) {
    if (handle <= 0 || handle > static_cast<int>(g_programs.size())) return nullptr;
    return g_programs[handle - 1].get();
}

} // namespace Core
} // namespace ArchMaths

using namespace ArchMaths::Core;

// Bumped whenever the ABI below changes; the page refuses mismatched binaries.
// v2: adds the CalcJs scalar-evaluate ABI (ac_calc_compile / ac_calc_eval1).
ARCHCORE_EXPORT(ac_abi_version) int ac_abi_version() { return 2; }

ARCHCORE_EXPORT(ac_alloc) void* ac_alloc(int bytes) { return std::malloc(bytes > 0 ? static_cast<size_t>(bytes) : 1); }
ARCHCORE_EXPORT(ac_free) void ac_free(void* ptr) { std::free(ptr); }

// names: arg names followed by param names, separated by '\n'. The first
// nArgs names are lane inputs. Returns a handle > 0, or 0 with ac_error_*.
ARCHCORE_EXPORT(ac_compile) int ac_compile(const char* src, int srcLen, const char* names, int namesLen, int nArgs) {
    std::vector<std::string> args;
    std::vector<std::string> params;
    std::string all(names ? names : "", names ? static_cast<size_t>(namesLen) : 0);
    size_t pos = 0;
    int index = 0;
    while (!all.empty() && pos <= all.size()) {
        size_t nl = all.find('\n', pos);
        std::string name = all.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
        (index < nArgs ? args : params).push_back(name);
        ++index;
        if (nl == std::string::npos) break;
        pos = nl + 1;
    }
    if (nArgs > 8 || static_cast<int>(args.size()) != nArgs) {
        g_lastError = "bad argument list";
        return 0;
    }

    auto program = std::make_unique<Program>();
    if (!program->compile(std::string(src, static_cast<size_t>(srcLen)), args, params)) {
        g_lastError = program->error();
        return 0;
    }
    g_lastError.clear();
    if (!g_freeHandles.empty()) {
        int h = g_freeHandles.back();
        g_freeHandles.pop_back();
        g_programs[h - 1] = std::move(program);
        return h;
    }
    g_programs.push_back(std::move(program));
    return static_cast<int>(g_programs.size());
}

ARCHCORE_EXPORT(ac_error_ptr) const char* ac_error_ptr() { return g_lastError.c_str(); }
ARCHCORE_EXPORT(ac_error_len) int ac_error_len() { return static_cast<int>(g_lastError.size()); }

// CalcJs scalar path (ABI v2). names/userFns use the same '\n'-separated
// layout as ac_compile; the first nArgs names are lane inputs (0 for the
// scalar use case — every variable is a uniform parameter, so the args<=8
// limit does not apply). userFns carries the page's simple custom functions,
// one per line, as "name|p1,p2|body" where body is the page's stored
// bodyTokens joined by single spaces (page-faithful tokenization, see
// wasm/js/kernels/calc.js); an empty string means none. integralSteps is the
// trapezoid step count for int(f,x,a,b) (page: calcJSUtils.integralNumSteps).
// Returns a handle > 0, or 0 with ac_error_*.
ARCHCORE_EXPORT(ac_calc_compile) int ac_calc_compile(const char* src, int srcLen,
                                                     const char* names, int namesLen, int nArgs,
                                                     const char* userFns, int userFnsLen,
                                                     double integralSteps) {
    std::vector<std::string> args;
    std::vector<std::string> params;
    std::string all(names ? names : "", names ? static_cast<size_t>(namesLen) : 0);
    size_t pos = 0;
    int index = 0;
    while (!all.empty() && pos <= all.size()) {
        size_t nl = all.find('\n', pos);
        std::string name = all.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
        (index < nArgs ? args : params).push_back(name);
        ++index;
        if (nl == std::string::npos) break;
        pos = nl + 1;
    }
    if (nArgs > 8 || static_cast<int>(args.size()) != nArgs) {
        g_lastError = "bad argument list";
        return 0;
    }

    std::vector<CalcJsUserFn> fns;
    std::string fnsText(userFns ? userFns : "", userFns ? static_cast<size_t>(userFnsLen) : 0);
    pos = 0;
    while (pos < fnsText.size()) {
        size_t nl = fnsText.find('\n', pos);
        std::string record = fnsText.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
        pos = nl == std::string::npos ? fnsText.size() : nl + 1;
        if (record.empty()) continue;
        size_t p1 = record.find('|');
        size_t p2 = p1 == std::string::npos ? std::string::npos : record.find('|', p1 + 1);
        if (p1 == std::string::npos || p2 == std::string::npos) {
            g_lastError = "bad userFns record";
            return 0;
        }
        CalcJsUserFn fn;
        fn.name = record.substr(0, p1);
        std::string plist = record.substr(p1 + 1, p2 - p1 - 1);
        std::string body = record.substr(p2 + 1);
        size_t q = 0;
        while (q < plist.size()) {
            size_t comma = plist.find(',', q);
            fn.params.push_back(plist.substr(q, comma == std::string::npos ? std::string::npos : comma - q));
            if (comma == std::string::npos) break;
            q = comma + 1;
        }
        // body: page bodyTokens joined by single spaces; tokens never contain
        // whitespace, so splitting on runs of spaces restores them verbatim.
        std::string tok;
        for (size_t k = 0; k <= body.size(); ++k) {
            if (k == body.size() || body[k] == ' ' || body[k] == '\t') {
                if (!tok.empty()) {
                    fn.bodyTokens.push_back(tok);
                    tok.clear();
                }
            } else {
                tok += body[k];
            }
        }
        fns.push_back(std::move(fn));
    }

    auto program = std::make_unique<Program>();
    if (!program->compileCalcJs(std::string(src, static_cast<size_t>(srcLen)), args, params,
                                fns, integralSteps)) {
        g_lastError = program->error();
        return 0;
    }
    g_lastError.clear();
    if (!g_freeHandles.empty()) {
        int h = g_freeHandles.back();
        g_freeHandles.pop_back();
        g_programs[h - 1] = std::move(program);
        return h;
    }
    g_programs.push_back(std::move(program));
    return static_cast<int>(g_programs.size());
}

// Single-point evaluation of a compiled ac_calc_compile program with no lane
// inputs (the scalar use case): parameters are uploaded via ac_set_params.
// NaN for unknown/released handles.
ARCHCORE_EXPORT(ac_calc_eval1) double ac_calc_eval1(int handle) {
    Program* p = programFromHandle(handle);
    if (!p || p->argCount() != 0) return std::numeric_limits<double>::quiet_NaN();
    return p->evaluateOne(nullptr, 0);
}

ARCHCORE_EXPORT(ac_release) void ac_release(int handle) {
    if (!programFromHandle(handle)) return;
    g_programs[handle - 1].reset();
    g_freeHandles.push_back(handle);
}

// what: 0 = body instruction count, 1 = prologue count, 2 = bitmask of used args
ARCHCORE_EXPORT(ac_program_info) int ac_program_info(int handle, int what) {
    Program* p = programFromHandle(handle);
    if (!p) return -1;
    switch (what) {
        case 0: return static_cast<int>(p->instructionCount());
        case 1: return static_cast<int>(p->prologueCount());
        case 2: {
            int mask = 0;
            for (int k = 0; k < p->argCount(); ++k) if (p->usesArg(k)) mask |= 1 << k;
            return mask;
        }
        default: return -1;
    }
}

ARCHCORE_EXPORT(ac_set_params) void ac_set_params(int handle, const double* values, int count) {
    if (Program* p = programFromHandle(handle)) p->setParams(values, count);
}

// argPtrs: argCount() pointers (wasm32 addresses) to n doubles each.
ARCHCORE_EXPORT(ac_eval) int ac_eval(int handle, const double* const* argPtrs, int n, double* out, int flags) {
    Program* p = programFromHandle(handle);
    if (!p || n < 0) return 0;
    p->evaluate(argPtrs, n, out, flags);
    return 1;
}

// Lane k of arg j is base_j + step_j * ((k / div_j) % mod_j), with spec laid
// out as argCount() rows of {base, step, div, mod}. Covers 1-D sweeps and
// row-major 2-D/3-D grids without materialising coordinate arrays in JS.
ARCHCORE_EXPORT(ac_eval_affine) int ac_eval_affine(int handle, const double* spec, int n, double* out, int flags) {
    Program* p = programFromHandle(handle);
    if (!p || n < 0) return 0;
    const int argc = p->argCount();
    g_laneScratch.resize(static_cast<size_t>(argc) * kBlock);
    const double* lanes[8] = {nullptr};
    for (int start = 0; start < n; start += kBlock) {
        const int m = n - start < kBlock ? n - start : kBlock;
        for (int j = 0; j < argc; ++j) {
            if (!p->usesArg(j)) { lanes[j] = nullptr; continue; }
            double* dst = g_laneScratch.data() + static_cast<size_t>(j) * kBlock;
            const double base = spec[j * 4 + 0];
            const double step = spec[j * 4 + 1];
            const long long div = spec[j * 4 + 2] >= 1 ? static_cast<long long>(spec[j * 4 + 2]) : 1;
            const long long mod = spec[j * 4 + 3] >= 1 ? static_cast<long long>(spec[j * 4 + 3]) : (1LL << 62);
            for (int i = 0; i < m; ++i) {
                const long long k = start + i;
                dst[i] = base + step * static_cast<double>((k / div) % mod);
            }
            lanes[j] = dst;
        }
        p->evaluate(lanes, m, out + start, flags);
    }
    return 1;
}
