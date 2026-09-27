#pragma once

#include "math/MathTypes.h"
#include "math/Tokenizer.h"
#include <string>
#include <memory>

namespace ArchMaths {

// Errors are reported through hasError()/getError() rather than exceptions so
// the same parser also builds for the exception-free WebAssembly core.
class ExpressionParser {
public:
    explicit ExpressionParser(Tokenizer::Dialect dialect = Tokenizer::Dialect::Math);

    // 解析表达式字符串，返回AST
    ExprNodePtr parse(const std::string& expression);

    // 获取解析错误信息
    const std::string& getError() const { return errorMessage_; }
    bool hasError() const { return hasError_; }

    // 用户自定义函数管理
    void setUserFunctions(UserFunctionRegistry* registry) { userFunctions_ = registry; }
    bool isUserFunctionDefinition(const std::string& expression) const;

private:
    ExprNodePtr parseExpression();
    ExprNodePtr parseComparison();
    ExprNodePtr parseAddSub();
    ExprNodePtr parseMulDiv();
    ExprNodePtr parsePower();
    ExprNodePtr parseUnary();
    ExprNodePtr parsePrimary();
    ExprNodePtr parseFunction(const std::string& name);

    // 用户函数替换
    ExprNodePtr substituteUserFunction(const std::string& name, const std::vector<ExprNodePtr>& args);
    ExprNodePtr cloneAndSubstitute(const ExprNodePtr& node, const std::unordered_map<std::string, ExprNodePtr>& subs);

    Token currentToken() const;
    Token nextToken();
    bool match(TokenType type);
    bool expect(TokenType type, const std::string& errorMsg);
    ExprNodePtr fail(const std::string& errorMsg);
    bool isJsSubset() const { return tokenizer_.dialect() == Tokenizer::Dialect::JsSubset; }

    Tokenizer tokenizer_;
    std::vector<Token> tokens_;
    size_t currentIndex_ = 0;
    bool hasError_ = false;
    std::string errorMessage_;
    UserFunctionRegistry* userFunctions_ = nullptr;
};

} // namespace ArchMaths
