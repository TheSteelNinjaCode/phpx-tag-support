import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export class PhpxClassSnippetProvider implements vscode.CompletionItemProvider {
  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const item = new vscode.CompletionItem(
      "phpxclass",
      vscode.CompletionItemKind.Snippet
    );

    item.detail = "Scaffold a new Prisma PHPX Component";
    item.documentation =
      "Creates a standard PHPX class structure with namespace and render method.";

    // 1. Resolve Class Name
    let className = "ClassName";
    if (!document.isUntitled) {
      const fileName = path.basename(document.fileName);
      const ext = path.extname(fileName);
      className = fileName.replace(ext, "");
    }

    // 2. Resolve Namespace
    const namespace = this.resolveNamespace(document);

    // 3. Build Snippet
    // Note: We perform double escaping for backslashes in the namespace because
    // it goes into a template string, then into a SnippetString.
    const escapedNamespace = namespace.replace(/\\/g, "\\\\");

    item.insertText = new vscode.SnippetString(
      `<?php

declare(strict_types=1);

namespace \${1:${escapedNamespace}};

use PP\\\\PHPX\\\\PHPX;

class \${2:${className}} extends PHPX
{
    public ?string \\$class = '';
    public mixed \\$children = null;

    public function __construct(array \\$props = [])
    {
        parent::__construct(\\$props);
    }

    public function render(): string
    {
        \\$class = \\$this->getMergeClasses(\\$this->class);
        \\$attributes = \\$this->getAttributes([
            'class' => \\$class,
        ]);

        return <<<HTML
        <div {\\$attributes}>
            {\\$this->children}
        </div>
        HTML;
    }
}
`
    );

    return [item];
  }

  /**
   * Attempts to resolve the PSR-4 namespace based on composer.json
   */
  private resolveNamespace(document: vscode.TextDocument): string {
    // Default fallback
    const defaultNamespace = "App\\View\\Components";

    if (document.isUntitled) {
      return defaultNamespace;
    }

    const docPath = document.uri.fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    if (!workspaceFolder) {
      return defaultNamespace;
    }

    const composerPath = path.join(workspaceFolder.uri.fsPath, "composer.json");

    if (!fs.existsSync(composerPath)) {
      return defaultNamespace;
    }

    try {
      const composerContent = fs.readFileSync(composerPath, "utf8");
      const composer = JSON.parse(composerContent);
      const psr4 = composer.autoload?.["psr-4"];

      if (!psr4) {
        return defaultNamespace;
      }

      // Sort prefixes by length (longest first) to ensure we match the most specific namespace
      const prefixes = Object.keys(psr4).sort((a, b) => b.length - a.length);

      for (const prefix of prefixes) {
        // Source path from composer (e.g., "src/" or "app/")
        let srcPath = psr4[prefix];

        // Ensure srcPath ends with a separator for correct joining
        if (!srcPath.endsWith("/")) {
          srcPath += "/";
        }

        // Get absolute path to this source directory
        const absSrcPath = path.join(path.dirname(composerPath), srcPath);

        // Check if the current document is inside this source directory
        if (docPath.startsWith(absSrcPath)) {
          // Get the path relative to the source root
          // e.g., if doc is .../app/View/Components/Alert.php and root is .../app/
          // relative is View/Components/Alert.php
          const relativePath = path.relative(absSrcPath, docPath);

          // Get the directory part: View/Components
          const directory = path.dirname(relativePath);

          // If the file is directly in the root, directory is "."
          let subNamespace = "";
          if (directory !== ".") {
            // Convert file separators to namespace separators
            subNamespace = directory.split(path.sep).join("\\");
          }

          // Clean up the prefix (remove trailing backslash for joining)
          const cleanPrefix = prefix.endsWith("\\")
            ? prefix.slice(0, -1)
            : prefix;

          return subNamespace ? `${cleanPrefix}\\${subNamespace}` : cleanPrefix;
        }
      }
    } catch (error) {
      console.error(
        "Prisma PHP: Error parsing composer.json for namespace resolution",
        error
      );
    }

    return defaultNamespace;
  }
}
