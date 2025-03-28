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

  // Collection for missing-import diagnostics
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

      // Build a shortName → fullClass map from all use statements
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
        // Extract tag name from something like <Tag or </Tag
        const range = document.getWordRangeAtPosition(
          position,
          /<\/?[A-Z][A-Za-z0-9]*/
        );
        if (!range) {
          return;
        }
        const word = document.getText(range);
        const tagName = word.replace(/[</]/g, "");

        // Get the current workspace folder
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
          document.uri
        );
        if (!workspaceFolder) {
          return;
        }

        // Build the URI for the class-log.json mapping file
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
            // Loop through each fully qualified class name in the JSON mapping
            for (const fqcn in jsonMapping) {
              // Use getLastPart to get the short name from the fully qualified class name
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

        // Fallback: if no mapping found in the JSON, parse the PHP file's use statements.
        if (!mapping) {
          const useMap = parsePhpUseStatements(document.getText());
          if (!useMap.has(tagName)) {
            return;
          }
          const fullClass = useMap.get(tagName)!;
          mapping = { filePath: fullClass.replace(/\\\\/g, "/") + ".php" };
        } else {
          // Normalize backslashes in the mapping file path
          mapping.filePath = mapping.filePath.replace(/\\/g, "/");
        }

        // Read the custom source root setting (defaults to "src")
        const sourceRoot = vscode.workspace
          .getConfiguration("phpx-tag-support")
          .get("sourceRoot", "src");

        // Construct the full path to the file
        const fullPath = vscode.Uri.file(
          `${workspaceFolder.uri.fsPath}/${sourceRoot}/${mapping.filePath}`
        );

        // Return a Location pointing to the file (at position 0,0).
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
      // This command simply invokes VS Code’s built-in peek definition on the current symbol.
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

        // Get the current line's text and check for a '<' before the cursor
        const line = document.lineAt(position.line);
        const lessThanIndex = line.text.lastIndexOf("<", position.character);
        // If a '<' exists, calculate a replacement range; if not, leave it undefined.
        let replaceRange: vscode.Range | undefined;
        if (lessThanIndex !== -1) {
          replaceRange = new vscode.Range(
            new vscode.Position(position.line, lessThanIndex),
            position
          );
        }

        // Create a CompletionItem for each imported component
        for (const [shortName, fullClass] of useMap.entries()) {
          const item = new vscode.CompletionItem(
            shortName,
            vscode.CompletionItemKind.Class
          );
          item.detail = `Component from ${fullClass}`;
          // Set filterText to help match even if the user starts with a '<'
          item.filterText = `<${shortName}`;
          // Use a SnippetString so that when inserted it becomes <Component />
          item.insertText = new vscode.SnippetString(`<${shortName}`);
          // If a replacement range was calculated, assign it so that any pre-typed '<' (or partial tag) is replaced.
          if (replaceRange) {
            item.range = replaceRange;
          }
          completionItems.push(item);
        }

        return completionItems;
      },
    },
    "<" // Trigger character for suggestions
  );
  context.subscriptions.push(completionProvider);
}

/**
 * Validates that all used JSX-like tags have a corresponding import.
 * If a tag is missing an import, a warning diagnostic is added.
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

  // Capture tags like <Toggle or <GoogleSearch
  const tagMatches = [...strippedText.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)];

  const diagnostics: vscode.Diagnostic[] = [];
  for (const match of tagMatches) {
    const tag = match[1];
    if (!useMap.has(tag)) {
      // Mark the tag usage as a warning if missing
      const start = document.positionAt(match.index! + 1); // +1 to skip '<'
      const end = start.translate(0, tag.length);
      const range = new vscode.Range(start, end);
      const message = `⚠️ Missing import for component <${tag} />`;
      diagnostics.push(
        new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning)
      );
    }
  }

  diagnosticCollection.set(document.uri, diagnostics);
}

/**
 * Parse all "use" statements (including group imports) from the given text.
 * Returns a Map of shortName -> fullClass.
 *
 * Examples:
 *   use Lib\PHPX\Toggle;                 // "Toggle" -> "Lib\PHPX\Toggle"
 *   use Lib\PHPX\Toggle as MyToggle;     // "MyToggle" -> "Lib\PHPX\Toggle"
 *   use Lib\PHPX\PPIcons\{Search};       // "Search" -> "Lib\PHPX\PPIcons\Search"
 *   use Lib\PHPX\PPIcons\{Search as GoogleSearch}; // "GoogleSearch" -> "Lib\PHPX\PPIcons\Search"
 */
function parsePhpUseStatements(text: string): Map<string, string> {
  const shortNameMap = new Map<string, string>();

  // Regex to match entire use statement up to the semicolon
  // e.g. "use Lib\PHPX\Toggle;" or "use Lib\PHPX\PPIcons\{Search as GoogleSearch};"
  const useRegex = /use\s+([^;]+);/g;
  let match: RegExpExecArray | null;

  while ((match = useRegex.exec(text))) {
    const importBody = match[1].trim();
    if (!importBody) {
      continue;
    }

    // If it's a group import with braces: "use Some\Prefix\{A, B as C};"
    const braceOpenIndex = importBody.indexOf("{");
    const braceCloseIndex = importBody.lastIndexOf("}");
    if (braceOpenIndex !== -1 && braceCloseIndex !== -1) {
      // e.g. prefix = "Some\Prefix\"
      const prefix = importBody.substring(0, braceOpenIndex).trim();
      // e.g. "A, B as C"
      const insideBraces = importBody
        .substring(braceOpenIndex + 1, braceCloseIndex)
        .trim();

      // Split by commas to get each item
      const items = insideBraces.split(",");
      for (let rawItem of items) {
        rawItem = rawItem.trim();
        if (!rawItem) {
          continue;
        }
        processSingleImport(prefix, rawItem, shortNameMap);
      }
    } else {
      // Single import statement
      processSingleImport("", importBody, shortNameMap);
    }
  }

  return shortNameMap;
}

/**
 * Processes a single import piece like:
 *   - "Lib\PHPX\Toggle"
 *   - "Lib\PHPX\Toggle as MyToggle"
 *   - "Toggle"
 *   - "Toggle as MyToggle"
 *   - prefix = "Some\Prefix\" plus item = "Search as GoogleSearch"
 */
function processSingleImport(
  prefix: string,
  item: string,
  shortNameMap: Map<string, string>
) {
  // If there's an " as " we highlight the alias; otherwise the short name is the last part.
  const asMatch = /\bas\b\s+([\w]+)/i.exec(item);
  if (asMatch) {
    // e.g. "Lib\PHPX\Toggle as MyToggle"
    const aliasName = asMatch[1];
    const originalPart = item.substring(0, asMatch.index).trim(); // e.g. "Lib\PHPX\Toggle"
    const fullClass = prefix ? joinPath(prefix, originalPart) : originalPart;
    shortNameMap.set(aliasName, fullClass);
  } else {
    // e.g. "Lib\PHPX\Toggle"
    const fullClass = prefix ? joinPath(prefix, item) : item;
    const shortName = getLastPart(item);
    shortNameMap.set(shortName, fullClass);
  }
}

/**
 * Joins a prefix and item ensuring we don't lose backslashes.
 * e.g. prefix="Lib\PHPX\PPIcons\" and item="Search"
 */
function joinPath(prefix: string, item: string): string {
  // Remove any trailing backslash from prefix
  if (prefix.endsWith("\\")) {
    return prefix + item;
  }
  return prefix + "\\" + item;
}

/**
 * Returns the last part of a backslash-separated string.
 * e.g. "Lib\PHPX\Toggle" -> "Toggle"
 */
function getLastPart(path: string): string {
  const parts = path.split("\\");
  return parts[parts.length - 1];
}

/**
 * Removes heredoc/nowdoc blocks from text to avoid false positives like <HTML />
 * inside a string block.
 */
function removeHeredocsAndNowdocs(text: string): string {
  // This handles both heredocs and nowdocs, with or without quotes,
  // and allows indentation before the closing label.
  const heredocPattern =
    /<<<(['"]?)([A-Za-z0-9_]+)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2\s*;/gm;
  return text.replace(heredocPattern, "");
}

// Called when your extension is deactivated
export function deactivate() {}
