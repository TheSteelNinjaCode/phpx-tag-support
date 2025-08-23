import ts from "typescript";
import * as vscode from "vscode";

/**
 * Sanitizes PHP-mixed code for TypeScript parsing by replacing PHP blocks with placeholders
 */
function sanitizeForTsParser(text: string): string {
  // Replace PHP short tags and blocks with placeholder values
  return (
    text
      // Replace <?= ... ?> with a placeholder
      .replace(/<\?=\s*[^?]*\?>/g, '"__PHP_VALUE__"')
      // Replace <?php ... ?> with a placeholder
      .replace(/<\?php\s+[^?]*\?>/g, '"__PHP_VALUE__"')
      // Replace standalone <?php blocks (without closing ?>)
      .replace(/<\?php\s+[^?]*$/g, '"__PHP_VALUE__"')
      // Replace any remaining PHP-like patterns
      .replace(/<\?[^?]*\?>/g, '"__PHP_VALUE__"')
  );
}

/**
 * Validates that tuple-style state calls (array destructuring) use exactly one argument.
 */
export function validateStateTupleUsage(
  document: vscode.TextDocument,
  diagCollection: vscode.DiagnosticCollection
): void {
  // Only validate PHP files that might contain mixed PHP/JS code
  if (document.languageId !== "php") {
    return;
  }

  const originalText = document.getText();
  const sanitizedText = sanitizeForTsParser(originalText);

  // Try to parse as TypeScript - if it fails, skip validation
  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(
      document.uri.fsPath,
      sanitizedText,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      ts.ScriptKind.TS
    );
  } catch (error) {
    // If parsing fails, don't show diagnostics
    return;
  }

  const diags: vscode.Diagnostic[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const call = node.initializer;
      const expr = call.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === "pphp" &&
        expr.name.text === "state"
      ) {
        // Tuple form must have exactly one argument
        if (call.arguments.length > 1) {
          // Map positions back to original document
          const start = document.positionAt(call.getStart());
          const end = document.positionAt(call.getEnd());
          const range = new vscode.Range(start, end);
          diags.push(
            new vscode.Diagnostic(
              range,
              "Tuple-style pphp.state(...) must be called with a single initial value argument, not multiple.",
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  diagCollection.set(document.uri, diags);
}
