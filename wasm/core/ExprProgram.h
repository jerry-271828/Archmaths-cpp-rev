#pragma once

// Compiled expression program for the WebAssembly compute core.
//
// Pipeline: source text -> Tokenizer/ExpressionParser (JsSubset dialect) ->
// ExprNode AST -> hash-consed DAG (constant folding + common subexpression
// elimination) -> linear bytecode. Nodes that depend only on constants and
// parameters ("uniform") run once per evaluation in a scalar prologue; the
// rest run as vector instructions over blocks of kBlock lanes, so the
// interpreter's dispatch cost is paid once per block instead of per point.

#include "math/MathTypes.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ArchMaths {
namespace Core {

struct CalcJsUserFn;

constexpr int kBlock = 256;

enum class Fn : uint8_t {
    // unary
    Sin, Cos, Tan, Asin, Acos, Atan, Sinh, Cosh, Tanh, Asinh, Acosh, Atanh,
    Exp, Expm1, Log, Log10, Log2, Log1p, Sqrt, Cbrt, Abs, Floor, Ceil, Round,
    Trunc, Sign, Fround,
    // binary
    Pow, AdvPow, Atan2, Min, Max, Hypot,
    None,
};

// Adv1..Adv3 call a registered advanced function (AdvancedRegistry.h) with
// 1..3 operands; Instr::adv indexes the program's function table.
// Loop evaluates a sum/prod/int large operator: operands are (start, end,
// steps) and Instr::adv indexes the program's loop table.
enum class Op : uint8_t { Add, Sub, Mul, Div, Neg, Call1, Call2, Adv1, Adv2, Adv3, Loop };

enum class OperandKind : uint8_t { Scalar, Vector, Arg };

struct Operand {
    OperandKind kind = OperandKind::Scalar;
    uint16_t index = 0;
};

struct AdvancedFunction;

struct Instr {
    Op op;
    Fn fn;
    uint16_t dst;   // scalar slot (prologue) or vector register (body)
    Operand a;
    Operand b;
    Operand c;
    uint16_t adv = 0;
};

// Evaluation flags.
enum : int {
    kFlagStrictPow = 1,  // `pow` behaves like the 3D/implicit wrapper
};

class Program {
public:
    // argNames: lane inputs (e.g. x, y, z or t), in call order.
    // paramNames: uniform inputs (slider variables), in setParams() order.
    // Returns false (with error()) when the source uses anything the core
    // cannot evaluate exactly; the caller then keeps the JS path.
    bool compile(const std::string& source,
                 const std::vector<std::string>& argNames,
                 const std::vector<std::string>& paramNames);
    // CalcJs dialect (the page's calculator input language), compiled through
    // the CalcJsCompiler token pipeline. `integralSteps` is the trapezoid step
    // count for `int(f,x,a,b)` (page: calcJSUtils.integralNumSteps). Large
    // operators run with page scalar-path semantics (see evalLoop).
    bool compileCalcJs(const std::string& source,
                       const std::vector<std::string>& argNames,
                       const std::vector<std::string>& paramNames,
                       const std::vector<CalcJsUserFn>& userFns,
                       double integralSteps);
    bool compileAst(const ExprNodePtr& ast,
                    const std::vector<std::string>& argNames,
                    const std::vector<std::string>& paramNames,
                    bool calcJs = false);

    const std::string& error() const { return error_; }
    int argCount() const { return argCount_; }
    int paramCount() const { return static_cast<int>(params_.size()); }
    bool usesArg(int k) const { return k >= 0 && k < argCount_ && argUsed_[k]; }
    bool usesParam(int k) const { return k >= 0 && k < static_cast<int>(paramUsed_.size()) && paramUsed_[k]; }

    void setParams(const double* values, int count);

    // Evaluate n lanes. args[k] points at n doubles for lane input k (may be
    // null for inputs the program does not use). Writes n results to out.
    void evaluate(const double* const* args, int n, double* out, int flags);

    // Single point convenience wrapper (args: argCount() doubles).
    double evaluateOne(const double* args, int flags);

    size_t instructionCount() const { return body_.size(); }
    size_t prologueCount() const { return prologue_.size(); }

private:
    struct Node {
        enum Kind : uint8_t { Const, Arg, Param, Operation } kind;
        Op op = Op::Add;
        Fn fn = Fn::None;
        int a = -1;
        int b = -1;
        int c = -1;
        int adv = -1;
        double value = 0.0;
        int index = 0;
        bool uniform = true;
    };

    // sum/prod/int: the body is a sub-program whose lane input is the loop
    // variable and whose parameters are this program's args then params.
    struct Loop {
        enum Kind : uint8_t { Sum, Prod, Integral } kind;
        std::unique_ptr<Program> body;
        bool usesLaneArgs = false;
    };

    int lower(const ExprNodePtr& node);
    int lowerLoop(const ExprNodePtr& node, Loop::Kind kind);
    double evalLoop(int index, double start, double end, double steps, const double* laneArgs, int flags);
    int intern(Node node);
    int makeConst(double v);
    int makeOp(Op op, Fn fn, int a, int b, int c = -1, int adv = -1);
    double scalarOp(const Node& n, double a, double b, double c, int flags) const;
    double scalarOp(const Instr& in, double a, double b, double c, int flags) const;
    bool fail(const std::string& message);
    void emit(int root);
    void runPrologue(int flags);

    std::vector<Node> nodes_;
    std::vector<const AdvancedFunction*> advTable_;
    std::vector<Loop> loops_;
    std::vector<double> loopLanes_;
    std::vector<double> loopOut_;
    std::vector<double> loopParams_;
    std::vector<std::string> argNames_;
    std::vector<std::string> paramNames_;
    std::vector<bool> argUsed_;
    std::vector<bool> paramUsed_;
    int argCount_ = 0;
    std::string error_;

    std::vector<Instr> prologue_;
    std::vector<Instr> body_;
    std::vector<double> params_;
    std::vector<double> scalars_;   // prologue slots: [consts..., params..., temps...]
    std::vector<double> vregs_;     // numVRegs_ * kBlock
    int numVRegs_ = 0;
    Operand result_;
    int preparedFlags_ = -1;
    bool calcJsMode_ = false;  // page scalar-path large-operator semantics
};

} // namespace Core
} // namespace ArchMaths
