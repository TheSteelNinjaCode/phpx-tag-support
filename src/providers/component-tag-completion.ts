import * as vscode from "vscode";
import { COMMAND_ADD_IMPORT } from "./component-import";

export class ComponentTagCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private getComponentMap: () => Map<string, string>) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    // 1. Check if we are typing a tag: matches "<" or "<X"
    const linePrefix = document
      .lineAt(position)
      .text.substr(0, position.character);

    // Regex to match an open bracket followed by optional characters (e.g., "<" or "<Ca")
    const match = /<([A-Z][a-zA-Z0-9]*)?$/.exec(linePrefix);

    if (!match) {
      return undefined;
    }

    const componentMap = this.getComponentMap();
    const completionItems: vscode.CompletionItem[] = [];

    for (const [shortName, fqcn] of componentMap) {
      const item = new vscode.CompletionItem(
        shortName,
        vscode.CompletionItemKind.Class
      );

      // 2. Set the detail (shows the full namespace in the menu)
      item.detail = fqcn;
      item.documentation = new vscode.MarkdownString(
        `Import component **${shortName}** from \`${fqcn}\``
      );

      // 3. Define what gets inserted (Just the name, VS Code keeps the '<')
      item.insertText = shortName;

      // 4. Attach the Auto-Import Command
      // When the user accepts this suggestion, run the import command immediately
      item.command = {
        command: COMMAND_ADD_IMPORT,
        title: "Auto-Import Component",
        arguments: [document, fqcn], // Pass document and class name
      };

      completionItems.push(item);
    }

    return completionItems;
  }
}
