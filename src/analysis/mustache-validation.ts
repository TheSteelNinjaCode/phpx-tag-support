import * as vscode from "vscode";
import {
  extractMustacheExpressions,
  containsAssignment,
  buildExclusionRanges,
} from "./mustache-ast";

export function validateMustacheExpressions(
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  if (document.languageId !== "php") {
    return [];
  }

  const text = document.getText();

  if (isPurePhpFile(text)) {
    return [];
  }

  const exclusions = buildExclusionRanges(text);
  const expressions = extractMustacheExpressions(text, exclusions);

  const diagnostics: vscode.Diagnostic[] = [];

  for (const expr of expressions) {
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

function isPurePhpFile(text: string): boolean {
  const trimmed = text.trim();

  if (!trimmed.startsWith("<?php")) {
    return false;
  }

  const purePhpIndicators = [
    /^\s*<\?php\s+declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;/m,
    /^\s*<\?php\s+namespace\s+/m,
    /\bclass\s+\w+/,
    /\binterface\s+\w+/,
    /\btrait\s+\w+/,
    /\babstract\s+class\s+\w+/,
    /\bfinal\s+class\s+\w+/,
  ];

  const hasPhpIndicators = purePhpIndicators.some((regex) => regex.test(text));

  const hasHtmlTags =
    /<(?:html|head|body|div|span|p|h[1-6]|a|img|ul|li|table|form|input|button|nav|header|footer|section|article)\b/i.test(
      text
    );

  if (hasPhpIndicators && !hasHtmlTags) {
    return true;
  }

  const hasNoClosingTag = !findActualClosingTag(text);
  if (hasNoClosingTag && hasPhpIndicators) {
    return true;
  }

  return false;
}

function findActualClosingTag(text: string): boolean {
  let inString: string | null = null;
  let escaped = false;

  for (let i = 0; i < text.length - 1; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }

    if ((char === '"' || char === "'") && !inString) {
      inString = char;
      continue;
    }

    if (char === inString) {
      inString = null;
      continue;
    }

    if (!inString && char === "?" && next === ">") {
      return true;
    }
  }

  return false;
}
