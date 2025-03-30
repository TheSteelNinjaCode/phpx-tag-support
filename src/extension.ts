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
      diagnostics = diagnostics.concat(getTagPairDiagnostics(document));
    }
    diagnosticCollection.set(document.uri, diagnostics);
  });
}

/**
 * Returns diagnostics for XML attributes without an explicit value.
 * In "XML mode," every attribute must be assigned a value (e.g., foo="bar").
 */
function getXmlAttributeDiagnostics(
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];

  //
  // 1) Replace all inline PHP blocks with whitespace, preserving offsets.
  //    (Same as your old code.)
  //
  let noPhpText = text.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (phpBlock) => {
    return " ".repeat(phpBlock.length);
  });

  //
  // 2) Blank out heredoc/nowdoc *opener* tokens like `<<<HTML` or `<<<'HTML'`.
  //    This prevents them from being read as real `<HTML>` tags.
  //
  noPhpText = noPhpText.replace(/<<<[A-Za-z_][A-Za-z0-9_]*/g, (match) => {
    return " ".repeat(match.length);
  });
  noPhpText = noPhpText.replace(/<<<'[A-Za-z_][A-Za-z0-9_]*'/g, (match) => {
    return " ".repeat(match.length);
  });

  //
  // 3) Now match tags (including self-closing). For each tag:
  //    - Group 1: the tag name (e.g., "input")
  //    - Group 2: everything until ">", i.e. the attributes portion
  //
  const tagRegex = /<(\w+)([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(noPhpText))) {
    const fullTag = match[0]; // e.g. <input isActive ... />
    const tagName = match[1]; // e.g. "input"
    const attrText = match[2] || ""; // e.g. isActive type="checkbox" isChecked

    // Figure out where the attributes begin in the document (for diagnostics).
    const attrTextIndex = match.index + fullTag.indexOf(attrText);

    //
    // 4) Look for attributes. For each, check if it has = "..." or = '...'.
    //    Group 1: attribute name, Group 2: optional assignment (="...")
    //
    const attrRegex = /([A-Za-z_:][A-Za-z0-9_.:\-]*)(\s*=\s*(".*?"|'.*?'))?/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrText))) {
      const attrName = attrMatch[1];
      const attrAssignment = attrMatch[2];

      // If there's no assignment at all, it's invalid XML syntax in "XML mode."
      if (!attrAssignment) {
        const startIndex = attrTextIndex + attrMatch.index;
        const endIndex = startIndex + attrName.length;
        const startPos = document.positionAt(startIndex);
        const endPos = document.positionAt(endIndex);

        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(startPos, endPos),
            `In XML mode, attribute "${attrName}" in <${tagName}> must have an explicit value (e.g. ${attrName}="value")`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }
  }

  return diagnostics;
}

function getTagPairDiagnostics(
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const text = document.getText();

  // 1) Remove inline PHP blocks but keep heredoc/nowdoc content intact
  let noPhpText = text.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (phpBlock) =>
    " ".repeat(phpBlock.length)
  );

  // 2) Blank out the heredoc/nowdoc *opener* itself, wherever it appears
  //    This ensures "<<<HTML" won't be misread as "<HTML>"
  //    - The following two regexes remove the literal substring `<<<HTML` or `<<<'HTML'`
  //      from anywhere in the line (including "return <<<HTML").
  noPhpText = noPhpText.replace(/<<<[A-Za-z_][A-Za-z0-9_]*/g, (match) =>
    " ".repeat(match.length)
  );
  noPhpText = noPhpText.replace(/<<<'[A-Za-z_][A-Za-z0-9_]*'/g, (match) =>
    " ".repeat(match.length)
  );

  // (Optional) If you ever need to blank out the closing identifier (e.g. `HTML;`),
  // you could do a similar replacement. But typically it's not parsed as a tag, so it’s safe.

  // 3) Tag-pair validation
  const voidElements = new Set(["input", "br", "hr", "img", "meta", "link"]);
  const tagRegex = /<(\/?)([A-Za-z][A-Za-z0-9]*)(\s[^>]*?)?(\/?)>/g;
  const stack: { tag: string; pos: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(noPhpText))) {
    const isClosing = match[1] === "/";
    const tagName = match[2].toLowerCase();
    const selfClosingIndicator = match[4];
    const matchIndex = match.index;

    if (isClosing) {
      // Closing tag logic
      if (stack.length === 0) {
        // No matching opening tag
        const pos = document.positionAt(matchIndex);
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(pos, pos.translate(0, tagName.length + 3)),
            `Extra closing tag </${tagName}> found.`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      } else {
        const last = stack.pop()!;
        if (last.tag !== tagName) {
          // Mismatched tag name
          const pos = document.positionAt(matchIndex);
          diagnostics.push(
            new vscode.Diagnostic(
              new vscode.Range(pos, pos.translate(0, tagName.length + 3)),
              `Mismatched closing tag: expected </${last.tag}> but found </${tagName}>.`,
              vscode.DiagnosticSeverity.Warning
            )
          );
        }
      }
    } else {
      // Opening tag logic
      if (voidElements.has(tagName)) {
        // Void elements in XML mode must be self-closed
        if (selfClosingIndicator !== "/") {
          const pos = document.positionAt(matchIndex);
          diagnostics.push(
            new vscode.Diagnostic(
              new vscode.Range(pos, pos.translate(0, tagName.length)),
              `In XML mode, <${tagName}> must be self-closed (e.g., <${tagName} ... />).`,
              vscode.DiagnosticSeverity.Warning
            )
          );
        }
      } else {
        // Non-void elements: push onto stack if not self-closed
        if (selfClosingIndicator !== "/") {
          stack.push({ tag: tagName, pos: matchIndex });
        }
      }
    }
  }

  // 4) Any unclosed tags left on stack
  for (const unclosed of stack) {
    const pos = document.positionAt(unclosed.pos);
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(pos, pos.translate(0, unclosed.tag.length)),
        `Missing closing tag for <${unclosed.tag}>.`,
        vscode.DiagnosticSeverity.Warning
      )
    );
  }

  return diagnostics;
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
