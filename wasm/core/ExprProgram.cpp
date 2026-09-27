#include "ExprProgram.h"

#include "AdvancedRegistry.h"
#include "CalcJsCompiler.h"
#include "JsMath.h"
#include "math/ExpressionParser.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>
#include <tuple>

namespace ArchMaths {
namespace Core {

namespace {

struct FnInfo {
    const char* name;
    Fn fn;
    int arity;      // 1 or 2; 0 = n-ary fold (min/max)
};

// Math.* members the page's transpiler can emit (calc1) plus a few safe extras.
const FnInfo kMathFunctions[] = {
    {"sin", Fn::Sin, 1}, {"cos", Fn::Cos, 1}, {"tan", Fn::Tan, 1},
    {"asin", Fn::Asin, 1}, {"acos", Fn::Acos, 1}, {"atan", Fn::Atan, 1},
    {"sinh", Fn::Sinh, 1}, {"cosh", Fn::Cosh, 1}, {"tanh", Fn::Tanh, 1},
    {"asinh", Fn::Asinh, 1}, {"acosh", Fn::Acosh, 1}, {"atanh", Fn::Atanh, 1},
    {"exp", Fn::Exp, 1}, {"expm1", Fn::Expm1, 1}, {"log", Fn::Log, 1},
    {"log10", Fn::Log10, 1}, {"log2", Fn::Log2, 1}, {"log1p", Fn::Log1p, 1},
    {"sqrt", Fn::Sqrt, 1}, {"cbrt", Fn::Cbrt, 1}, {"abs", Fn::Abs, 1},
    {"floor", Fn::Floor, 1}, {"ceil", Fn::Ceil, 1}, {"round", Fn::Round, 1},
    {"trunc", Fn::Trunc, 1}, {"sign", Fn::Sign, 1}, {"fround", Fn::Fround, 1},
    {"pow", Fn::Pow, 2}, {"atan2", Fn::Atan2, 2}, {"hypot", Fn::Hypot, 2},
    {"min", Fn::Min, 0}, {"max", Fn::Max, 0},
};

inline double unaryScalar(Fn fn, double v) {
    switch (fn) {
        case Fn::Sin: return std::sin(v);
        case Fn::Cos: return std::cos(v);
        case Fn::Tan: return std::tan(v);
        case Fn::Asin: return std::asin(v);
        case Fn::Acos: return std::acos(v);
        case Fn::Atan: return std::atan(v);
        case Fn::Sinh: return std::sinh(v);
        case Fn::Cosh: return std::cosh(v);
        case Fn::Tanh: return std::tanh(v);
        case Fn::Asinh: return std::asinh(v);
        case Fn::Acosh: return std::acosh(v);
        case Fn::Atanh: return std::atanh(v);
        case Fn::Exp: return std::exp(v);
        case Fn::Expm1: return std::expm1(v);
        case Fn::Log: return std::log(v);
        case Fn::Log10: return std::log10(v);
        case Fn::Log2: return std::log2(v);
        case Fn::Log1p: return std::log1p(v);
        case Fn::Sqrt: return std::sqrt(v);
        case Fn::Cbrt: return std::cbrt(v);
        case Fn::Abs: return std::fabs(v);
        case Fn::Floor: return std::floor(v);
        case Fn::Ceil: return std::ceil(v);
        case Fn::Round: return JsMath::round(v);
        case Fn::Trunc: return std::trunc(v);
        case Fn::Sign: return JsMath::sign(v);
        case Fn::Fround: return static_cast<double>(static_cast<float>(v));
        default: return JsMath::kNaN;
    }
}

inline double binaryScalar(Fn fn, double a, double b, int flags) {
    switch (fn) {
        case Fn::Pow: return JsMath::pow(a, b);
        case Fn::AdvPow:
            return (flags & kFlagStrictPow) ? JsMath::advancedPowStrict(a, b) : JsMath::advancedPow(a, b);
        case Fn::Atan2: return JsMath::atan2(a, b);
        case Fn::Min: return JsMath::min(a, b);
        case Fn::Max: return JsMath::max(a, b);
        case Fn::Hypot: return JsMath::hypot(a, b);
        default: return JsMath::kNaN;
    }
}

inline double basicScalarOp(Op op, Fn fn, double a, double b, int flags) {
    switch (op) {
        case Op::Add: return a + b;
        case Op::Sub: return a - b;
        case Op::Mul: return a * b;
        case Op::Div: return a / b;
        case Op::Neg: return -a;
        case Op::Call1: return unaryScalar(fn, a);
        case Op::Call2: return binaryScalar(fn, a, b, flags);
        default: return JsMath::kNaN;
    }
}

inline double advancedScalar(const AdvancedFunction* f, Op op, double a, double b, double c) {
    switch (op) {
        case Op::Adv1: return f->fn1(a);
        case Op::Adv2: return f->fn2(a, b);
        case Op::Adv3: return f->fn3(a, b, c);
        default: return JsMath::kNaN;
    }
}

struct Src {
    const double* p;
    double s;
    bool scalar;
};

template <class F>
inline void binaryLoop(double* o, Src a, Src b, int m, F f) {
    if (a.scalar) {
        const double s = a.s;
        const double* pb = b.p;
        for (int i = 0; i < m; ++i) o[i] = f(s, pb[i]);
    } else if (b.scalar) {
        const double s = b.s;
        const double* pa = a.p;
        for (int i = 0; i < m; ++i) o[i] = f(pa[i], s);
    } else {
        const double* pa = a.p;
        const double* pb = b.p;
        for (int i = 0; i < m; ++i) o[i] = f(pa[i], pb[i]);
    }
}

template <class F>
inline void unaryLoop(double* o, const double* a, int m, F f) {
    for (int i = 0; i < m; ++i) o[i] = f(a[i]);
}

void runUnary(Fn fn, double* o, const double* a, int m) {
    switch (fn) {
        case Fn::Sin: unaryLoop(o, a, m, [](double v) { return std::sin(v); }); break;
        case Fn::Cos: unaryLoop(o, a, m, [](double v) { return std::cos(v); }); break;
        case Fn::Tan: unaryLoop(o, a, m, [](double v) { return std::tan(v); }); break;
        case Fn::Asin: unaryLoop(o, a, m, [](double v) { return std::asin(v); }); break;
        case Fn::Acos: unaryLoop(o, a, m, [](double v) { return std::acos(v); }); break;
        case Fn::Atan: unaryLoop(o, a, m, [](double v) { return std::atan(v); }); break;
        case Fn::Sinh: unaryLoop(o, a, m, [](double v) { return std::sinh(v); }); break;
        case Fn::Cosh: unaryLoop(o, a, m, [](double v) { return std::cosh(v); }); break;
        case Fn::Tanh: unaryLoop(o, a, m, [](double v) { return std::tanh(v); }); break;
        case Fn::Asinh: unaryLoop(o, a, m, [](double v) { return std::asinh(v); }); break;
        case Fn::Acosh: unaryLoop(o, a, m, [](double v) { return std::acosh(v); }); break;
        case Fn::Atanh: unaryLoop(o, a, m, [](double v) { return std::atanh(v); }); break;
        case Fn::Exp: unaryLoop(o, a, m, [](double v) { return std::exp(v); }); break;
        case Fn::Expm1: unaryLoop(o, a, m, [](double v) { return std::expm1(v); }); break;
        case Fn::Log: unaryLoop(o, a, m, [](double v) { return std::log(v); }); break;
        case Fn::Log10: unaryLoop(o, a, m, [](double v) { return std::log10(v); }); break;
        case Fn::Log2: unaryLoop(o, a, m, [](double v) { return std::log2(v); }); break;
        case Fn::Log1p: unaryLoop(o, a, m, [](double v) { return std::log1p(v); }); break;
        case Fn::Sqrt: unaryLoop(o, a, m, [](double v) { return std::sqrt(v); }); break;
        case Fn::Cbrt: unaryLoop(o, a, m, [](double v) { return std::cbrt(v); }); break;
        case Fn::Abs: unaryLoop(o, a, m, [](double v) { return std::fabs(v); }); break;
        case Fn::Floor: unaryLoop(o, a, m, [](double v) { return std::floor(v); }); break;
        case Fn::Ceil: unaryLoop(o, a, m, [](double v) { return std::ceil(v); }); break;
        case Fn::Round: unaryLoop(o, a, m, [](double v) { return JsMath::round(v); }); break;
        case Fn::Trunc: unaryLoop(o, a, m, [](double v) { return std::trunc(v); }); break;
        case Fn::Sign: unaryLoop(o, a, m, [](double v) { return JsMath::sign(v); }); break;
        case Fn::Fround: unaryLoop(o, a, m, [](double v) { return static_cast<double>(static_cast<float>(v)); }); break;
        default: unaryLoop(o, a, m, [](double) { return JsMath::kNaN; }); break;
    }
}

void runBinaryFn(Fn fn, double* o, Src a, Src b, int m, int flags) {
    switch (fn) {
        case Fn::Pow: binaryLoop(o, a, b, m, [](double x, double y) { return JsMath::pow(x, y); }); break;
        case Fn::AdvPow:
            if (flags & kFlagStrictPow) {
                binaryLoop(o, a, b, m, [](double x, double y) { return JsMath::advancedPowStrict(x, y); });
            } else {
                binaryLoop(o, a, b, m, [](double x, double y) { return JsMath::advancedPow(x, y); });
            }
            break;
        case Fn::Atan2: binaryLoop(o, a, b, m, [](double x, double y) { return JsMath::atan2(x, y); }); break;
        case Fn::Min: binaryLoop(o, a, b, m, [](double x, double y) { return JsMath::min(x, y); }); break;
        case Fn::Max: binaryLoop(o, a, b, m, [](double x, double y) { return JsMath::max(x, y); }); break;
        case Fn::Hypot: binaryLoop(o, a, b, m, [](double x, double y) { return JsMath::hypot(x, y); }); break;
        default: binaryLoop(o, a, b, m, [](double, double) { return JsMath::kNaN; }); break;
    }
}

bool isUnaryOp(Op op) { return op == Op::Neg || op == Op::Call1 || op == Op::Adv1; }
int operandCount(Op op) {
    if (isUnaryOp(op)) return 1;
    return (op == Op::Adv3 || op == Op::Loop) ? 3 : 2;
}

// Loops over more lanes than this are left to the JS path (which would take
// seconds per point anyway).
constexpr double kMaxLoopLanes = 1000000.0;

uint64_t bitsOf(double v) {
    uint64_t bits;
    std::memcpy(&bits, &v, sizeof bits);
    return bits;
}

} // namespace

// Builds without core/kernels/advfuncs.cpp know no advanced functions.
__attribute__((weak)) const AdvancedFunction* findAdvancedFunction(const char*) { return nullptr; }
__attribute__((weak)) int advancedFunctionCount() { return 0; }
__attribute__((weak)) const char* advancedFunctionNameAt(int) { return nullptr; }

double Program::scalarOp(const Node& n, double a, double b, double c, int flags) const {
    if (n.op == Op::Adv1 || n.op == Op::Adv2 || n.op == Op::Adv3) return advancedScalar(advTable_[n.adv], n.op, a, b, c);
    return basicScalarOp(n.op, n.fn, a, b, flags);
}

double Program::scalarOp(const Instr& in, double a, double b, double c, int flags) const {
    if (in.op == Op::Adv1 || in.op == Op::Adv2 || in.op == Op::Adv3) return advancedScalar(advTable_[in.adv], in.op, a, b, c);
    return basicScalarOp(in.op, in.fn, a, b, flags);
}

bool Program::fail(const std::string& message) {
    if (error_.empty()) error_ = message;
    return false;
}

int Program::intern(Node node) {
    // Linear probing over existing nodes is fine: programs are small and this
    // runs once per compile. Constants compare by bit pattern (-0 vs 0, NaN).
    for (size_t i = 0; i < nodes_.size(); ++i) {
        const Node& n = nodes_[i];
        if (n.kind != node.kind) continue;
        switch (n.kind) {
            case Node::Const:
                if (bitsOf(n.value) == bitsOf(node.value)) return static_cast<int>(i);
                break;
            case Node::Arg:
            case Node::Param:
                if (n.index == node.index) return static_cast<int>(i);
                break;
            case Node::Operation:
                if (n.op == node.op && n.fn == node.fn && n.a == node.a && n.b == node.b &&
                    n.c == node.c && n.adv == node.adv) return static_cast<int>(i);
                break;
        }
    }
    nodes_.push_back(node);
    return static_cast<int>(nodes_.size() - 1);
}

int Program::makeConst(double v) {
    Node n;
    n.kind = Node::Const;
    n.value = v;
    n.uniform = true;
    return intern(n);
}

int Program::makeOp(Op op, Fn fn, int a, int b, int c, int adv) {
    const int count = operandCount(op);
    Node n;
    n.kind = Node::Operation;
    n.op = op;
    n.fn = fn;
    n.a = a;
    n.b = count >= 2 ? b : -1;
    n.c = count >= 3 ? c : -1;
    n.adv = adv;
    const int kids[3] = {n.a, n.b, n.c};
    bool allConst = true;
    n.uniform = true;
    for (int k = 0; k < count; ++k) {
        allConst = allConst && nodes_[kids[k]].kind == Node::Const;
        n.uniform = n.uniform && nodes_[kids[k]].uniform;
    }
    // Fold constants, except `pow` whose meaning depends on the per-call flag
    // and loops (evaluated by the prologue).
    if (allConst && fn != Fn::AdvPow && op != Op::Loop) {
        const double va = nodes_[n.a].value;
        const double vb = count >= 2 ? nodes_[n.b].value : 0.0;
        const double vc = count >= 3 ? nodes_[n.c].value : 0.0;
        return makeConst(scalarOp(n, va, vb, vc, 0));
    }
    return intern(n);
}

int Program::lower(const ExprNodePtr& node) {
    if (!node) {
        fail("empty node");
        return -1;
    }
    switch (node->type) {
        case NodeType::Number:
            return makeConst(node->value);

        case NodeType::Variable: {
            for (int k = 0; k < argCount_; ++k) {
                if (argNames_[k] == node->name) {
                    argUsed_[k] = true;
                    Node n;
                    n.kind = Node::Arg;
                    n.index = k;
                    n.uniform = false;
                    return intern(n);
                }
            }
            for (size_t k = 0; k < paramNames_.size(); ++k) {
                if (paramNames_[k] == node->name) {
                    paramUsed_[k] = true;
                    Node n;
                    n.kind = Node::Param;
                    n.index = static_cast<int>(k);
                    n.uniform = true;
                    return intern(n);
                }
            }
            fail("unknown identifier: " + node->name);
            return -1;
        }

        case NodeType::BinaryOp: {
            int a = lower(node->left);
            if (a < 0) return -1;
            int b = lower(node->right);
            if (b < 0) return -1;
            if (node->op == "+") return makeOp(Op::Add, Fn::None, a, b);
            if (node->op == "-") return makeOp(Op::Sub, Fn::None, a, b);
            if (node->op == "*") return makeOp(Op::Mul, Fn::None, a, b);
            if (node->op == "/") return makeOp(Op::Div, Fn::None, a, b);
            fail("unsupported operator: " + node->op);
            return -1;
        }

        case NodeType::UnaryOp: {
            int a = lower(node->left);
            if (a < 0) return -1;
            if (node->op == "-") return makeOp(Op::Neg, Fn::None, a, -1);
            if (node->op == "+") return a;
            fail("unsupported unary operator: " + node->op);
            return -1;
        }

        case NodeType::Function: {
            if (node->name == "__archsum") return lowerLoop(node, Loop::Sum);
            if (node->name == "__archprod") return lowerLoop(node, Loop::Prod);
            if (node->name == "__archint") return lowerLoop(node, Loop::Integral);
            std::vector<int> args;
            for (const auto& arg : node->args) {
                int v = lower(arg);
                if (v < 0) return -1;
                args.push_back(v);
            }
            // Missing JS arguments are `undefined`, which converts to NaN.
            auto argOrNaN = [&](size_t i) { return i < args.size() ? args[i] : makeConst(JsMath::kNaN); };

            if (node->name == "adv.pow") {
                return makeOp(Op::Call2, Fn::AdvPow, argOrNaN(0), argOrNaN(1));
            }
            if (node->name.compare(0, 4, "adv.") == 0) {
                const AdvancedFunction* f = findAdvancedFunction(node->name.c_str() + 4);
                if (!f || f->arity < 1 || f->arity > 3) {
                    fail("unsupported function: " + node->name);
                    return -1;
                }
                int index = -1;
                for (size_t i = 0; i < advTable_.size(); ++i) {
                    if (advTable_[i] == f) index = static_cast<int>(i);
                }
                if (index < 0) {
                    index = static_cast<int>(advTable_.size());
                    advTable_.push_back(f);
                }
                const Op op = f->arity == 1 ? Op::Adv1 : (f->arity == 2 ? Op::Adv2 : Op::Adv3);
                return makeOp(op, Fn::None, argOrNaN(0), argOrNaN(1), argOrNaN(2), index);
            }
            for (const FnInfo& info : kMathFunctions) {
                if (node->name != info.name) continue;
                if (info.arity == 1) return makeOp(Op::Call1, info.fn, argOrNaN(0), -1);
                if (info.arity == 2) {
                    if (info.fn == Fn::Hypot && args.size() > 2) break;
                    return makeOp(Op::Call2, info.fn, argOrNaN(0), argOrNaN(1));
                }
                // n-ary min/max: Math.max() is -Infinity, Math.min() is +Infinity.
                if (args.empty()) return makeConst(info.fn == Fn::Max ? -JsMath::kInf : JsMath::kInf);
                int acc = args[0];
                if (args.size() == 1) {
                    // Math.max(v) is v, but still converts via ToNumber: identity for numbers.
                    return acc;
                }
                for (size_t i = 1; i < args.size(); ++i) acc = makeOp(Op::Call2, info.fn, acc, args[i]);
                return acc;
            }
            fail("unsupported function: " + node->name);
            return -1;
        }

        default:
            fail("unsupported node");
            return -1;
    }
}

int Program::lowerLoop(const ExprNodePtr& node, Loop::Kind kind) {
    // Math.__archsum(body, var, start, end) / __archprod(...) /
    // Math.__archint(body, var, a, b, steps): emitted by the page's
    // recompileFunctions() in place of its sum/prod/int IIFEs.
    const size_t expected = kind == Loop::Integral ? 5 : 4;
    if (node->args.size() != expected || !node->args[1] || node->args[1]->type != NodeType::Variable) {
        fail("malformed large operator");
        return -1;
    }
    const int start = lower(node->args[2]);
    if (start < 0) return -1;
    const int end = lower(node->args[3]);
    if (end < 0) return -1;
    const int steps = kind == Loop::Integral ? lower(node->args[4]) : makeConst(0.0);
    if (steps < 0) return -1;
    if (kind == Loop::Integral && nodes_[steps].kind != Node::Const) {
        fail("integral step count must be constant");
        return -1;
    }

    // Body sees: loop variable (lane input), then this program's args and
    // params as uniforms. Lookup order makes the loop variable shadow them,
    // like the JS `let`.
    std::vector<std::string> subParams = argNames_;
    subParams.insert(subParams.end(), paramNames_.begin(), paramNames_.end());
    Loop loop;
    loop.kind = kind;
    loop.body.reset(new Program());
    if (!loop.body->compileAst(node->args[0], {node->args[1]->name}, subParams, calcJsMode_)) {
        fail(loop.body->error());
        return -1;
    }
    for (int k = 0; k < argCount_; ++k) {
        if (loop.body->usesParam(k)) {
            loop.usesLaneArgs = true;
            argUsed_[k] = true;
        }
    }
    for (size_t k = 0; k < paramNames_.size(); ++k) {
        if (loop.body->usesParam(argCount_ + static_cast<int>(k))) paramUsed_[k] = true;
    }
    const bool usesLanes = loop.usesLaneArgs;
    loops_.push_back(std::move(loop));
    const int index = static_cast<int>(loops_.size() - 1);

    Node n;
    n.kind = Node::Operation;
    n.op = Op::Loop;
    n.fn = Fn::None;
    n.a = start;
    n.b = end;
    n.c = steps;
    n.adv = index;
    n.uniform = !usesLanes && nodes_[start].uniform && nodes_[end].uniform;
    // Never hash-cons loops: each owns its body program.
    nodes_.push_back(n);
    return static_cast<int>(nodes_.size() - 1);
}

double Program::evalLoop(int index, double start, double end, double steps, const double* laneArgs, int flags) {
    Loop& loop = loops_[index];
    loopLanes_.clear();
    double initial = 0.0;
    if (loop.kind == Loop::Integral) {
        // let __h = (__b - __a) / __n; if (Math.abs(__h) < 1e-15) return 0;
        const double a = start;
        const double b = end;
        if (calcJsMode_ && (!JsMath::isFinite(a) || !JsMath::isFinite(b))) {
            // the page throws "范围必须是有效数字" for non-finite bounds
            return JsMath::kNaN;
        }
        const double h = (b - a) / steps;
        if (std::fabs(h) < 1e-15) return 0.0;
        if (!(steps < kMaxLoopLanes)) return JsMath::kNaN;
        if (calcJsMode_) {
            // Page scalar path: for (k = 0; k <= N; k++) x = a + k*h, with the
            // 0.5 weight on k==0 and on k==N exactly (the final sample is a+N*h,
            // not b, so a rounding-different b must not be substituted).
            for (double k = 0.0; k <= steps; k++) {
                loopLanes_.push_back(a + k * h);
                if (k + 1 == k || loopLanes_.size() > static_cast<size_t>(kMaxLoopLanes)) {
                    return JsMath::kNaN;  // JS would never terminate
                }
            }
        } else {
            loopLanes_.push_back(a);
            for (double i = 1; i < steps; i++) loopLanes_.push_back(a + i * h);
            loopLanes_.push_back(b);
        }
    } else {
        // let __s = Math.round(start); let __e = Math.round(end);
        // if (Math.abs(__e - __s) > 50000) return 0; for (k = __s; k <= __e; k++)
        const double s = JsMath::round(start);
        const double e = JsMath::round(end);
        if (calcJsMode_) {
            // Page scalar path (evaluateScopedExpression): non-finite bounds or
            // more than 1e6 iterations throw (NaN at every call site); an empty
            // interval yields the identity (0 for sum, 1 for prod).
            if (!JsMath::isFinite(s) || !JsMath::isFinite(e)) return JsMath::kNaN;
            if (std::fabs(e - s) > 1000000.0) return JsMath::kNaN;
        } else if (std::fabs(e - s) > 50000) {
            return 0.0;
        }
        initial = loop.kind == Loop::Sum ? 0.0 : 1.0;
        const size_t maxLanes = calcJsMode_ ? 1000001 : 50001;
        for (double k = s; k <= e; k++) {
            loopLanes_.push_back(k);
            if (k + 1 == k || loopLanes_.size() > maxLanes) return JsMath::kNaN;  // JS would never terminate
        }
        if (loopLanes_.empty()) return initial;
    }

    Program& body = *loop.body;
    loopParams_.resize(static_cast<size_t>(argCount_) + params_.size());
    for (int k = 0; k < argCount_; ++k) loopParams_[k] = laneArgs ? laneArgs[k] : JsMath::kNaN;
    for (size_t k = 0; k < params_.size(); ++k) loopParams_[argCount_ + k] = params_[k];
    body.setParams(loopParams_.data(), static_cast<int>(loopParams_.size()));

    const int n = static_cast<int>(loopLanes_.size());
    loopOut_.resize(static_cast<size_t>(n));
    const double* lanes[1] = {loopLanes_.data()};
    body.evaluate(lanes, n, loopOut_.data(), flags);
    const double* v = loopOut_.data();

    if (loop.kind == Loop::Integral) {
        const double h = (end - start) / steps;
        if (calcJsMode_) {
            // Page scalar path: samples are evaluated raw (no finite-zeroing —
            // that only exists in the plotting IIFE template), w_k = 0.5 for
            // k==0 and k==N, else 1, accumulated left-to-right like the page's
            // expanded "v0+v1+...+vN" string.
            double sum = 0.0;
            for (int k = 0; k < n; ++k) {
                const double w = (k == 0 || static_cast<double>(k) == steps) ? 0.5 : 1.0;
                sum += w * v[k];
            }
            return sum * h;
        }
        auto finite = [](double x) { return JsMath::isFinite(x) ? x : 0.0; };
        double sum = 0.0;
        sum += 0.5 * finite(v[0]);
        for (int i = 1; i < n - 1; ++i) sum += finite(v[i]);
        sum += 0.5 * finite(v[n - 1]);
        return sum * h;
    }
    double res = initial;
    if (loop.kind == Loop::Sum) {
        for (int i = 0; i < n; ++i) res += v[i];
    } else {
        for (int i = 0; i < n; ++i) res *= v[i];
    }
    return res;
}

bool Program::compile(const std::string& source,
                      const std::vector<std::string>& argNames,
                      const std::vector<std::string>& paramNames) {
    ExpressionParser parser(Tokenizer::Dialect::JsSubset);
    ExprNodePtr ast = parser.parse(source);
    if (!ast || parser.hasError()) {
        error_.clear();
        return fail(parser.hasError() ? parser.getError() : "parse failed");
    }
    return compileAst(ast, argNames, paramNames);
}

bool Program::compileCalcJs(const std::string& source,
                            const std::vector<std::string>& argNames,
                            const std::vector<std::string>& paramNames,
                            const std::vector<CalcJsUserFn>& userFns,
                            double integralSteps) {
    CalcJsCompiler compiler;
    std::string js;
    if (!compiler.run(source, userFns, integralSteps, js)) {
        error_.clear();
        return fail(compiler.error().empty() ? "calcjs compile failed" : compiler.error());
    }
    ExpressionParser parser(Tokenizer::Dialect::JsSubset);
    ExprNodePtr ast = parser.parse(js);
    if (!ast || parser.hasError()) {
        error_.clear();
        return fail(parser.hasError() ? parser.getError() : "parse failed");
    }
    return compileAst(ast, argNames, paramNames, /*calcJs=*/true);
}

bool Program::compileAst(const ExprNodePtr& ast,
                         const std::vector<std::string>& argNames,
                         const std::vector<std::string>& paramNames,
                         bool calcJs) {
    nodes_.clear();
    advTable_.clear();
    loops_.clear();
    prologue_.clear();
    body_.clear();
    error_.clear();
    argNames_ = argNames;
    paramNames_ = paramNames;
    argCount_ = static_cast<int>(argNames.size());
    argUsed_.assign(argCount_, false);
    paramUsed_.assign(paramNames.size(), false);
    params_.assign(paramNames.size(), JsMath::kNaN);
    preparedFlags_ = -1;
    calcJsMode_ = calcJs;

    int root = lower(ast);
    if (root < 0) return false;
    if (nodes_.size() > 60000) return fail("expression too large");
    emit(root);
    return true;
}

void Program::emit(int root) {
    const int count = static_cast<int>(nodes_.size());
    std::vector<char> needed(count, 0);
    needed[root] = 1;
    // Children always precede parents, so one reverse sweep marks reachability.
    for (int i = count - 1; i >= 0; --i) {
        if (!needed[i] || nodes_[i].kind != Node::Operation) continue;
        needed[nodes_[i].a] = 1;
        if (nodes_[i].b >= 0) needed[nodes_[i].b] = 1;
        if (nodes_[i].c >= 0) needed[nodes_[i].c] = 1;
    }

    // Scalar slots for uniform nodes; body instruction index for varying ops.
    std::vector<int> slot(count, -1);
    std::vector<int> bodyIndex(count, -1);
    scalars_.clear();
    for (int i = 0; i < count; ++i) {
        if (!needed[i] || !nodes_[i].uniform) continue;
        slot[i] = static_cast<int>(scalars_.size());
        scalars_.push_back(nodes_[i].kind == Node::Const ? nodes_[i].value : 0.0);
    }

    auto operandOf = [&](int n) {
        Operand o;
        const Node& node = nodes_[n];
        if (node.uniform) {
            o.kind = OperandKind::Scalar;
            o.index = static_cast<uint16_t>(slot[n]);
        } else if (node.kind == Node::Arg) {
            o.kind = OperandKind::Arg;
            o.index = static_cast<uint16_t>(node.index);
        } else {
            o.kind = OperandKind::Vector;
            o.index = static_cast<uint16_t>(n);  // node id; remapped to a register below
        }
        return o;
    };

    std::vector<int> bodyNodes;
    for (int i = 0; i < count; ++i) {
        if (!needed[i]) continue;
        const Node& node = nodes_[i];
        if (node.kind == Node::Param) {
            Instr in{Op::Add, Fn::None, static_cast<uint16_t>(slot[i]), Operand{}, Operand{}};
            // Params are copied into their slot by runPrologue(); encode with op Neg on
            // an Arg operand pointing at the parameter index.
            in.op = Op::Neg;
            in.a.kind = OperandKind::Arg;
            in.a.index = static_cast<uint16_t>(node.index);
            prologue_.push_back(in);
            continue;
        }
        if (node.kind != Node::Operation) continue;
        Instr in;
        in.op = node.op;
        in.fn = node.fn;
        in.a = operandOf(node.a);
        in.b = node.b >= 0 ? operandOf(node.b) : Operand{};
        in.c = node.c >= 0 ? operandOf(node.c) : Operand{};
        in.adv = static_cast<uint16_t>(node.adv >= 0 ? node.adv : 0);
        if (node.uniform) {
            in.dst = static_cast<uint16_t>(slot[i]);
            prologue_.push_back(in);
        } else {
            in.dst = static_cast<uint16_t>(i);
            bodyIndex[i] = static_cast<int>(body_.size());
            body_.push_back(in);
            bodyNodes.push_back(i);
        }
    }

    // Linear-scan register allocation over the body (elementwise ops may run in place).
    std::vector<int> lastUse(count, -1);
    for (size_t k = 0; k < body_.size(); ++k) {
        const Instr& in = body_[k];
        if (in.a.kind == OperandKind::Vector) lastUse[in.a.index] = static_cast<int>(k);
        if (in.b.kind == OperandKind::Vector) lastUse[in.b.index] = static_cast<int>(k);
        if (in.c.kind == OperandKind::Vector) lastUse[in.c.index] = static_cast<int>(k);
    }
    result_ = operandOf(root);
    if (result_.kind == OperandKind::Vector) lastUse[root] = static_cast<int>(body_.size());

    std::vector<int> reg(count, -1);
    std::vector<int> freeRegs;
    numVRegs_ = 0;
    for (size_t k = 0; k < body_.size(); ++k) {
        Instr& in = body_[k];
        const int node = bodyNodes[k];
        auto mapOperand = [&](Operand& o) {
            if (o.kind != OperandKind::Vector) return;
            const int src = o.index;
            o.index = static_cast<uint16_t>(reg[src]);
            if (lastUse[src] == static_cast<int>(k)) {
                freeRegs.push_back(reg[src]);
                lastUse[src] = -2;  // freed once even when used as both operands
            }
        };
        mapOperand(in.a);
        mapOperand(in.b);
        mapOperand(in.c);
        int r;
        if (!freeRegs.empty()) {
            r = freeRegs.back();
            freeRegs.pop_back();
        } else {
            r = numVRegs_++;
        }
        reg[node] = r;
        in.dst = static_cast<uint16_t>(r);
        if (lastUse[node] == -1) freeRegs.push_back(r);  // dead value (should not happen)
    }
    if (result_.kind == OperandKind::Vector) result_.index = static_cast<uint16_t>(reg[root]);
    vregs_.assign(static_cast<size_t>(std::max(numVRegs_, 1)) * kBlock, 0.0);
}

void Program::setParams(const double* values, int count) {
    for (int i = 0; i < static_cast<int>(params_.size()); ++i) {
        params_[i] = (values && i < count) ? values[i] : JsMath::kNaN;
    }
    preparedFlags_ = -1;
}

void Program::runPrologue(int flags) {
    if (preparedFlags_ == flags) return;
    double* s = scalars_.data();
    for (const Instr& in : prologue_) {
        if (in.a.kind == OperandKind::Arg) {  // parameter load
            s[in.dst] = params_[in.a.index];
            continue;
        }
        const int count = operandCount(in.op);
        const double a = s[in.a.index];
        const double b = count >= 2 ? s[in.b.index] : 0.0;
        const double c = count >= 3 ? s[in.c.index] : 0.0;
        if (in.op == Op::Loop) {
            s[in.dst] = evalLoop(in.adv, a, b, c, nullptr, flags);
            continue;
        }
        s[in.dst] = scalarOp(in, a, b, c, flags);
    }
    preparedFlags_ = flags;
}

void Program::evaluate(const double* const* args, int n, double* out, int flags) {
    runPrologue(flags);
    if (n <= 0) return;

    if (result_.kind == OperandKind::Scalar) {
        const double v = scalars_[result_.index];
        for (int i = 0; i < n; ++i) out[i] = v;
        return;
    }
    if (result_.kind == OperandKind::Arg) {
        std::memcpy(out, args[result_.index], sizeof(double) * static_cast<size_t>(n));
        return;
    }

    const double* s = scalars_.data();
    double* regs = vregs_.data();
    const size_t last = body_.size() - 1;
    for (int start = 0; start < n; start += kBlock) {
        const int m = std::min(kBlock, n - start);
        auto src = [&](const Operand& o) {
            Src r{nullptr, 0.0, false};
            switch (o.kind) {
                case OperandKind::Scalar: r.s = s[o.index]; r.scalar = true; break;
                case OperandKind::Arg: r.p = args[o.index] + start; break;
                case OperandKind::Vector: r.p = regs + static_cast<size_t>(o.index) * kBlock; break;
            }
            return r;
        };
        for (size_t k = 0; k <= last; ++k) {
            const Instr& in = body_[k];
            double* o = (k == last) ? out + start : regs + static_cast<size_t>(in.dst) * kBlock;
            const Src a = src(in.a);
            switch (in.op) {
                case Op::Add: binaryLoop(o, a, src(in.b), m, [](double x, double y) { return x + y; }); break;
                case Op::Sub: binaryLoop(o, a, src(in.b), m, [](double x, double y) { return x - y; }); break;
                case Op::Mul: binaryLoop(o, a, src(in.b), m, [](double x, double y) { return x * y; }); break;
                case Op::Div: binaryLoop(o, a, src(in.b), m, [](double x, double y) { return x / y; }); break;
                case Op::Neg: unaryLoop(o, a.p, m, [](double v) { return -v; }); break;
                case Op::Call1: runUnary(in.fn, o, a.p, m); break;
                case Op::Call2: runBinaryFn(in.fn, o, a, src(in.b), m, flags); break;
                case Op::Adv1: {
                    double (*f)(double) = advTable_[in.adv]->fn1;
                    for (int i = 0; i < m; ++i) o[i] = f(a.p[i]);
                    break;
                }
                case Op::Adv2: {
                    double (*f)(double, double) = advTable_[in.adv]->fn2;
                    binaryLoop(o, a, src(in.b), m, [f](double x, double y) { return f(x, y); });
                    break;
                }
                case Op::Loop: {
                    const Src b = src(in.b);
                    const Src c = src(in.c);
                    double laneArgs[8];
                    for (int i = 0; i < m; ++i) {
                        for (int k = 0; k < argCount_ && k < 8; ++k) {
                            laneArgs[k] = args[k] ? args[k][start + i] : JsMath::kNaN;
                        }
                        o[i] = evalLoop(in.adv, a.scalar ? a.s : a.p[i], b.scalar ? b.s : b.p[i],
                                        c.scalar ? c.s : c.p[i], laneArgs, flags);
                    }
                    break;
                }
                case Op::Adv3: {
                    double (*f)(double, double, double) = advTable_[in.adv]->fn3;
                    const Src b = src(in.b);
                    const Src c = src(in.c);
                    for (int i = 0; i < m; ++i) {
                        o[i] = f(a.scalar ? a.s : a.p[i], b.scalar ? b.s : b.p[i], c.scalar ? c.s : c.p[i]);
                    }
                    break;
                }
            }
        }
    }
}

double Program::evaluateOne(const double* args, int flags) {
    const double* lanes[8] = {nullptr};
    for (int k = 0; k < argCount_ && k < 8; ++k) lanes[k] = args + k;
    double out = JsMath::kNaN;
    evaluate(lanes, 1, &out, flags);
    return out;
}

} // namespace Core
} // namespace ArchMaths
