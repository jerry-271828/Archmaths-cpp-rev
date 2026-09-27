#pragma once

// CalcJs dialect front-end: a faithful port of the page's calcJSUtils token
// pipeline (tokenize -> expandCustomFunctions -> expandDiffOperations ->
// processTokensForEval -> large-operator lowering). The output is a JsSubset
// source string the Program VM already understands (Math.* / __advanced__.* /
// Math.__archsum|__archprod|__archint). Anything the core cannot evaluate
// exactly makes run() fail, so the caller keeps the JS path.
//
// Fidelity notes (all verified against arch-current.html's calcJSUtils):
// - tokenize() is Tokenizer::Dialect::CalcJs (same file, shared tables).
// - Textual substitution of the loop variable by a numeric literal is
//   equivalent to keeping it as an operand: processTokensForEval's implicit-
//   multiplication rules treat number and variable tokens identically, so
//   sum(2x,x,1,3) == 2*1+2*2+2*3 on the page AND here (the "21" reading is
//   prevented by the implicit '*' insertion itself).
// - Large operators therefore lower to the VM's Loop op instead of textual
//   expansion. The one case that cannot be reproduced structurally — a
//   nested operator's bounds (or, in eager position, its body) referencing an
//   ENCLOSING loop variable (the page evaluates bounds before substituting
//   the enclosing variable) — is detected at compile time and rejected.

#include <string>
#include <vector>

namespace ArchMaths {
namespace Core {

struct CalcJsUserFn {
    std::string name;                    // lower-case
    std::vector<std::string> params;     // lower-case
    std::vector<std::string> bodyTokens; // page-produced bodyTokens, verbatim
};

class CalcJsCompiler {
public:
    bool run(const std::string& source,
             const std::vector<CalcJsUserFn>& userFns,
             double integralSteps,
             std::string& outJs);

    const std::string& error() const { return error_; }

private:
    using Tokens = std::vector<std::string>;

    bool fail(const std::string& message);

    // -- fixed tables (page calc1 / constants / large operators) -------------
    static bool isCalc1(const std::string& t);
    static bool isConstant(const std::string& t);
    static bool isLargeOp(const std::string& t);   // sum/prod/int/diff/diffat
    static bool isCalcLargeOp(const std::string& t); // sum/prod/int
    bool isCalc3(const std::string& t) const;
    // A registered (pristine) advanced function name. The '__advanced__.pow'
    // marker produced by the `^` rewrite is deliberately NOT matched here —
    // the page's funcNames lists don't contain it either, which is why e.g.
    // x^2^3 is a syntax error (NaN) on the page.
    bool isAdvName(const std::string& t) const;
    const CalcJsUserFn* findUserFn(const std::string& t) const;

    // -- page pipeline stages ------------------------------------------------
    Tokens expandCustomFunctions(const Tokens& tokens, const std::vector<std::string>& shadows, int depth);
    Tokens uniqueifyLocals(const Tokens& tokens);
    Tokens expandDiffOperations(const Tokens& tokens);
    Tokens substituteInTokens(const Tokens& target, const std::string& variable,
                              const Tokens& replacement);
    // Implicit multiplication + `^` rewrite + name mapping (page
    // processTokensForEval with empty localShadows; sum/prod/int tokens kept).
    Tokens processTokensForEval(const Tokens& tokens);

    // Lowers sum/prod/int call sites to Math.__archsum/__archprod/__archint
    // and joins the token stream.
    std::string lowerLargeOps(const Tokens& tokens);

    // Structural pre-pass: rejects the one shape the structured Loop cannot
    // reproduce — an operator whose bounds (or, in eager position, its body)
    // reference an ENCLOSING loop variable (the page evaluates bounds before
    // substituting the enclosing variable). Mirrors the page's nesting
    // textually, independent of the innermost-first expansion order.
    bool checkLargeOps(const Tokens& tokens, const std::vector<std::string>& enclosing,
                       bool inEager);

    // -- helpers -------------------------------------------------------------
    static bool isLetter(const std::string& s);
    static bool isNumericString(const std::string& s);
    static std::string toLower(const std::string& s);
    static long findMatchingParen(const Tokens& tokens, long openIdx);
    static long findMatchingParenBackwards(const Tokens& tokens, long closeIdx);
    bool extractArguments(const Tokens& tokens, long openIdx, long closeIdx, int expected,
                          std::vector<Tokens>& out);
    static bool containsIdentifier(const Tokens& tokens, const std::vector<std::string>& names);
    static std::string join(const Tokens& tokens);

    std::vector<CalcJsUserFn> userFns_;
    double integralSteps_ = 100.0;
    unsigned uidCounter_ = 0;
    std::string error_;
};

} // namespace Core
} // namespace ArchMaths
