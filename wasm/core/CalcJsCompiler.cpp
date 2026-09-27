#include "CalcJsCompiler.h"

#include "AdvancedRegistry.h"
#include "JsMath.h"
#include "math/Tokenizer.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <algorithm>

namespace ArchMaths {
namespace Core {

namespace {

// Page calcJSUtils.calc1 (order preserved; lookups are membership-only).
const char* const kCalc1[] = {
    "ln", "lg", "log", "exp", "sqrt", "cbrt", "abs", "floor", "ceil", "round",
    "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
    "asinh", "acosh", "atanh", "sum", "prod", "int", "diff", "diffat",
};

// JS Number.prototype.toString() of the page's constant values.
const char* const kConstE = "2.718281828459045";
const char* const kConstPi = "3.141592653589793";

bool inList(const char* const* list, size_t n, const std::string& t) {
    for (size_t i = 0; i < n; ++i) if (t == list[i]) return true;
    return false;
}

} // namespace

bool CalcJsCompiler::isCalc1(const std::string& t) {
    return inList(kCalc1, sizeof(kCalc1) / sizeof(kCalc1[0]), t);
}

bool CalcJsCompiler::isConstant(const std::string& t) {
    return t == "e" || t == "pi" || t == "\xCF\x80";
}

bool CalcJsCompiler::isLargeOp(const std::string& t) {
    return t == "sum" || t == "prod" || t == "int" || t == "diff" || t == "diffat";
}

bool CalcJsCompiler::isCalcLargeOp(const std::string& t) {
    return t == "sum" || t == "prod" || t == "int";
}

bool CalcJsCompiler::isCalc3(const std::string& t) const {
    for (const auto& fn : userFns_) if (fn.name == t) return true;
    return false;
}

bool CalcJsCompiler::isAdvName(const std::string& t) const {
    if (t.compare(0, 11, "__advanced__") == 0) return false; // rewrite marker
    if (t == "pow") return true;  // registered on the page; VM special-cases it
    return findAdvancedFunction(t.c_str()) != nullptr;
}

const CalcJsUserFn* CalcJsCompiler::findUserFn(const std::string& t) const {
    for (const auto& fn : userFns_) if (fn.name == t) return &fn;
    return nullptr;
}

bool CalcJsCompiler::fail(const std::string& message) {
    if (error_.empty()) error_ = message;
    return false;
}

bool CalcJsCompiler::isLetter(const std::string& s) {
    if (s.empty()) return false;
    const unsigned char first = static_cast<unsigned char>(s[0]);
    if (!(std::isalpha(first) || s[0] == '_')) return false;
    for (size_t i = 1; i < s.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        if (!(std::isalnum(c) || s[i] == '_')) return false;
    }
    return true;
}

bool CalcJsCompiler::isNumericString(const std::string& s) {
    // page: !isNaN(str) && !isNaN(parseFloat(str)) — full consumption with at
    // least one digit matches for every token shape the tokenizer emits.
    if (s.empty()) return false;
    bool hasDigit = false;
    for (char c : s) if (std::isdigit(static_cast<unsigned char>(c))) hasDigit = true;
    if (!hasDigit) return false;
    char* end = nullptr;
    std::strtod(s.c_str(), &end);
    return end == s.c_str() + s.size();
}

std::string CalcJsCompiler::toLower(const std::string& s) {
    std::string out = s;
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

long CalcJsCompiler::findMatchingParen(const Tokens& tokens, long openIdx) {
    long balance = 0;
    for (long i = openIdx; i < static_cast<long>(tokens.size()); ++i) {
        if (tokens[i] == "(") ++balance;
        else if (tokens[i] == ")") --balance;
        if (balance == 0) return i;
    }
    return -1;
}

long CalcJsCompiler::findMatchingParenBackwards(const Tokens& tokens, long closeIdx) {
    long balance = 0;
    for (long i = closeIdx; i >= 0; --i) {
        if (tokens[i] == ")") ++balance;
        else if (tokens[i] == "(") --balance;
        if (balance == 0) return i;
    }
    return -1;
}

bool CalcJsCompiler::extractArguments(const Tokens& tokens, long openIdx, long closeIdx,
                                      int expected, std::vector<Tokens>& out) {
    Tokens argTokens(tokens.begin() + openIdx + 1, tokens.begin() + closeIdx);
    if (expected == 0) {
        if (!argTokens.empty()) return fail("语法错误-参数数量有误！");
        return true;
    }
    if (argTokens.empty()) return fail("语法错误-参数数量有误！");

    std::vector<Tokens> args;
    Tokens current;
    long balance = 0;
    for (const auto& token : argTokens) {
        if (token == "(") ++balance;
        else if (token == ")") --balance;
        if (token == "," && balance == 0) {
            if (current.empty()) return fail("语法错误-参数输入错误！");
            args.push_back(current);
            current.clear();
        } else {
            current.push_back(token);
        }
    }
    if (!current.empty() || static_cast<int>(args.size()) < expected) {
        if (current.empty() && static_cast<int>(args.size()) == expected - 1 && expected > 0) {
            return fail("语法错误-参数输入错误！");
        }
        args.push_back(current);
    }
    if (static_cast<int>(args.size()) != expected) return fail("语法错误-参数输入错误！");
    for (auto& arg : args) {
        if (arg.empty()) arg.push_back(""); // page: arg.length === 0 ? [''] : arg
        out.push_back(arg);
    }
    return true;
}

bool CalcJsCompiler::containsIdentifier(const Tokens& tokens, const std::vector<std::string>& names) {
    if (names.empty()) return false;
    for (const auto& t : tokens) {
        if (!isLetter(t)) continue;
        for (const auto& name : names) if (t == name) return true;
    }
    return false;
}

std::string CalcJsCompiler::join(const Tokens& tokens) {
    std::string out;
    for (const auto& t : tokens) out += t;
    return out;
}

// ---- expandCustomFunctions -------------------------------------------------
// Port of calcJSUtils.expandCustomFunctions (simple custom functions only;
// advanced custom calls are left as tokens — the page's grouping of their
// arguments expands to the same stream, and the pristine-advanced gate runs
// on the JS side before compiling).
CalcJsCompiler::Tokens CalcJsCompiler::expandCustomFunctions(const Tokens& tokens,
                                                             const std::vector<std::string>& shadows,
                                                             int depth) {
    Tokens result;
    if (depth > 50) {
        fail("函数定义可能存在循环引用或嵌套过深");
        return result;
    }
    auto isShadowed = [&](const std::string& t) {
        return std::find(shadows.begin(), shadows.end(), t) != shadows.end();
    };

    size_t i = 0;
    while (i < tokens.size() && error_.empty()) {
        const std::string& token = tokens[i];

        if (isLargeOp(token) && i + 1 < tokens.size() && tokens[i + 1] == "(") {
            const long openIdx = static_cast<long>(i) + 1;
            const long closeIdx = findMatchingParen(tokens, openIdx);
            bool continued = false;
            if (closeIdx != -1) {
                const int expected = token == "diff" ? 2 : (token == "diffat" ? 3 : 4);
                std::vector<Tokens> args;
                if (extractArguments(tokens, openIdx, closeIdx, expected, args)) {
                    std::string boundVar;
                    if (args[1].size() == 1 && isLetter(args[1][0])) boundVar = toLower(args[1][0]);
                    std::vector<std::string> bodyShadows = shadows;
                    if (!boundVar.empty()) bodyShadows.push_back(boundVar);

                    std::vector<Tokens> processedArgs;
                    processedArgs.push_back(expandCustomFunctions(args[0], bodyShadows, depth));
                    processedArgs.push_back(args[1]);
                    for (size_t k = 2; k < args.size(); ++k) {
                        processedArgs.push_back(expandCustomFunctions(args[k], shadows, depth));
                    }
                    if (!error_.empty()) return result;

                    result.push_back(token);
                    result.push_back("(");
                    for (size_t k = 0; k < processedArgs.size(); ++k) {
                        if (k > 0) result.push_back(",");
                        result.insert(result.end(), processedArgs[k].begin(), processedArgs[k].end());
                    }
                    result.push_back(")");
                    i = static_cast<size_t>(closeIdx) + 1;
                    continued = true;
                } else {
                    error_.clear(); // page: try/catch falls through to plain handling
                }
            }
            if (continued) continue;
        }

        const bool isSimpleCustom = isCalc3(token);
        if (isSimpleCustom && !isShadowed(token)) {
            if (i + 1 < tokens.size() && tokens[i + 1] == "(") {
                const long openIdx = static_cast<long>(i) + 1;
                const long closeIdx = findMatchingParen(tokens, openIdx);
                bool consumed = false;
                if (closeIdx != -1) {
                    const CalcJsUserFn* fn = findUserFn(token);
                    if (fn) {
                        std::vector<Tokens> argValues;
                        const bool okArgs = extractArguments(tokens, openIdx, closeIdx,
                                                             static_cast<int>(fn->params.size()), argValues);
                        if (okArgs) {
                            std::vector<Tokens> processedArgs;
                            for (const auto& arg : argValues) {
                                processedArgs.push_back(expandCustomFunctions(arg, shadows, depth));
                            }
                            if (!error_.empty()) return result;

                            Tokens substituted = uniqueifyLocals(fn->bodyTokens);
                            Tokens expandedBody;
                            for (const auto& bodyToken : substituted) {
                                const std::string lower = toLower(bodyToken);
                                int paramIndex = -1;
                                for (size_t p = 0; p < fn->params.size(); ++p) {
                                    if (fn->params[p] == lower) { paramIndex = static_cast<int>(p); break; }
                                }
                                if (paramIndex >= 0) {
                                    expandedBody.push_back("(");
                                    const Tokens& arg = processedArgs[static_cast<size_t>(paramIndex)];
                                    expandedBody.insert(expandedBody.end(), arg.begin(), arg.end());
                                    expandedBody.push_back(")");
                                } else {
                                    expandedBody.push_back(bodyToken);
                                }
                            }
                            Tokens body = expandCustomFunctions(expandedBody, shadows, depth + 1);
                            if (!error_.empty()) return result;
                            result.push_back("(");
                            result.insert(result.end(), body.begin(), body.end());
                            result.push_back(")");
                            i = static_cast<size_t>(closeIdx) + 1;
                            consumed = true;
                        } else {
                            error_.clear(); // fall through like the page's catch
                        }
                    }
                }
                if (consumed) continue;
            }
        }

        result.push_back(token);
        ++i;
    }
    return result;
}

// ---- uniqueifyLocals -------------------------------------------------------
CalcJsCompiler::Tokens CalcJsCompiler::uniqueifyLocals(const Tokens& inputTokens) {
    Tokens result;
    size_t i = 0;
    while (i < inputTokens.size()) {
        const std::string& token = inputTokens[i];
        if (isLargeOp(token) && i + 1 < inputTokens.size() && inputTokens[i + 1] == "(") {
            const long openParenIdx = static_cast<long>(i) + 1;
            const long closeParenIdx = findMatchingParen(inputTokens, openParenIdx);
            if (closeParenIdx == -1) {
                result.push_back(token);
                ++i;
                continue;
            }
            const int expected = token == "diff" ? 2 : (token == "diffat" ? 3 : 4);
            std::vector<Tokens> args;
            if (!extractArguments(inputTokens, openParenIdx, closeParenIdx, expected, args)) {
                error_.clear(); // page: catch -> push token, move on
                result.push_back(token);
                ++i;
                continue;
            }
            const std::string oldVarName = args[1][0];
            const std::string newVarName = oldVarName + "_uid_" + std::to_string(uidCounter_++);

            Tokens processedBody = uniqueifyLocals(args[0]);
            Tokens processedStart = uniqueifyLocals(args[2]);
            Tokens processedEnd = args.size() > 3 ? uniqueifyLocals(args[3]) : Tokens{};

            Tokens finalBody;
            size_t k = 0;
            while (k < processedBody.size()) {
                const std::string& t = processedBody[k];
                bool copiedVerbatim = false;
                if (isLargeOp(t) && k + 1 < processedBody.size() && processedBody[k + 1] == "(") {
                    const long nOpen = static_cast<long>(k) + 1;
                    const long nClose = findMatchingParen(processedBody, nOpen);
                    if (nClose != -1) {
                        const int nExpected = t == "diff" ? 2 : (t == "diffat" ? 3 : 4);
                        std::vector<Tokens> nArgs;
                        if (extractArguments(processedBody, nOpen, nClose, nExpected, nArgs)) {
                            const std::string nVar = nArgs[1][0];
                            if (nVar == oldVarName) {
                                // Nested operator binding the same variable is
                                // self-consistent; copy it unchanged (page quirk).
                                for (long m = static_cast<long>(k); m <= nClose; ++m) {
                                    finalBody.push_back(processedBody[static_cast<size_t>(m)]);
                                }
                                k = static_cast<size_t>(nClose) + 1;
                                copiedVerbatim = true;
                            }
                        } else {
                            error_.clear();
                        }
                    }
                }
                if (copiedVerbatim) continue;
                finalBody.push_back(t == oldVarName ? newVarName : t);
                ++k;
            }

            result.push_back(token);
            result.push_back("(");
            result.insert(result.end(), finalBody.begin(), finalBody.end());
            result.push_back(",");
            result.push_back(newVarName);
            result.push_back(",");
            result.insert(result.end(), processedStart.begin(), processedStart.end());
            if (args.size() > 3) {
                result.push_back(",");
                result.insert(result.end(), processedEnd.begin(), processedEnd.end());
            }
            result.push_back(")");
            i = static_cast<size_t>(closeParenIdx) + 1;
        } else {
            result.push_back(token);
            ++i;
        }
    }
    return result;
}

// ---- expandDiffOperations --------------------------------------------------
CalcJsCompiler::Tokens CalcJsCompiler::substituteInTokens(const Tokens& target,
                                                          const std::string& variable,
                                                          const Tokens& replacement) {
    Tokens result;
    size_t i = 0;
    while (i < target.size()) {
        const std::string& token = target[i];
        if (isLargeOp(token) && i + 1 < target.size() && target[i + 1] == "(") {
            const long openParenIdx = static_cast<long>(i) + 1;
            const long closeParenIdx = findMatchingParen(target, openParenIdx);
            if (closeParenIdx == -1) {
                result.push_back(token);
                ++i;
                continue;
            }
            const int expected = token == "diff" ? 2 : (token == "diffat" ? 3 : 4);
            std::vector<Tokens> args;
            if (!extractArguments(target, openParenIdx, closeParenIdx, expected, args)) {
                error_.clear(); // page: catch -> plain token
                result.push_back(token);
                ++i;
                continue;
            }
            const std::string boundVarToken = args[1][0];
            const bool isShadowed = boundVarToken == variable;

            result.push_back(token);
            result.push_back("(");
            if (isShadowed) {
                result.insert(result.end(), args[0].begin(), args[0].end());
            } else {
                Tokens sub = substituteInTokens(args[0], variable, replacement);
                result.insert(result.end(), sub.begin(), sub.end());
            }
            result.push_back(",");
            result.insert(result.end(), args[1].begin(), args[1].end());
            for (size_t k = 2; k < args.size(); ++k) {
                result.push_back(",");
                Tokens sub = substituteInTokens(args[k], variable, replacement);
                result.insert(result.end(), sub.begin(), sub.end());
            }
            result.push_back(")");
            i = static_cast<size_t>(closeParenIdx) + 1;
        } else if (token == variable) {
            result.push_back("(");
            result.insert(result.end(), replacement.begin(), replacement.end());
            result.push_back(")");
            ++i;
        } else {
            result.push_back(token);
            ++i;
        }
    }
    return result;
}

CalcJsCompiler::Tokens CalcJsCompiler::expandDiffOperations(const Tokens& initialTokens) {
    Tokens tokens = initialTokens;
    bool expandedSomething = true;
    int iterationGuard = 0;
    const int kMaxExpansionIterations = 50;
    const std::string hStr = "0.00001";
    const std::string hInv2hStr = "50000";

    while (expandedSomething && iterationGuard < kMaxExpansionIterations) {
        expandedSomething = false;
        ++iterationGuard;
        size_t i = 0;
        while (i < tokens.size()) {
            const std::string& token = tokens[i];
            if (token == "diff" || token == "diffat") {
                const std::string opName = token;
                if (i + 1 >= tokens.size() || tokens[i + 1] != "(") {
                    fail("语法错误-括号匹配错误！");
                    return {};
                }
                const long openParenIdx = static_cast<long>(i) + 1;
                const long closeParenIdx = findMatchingParen(tokens, openParenIdx);
                if (closeParenIdx == -1) {
                    fail("语法错误-括号匹配错误！");
                    return {};
                }
                const int expected = opName == "diff" ? 2 : 3;
                std::vector<Tokens> argList;
                if (!extractArguments(tokens, openParenIdx, closeParenIdx, expected, argList)) {
                    return {};
                }
                Tokens exprTokens = argList[0];
                Tokens varNameTokens = argList[1];
                if (varNameTokens.size() == 3 && varNameTokens[0] == "(" && varNameTokens[2] == ")" &&
                    isLetter(varNameTokens[1]) && varNameTokens[1].size() == 1) {
                    varNameTokens = Tokens{varNameTokens[1]};
                }
                if (varNameTokens.size() != 1 || !isLetter(varNameTokens[0]) ||
                    isCalc1(varNameTokens[0]) || isConstant(varNameTokens[0])) {
                    fail("语法错误-变量语法错误，请检查算式！");
                    return {};
                }
                const std::string varName = varNameTokens[0];

                Tokens pointTokens;
                if (opName == "diffat") {
                    pointTokens = argList[2];
                    Tokens preProcessed = expandCustomFunctions(pointTokens, {}, 0);
                    if (!error_.empty()) return {};
                    pointTokens = expandDiffOperations(preProcessed);
                    if (!error_.empty()) return {};
                }

                Tokens plusH, minusH;
                if (opName == "diff") {
                    plusH = Tokens{"(", varName, "+", hStr, ")"};
                    minusH = Tokens{"(", varName, "-", hStr, ")"};
                } else {
                    plusH = Tokens{"("};
                    plusH.insert(plusH.end(), pointTokens.begin(), pointTokens.end());
                    plusH.insert(plusH.end(), {"+", hStr, ")"});
                    minusH = Tokens{"("};
                    minusH.insert(minusH.end(), pointTokens.begin(), pointTokens.end());
                    minusH.insert(minusH.end(), {"-", hStr, ")"});
                }

                Tokens finalExpansion;
                finalExpansion.push_back("(");
                finalExpansion.push_back("(");
                Tokens subPlus = substituteInTokens(exprTokens, varName, plusH);
                finalExpansion.insert(finalExpansion.end(), subPlus.begin(), subPlus.end());
                finalExpansion.push_back(")");
                finalExpansion.push_back("-");
                finalExpansion.push_back("(");
                Tokens subMinus = substituteInTokens(exprTokens, varName, minusH);
                finalExpansion.insert(finalExpansion.end(), subMinus.begin(), subMinus.end());
                finalExpansion.push_back(")");
                finalExpansion.push_back(")");
                finalExpansion.push_back("*");
                finalExpansion.push_back(hInv2hStr);

                tokens.erase(tokens.begin() + static_cast<long>(i),
                             tokens.begin() + closeParenIdx + 1);
                tokens.insert(tokens.begin() + static_cast<long>(i),
                              finalExpansion.begin(), finalExpansion.end());
                expandedSomething = true;
                i = static_cast<size_t>(-1);
            }
            ++i;
        }
    }
    if (iterationGuard >= kMaxExpansionIterations && expandedSomething) {
        fail("语法错误-循环解析错误，请检查！");
        return {};
    }
    return tokens;
}

// ---- processTokensForEval --------------------------------------------------
CalcJsCompiler::Tokens CalcJsCompiler::processTokensForEval(const Tokens& inputTokens) {
    Tokens result;
    const size_t n = inputTokens.size();
    for (size_t i = 0; i < n; ++i) {
        const std::string& token = inputTokens[i];
        result.push_back(token);

        const bool isCurrentNumber = isNumericString(token);
        const bool isCurrentClosingParen = token == ")";
        const bool isCurrentKnownName = isCalc1(token) || isCalc3(token) || isAdvName(token) || isConstant(token);
        const bool isCurrentVariable = isLetter(token) && !isCurrentKnownName && !isConstant(token);

        if (i + 1 < n && inputTokens[i + 1] != ")" &&
            inputTokens[i + 1] != "+" && inputTokens[i + 1] != "-" &&
            inputTokens[i + 1] != "*" && inputTokens[i + 1] != "/" &&
            inputTokens[i + 1] != "^" && inputTokens[i + 1] != ",") {
            const std::string& next = inputTokens[i + 1];
            const bool nextIsNumber = isNumericString(next);
            const bool nextIsKnownName = isCalc1(next) || isCalc3(next) || isAdvName(next) || isConstant(next);
            const bool nextIsVariable = isLetter(next) && !nextIsKnownName && !isConstant(next);
            const bool nextIsOpeningParen = next == "(";

            const bool currentCanMultiply =
                isCurrentNumber || isCurrentClosingParen || isCurrentVariable ||
                (isCurrentKnownName && token != "(" && !isCalc1(token) && !isCalc3(token) && !isAdvName(token)) ||
                isConstant(token);
            const bool nextCanBeMultiplied =
                nextIsNumber || nextIsVariable ||
                (nextIsKnownName && !isCalc1(next) && !isCalc3(next) && !isAdvName(next)) ||
                isConstant(next) || nextIsOpeningParen ||
                (isCalc1(next) || isCalc3(next) || isAdvName(next));
            const bool isCurrentFuncName = isCalc1(token) || isCalc3(token) || isAdvName(token);

            if (isCurrentFuncName && next == "(") {
                // function call: no multiplication
            } else if (currentCanMultiply && nextCanBeMultiplied) {
                result.push_back("*");
            }
        }
    }

    // `^` rewrite, scanning right to left (page: calcJSUtils.processTokensForEval).
    long i = static_cast<long>(result.size()) - 1;
    while (i >= 0 && error_.empty()) {
        if (result[static_cast<size_t>(i)] == "^") {
            const long size = static_cast<long>(result.size());
            long rightStart = i + 1;
            long rightEnd = rightStart;
            const bool prevOk = i == 0 ||
                result[static_cast<size_t>(i - 1)] == "(" || result[static_cast<size_t>(i - 1)] == "^" ||
                result[static_cast<size_t>(i - 1)] == "," || result[static_cast<size_t>(i - 1)] == "*" ||
                result[static_cast<size_t>(i - 1)] == "/" || result[static_cast<size_t>(i - 1)] == "+" ||
                result[static_cast<size_t>(i - 1)] == "-";
            if (rightStart < size && result[static_cast<size_t>(rightStart)] == "-" && prevOk) {
                ++rightStart;
                ++rightEnd;
            }
            if (rightStart < size && result[static_cast<size_t>(rightStart)] == "(") {
                rightEnd = findMatchingParen(result, rightStart);
            } else if (rightStart < size &&
                       (isCalc1(result[static_cast<size_t>(rightStart)]) ||
                        isCalc3(result[static_cast<size_t>(rightStart)]) ||
                        isAdvName(result[static_cast<size_t>(rightStart)])) &&
                       rightStart + 1 < size && result[static_cast<size_t>(rightStart) + 1] == "(") {
                rightEnd = findMatchingParen(result, rightStart + 1);
            }
            long leftEnd = i - 1;
            long leftStart = leftEnd;
            if (leftEnd >= 0 && result[static_cast<size_t>(leftEnd)] == ")") {
                leftStart = findMatchingParenBackwards(result, leftEnd);
                if (leftStart > 0) {
                    const std::string& beforeParen = result[static_cast<size_t>(leftStart) - 1];
                    if (isCalc1(beforeParen) || isCalc3(beforeParen) || isAdvName(beforeParen)) {
                        --leftStart;
                    }
                }
            }
            if (leftStart < 0 || rightEnd < 0 || rightEnd >= size) {
                fail("malformed power expression");
                return {};
            }
            Tokens replacement;
            replacement.push_back("__advanced__.pow");
            replacement.push_back("(");
            replacement.insert(replacement.end(), result.begin() + leftStart, result.begin() + leftEnd + 1);
            replacement.push_back(",");
            replacement.insert(replacement.end(), result.begin() + i + 1, result.begin() + rightEnd + 1);
            replacement.push_back(")");
            result.erase(result.begin() + leftStart, result.begin() + rightEnd + 1);
            result.insert(result.begin() + leftStart, replacement.begin(), replacement.end());
            i = static_cast<long>(result.size());
        }
        --i;
    }

    // Final name mapping.
    Tokens mapped;
    mapped.reserve(result.size());
    for (const auto& token : result) {
        if (token == "sum" || token == "prod" || token == "int") {
            mapped.push_back(token);
        } else if (isCalc1(token)) {
            if (token == "ln") mapped.push_back("Math.log");
            else if (token == "lg") mapped.push_back("Math.log10");
            else if (token == "log") mapped.push_back("Math.log10");
            else mapped.push_back("Math." + token);
        } else if (isAdvName(token)) {
            mapped.push_back("__advanced__." + token);
        } else if (isConstant(token)) {
            mapped.push_back(token == "e" ? kConstE : kConstPi);
        } else {
            mapped.push_back(token);
        }
    }
    return mapped;
}

// ---- checkLargeOps ---------------------------------------------------------
// Structural mirror of the page's nesting: finds every sum/prod/int call and
// checks its bounds (and, in eager position, its body) against the enclosing
// loop variables. The page evaluates bounds before substituting the enclosing
// variable, so such a reference binds to the outer scope — which the
// structured Loop cannot express. Rejecting keeps the JS path (identical
// outcome there).
bool CalcJsCompiler::checkLargeOps(const Tokens& tokens, const std::vector<std::string>& enclosing,
                                   bool inEager) {
    size_t i = 0;
    while (i < tokens.size()) {
        if (isCalcLargeOp(tokens[i]) && i + 1 < tokens.size() && tokens[i + 1] == "(") {
            const long openIdx = static_cast<long>(i) + 1;
            const long closeIdx = findMatchingParen(tokens, openIdx);
            if (closeIdx < 0) return fail(tokens[i] + " 的括号不匹配");
            std::vector<Tokens> args;
            if (extractArguments(tokens, openIdx, closeIdx, 4, args)) {
                if (containsIdentifier(args[2], enclosing) || containsIdentifier(args[3], enclosing)) {
                    return fail("loop bounds reference an enclosing loop variable");
                }
                if (inEager && containsIdentifier(args[0], enclosing)) {
                    return fail("loop body in eager position references an enclosing loop variable");
                }
                std::vector<std::string> bodyEnclosing = enclosing;
                if (args[1].size() == 1) bodyEnclosing.push_back(args[1][0]);
                if (!checkLargeOps(args[0], bodyEnclosing, inEager)) return false;
                if (!checkLargeOps(args[2], enclosing, true)) return false;
                if (!checkLargeOps(args[3], enclosing, true)) return false;
                i = static_cast<size_t>(closeIdx) + 1;
                continue;
            }
            error_.clear(); // page: fall through to plain handling
        }
        ++i;
    }
    return true;
}

// ---- lowerLargeOps ---------------------------------------------------------
std::string CalcJsCompiler::lowerLargeOps(const Tokens& tokens) {
    Tokens current = tokens;
    int passes = 0;
    while (true) {
        long found = -1;
        for (long k = static_cast<long>(current.size()) - 1; k >= 0; --k) {
            if (isCalcLargeOp(current[static_cast<size_t>(k)]) &&
                k + 1 < static_cast<long>(current.size()) &&
                current[static_cast<size_t>(k) + 1] == "(") {
                found = k;
                break;
            }
        }
        if (found < 0) break;
        if (++passes > 20) {
            // page leaves the operators unexpanded after 20 passes and the
            // final JS evaluation fails; reject so the JS path produces that.
            fail("macro expansion pass limit");
            return "";
        }
        const std::string opToken = current[static_cast<size_t>(found)];
        const long openIdx = found + 1;
        const long closeIdx = findMatchingParen(current, openIdx);
        if (closeIdx < 0) {
            fail(opToken + " 的括号不匹配");
            return "";
        }
        std::vector<Tokens> args;
        if (!extractArguments(current, openIdx, closeIdx, 4, args)) {
            fail("malformed large operator");
            return "";
        }
        if (args[1].size() != 1 || !isLetter(args[1][0])) {
            fail(opToken + " 的第二个参数必须是变量名");
            return "";
        }
        const std::string varName = args[1][0];
        // A binder colliding with a known name cannot be reproduced
        // structurally (the page substitutes its tokens textually, even
        // inside calls named like it); keep those on the JS path.
        if (isCalc1(varName) || isCalc3(varName) || isAdvName(varName) || isConstant(varName)) {
            fail("loop variable shadows a known name: " + varName);
            return "";
        }

        const std::string bodyStr = join(args[0]);
        const std::string startStr = join(args[2]);
        const std::string endStr = join(args[3]);

        std::string call = opToken == "sum" ? "Math.__archsum" :
                           opToken == "prod" ? "Math.__archprod" : "Math.__archint";
        Tokens rebuilt;
        rebuilt.insert(rebuilt.end(), current.begin(), current.begin() + found);
        rebuilt.push_back(call);
        rebuilt.push_back("(");
        rebuilt.push_back(bodyStr);
        rebuilt.push_back(",");
        rebuilt.push_back(varName);
        rebuilt.push_back(",");
        rebuilt.push_back(startStr);
        rebuilt.push_back(",");
        rebuilt.push_back(endStr);
        if (opToken == "int") {
            double steps = integralSteps_;
            if (steps == 0.0 || JsMath::isNaN(steps)) steps = 50.0;
            char buf[48];
            if (steps == std::floor(steps) && std::fabs(steps) < 1e15) {
                std::snprintf(buf, sizeof buf, "%.0f", steps);
            } else {
                std::snprintf(buf, sizeof buf, "%.17g", steps);
            }
            rebuilt.push_back(",");
            rebuilt.push_back(buf);
        }
        rebuilt.push_back(")");
        rebuilt.insert(rebuilt.end(), current.begin() + closeIdx + 1, current.end());
        current.swap(rebuilt);
    }
    return join(current);
}

// ---- run -------------------------------------------------------------------
bool CalcJsCompiler::run(const std::string& source,
                         const std::vector<CalcJsUserFn>& userFns,
                         double integralSteps,
                         std::string& outJs) {
    error_.clear();
    userFns_ = userFns;
    integralSteps_ = integralSteps;
    uidCounter_ = 0;

    Tokenizer tokenizer(Tokenizer::Dialect::CalcJs);
    // Phase-1 symbol split: calc1 (built into the tokenizer) plus simple
    // custom function names and ported advanced function names — the page's
    // opDetails set. "pow" is registered on the page but special-cased by
    // the VM, so it is listed explicitly.
    std::vector<std::string> symbols;
    for (const auto& fn : userFns_) symbols.push_back(fn.name);
    const int advCount = advancedFunctionCount();
    for (int k = 0; k < advCount; ++k) {
        const char* name = advancedFunctionNameAt(k);
        if (name) symbols.emplace_back(name);
    }
    symbols.emplace_back("pow");
    tokenizer.setCalcJsSymbols(std::move(symbols));

    std::vector<Token> lexed = tokenizer.tokenize(source);
    if (tokenizer.hasError()) return fail(tokenizer.getError());
    Tokens tokens;
    tokens.reserve(lexed.size());
    for (const auto& t : lexed) {
        if (t.type == TokenType::End) break;
        tokens.push_back(t.value);
    }

    tokens = expandCustomFunctions(tokens, {}, 0);
    if (!error_.empty()) return false;
    tokens = expandDiffOperations(tokens);
    if (!error_.empty()) return false;
    tokens = processTokensForEval(tokens);
    if (!error_.empty()) return false;
    if (!checkLargeOps(tokens, {}, false)) return false;
    outJs = lowerLargeOps(tokens);
    if (!error_.empty()) return false;
    if (outJs.empty()) return fail("empty expression");
    return true;
}

} // namespace Core
} // namespace ArchMaths
