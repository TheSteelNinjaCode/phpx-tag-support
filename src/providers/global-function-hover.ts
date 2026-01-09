import * as vscode from "vscode";
import { GlobalFunctionsLoader } from "../services/global-functions-loader";
import { parseHTMLDocument } from "../utils/html-parser";

export class GlobalFunctionHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    // 1. Get the word under cursor
    const range = document.getWordRangeAtPosition(position);
    if (!range) return undefined;

    const word = document.getText(range);

    // 2. Check Context (Script or Mustache)
    const offset = document.offsetAt(position);
    const parsedDoc = parseHTMLDocument(document.getText());
    const isInsideScript = parsedDoc.isInsideScript(offset);

    // Simple regex check for mustache context if parser doesn't cover it specific enough
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);
    // Checks for opening brace that hasn't been closed on the same line
    const isInsideMustache = /\{[^{}]*$/.test(linePrefix);

    if (!isInsideScript && !isInsideMustache) {
      return undefined;
    }

    // 3. Lookup Function
    const fnDef = GlobalFunctionsLoader.getInstance().getFunction(word);
    if (!fnDef) {
      return undefined;
    }

    // 4. Build Hover Content
    const md = new vscode.MarkdownString();
    md.appendCodeblock(`const ${fnDef.name}: ${fnDef.signature}`, "typescript");
    md.appendMarkdown(`\n\n*Global Helper (Prisma PHP)*`);

    return new vscode.Hover(md, range);
  }
}
