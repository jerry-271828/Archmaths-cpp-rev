#pragma once

#include "math/MathTypes.h"
#include <string>
#include <vector>

namespace ArchMaths {

class Tokenizer {
public:
    // Math: the calculator's own input syntax (implicit products, constants).
    // JsSubset: the arithmetic JavaScript emitted by the web front-end, e.g.
    //   Math.sin(x)*__advanced__.pow(x,2)+a
    // Identifiers stay whole, `Math.f` becomes Function "f" and
    // `__advanced__.f` becomes Function "adv.f". Anything outside that subset
    // is reported through hasError() instead of being skipped.
    // CalcJs: the web front-end's calcJSUtils input dialect, e.g.
    //   2sin(x)^2 + pi*a. Tokens match the page's calcJSUtils.tokenize()
    // output one-to-one (lowercased input, longest known-symbol match before
    // '(', constants e/pi/π); ExpressionParser refuses this dialect — compile
    // it through Program::compileCalcJs, which replicates the page's whole
    // token pipeline before lowering to the VM.
    enum class Dialect { Math, JsSubset, CalcJs };

    // CalcJs only: extra "known symbols" the tokenizer must split before '('
    // (simple custom function names and ported advanced function names). The
    // page's tokenize does this for calc1+calc3+advancedCustomFunctionNames;
    // without it names starting with a constant prefix (exp, erf, elliptick,
    // pow, ...) would be mangled by the constant pass.
    void setCalcJsSymbols(std::vector<std::string> symbols) { calcJsSymbols_ = std::move(symbols); }

    explicit Tokenizer(Dialect dialect = Dialect::Math);

    std::vector<Token> tokenize(const std::string& expression);

    Dialect dialect() const { return dialect_; }
    bool hasError() const { return hasError_; }
    const std::string& getError() const { return errorMessage_; }

private:
    std::vector<Token> tokenizeJsSubset(const std::string& expression);
    std::vector<Token> tokenizeCalcJs(const std::string& expression);
    bool isOperator(char c) const;
    bool isFunction(const std::string& name) const;
    std::string toLower(const std::string& str) const;

    Dialect dialect_;
    bool hasError_ = false;
    std::string errorMessage_;
    std::vector<std::string> calcJsSymbols_;

    static const std::vector<std::string> FUNCTIONS;
    static const std::vector<std::string> CONSTANTS;
};

} // namespace ArchMaths
