import * as vscode from "vscode";
import {
  getPulsePointCompletions,
  getSearchParamsCompletions,
  getPulsePointGlobals,
  getStoreCompletions,
} from "../data/pulsepoint-methods";
import { parseHTMLDocument, getOffsetFromPosition } from "../utils/html-parser";

export class PulsePointCompletionProvider
  implements vscode.CompletionItemProvider
{
  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);

    // 1. AST Check: Ensure we are inside a <script> tag
    const fullText = document.getText();
    const htmlDoc = parseHTMLDocument(fullText);
    const offset = getOffsetFromPosition(
      fullText,
      position.line,
      position.character
    );

    if (!htmlDoc.isInsideScript(offset)) {
      return undefined;
    }

    const trimmedPrefix = linePrefix.trim();

    // 2. SCENARIO A: Property Access (User typed a dot)
    if (trimmedPrefix.endsWith(".")) {
      if (trimmedPrefix.endsWith("searchParams.")) {
        return getSearchParamsCompletions();
      }
      if (trimmedPrefix.endsWith("store.")) {
        return getStoreCompletions();
      }
      if (trimmedPrefix.endsWith("pp.") || trimmedPrefix.endsWith("this.")) {
        return getPulsePointCompletions();
      }
      return undefined;
    }

    // 3. SCENARIO B: Global Access (User is just typing a word)
    // We provide the globals (pp, searchParams) so VS Code can filter them.
    return getPulsePointGlobals();
  }
}
