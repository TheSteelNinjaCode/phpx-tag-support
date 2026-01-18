import * as vscode from "vscode";
import { parse } from "@babel/parser";
import { parseHTMLDocument } from "../utils/html-parser";

const diagnosticCollection = vscode.languages.createDiagnosticCollection(
  "pulsepoint-mustache",
);

export function registerMustacheValidator(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidSaveTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((e) => validate(e.document)),
    diagnosticCollection,
  );

  vscode.workspace.textDocuments.forEach(validate);
}

function validate(document: vscode.TextDocument) {
  if (document.languageId !== "html" && document.languageId !== "php") return;

  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];

  // If your html-parser ever throws, don't kill validation entirely.
  let htmlDoc: { isInsideExcludedRegion: (offset: number) => boolean };
  try {
    htmlDoc = parseHTMLDocument(text);
  } catch {
    htmlDoc = { isInsideExcludedRegion: () => false };
  }

  // Groups:
  // 1) PHP start       (<\?(?:php|=))
  // 2) PHP end         (\?>)
  // 3) Heredoc         (<<< ... )
  // 4) Heredoc id      ([a-zA-Z0-9_]+)
  // 5) Script/Style    (<\/?(?:script|style)\b)
  // 6) Mustache        (\{)
  const boundaryRegex =
    /(<\?(?:php|=))|(\?>)|(<<<['"]?([a-zA-Z0-9_]+)['"]?)|(<\/?(?:script|style)\b)|(\{)/gi;

  let match: RegExpExecArray | null;
  let inPhp = false;
  let inHeredoc = false;
  let heredocTag = "";
  let inScriptOrStyle = false;

  while ((match = boundaryRegex.exec(text)) !== null) {
    const phpStart = match[1];
    const phpEnd = match[2];
    const heredocStart = match[3];
    const heredocId = match[4];
    const tagMatch = match[5];
    const mustacheStart = match[6];

    // 1) Enter PHP Mode
    if (phpStart) {
      inPhp = true;
      continue;
    }

    // 2) Exit PHP Mode
    if (phpEnd) {
      inPhp = false;
      inHeredoc = false;
      heredocTag = "";
      continue;
    }

    // 3) Enter Heredoc Mode
    if (heredocStart && inPhp && !inHeredoc) {
      inHeredoc = true;
      heredocTag = heredocId || "";
      inScriptOrStyle = false;
      continue;
    }

    // 4) Check for Heredoc End (heuristic)
    if (inHeredoc && heredocTag) {
      const restOfText = text.slice(0, match.index);
      const closeRe = new RegExp(
        `\\n\\s*${escapeRegExp(heredocTag)}\\s*;?\\s*$`,
        "m",
      );
      const tail = restOfText.slice(Math.max(0, restOfText.length - 2000));
      if (closeRe.test(tail)) {
        inHeredoc = false;
        inScriptOrStyle = false;
      }
    }

    // 5) Handle Script/Style Tags
    if (tagMatch) {
      if (!inPhp || (inPhp && inHeredoc)) {
        if (tagMatch.startsWith("</")) {
          inScriptOrStyle = false;
        } else {
          inScriptOrStyle = true;
        }
      }
      continue;
    }

    // 6) Handle Mustache '{'
    if (mustacheStart) {
      const startIndex = match.index;

      // Validate IF: NOT in PHP, OR in PHP but inside a Heredoc
      const shouldValidate = !inPhp || (inPhp && inHeredoc);

      if (inScriptOrStyle) continue;

      if (!shouldValidate) continue;

      if (htmlDoc.isInsideExcludedRegion(startIndex)) continue;

      const nextChar = text[startIndex + 1];
      const prevChar = text[startIndex - 1];

      // Ignore PHP complex syntax "{$...}"
      if (nextChar === "$") continue;

      // Ignore handlebars/double-mustache "{{ ... }}"
      if (nextChar === "{") continue;

      // Ignore escaped brace "\{"
      if (prevChar === "\\") continue;

      const exprMatch = extractBalancedBrace(text, startIndex);

      if (!exprMatch) {
        const start = document.positionAt(startIndex);
        const end = document.positionAt(Math.min(text.length, startIndex + 1));
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(start, end),
            "Unclosed { ... } expression",
            vscode.DiagnosticSeverity.Error,
          ),
        );
        continue;
      }

      const { content, endPos } = exprMatch;

      // Continue scanning after the closing brace
      boundaryRegex.lastIndex = endPos;

      // --- FIX START ---
      // If the content contains a PHP opening tag (<? or <?=), skip JS validation.
      // This prevents "Unexpected token" errors when PHP is used to inject values.
      if (/<\?/.test(content)) {
        continue;
      }
      // --- FIX END ---

      if (!content.trim()) continue;

      const error = parseExpression(content);
      if (error) {
        const start = document.positionAt(startIndex);
        const end = document.positionAt(endPos);
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(start, end),
            `Invalid JS: ${error}`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }
  }

  diagnosticCollection.set(document.uri, diagnostics);
}

function extractBalancedBrace(
  text: string,
  startIndex: number,
): { content: string; endPos: number } | null {
  let balance = 0;

  // simple JS-aware scanning
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = startIndex; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingle) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "`") inBacktick = false;
      continue;
    }

    if (c === "/" && n === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "`") {
      inBacktick = true;
      continue;
    }

    if (c === "{") balance++;
    else if (c === "}") balance--;

    if (balance === 0) {
      return {
        content: text.substring(startIndex + 1, i),
        endPos: i + 1,
      };
    }
  }

  return null;
}

function parseExpression(expr: string): string | null {
  try {
    parse(`(${expr})`, { sourceType: "module", plugins: ["jsx"] });
    return null;
  } catch (e: any) {
    try {
      parse(`({${expr}})`, { sourceType: "module", plugins: ["jsx"] });
      return null;
    } catch {
      return e?.message?.split("\n")[0] || "Invalid syntax";
    }
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function deactivate() {
  diagnosticCollection.clear();
}
