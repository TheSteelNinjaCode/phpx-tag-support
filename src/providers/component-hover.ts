import * as vscode from "vscode";
import * as fs from "fs";

export class ComponentHoverProvider implements vscode.HoverProvider {
  constructor(
    private getComponentMap: () => Map<string, string>,
    private resolveFile: (fqcn: string) => string | undefined
  ) {}

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const range = document.getWordRangeAtPosition(position, /<[a-zA-Z0-9_]+/);
    const wordRange = document.getWordRangeAtPosition(position);

    if (!range || !wordRange) {
      return undefined;
    }

    const word = document.getText(wordRange);

    // 1. Check if word matches a known component
    const map = this.getComponentMap();
    const fqcn = map.get(word);

    if (!fqcn) {
      return undefined;
    }

    // 2. Resolve File Path
    const filePath = this.resolveFile(fqcn);

    // 3. Build Markdown Content
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    md.appendMarkdown(`**Component:** \`<${word}>\`\n\n`);
    md.appendCodeblock(`class ${word} extends PHPX`, "php");
    md.appendMarkdown(`**Namespace:** \`${fqcn}\`\n\n`);

    if (filePath) {
      const uri = vscode.Uri.file(filePath);
      md.appendMarkdown(`[Go to Source](${uri})\n\n`);

      // 4. (Optional) Quick Prop Extraction
      // Reads the file to find "public $var;" to list available props
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, "utf-8");
          const props = this.extractProps(content);
          if (props.length > 0) {
            md.appendMarkdown(`---\n**Available Props:**\n`);
            props.forEach((p) => md.appendMarkdown(`- \`${p}\`\n`));
          }
        }
      } catch (e) {
        // Ignore read errors
      }
    }

    return new vscode.Hover(md);
  }

  private extractProps(content: string): string[] {
    const props: string[] = [];
    // Regex to match: public ?Type $name
    // excludes static, const, or function
    const propRegex =
      /public\s+(?:(?:\?|[a-zA-Z\\]+)\s+)?\$([a-zA-Z0-9_]+)(?:\s*=|;)/g;

    let match;
    while ((match = propRegex.exec(content)) !== null) {
      if (match[1] !== "children") {
        // Filter out 'children' if desired
        props.push(match[1]);
      }
    }
    return props;
  }
}
