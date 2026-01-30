import * as vscode from "vscode";
import {
  getPulsePointCompletions,
  getSearchParamsCompletions,
  getStoreCompletions,
  getPulsePointGlobals,
} from "../data/pulsepoint-methods";
import { parseHTMLDocument, getOffsetFromPosition } from "../utils/html-parser";

export class PulsePointHoverProvider implements vscode.HoverProvider {
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      return undefined;
    }

    const word = document.getText(range);
    const lineText = document.lineAt(position).text;

    // 1. AST Check: Ensure we are inside a <script> tag
    const fullText = document.getText();
    const htmlDoc = parseHTMLDocument(fullText);
    const offset = getOffsetFromPosition(
      fullText,
      position.line,
      position.character,
    );

    if (!htmlDoc.isInsideScript(offset)) {
      return undefined;
    }

    // 2. Determine Context (what comes before the word?)
    // We look at the text immediately preceding the current word range.
    const textBefore = lineText.substring(0, range.start.character).trim();

    let items: vscode.CompletionItem[] = [];

    // Case A: Method/Property on an object (pp.state, searchParams.get)
    if (textBefore.endsWith("pp.") || textBefore.endsWith("this.")) {
      items = getPulsePointCompletions();
    } else if (textBefore.endsWith("searchParams.")) {
      items = getSearchParamsCompletions();
    } else if (textBefore.endsWith("store.")) {
      items = getStoreCompletions();
    }
    // Case B: Global Object itself (hovering over 'pp', 'searchParams', 'store')
    else {
      // Check if the word itself is one of the globals
      const globals = getPulsePointGlobals();
      const match = globals.find((g) => g.label === word);
      if (match) {
        return this.createHoverFromItem(match);
      }
      return undefined;
    }

    // 3. Find the matching item
    const match = items.find((item) => {
      // Handle string labels vs CompletionItemLabel objects
      const label =
        typeof item.label === "string" ? item.label : item.label.label;
      return label === word;
    });

    if (!match) {
      return undefined;
    }

    return this.createHoverFromItem(match);
  }

  private createHoverFromItem(item: vscode.CompletionItem): vscode.Hover {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true; // Essential for rendering the RpcOptions code block

    if (item.detail) {
      markdown.appendCodeblock(item.detail, "typescript");
    }

    if (item.documentation) {
      markdown.appendMarkdown("---\n");
      if (typeof item.documentation === "string") {
        markdown.appendMarkdown(item.documentation);
      } else {
        // Use the value from the MarkdownString objects generated in pulsepoint-methods.ts
        markdown.appendMarkdown(item.documentation.value);
      }
    }

    return new vscode.Hover(markdown);
  }
}
