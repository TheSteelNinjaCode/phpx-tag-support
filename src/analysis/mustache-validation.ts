import * as vscode from "vscode";
import {
  extractMustacheExpressions,
  containsAssignment,
  buildExclusionRanges,
  type MustacheExpression,
} from "./mustache-ast";

/**
 * Validate mustache expressions using AST
 */
export function validateMustacheExpressions(
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const text = document.getText();
  const exclusions = buildExclusionRanges(text);
  const expressions = extractMustacheExpressions(text, exclusions);
  
  const diagnostics: vscode.Diagnostic[] = [];

  for (const expr of expressions) {
    // Check for invalid syntax
    if (!expr.ast && expr.inner.trim()) {
      const range = new vscode.Range(
        document.positionAt(expr.startOffset + 1),
        document.positionAt(expr.endOffset - 1)
      );
      
      diagnostics.push(
        new vscode.Diagnostic(
          range,
          "⚠️ Invalid JavaScript expression in { ... }.",
          vscode.DiagnosticSeverity.Warning
        )
      );
      continue;
    }

    // Check for assignments
    if (containsAssignment(expr)) {
      const range = new vscode.Range(
        document.positionAt(expr.startOffset + 1),
        document.positionAt(expr.endOffset - 1)
      );
      
      diagnostics.push(
        new vscode.Diagnostic(
          range,
          "⚠️ Assignments are not allowed inside { ... }. Use values or pure expressions.",
          vscode.DiagnosticSeverity.Warning
        )
      );
    }
  }

  return diagnostics;
}