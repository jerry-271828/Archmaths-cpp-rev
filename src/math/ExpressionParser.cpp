#include "math/ExpressionParser.h"

// Debug tracing of user-function expansion (native builds only; the wasm core
// defines ARCHMATHS_NO_PARSER_TRACE to keep iostream out of the binary).
#ifdef ARCHMATHS_NO_PARSER_TRACE
#define PARSER_TRACE(msg) do {} while (0)
#else
#include <iostream>
#define PARSER_TRACE(msg) do { std::cerr << msg << std::endl; } while (0)
#endif

namespace ArchMaths {

ExpressionParser::ExpressionParser(Tokenizer::Dialect dialect) : tokenizer_(dialect) {}

bool ExpressionParser::isUserFunctionDefinition(const std::string& expression) const {
    // 简单检测: 查找 name(params) = body 模式
    size_t parenOpen = expression.find('(');
    if (parenOpen == std::string::npos || parenOpen == 0) return false;
    size_t parenClose = expression.find(')', parenOpen);
    if (parenClose == std::string::npos) return false;
    size_t eqPos = expression.find('=', parenClose);
    return eqPos != std::string::npos;
}

ExprNodePtr ExpressionParser::parse(const std::string& expression) {
    hasError_ = false;
    errorMessage_.clear();
    currentIndex_ = 0;

    if (tokenizer_.dialect() == Tokenizer::Dialect::CalcJs) {
        // CalcJs goes through Program::compileCalcJs (page token pipeline +
        // large-operator lowering), not the generic recursive-descent parse.
        return fail("CalcJs dialect must be compiled via Program::compileCalcJs");
    }

    tokens_ = tokenizer_.tokenize(expression);
    if (tokenizer_.hasError()) {
        return fail(tokenizer_.getError());
    }

    auto result = parseExpression();
    if (hasError_) {
        return nullptr;
    }
    if (currentToken().type != TokenType::End) {
        return fail("意外的标记: " + currentToken().value);
    }
    return result;
}

ExprNodePtr ExpressionParser::fail(const std::string& errorMsg) {
    if (!hasError_) {
        hasError_ = true;
        errorMessage_ = errorMsg;
    }
    return nullptr;
}

Token ExpressionParser::currentToken() const {
    if (currentIndex_ < tokens_.size()) {
        return tokens_[currentIndex_];
    }
    return Token(TokenType::End, "");
}

Token ExpressionParser::nextToken() {
    if (currentIndex_ < tokens_.size()) {
        return tokens_[currentIndex_++];
    }
    return Token(TokenType::End, "");
}

bool ExpressionParser::match(TokenType type) {
    if (currentToken().type == type) {
        nextToken();
        return true;
    }
    return false;
}

bool ExpressionParser::expect(TokenType type, const std::string& errorMsg) {
    if (!match(type)) {
        fail(errorMsg);
        return false;
    }
    return true;
}

ExprNodePtr ExpressionParser::parseExpression() {
    return parseComparison();
}

ExprNodePtr ExpressionParser::parseComparison() {
    auto left = parseAddSub();
    if (!left) return nullptr;

    while (true) {
        Token token = currentToken();
        if (token.type == TokenType::Equals ||
            token.type == TokenType::LessThan ||
            token.type == TokenType::GreaterThan ||
            token.type == TokenType::LessEqual ||
            token.type == TokenType::GreaterEqual) {
            nextToken();
            auto right = parseAddSub();
            if (!right) return nullptr;
            // 对于隐函数，转换为 left - right 形式
            left = ExprNode::makeBinaryOp("-", left, right);
        } else {
            break;
        }
    }

    return left;
}

ExprNodePtr ExpressionParser::parseAddSub() {
    auto left = parseMulDiv();
    if (!left) return nullptr;

    while (true) {
        Token token = currentToken();
        if (token.type == TokenType::Operator &&
            (token.value == "+" || token.value == "-")) {
            nextToken();
            auto right = parseMulDiv();
            if (!right) return nullptr;
            left = ExprNode::makeBinaryOp(token.value, left, right);
        } else {
            break;
        }
    }

    return left;
}

ExprNodePtr ExpressionParser::parseMulDiv() {
    auto left = parsePower();
    if (!left) return nullptr;

    while (true) {
        Token token = currentToken();
        if (token.type == TokenType::Operator &&
            (token.value == "*" || token.value == "/")) {
            nextToken();
            auto right = parsePower();
            if (!right) return nullptr;
            left = ExprNode::makeBinaryOp(token.value, left, right);
        }
        // 隐式乘法: 2x, x(y+1), (x+1)(y+1)
        // (JavaScript has no implicit products; the JS dialect stops here.)
        else if (!isJsSubset() &&
                 (token.type == TokenType::Number ||
                 token.type == TokenType::Variable ||
                 token.type == TokenType::Function ||
                 token.type == TokenType::LeftParen)) {
            auto right = parsePower();
            if (!right) return nullptr;
            left = ExprNode::makeBinaryOp("*", left, right);
        } else {
            break;
        }
    }

    return left;
}

ExprNodePtr ExpressionParser::parsePower() {
    auto left = parseUnary();
    if (!left) return nullptr;

    if (currentToken().type == TokenType::Operator &&
        currentToken().value == "^") {
        nextToken();
        auto right = parsePower(); // 右结合
        if (!right) return nullptr;
        return ExprNode::makeBinaryOp("^", left, right);
    }

    return left;
}

ExprNodePtr ExpressionParser::parseUnary() {
    Token token = currentToken();

    if (token.type == TokenType::Operator && token.value == "-") {
        nextToken();
        auto operand = parseUnary();
        if (!operand) return nullptr;
        return ExprNode::makeUnaryOp("-", operand);
    }

    if (token.type == TokenType::Operator && token.value == "+") {
        nextToken();
        return parseUnary();
    }

    return parsePrimary();
}

ExprNodePtr ExpressionParser::parsePrimary() {
    Token token = currentToken();

    // 数字
    if (token.type == TokenType::Number) {
        nextToken();
        return ExprNode::makeNumber(token.numValue);
    }

    // 函数调用
    if (token.type == TokenType::Function) {
        nextToken();
        return parseFunction(token.value);
    }

    // 变量 - 检查是否是用户自定义函数调用
    if (token.type == TokenType::Variable) {
        std::string varName = token.value;
        nextToken();

        // 检查是否后面跟着左括号且是用户自定义函数
        if (currentToken().type == TokenType::LeftParen && isJsSubset()) {
            return fail("调用非函数: " + varName);
        }
        if (currentToken().type == TokenType::LeftParen && userFunctions_ && userFunctions_->count(varName) > 0) {
            PARSER_TRACE("Found user function call: " << varName);
            return parseFunction(varName);
        }

        return ExprNode::makeVariable(varName);
    }

    // 括号表达式
    if (token.type == TokenType::LeftParen) {
        nextToken();
        auto expr = parseExpression();
        if (!expr) return nullptr;
        if (!expect(TokenType::RightParen, "缺少右括号")) return nullptr;
        return expr;
    }

    return fail("意外的标记: " + token.value);
}

ExprNodePtr ExpressionParser::parseFunction(const std::string& name) {
    PARSER_TRACE("parseFunction called for: " << name);
    if (!expect(TokenType::LeftParen, "函数调用缺少左括号")) return nullptr;

    std::vector<ExprNodePtr> args;

    if (currentToken().type != TokenType::RightParen) {
        auto arg = parseExpression();
        if (!arg) return nullptr;
        args.push_back(arg);

        while (currentToken().type == TokenType::Comma) {
            nextToken();
            arg = parseExpression();
            if (!arg) return nullptr;
            args.push_back(arg);
        }
    }

    if (!expect(TokenType::RightParen, "函数调用缺少右括号")) return nullptr;
    PARSER_TRACE("parseFunction: parsed " << args.size() << " args");

    // 检查是否是用户自定义函数
    if (userFunctions_) {
        auto it = userFunctions_->find(name);
        if (it != userFunctions_->end()) {
            PARSER_TRACE("Calling substituteUserFunction for: " << name);
            auto result = substituteUserFunction(name, args);
            PARSER_TRACE("substituteUserFunction returned, result=" << (result ? "valid" : "null"));
            return result;
        }
    }

    return ExprNode::makeFunction(name, std::move(args));
}

ExprNodePtr ExpressionParser::substituteUserFunction(const std::string& name, const std::vector<ExprNodePtr>& args) {
    PARSER_TRACE("substituteUserFunction: name=" << name << ", args.size()=" << args.size());

    if (!userFunctions_ || userFunctions_->empty()) {
        PARSER_TRACE("substituteUserFunction: no user functions");
        return ExprNode::makeFunction(name, std::vector<ExprNodePtr>(args));
    }

    auto it = userFunctions_->find(name);
    if (it == userFunctions_->end()) {
        PARSER_TRACE("substituteUserFunction: function not found");
        return ExprNode::makeFunction(name, std::vector<ExprNodePtr>(args));
    }

    const UserFunction& func = it->second;
    PARSER_TRACE("substituteUserFunction: bodyStr=" << func.bodyStr << ", params.size()=" << func.params.size());

    if (func.bodyStr.empty()) {
        PARSER_TRACE("substituteUserFunction: empty body");
        return ExprNode::makeFunction(name, std::vector<ExprNodePtr>(args));
    }
    if (args.size() != func.params.size()) {
        return fail("函数 " + name + " 参数数量不匹配: 期望 " +
            std::to_string(func.params.size()) + " 个参数，实际 " + std::to_string(args.size()) + " 个");
    }

    PARSER_TRACE("substituteUserFunction: creating bodyParser");
    // 使用新的解析器实例解析函数体（避免状态污染）
    ExpressionParser bodyParser;
    PARSER_TRACE("substituteUserFunction: parsing body");
    ExprNodePtr bodyExpr = bodyParser.parse(func.bodyStr);
    PARSER_TRACE("substituteUserFunction: body parsed, bodyExpr=" << (bodyExpr ? "valid" : "null"));
    if (!bodyExpr || bodyParser.hasError()) {
        return fail("函数体解析失败: " + bodyParser.getError());
    }

    PARSER_TRACE("substituteUserFunction: building subs map");
    // 构建参数替换映射
    std::unordered_map<std::string, ExprNodePtr> subs;
    for (size_t i = 0; i < func.params.size(); ++i) {
        PARSER_TRACE("substituteUserFunction: param[" << i << "]=" << func.params[i]);
        if (!args[i]) {
            return fail("函数参数为空");
        }
        subs[func.params[i]] = args[i];
    }

    PARSER_TRACE("substituteUserFunction: calling cloneAndSubstitute");
    // 克隆函数体并替换参数
    auto result = cloneAndSubstitute(bodyExpr, subs);
    PARSER_TRACE("substituteUserFunction: cloneAndSubstitute done, result=" << (result ? "valid" : "null"));
    if (!result) {
        return fail("函数替换失败");
    }
    return result;
}

ExprNodePtr ExpressionParser::cloneAndSubstitute(const ExprNodePtr& node, const std::unordered_map<std::string, ExprNodePtr>& subs) {
    if (!node) return nullptr;

    switch (node->type) {
        case NodeType::Number:
            return ExprNode::makeNumber(node->value);

        case NodeType::Variable: {
            auto it = subs.find(node->name);
            if (it != subs.end() && it->second) {
                // 深拷贝替换的表达式 - 使用空map避免无限递归
                return cloneAndSubstitute(it->second, {});
            }
            return ExprNode::makeVariable(node->name);
        }

        case NodeType::BinaryOp: {
            auto left = cloneAndSubstitute(node->left, subs);
            auto right = cloneAndSubstitute(node->right, subs);
            if (!left || !right) return nullptr;
            return ExprNode::makeBinaryOp(node->op, left, right);
        }

        case NodeType::UnaryOp: {
            auto operand = cloneAndSubstitute(node->left, subs);
            if (!operand) return nullptr;
            return ExprNode::makeUnaryOp(node->op, operand);
        }

        case NodeType::Function: {
            std::vector<ExprNodePtr> newArgs;
            for (const auto& arg : node->args) {
                auto newArg = cloneAndSubstitute(arg, subs);
                if (!newArg) return nullptr;
                newArgs.push_back(newArg);
            }
            return ExprNode::makeFunction(node->name, std::move(newArgs));
        }

        default:
            return nullptr;
    }
}

} // namespace ArchMaths
