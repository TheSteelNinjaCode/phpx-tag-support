import * as vscode from "vscode";
import {
  parseHTMLDocument,
  isInsideTag,
  getTagName,
  getOffsetFromPosition,
} from "../utils/html-parser";

const GLOBAL_DIRECTIVES = [
  { name: "pp-component", description: "Define a component" },
  { name: "pp-spread", description: "Spread props to element" },
  { name: "pp-ref", description: "Get element reference" },
  { name: "pp-ignore", description: "Ignore element for processing" },
  { name: "pp-loading-content", description: "Content to show while loading" },
];

export class PulsePointAttributeCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);

    // 1. Safety Check: Must be inside a tag <...>
    if (!isInsideTag(textBefore)) return [];

    // 2. Block suggestions if inside an attribute value (e.g. id="...")
    if (/\s+[a-zA-Z0-9_\-:@]+=["'][^"']*$/.test(textBefore)) {
      return [];
    }

    const tagName = getTagName(textBefore);
    if (!tagName || tagName === "script" || tagName === "style") return [];

    // --- DEDUPLICATION LOGIC START ---
    const existingAttributes = new Set<string>();

    const lastOpenBracket = textBefore.lastIndexOf("<");
    if (lastOpenBracket !== -1) {
      const tagContent = textBefore.substring(lastOpenBracket);
      const usedAttrRegex = /\s+([a-zA-Z0-9_\-:@]+)(?:=|\s|$)/g;

      let match;
      while ((match = usedAttrRegex.exec(tagContent)) !== null) {
        existingAttributes.add(match[1]);
      }
    }
    // --- DEDUPLICATION LOGIC END ---

    // --- FIX START: Detect Case-Sensitive Tag Name ---
    // getTagName() returns lowercase, so we explicitly look for the raw string
    // to check if it starts with an Uppercase letter (Component).
    const rawTagMatch = /<([a-zA-Z0-9_\-]+)[^>]*$/.exec(textBefore);
    const rawTagName = rawTagMatch ? rawTagMatch[1] : tagName;
    const isCustomComponent = /^[A-Z]/.test(rawTagName);
    // --- FIX END ---

    const items: vscode.CompletionItem[] = [];

    // 3. Handle Template Tags (Special Case)
    if (tagName === "template") {
      if (!existingAttributes.has("pp-for")) {
        const item = new vscode.CompletionItem(
          "pp-for",
          vscode.CompletionItemKind.Property
        );
        item.detail = "Loop over items (template only)";
        item.insertText = new vscode.SnippetString('pp-for="$1"');
        items.push(item);
      }
    } else {
      // 4. Handle Global Directives
      for (const dir of GLOBAL_DIRECTIVES) {
        // Skip if already present
        if (existingAttributes.has(dir.name)) continue;

        // FIX: Skip 'pp-component' if it is a Custom Component (starts with Uppercase)
        if (dir.name === "pp-component" && isCustomComponent) {
          continue;
        }

        const item = new vscode.CompletionItem(
          dir.name,
          vscode.CompletionItemKind.Property
        );
        item.detail = dir.description;
        item.insertText = new vscode.SnippetString(`${dir.name}="$1"`);
        items.push(item);
      }

      // 5. Context-Aware Suggestions (pp-for scope)
      const fullText = document.getText();
      const htmlDoc = parseHTMLDocument(fullText);
      const offset = getOffsetFromPosition(
        fullText,
        position.line,
        position.character
      );

      if (htmlDoc.isInsidePpForTemplate(offset)) {
        if (!existingAttributes.has("key")) {
          const keyItem = new vscode.CompletionItem(
            "key",
            vscode.CompletionItemKind.Property
          );
          keyItem.detail = "Unique key for list items";
          keyItem.insertText = new vscode.SnippetString('key="$1"');
          items.push(keyItem);
        }
      }
    }

    return items;
  }
}
