import * as vscode from "vscode";
import { GlobalFunctionsLoader } from "../services/global-functions-loader";
import { parseHTMLDocument } from "../utils/html-parser"; // Ensure correct relative path to your html-parser

export class GlobalFunctionCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // 1. Check Context using your existing HTML parser
    const parsedDoc = parseHTMLDocument(text);
    const isInsideScript = parsedDoc.isInsideScript(offset);

    // 2. Check Context for Mustache (Regex fallback as parser might not capture text nodes)
    // Looks for an opening "{" on the same line that hasn't been closed
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);
    const isInsideMustache = /\{[^{}]*$/.test(linePrefix);

    if (!isInsideScript && !isInsideMustache) {
      return undefined;
    }

    const functions = GlobalFunctionsLoader.getInstance().getFunctions();
    if (functions.length === 0) return undefined;

    return functions.map((fn) => {
      const item = new vscode.CompletionItem(
        fn.name,
        vscode.CompletionItemKind.Function
      );

      // Beautify the signature for the label details
      item.detail = `Global Helper`;
      item.documentation = new vscode.MarkdownString()
        .appendCodeblock(`const ${fn.name}: ${fn.signature}`, "typescript")
        .appendMarkdown(`\n\n*Defined in .pp/global-functions.d.ts*`);

      // Snippet for easier insertion
      item.insertText = new vscode.SnippetString(`${fn.name}($0)`);

      return item;
    });
  }
}
