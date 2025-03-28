import * as vscode from "vscode";

/**
 * Activates the PHPX extension.
 * Registers hover and definition providers, plus document change listeners.
 * Forces Ctrl+Click (Go to Definition) to open Peek Definition.
 */
export function activate(context: vscode.ExtensionContext) {
  console.log("PHPX tag support is now active!");

  // Force Peek Definition for Go to Definition
  const editorConfig = vscode.workspace.getConfiguration("editor");
  editorConfig.update(
    "gotoLocation.single",
    "peek",
    vscode.ConfigurationTarget.Global
  );
  editorConfig.update(
    "gotoLocation.multiple",
    "peek",
    vscode.ConfigurationTarget.Global
  );

  // Collection for diagnostics
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("phpx-tags");
  context.subscriptions.push(diagnosticCollection);

  // --- Register hover provider for PHP tags ---
  const hoverProvider = vscode.languages.registerHoverProvider("php", {
    provideHover(document, position) {
      // Match <Tag or </Tag
      const range = document.getWordRangeAtPosition(
        position,
        /<\/?[A-Z][A-Za-z0-9]*/
      );
      if (!range) {
        return;
      }
      const word = document.getText(range); // e.g. "<GoogleSearch" or "GoogleSearch"
      const tagName = word.replace(/[</]/g, ""); // remove '<' or '</'
      const useMap = parsePhpUseStatements(document.getText());
      if (useMap.has(tagName)) {
        const fullClass = useMap.get(tagName)!;
        return new vscode.Hover(
          `🔍 Tag \`${tagName}\` is imported from \`${fullClass}\``
        );
      }
      return new vscode.Hover(
        `ℹ️ Tag \`${tagName}\` not found in any use import.`
      );
    },
  });
  context.subscriptions.push(hoverProvider);

  // --- Register definition provider for PHP tags ---
  const definitionProvider = vscode.languages.registerDefinitionProvider(
    "php",
    {
      async provideDefinition(document, position) {
        const range = document.getWordRangeAtPosition(
          position,
          /<\/?[A-Z][A-Za-z0-9]*/
        );
        if (!range) {
          return;
        }
        const word = document.getText(range);
        const tagName = word.replace(/[</]/g, "");
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
          document.uri
        );
        if (!workspaceFolder) {
          return;
        }
        const jsonUri = vscode.Uri.joinPath(
          workspaceFolder.uri,
          "settings",
          "class-log.json"
        );
        let mapping: { filePath: string } | undefined;
        try {
          const data = await vscode.workspace.fs.readFile(jsonUri);
          const jsonStr = Buffer.from(data).toString("utf8").trim();
          if (jsonStr) {
            const jsonMapping = JSON.parse(jsonStr);
            for (const fqcn in jsonMapping) {
              if (getLastPart(fqcn) === tagName) {
                mapping = jsonMapping[fqcn];
                break;
              }
            }
          } else {
            console.error("class-log.json is empty.");
          }
        } catch (error) {
          console.error("Error reading class-log.json:", error);
        }
        if (!mapping) {
          const useMap = parsePhpUseStatements(document.getText());
          if (!useMap.has(tagName)) {
            return;
          }
          const fullClass = useMap.get(tagName)!;
          mapping = { filePath: fullClass.replace(/\\\\/g, "/") + ".php" };
        } else {
          mapping.filePath = mapping.filePath.replace(/\\/g, "/");
        }
        const sourceRoot = vscode.workspace
          .getConfiguration("phpx-tag-support")
          .get("sourceRoot", "src");
        const fullPath = vscode.Uri.file(
          `${workspaceFolder.uri.fsPath}/${sourceRoot}/${mapping.filePath}`
        );
        return new vscode.Location(fullPath, new vscode.Position(0, 0));
      },
    }
  );
  context.subscriptions.push(definitionProvider);

  // --- Listen for document changes and active editor changes ---
  const updateDiagnostics = (document: vscode.TextDocument) => {
    validateMissingImports(document, diagnosticCollection);
  };

  vscode.workspace.onDidChangeTextDocument((e) =>
    updateDiagnostics(e.document)
  );
  vscode.workspace.onDidSaveTextDocument(updateDiagnostics);
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      updateDiagnostics(editor.document);
    }
  });

  // --- Optional command to manually trigger Peek Definition ---
  const peekCommand = vscode.commands.registerCommand(
    "phpx-tag-support.peekTagDefinition",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await vscode.commands.executeCommand("editor.action.peekDefinition");
    }
  );
  context.subscriptions.push(peekCommand);

  // --- Example "hoverProvider" command from package.json ---
  const disposable = vscode.commands.registerCommand(
    "phpx-tag-support.hoverProvider",
    () => {
      vscode.window.showInformationMessage(
        "Hello World from phpx-tag-support!"
      );
    }
  );
  context.subscriptions.push(disposable);

  // Register a completion provider for PHP files that triggers on '<'
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    "php",
    {
      provideCompletionItems(document, position) {
        const useMap = parsePhpUseStatements(document.getText());
        const completionItems: vscode.CompletionItem[] = [];
        const line = document.lineAt(position.line);
        const lessThanIndex = line.text.lastIndexOf("<", position.character);
        let replaceRange: vscode.Range | undefined;
        if (lessThanIndex !== -1) {
          replaceRange = new vscode.Range(
            new vscode.Position(position.line, lessThanIndex),
            position
          );
        }
        for (const [shortName, fullClass] of useMap.entries()) {
          const item = new vscode.CompletionItem(
            shortName,
            vscode.CompletionItemKind.Class
          );
          item.detail = `Component from ${fullClass}`;
          item.filterText = `<${shortName}`;
          item.insertText = new vscode.SnippetString(`<${shortName}`);
          if (replaceRange) {
            item.range = replaceRange;
          }
          completionItems.push(item);
        }
        return completionItems;
      },
    },
    "<"
  );
  context.subscriptions.push(completionProvider);
}

/**
 * Validates that all used JSX-like tags have a corresponding import.
 * Also, if the workspace root contains prisma-php.json, validates that every
 * tag’s attributes follow XML syntax (i.e. every attribute has an explicit value).
 */
function validateMissingImports(
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
) {
  if (document.languageId !== "php") {
    return;
  }

  // Remove heredocs/nowdocs so we don't catch tags in strings
  const originalText = document.getText();
  const strippedText = removeHeredocsAndNowdocs(originalText);

  // Build shortName → fullClass map from all use statements
  const useMap = parsePhpUseStatements(originalText);
  let diagnostics: vscode.Diagnostic[] = [];

  // Capture tags like <Toggle or <GoogleSearch
  const tagMatches = [...strippedText.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)];
  for (const match of tagMatches) {
    const tag = match[1];
    if (!useMap.has(tag)) {
      const start = document.positionAt(match.index! + 1);
      const end = start.translate(0, tag.length);
      const range = new vscode.Range(start, end);
      const message = `⚠️ Missing import for component <${tag} />`;
      diagnostics.push(
        new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning)
      );
    }
  }

  // Check if prisma-php.json exists at the workspace root.
  // If it does, we assume the user is working with Prisma PHP and
  // perform additional XML attribute validation.
  vscode.workspace.findFiles("prisma-php.json", null, 1).then((files) => {
    if (files.length > 0) {
      // Merge XML attribute diagnostics
      diagnostics = diagnostics.concat(getXmlAttributeDiagnostics(document));
    }
    diagnosticCollection.set(document.uri, diagnostics);
  });
}

/**
 * Returns diagnostics for tags with attributes that don’t have an explicit value.
 * This enforces XML syntax where every attribute must be assigned a value.
 */
function getXmlAttributeDiagnostics(
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const text = document.getText();
  const xmlDiagnostics: vscode.Diagnostic[] = [];

  // Identify PHP regions in the document.
  const phpRegions = getPhpRegions(text);

  // Regex to match a tag with its attributes (supports self-closing tags).
  const tagRegex = /<(\w+)(\s+[^>]+?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text))) {
    const tagName = match[1];
    let attrText = match[2];
    // Remove any embedded PHP code from the attribute string (just in case).
    attrText = attrText.replace(/<\?(?:=)?[\s\S]+?\?>/g, "");
    // Regex to match attributes: Group 1 is the attribute name; Group 2 is the assignment (if present).
    const attrRegex = /(\w+)(\s*=\s*(".*?"|'.*?'))?/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrText))) {
      const attrName = attrMatch[1];
      const attrAssignment = attrMatch[2];
      // Only report if there's no explicit assignment.
      if (!attrAssignment) {
        const fullMatchIndex = match.index + match[0].indexOf(attrName);
        // Skip if the match falls within a PHP region.
        if (isIndexInPhpRegion(fullMatchIndex, phpRegions)) {
          continue;
        }
        const start = document.positionAt(fullMatchIndex);
        const end = document.positionAt(fullMatchIndex + attrName.length);
        xmlDiagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(start, end),
            `In XML mode, attribute "${attrName}" in <${tagName}> must have an explicit value (e.g., ${attrName}="value")`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }
  }
  return xmlDiagnostics;
}

// Helper function: returns ranges for PHP code segments.
function getPhpRegions(text: string): { start: number; end: number }[] {
  const regions: { start: number; end: number }[] = [];
  const phpRegex = /<\?(?:php|=)[\s\S]+?\?>/g;
  let m: RegExpExecArray | null;
  while ((m = phpRegex.exec(text))) {
    regions.push({ start: m.index, end: phpRegex.lastIndex });
  }
  return regions;
}

// Helper function: checks if an index falls within any PHP region.
function isIndexInPhpRegion(
  index: number,
  regions: { start: number; end: number }[]
): boolean {
  return regions.some((region) => index >= region.start && index < region.end);
}

/**
 * Parse all "use" statements (including group imports) from the given text.
 * Returns a Map of shortName -> fullClass.
 */
function parsePhpUseStatements(text: string): Map<string, string> {
  const shortNameMap = new Map<string, string>();
  const useRegex = /use\s+([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = useRegex.exec(text))) {
    const importBody = match[1].trim();
    if (!importBody) {
      continue;
    }
    const braceOpenIndex = importBody.indexOf("{");
    const braceCloseIndex = importBody.lastIndexOf("}");
    if (braceOpenIndex !== -1 && braceCloseIndex !== -1) {
      const prefix = importBody.substring(0, braceOpenIndex).trim();
      const insideBraces = importBody
        .substring(braceOpenIndex + 1, braceCloseIndex)
        .trim();
      const items = insideBraces.split(",");
      for (let rawItem of items) {
        rawItem = rawItem.trim();
        if (!rawItem) {
          continue;
        }
        processSingleImport(prefix, rawItem, shortNameMap);
      }
    } else {
      processSingleImport("", importBody, shortNameMap);
    }
  }
  return shortNameMap;
}

/**
 * Processes a single import piece like:
 *   - "Lib\PHPX\Toggle"
 *   - "Lib\PHPX\Toggle as MyToggle"
 */
function processSingleImport(
  prefix: string,
  item: string,
  shortNameMap: Map<string, string>
) {
  const asMatch = /\bas\b\s+([\w]+)/i.exec(item);
  if (asMatch) {
    const aliasName = asMatch[1];
    const originalPart = item.substring(0, asMatch.index).trim();
    const fullClass = prefix ? joinPath(prefix, originalPart) : originalPart;
    shortNameMap.set(aliasName, fullClass);
  } else {
    const fullClass = prefix ? joinPath(prefix, item) : item;
    const shortName = getLastPart(item);
    shortNameMap.set(shortName, fullClass);
  }
}

/**
 * Joins a prefix and item ensuring we don't lose backslashes.
 */
function joinPath(prefix: string, item: string): string {
  if (prefix.endsWith("\\")) {
    return prefix + item;
  }
  return prefix + "\\" + item;
}

/**
 * Returns the last part of a backslash-separated string.
 */
function getLastPart(path: string): string {
  const parts = path.split("\\");
  return parts[parts.length - 1];
}

/**
 * Removes heredoc/nowdoc blocks from text to avoid false positives.
 */
function removeHeredocsAndNowdocs(text: string): string {
  const heredocPattern =
    /<<<(['"]?)([A-Za-z0-9_]+)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2\s*;/gm;
  return text.replace(heredocPattern, "");
}

// Called when your extension is deactivated
export function deactivate() {}
