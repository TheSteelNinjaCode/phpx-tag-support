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
   * 1. Match PHP tags first (<?php ... ?> or <?= ... ?>) so we can IGNORE them.
   * This prevents the validator from trying to parse curly braces inside PHP logic (e.g., if ($a) { ... }).
   * 2. Match PulsePoint syntax ({ ... }) so we can VALIDATE it.
   * * Capture Groups:
   * [1] PHP Tag:       <? ... ?>
   * [2] PulsePoint:    { ... }    (The full match including braces)
   * [3] Expression:      ...      (The content inside the braces)
   */
  const regex = /(<\?(?:php|=)[\s\S]*?\?>)|(\{([^{}]+)\})/gi;

  let match;

  while ((match = regex.exec(text)) !== null) {
    // 1. If match[1] exists, it is a PHP tag. Skip it.
    if (match[1]) {
      continue;
    }

    // 2. Otherwise, it's a PulsePoint match.
    // match[3] is the inner expression (content inside { }).
    const expr = match[3]?.trim();

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
      // Calculate range for the full PulsePoint match (match[2])
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
