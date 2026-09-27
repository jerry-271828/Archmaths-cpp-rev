#include "math/Tokenizer.h"
#include <algorithm>
#include <cctype>
#include <cstdlib>

namespace ArchMaths {

const std::vector<std::string> Tokenizer::FUNCTIONS = {
    "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
    "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
    "sqrt", "cbrt", "abs", "floor", "ceil", "round",
    "exp", "log", "log10", "log2", "ln",
    "pow", "min", "max", "mod",
    "sign", "frac",
    "sum", "prod", "int", "diff"
};

const std::vector<std::string> Tokenizer::CONSTANTS = {
    "pi", "e", "phi", "tau"
};

Tokenizer::Tokenizer(Dialect dialect) : dialect_(dialect) {}

std::string Tokenizer::toLower(const std::string& str) const {
    std::string result = str;
    std::transform(result.begin(), result.end(), result.begin(), ::tolower);
    return result;
}

bool Tokenizer::isOperator(char c) const {
    return c == '+' || c == '-' || c == '*' || c == '/' || c == '^';
}

bool Tokenizer::isFunction(const std::string& name) const {
    std::string lower = toLower(name);
    return std::find(FUNCTIONS.begin(), FUNCTIONS.end(), lower) != FUNCTIONS.end();
}

std::vector<Token> Tokenizer::tokenize(const std::string& expression) {
    hasError_ = false;
    errorMessage_.clear();
    if (dialect_ == Dialect::JsSubset) {
        return tokenizeJsSubset(expression);
    }
    if (dialect_ == Dialect::CalcJs) {
        return tokenizeCalcJs(expression);
    }

    std::vector<Token> tokens;
    std::string expr = expression;

    // 移除空格
    expr.erase(std::remove_if(expr.begin(), expr.end(), ::isspace), expr.end());

    size_t i = 0;
    while (i < expr.length()) {
        char c = expr[i];

        // 数字
        if (std::isdigit(c) || (c == '.' && i + 1 < expr.length() && std::isdigit(expr[i + 1]))) {
            std::string numStr;
            bool hasDecimal = false;

            while (i < expr.length() && (std::isdigit(expr[i]) || expr[i] == '.')) {
                if (expr[i] == '.') {
                    if (hasDecimal) break;
                    hasDecimal = true;
                }
                numStr += expr[i++];
            }

            // 科学计数法
            if (i < expr.length() && (expr[i] == 'e' || expr[i] == 'E')) {
                numStr += expr[i++];
                if (i < expr.length() && (expr[i] == '+' || expr[i] == '-')) {
                    numStr += expr[i++];
                }
                while (i < expr.length() && std::isdigit(expr[i])) {
                    numStr += expr[i++];
                }
            }

            Token token(TokenType::Number, numStr);
            token.numValue = std::stod(numStr);
            tokens.push_back(token);
        }
        // 标识符（变量或函数）
        else if (std::isalpha(c) || c == '_') {
            std::string identifier;
            while (i < expr.length() && (std::isalnum(expr[i]) || expr[i] == '_')) {
                identifier += expr[i++];
            }

            std::string lower = toLower(identifier);

            // 检查是否是常量
            if (std::find(CONSTANTS.begin(), CONSTANTS.end(), lower) != CONSTANTS.end()) {
                Token token(TokenType::Number, identifier);
                if (lower == "pi") token.numValue = Constants::PI;
                else if (lower == "e") token.numValue = Constants::E;
                else if (lower == "phi") token.numValue = Constants::PHI;
                else if (lower == "tau") token.numValue = Constants::TAU;
                tokens.push_back(token);
            }
            // 检查是否是函数
            else if (isFunction(identifier)) {
                tokens.push_back(Token(TokenType::Function, lower));
            }
            // 变量 - 支持隐式乘法 (xy -> x*y)
            else {
                for (size_t k = 0; k < lower.length(); ++k) {
                    if (k > 0) {
                        tokens.push_back(Token(TokenType::Operator, "*"));
                    }
                    tokens.push_back(Token(TokenType::Variable, std::string(1, lower[k])));
                }
            }
        }
        // 运算符
        else if (isOperator(c)) {
            tokens.push_back(Token(TokenType::Operator, std::string(1, c)));
            i++;
        }
        // 括号
        else if (c == '(') {
            tokens.push_back(Token(TokenType::LeftParen, "("));
            i++;
        }
        else if (c == ')') {
            tokens.push_back(Token(TokenType::RightParen, ")"));
            i++;
        }
        // 逗号
        else if (c == ',') {
            tokens.push_back(Token(TokenType::Comma, ","));
            i++;
        }
        // 比较运算符
        else if (c == '=') {
            tokens.push_back(Token(TokenType::Equals, "="));
            i++;
        }
        else if (c == '<') {
            if (i + 1 < expr.length() && expr[i + 1] == '=') {
                tokens.push_back(Token(TokenType::LessEqual, "<="));
                i += 2;
            } else {
                tokens.push_back(Token(TokenType::LessThan, "<"));
                i++;
            }
        }
        else if (c == '>') {
            if (i + 1 < expr.length() && expr[i + 1] == '=') {
                tokens.push_back(Token(TokenType::GreaterEqual, ">="));
                i += 2;
            } else {
                tokens.push_back(Token(TokenType::GreaterThan, ">"));
                i++;
            }
        }
        else {
            // 跳过未知字符
            i++;
        }
    }

    tokens.push_back(Token(TokenType::End, ""));
    return tokens;
}

namespace {
bool isJsIdentStart(char c) { return std::isalpha(static_cast<unsigned char>(c)) || c == '_' || c == '$'; }
bool isJsIdentPart(char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '$'; }
} // namespace

std::vector<Token> Tokenizer::tokenizeCalcJs(const std::string& expression) {
    // Port of the page's calcJSUtils.tokenize() (case-insensitive, whitespace
    // stripped, paren balance enforced). Function names are NOT pre-split:
    // the page only recognizes a function call when the name is immediately
    // followed by '(', which is exactly where plain identifier munching stops
    // ([a-z0-9] continuation), so both produce the same token boundaries.
    // Tokens carry their string in `value`; numbers also set numValue.
    auto fail = [&](const std::string& msg) {
        hasError_ = true;
        errorMessage_ = msg;
        return std::vector<Token>{Token(TokenType::End, "")};
    };

    // JS toLowerCase() + \s+ removal; Unicode Π (CE A0) lowercases to π.
    std::string expr;
    for (size_t i = 0; i < expression.size();) {
        const unsigned char c = static_cast<unsigned char>(expression[i]);
        if (c == 0xCE && i + 1 < expression.size() &&
            static_cast<unsigned char>(expression[i + 1]) == 0xA0) {
            expr += "\xCF\x80";
            i += 2;
            continue;
        }
        if (c == 0xCF && i + 1 < expression.size() &&
            static_cast<unsigned char>(expression[i + 1]) == 0x80) {
            expr += "\xCF\x80";
            i += 2;
            continue;
        }
        if (std::isspace(c)) {
            ++i;
            continue;
        }
        expr += static_cast<char>(std::tolower(c));
        ++i;
    }
    if (expr.empty()) return {};

    int parenBalance = 0;
    for (char c : expr) {
        if (c == '(') ++parenBalance;
        else if (c == ')') --parenBalance;
    }
    if (parenBalance != 0) return fail("括号不匹配");

    // constants as (bytes, byteLength) sorted like the page's longest-first
    // pass; first bytes are disjoint so tie order is irrelevant.
    static const struct { const char* s; size_t len; } kCalcJsConstants[] = {
        {"pi", 2}, {"\xCF\x80", 2}, {"e", 1},
    };

    // Page calcJSUtils.calc1 (function tokens split before '(' in phase 1;
    // these take precedence over the constant pass, so "exp(x)" is not
    // read as e*xp(x)).
    static const char* const kCalcJsOps[] = {
        "asinh", "acosh", "atanh", "sinh", "cosh", "tanh", "asin", "acos",
        "atan", "sqrt", "cbrt", "diffat", "floor", "ceil", "round", "sin",
        "cos", "tan", "exp", "abs", "sum", "prod", "int", "ln", "lg", "log",
        "diff",
    };
    std::vector<std::string> ops;
    for (const char* op : kCalcJsOps) ops.emplace_back(op);
    for (const auto& s : calcJsSymbols_) {
        if (!s.empty() && std::find(ops.begin(), ops.end(), s) == ops.end()) ops.push_back(s);
    }
    std::sort(ops.begin(), ops.end(), [](const std::string& a, const std::string& b) {
        return a.size() != b.size() ? a.size() > b.size() : a < b;
    });

    std::vector<Token> tokens;
    size_t i = 0;
    const size_t n = expr.size();
    auto isLetterChar = [](char c) {
        const unsigned char u = static_cast<unsigned char>(c);
        return std::isalpha(u) || c == '_';
    };
    while (i < n) {
        // Phase 1 equivalent: a known function name immediately followed by
        // '(' becomes a single token (page: opDetails split, longest first).
        bool matched = false;
        for (const auto& op : ops) {
            if (i + op.size() < n && expr.compare(i, op.size(), op) == 0 && expr[i + op.size()] == '(') {
                tokens.push_back(Token(TokenType::Variable, op));
                i += op.size();
                matched = true;
                break;
            }
        }
        if (matched) continue;

        for (const auto& cnst : kCalcJsConstants) {
            if (i + cnst.len <= n && expr.compare(i, cnst.len, cnst.s, cnst.len) == 0) {
                tokens.push_back(Token(TokenType::Number, std::string(cnst.s, cnst.len)));
                i += cnst.len;
                matched = true;
                break;
            }
        }
        if (matched) continue;

        const char c = expr[i];
        if (std::isdigit(static_cast<unsigned char>(c)) || c == '.') {
            std::string numStr;
            while (i < n && (std::isdigit(static_cast<unsigned char>(expr[i])) || expr[i] == '.')) {
                numStr += expr[i++];
            }
            Token token(TokenType::Number, numStr);
            token.numValue = std::strtod(numStr.c_str(), nullptr);
            tokens.push_back(token);
            continue;
        }
        if (c == '+' || c == '-' || c == '*' || c == '/' || c == '^') {
            tokens.push_back(Token(TokenType::Operator, std::string(1, c)));
            ++i;
            continue;
        }
        if (c == '(') {
            tokens.push_back(Token(TokenType::LeftParen, "("));
            ++i;
            continue;
        }
        if (c == ')') {
            tokens.push_back(Token(TokenType::RightParen, ")"));
            ++i;
            continue;
        }
        if (c == ',') {
            tokens.push_back(Token(TokenType::Comma, ","));
            ++i;
            continue;
        }
        if (isLetterChar(c)) {
            // Identifier: first char [a-z_], continuation [a-z0-9] only — the
            // page's munch regex deliberately excludes '_' from continuation.
            // A '_' first char makes the page's tokenize loop forever (its
            // continuation test fails on the first char), so the scalar path
            // ends in NaN at its try/catch; fail here to keep the JS path.
            if (c == '_') return fail("输入的表达式语法有误，请检查！");
            std::string ident;
            ident += c;
            ++i;
            while (i < n && (std::isalnum(static_cast<unsigned char>(expr[i])) && expr[i] != '_')) {
                ident += expr[i++];
            }
            tokens.push_back(Token(TokenType::Variable, ident));
            continue;
        }
        return fail("输入的表达式语法有误，请检查！");
    }
    return tokens;
}

std::vector<Token> Tokenizer::tokenizeJsSubset(const std::string& expr) {
    std::vector<Token> tokens;
    auto fail = [&](const std::string& msg) {
        hasError_ = true;
        errorMessage_ = msg;
        tokens.clear();
        tokens.push_back(Token(TokenType::End, ""));
        return tokens;
    };

    size_t i = 0;
    const size_t n = expr.length();
    while (i < n) {
        char c = expr[i];
        if (std::isspace(static_cast<unsigned char>(c))) { ++i; continue; }

        if (std::isdigit(static_cast<unsigned char>(c)) ||
            (c == '.' && i + 1 < n && std::isdigit(static_cast<unsigned char>(expr[i + 1])))) {
            size_t start = i;
            // Sloppy-mode JS reads 012 as octal; keep such literals on the JS path.
            if (c == '0' && i + 1 < n && std::isdigit(static_cast<unsigned char>(expr[i + 1]))) {
                return fail("leading-zero literal");
            }
            while (i < n && std::isdigit(static_cast<unsigned char>(expr[i]))) ++i;
            if (i < n && expr[i] == '.') {
                ++i;
                while (i < n && std::isdigit(static_cast<unsigned char>(expr[i]))) ++i;
            }
            if (i < n && (expr[i] == 'e' || expr[i] == 'E')) {
                size_t save = i++;
                if (i < n && (expr[i] == '+' || expr[i] == '-')) ++i;
                if (i >= n || !std::isdigit(static_cast<unsigned char>(expr[i]))) {
                    i = save;
                } else {
                    while (i < n && std::isdigit(static_cast<unsigned char>(expr[i]))) ++i;
                }
            }
            if (i < n && (isJsIdentPart(expr[i]) || expr[i] == '.')) {
                return fail("malformed number");
            }
            std::string numStr = expr.substr(start, i - start);
            Token token(TokenType::Number, numStr);
            token.numValue = std::strtod(numStr.c_str(), nullptr);
            tokens.push_back(token);
            continue;
        }

        if (isJsIdentStart(c)) {
            size_t start = i;
            while (i < n && isJsIdentPart(expr[i])) ++i;
            std::string ident = expr.substr(start, i - start);

            if (i < n && expr[i] == '.') {
                size_t memberStart = ++i;
                if (i >= n || !isJsIdentStart(expr[i])) return fail("bad member access");
                while (i < n && isJsIdentPart(expr[i])) ++i;
                std::string member = expr.substr(memberStart, i - memberStart);
                if (i < n && expr[i] == '.') return fail("nested member access");
                if (ident == "Math") {
                    if (member == "PI" || member == "E") {
                        Token token(TokenType::Number, member);
                        token.numValue = member == "PI" ? Constants::PI : Constants::E;
                        tokens.push_back(token);
                    } else {
                        tokens.push_back(Token(TokenType::Function, member));
                    }
                } else if (ident == "__advanced__") {
                    tokens.push_back(Token(TokenType::Function, "adv." + member));
                } else {
                    return fail("unsupported member access: " + ident + "." + member);
                }
                continue;
            }

            if (ident == "NaN" || ident == "Infinity") {
                Token token(TokenType::Number, ident);
                token.numValue = ident == "NaN" ? std::nan("") : HUGE_VAL;
                tokens.push_back(token);
                continue;
            }
            static const char* const kReserved[] = {
                "undefined", "null", "true", "false", "this", "new", "typeof", "void", "delete",
                "in", "of", "instanceof", "function", "return", "var", "let", "const", "if", "else",
                "for", "while", "do", "switch", "case", "break", "continue", "throw", "try", "catch",
                "finally", "class", "extends", "super", "import", "export", "yield", "await",
                "async", "with", "debugger", "default", "enum", "arguments", "eval", "Math",
                "__advanced__", "variables"
            };
            for (const char* word : kReserved) {
                if (ident == word) return fail("unsupported identifier: " + ident);
            }
            tokens.push_back(Token(TokenType::Variable, ident));
            continue;
        }

        switch (c) {
            case '+': case '-': case '*': case '/':
                if (c == '*' && i + 1 < n && expr[i + 1] == '*') return fail("unsupported operator **");
                tokens.push_back(Token(TokenType::Operator, std::string(1, c)));
                ++i;
                continue;
            case '(': tokens.push_back(Token(TokenType::LeftParen, "(")); ++i; continue;
            case ')': tokens.push_back(Token(TokenType::RightParen, ")")); ++i; continue;
            case ',': tokens.push_back(Token(TokenType::Comma, ",")); ++i; continue;
            default:
                return fail(std::string("unsupported character: ") + c);
        }
    }

    tokens.push_back(Token(TokenType::End, ""));
    return tokens;
}

} // namespace ArchMaths
