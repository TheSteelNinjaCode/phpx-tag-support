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

  vscode.workspace.textDocuments.forEach(validate);
}

function validate(document: vscode.TextDocument) {
  if (document.languageId !== "html" && document.languageId !== "php") return;

  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];
  const htmlDoc = parseHTMLDocument(text);

  // Regex boundaries: PHP Start, PHP End, Heredoc Start, Mustache Start
  const boundaryRegex =
    /(<\?(?:php|=))|(\?>)|(<<<['"]?([a-zA-Z0-9_]+)['"]?)|(\{)/g;

  let match;
  let inPhp = false;
  let inHeredoc = false;
  let heredocTag = "";

  while ((match = boundaryRegex.exec(text)) !== null) {
    const [phpStart, phpEnd, heredocStart, heredocId, mustacheStart] = match;

    // 1. Enter PHP Mode
    if (phpStart) {
      inPhp = true;
      continue;
    }

    // 2. Exit PHP Mode
    if (phpEnd) {
      inPhp = false;
      inHeredoc = false;
      continue;
    }

    // 3. Enter Heredoc Mode
    if (heredocStart && inPhp && !inHeredoc) {
      inHeredoc = true;
      heredocTag = heredocId;
      continue;
    }

    // 4. Check for Heredoc End (Heuristic check)
    if (inHeredoc) {
      const restOfText = text.slice(0, match.index);
      const lastHeredocClose = restOfText.lastIndexOf(`\n${heredocTag};`);
      const lastHeredocStart = restOfText.lastIndexOf(`<<<`);

      if (lastHeredocClose > lastHeredocStart) {
        inHeredoc = false;
      }
    }

    // 5. Handle Mustache Match '{'
    if (mustacheStart) {
      // VALIDATE IF: We are NOT in PHP, OR we ARE in PHP but INSIDE a Heredoc
      const shouldValidate = !inPhp || (inPhp && inHeredoc);

      if (shouldValidate) {
        // FIX: Ignore PHP Complex Syntax "{$...}" immediately
        // If the character immediately following '{' is '$', it's PHP interpolation.
        if (text[match.index + 1] === "$") {
          continue;
        }

        const exprMatch = extractBalancedBrace(text, match.index);

        if (exprMatch) {
          const { content, endPos } = exprMatch;

          boundaryRegex.lastIndex = endPos;

          if (content.trim() && !htmlDoc.isInsideExcludedRegion(match.index)) {
            const error = parseExpression(content);
            if (error) {
              const start = document.positionAt(match.index);
              const end = document.positionAt(endPos);
              diagnostics.push(
                new vscode.Diagnostic(
                  new vscode.Range(start, end),
                  `Invalid JS: ${error}`,
                  vscode.DiagnosticSeverity.Error
                )
              );
            }
          }
        }
      }
    }
  }

  diagnosticCollection.set(document.uri, diagnostics);
}

function extractBalancedBrace(
  text: string,
  startIndex: number
): { content: string; endPos: number } | null {
  let balance = 0;
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === "{") balance++;
    else if (text[i] === "}") balance--;

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
    } catch (e2) {
      return e.message?.split("\n")[0] || "Invalid syntax";
    }
  }
}

export function deactivate() {
  diagnosticCollection.clear();
}
