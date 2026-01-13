import * as vscode from "vscode";
import { ComponentPropsProvider } from "./component-props";

export class ComponentAttributeValueProvider
  implements vscode.CompletionItemProvider
{
  constructor(private componentPropsProvider: ComponentPropsProvider) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    // 1. Get text before the cursor
    const linePrefix = document
      .lineAt(position)
      .text.substr(0, position.character);

    // 2. Regex to match: <TagName ... attribute="
    // Captures: 1=TagName, 2=AttributeName
    // Handles multiple attributes before the current one
    const regex =
      /<([A-Z][a-zA-Z0-9]*)\s+(?:[\s\S]*?\s+)?([a-zA-Z0-9_-]+)=["']([^"']*)$/;

    const match = regex.exec(linePrefix);

    if (!match) {
      return undefined;
    }

    const tagName = match[1];
    const attrName = match[2];

    // 3. Get Props Metadata
    const props = this.componentPropsProvider.getProps(tagName);
    const targetProp = props.find((p) => p.name === attrName);

    if (!targetProp) {
      return undefined;
    }

    const items: vscode.CompletionItem[] = [];

    // 4. Add "Default" value
    if (targetProp.default && targetProp.default !== "null") {
      const item = new vscode.CompletionItem(
        targetProp.default,
        vscode.CompletionItemKind.Value
      );
      item.detail = "(default)";
      item.sortText = "0"; // Show first
      items.push(item);
    }

    // 5. Add "Allowed" values (from @property or @var enum)
    if (targetProp.allowed) {
      const parts = targetProp.allowed.split("|");
      parts.forEach((val) => {
        const v = val.trim();
        if (v && v !== targetProp.default) {
          const item = new vscode.CompletionItem(
            v,
            vscode.CompletionItemKind.EnumMember
          );
          item.sortText = "1";
          items.push(item);
        }
      });
    }

    // 6. Special case: Boolean
    if (
      targetProp.type.includes("bool") ||
      targetProp.type.includes("boolean")
    ) {
      items.push(
        new vscode.CompletionItem("true", vscode.CompletionItemKind.Keyword)
      );
      items.push(
        new vscode.CompletionItem("false", vscode.CompletionItemKind.Keyword)
      );
    }

    return items;
  }
}
