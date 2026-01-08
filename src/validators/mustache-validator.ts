import * as vscode from "vscode";
import { parse } from "@babel/parser";
import { parseHTMLDocument } from "../utils/html-parser";

const diagnosticCollection = vscode.languages.createDiagnosticCollection(
  "pulsepoint-mustache"
);

export function registerMustacheValidator(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidSaveTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((e) => validate(e.document)),
    diagnosticCollection
  );

  // Validate currently open documents
  vscode.workspace.textDocuments.forEach(validate);
}

function validate(document: vscode.TextDocument) {
  // Ensure we validate PHP files (and HTML)
  if (document.languageId !== "html" && document.languageId !== "php") return;

  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];

  // Use AST-based HTML parser
  const htmlDoc = parseHTMLDocument(text);

  /**
   * REGEX STRATEGY:
   * 1. Match PHP tags first so we can IGNORE them.
   * UPDATED: Matches `<?php` until `?>` OR End-of-File ($).
   * This fixes the issue in Class files that do not have a closing PHP tag.
   * 2. Match Heredocs explicitly to ensure we don't validate inside them.
   * (Although usually inside PHP tags, this is a safety net).
   * 3. Match PulsePoint syntax ({ ... }) to VALIDATE it.
   */
  const regex =
    /(<\?(?:php|=)[\s\S]*?(?:\?>|$))|(<<<([a-zA-Z0-9_]+)[\s\S]*?\3;)|(\{([^{}]+)\})/gi;

  let match;

  while ((match = regex.exec(text)) !== null) {
    // [1] is PHP Tag (<?php ... ?> or ...EOF)
    // [2] is Heredoc (<<<HTML ... HTML;)
    if (match[1] || match[2]) {
      continue;
    }

    // [4] is PulsePoint match: { ... }
    // [5] is the inner expression: ...
    const expr = match[5]?.trim();

    // Ignore empty expressions
    if (!expr) continue;

    const pos = match.index;

    // Check if position is inside <script>, <style>, or pp-ignore excluded regions
    if (htmlDoc.isInsideExcludedRegion(pos)) {
      continue;
    }

    // 3. Validate the JavaScript expression
    const error = parseExpression(expr);
    if (error) {
      // Calculate range for the full PulsePoint match (match[4])
      const start = document.positionAt(match.index);
      const end = document.positionAt(match.index + match[0].length);

      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(start, end),
          `Invalid JS: ${error}`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }

  diagnosticCollection.set(document.uri, diagnostics);
}

/**
 * Validates the expression using Babel parser.
 * Supports Object Literals (e.g. { ...spread }) common in PulsePoint patterns.
 */
function parseExpression(expr: string): string | null {
  try {
    // Attempt 1: Standard expression validation
    // Example: { user.name } -> parses as (user.name)
    parse(`(${expr})`, { sourceType: "module", plugins: ["jsx"] });
    return null;
  } catch (e: any) {
    // Attempt 2: Object Literal / Spread Syntax Check
    // Example: { ...props } -> parses as ({ ...props })
    try {
      parse(`({${expr}})`, { sourceType: "module", plugins: ["jsx"] });
      return null;
    } catch (e2) {
      // Return the original error message
      return e.message?.split("\n")[0] || "Invalid syntax";
    }
  }
}

export function deactivate() {
  diagnosticCollection.clear();
}
