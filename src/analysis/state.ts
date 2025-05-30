import ts from "typescript";
import * as vscode from "vscode";

/**
 * Validates that tuple-style state calls (array destructuring) use exactly one argument.
 */
export function validateStateTupleUsage(
  document: vscode.TextDocument,
  diagCollection: vscode.DiagnosticCollection
): void {
  const source = ts.createSourceFile(
    document.uri.fsPath,
    document.getText(),
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS
  );

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
        // Tuple form must have either zero or one argument
        if (call.arguments.length > 1) {
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