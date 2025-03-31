import * as vscode from "vscode";

interface HeredocBlock {
  content: string;
  startIndex: number;
}

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
 * Captures any heredoc or nowdoc blocks of the form:
 *    <<<LABEL
 *    ... content ...
 *    LABEL;
 *
 *    <<<'LABEL'
 *    ... content ...
 *    LABEL;
 *
 * Then returns an array of { content, startIndex }.
 * The startIndex is where the *actual* content begins, so you can map tags to correct positions.
 */
function extractAllHeredocBlocks(text: string): HeredocBlock[] {
  const blocks: HeredocBlock[] = [];
  // Matches:
  //    <<<LABEL
  //    (content)
  //    LABEL;
  //
  // or  <<<'LABEL'
  //    (content)
  //    LABEL;
  //
  // Group 1: optional quote
  // Group 2: label (the identifier)
  // Group 3: the body
  const pattern =
    /<<<(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2\s*;/gm;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const [, , , blockContent] = match;
    // The blockContent starts at pattern.lastIndex minus the length of blockContent plus the newline.
    // However, simpler is to say: start of content is match.index + offset to the group(3).
    // We'll do a quick calculation:
    const fullMatchIndex = match.index; // Where the `<<<LABEL` begins
    const opener = match[0]; // Full matched text: `<<<LABEL\n...\nLABEL;`
    // We can find where group(3) starts by measuring lengths:
    const group3Start = match.index + match[0].indexOf(blockContent);

    blocks.push({
      content: blockContent,
      startIndex: group3Start,
    });
  }
  return blocks;
}

/**
 * Replaces heredoc/nowdoc openers like `<<<EOD`, `<<< EOD`, `<<<'EOD'`, etc.
 * with spaces so they aren't detected as <EOD> tags.
 */
function blankOutHeredocOpeners(text: string): string {
  // Notice the `\s*` after `<<<`.
  return text.replace(/<<<\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/g, (match) =>
    " ".repeat(match.length)
  );
}

function removePhpComments(text: string): string {
  let result = text;

  // Remove // single-line comments
  result = result.replace(/\/\/[^\r\n]*/g, (comment) =>
    " ".repeat(comment.length)
  );

  // Remove /* ... */ multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    " ".repeat(comment.length)
  );

  return result;
}

/**
 * Use this new function in your diagnostics.
 */
function validateMissingImports(
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
) {
  if (document.languageId !== "php") {
    return;
  }

  const originalText = document.getText();

  // 1) Remove PHP comments so that `<Something>` inside comments is ignored
  let noCommentsText = removePhpComments(originalText);

  // 2) Blank out `<<<LABEL` openers in that text to avoid seeing them as <LABEL> tags
  noCommentsText = blankOutHeredocOpeners(noCommentsText);

  // 3) Build shortName → fullClass map
  const useMap = parsePhpUseStatements(originalText);
  let diagnostics: vscode.Diagnostic[] = [];

  // 4) Find <Tag> in "normal" code (excluding heredoc openers, excluding comments)
  const tagMatches = [...noCommentsText.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)];
  for (const match of tagMatches) {
    const tag = match[1];
    // If not imported, issue a warning
    if (!useMap.has(tag)) {
      // match.index + 1 because `<Tag` -> the Tag starts at +1 offset
      const start = document.positionAt((match.index ?? 0) + 1);
      const range = new vscode.Range(start, start.translate(0, tag.length));
      diagnostics.push(
        new vscode.Diagnostic(
          range,
          `⚠️ Missing import for component <${tag} />`,
          vscode.DiagnosticSeverity.Warning
        )
      );
    }
  }

  // 5) Parse tags inside each heredoc block
  const heredocBlocks = extractAllHeredocBlocks(originalText);

  for (const block of heredocBlocks) {
    // FIRST blank out any nested `<<<EOD` openers inside the block content:
    let blockContent = block.content;
    blockContent = blankOutHeredocOpeners(blockContent);

    // THEN scan for <Tag>
    const blockTagMatches = [
      ...blockContent.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g),
    ];
    for (const match of blockTagMatches) {
      const tag = match[1];
      if (!useMap.has(tag)) {
        const absoluteIndex = block.startIndex + (match.index ?? 0) + 1;
        const startPos = document.positionAt(absoluteIndex);
        const range = new vscode.Range(
          startPos,
          startPos.translate(0, tag.length)
        );
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `⚠️ Missing import for component <${tag} /> (in heredoc)`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }
  }

  // 6) Optionally run extra validations if "prisma-php.json" is found
  vscode.workspace.findFiles("prisma-php.json", null, 1).then((files) => {
    if (files.length > 0) {
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

  // Define common HTML attributes that should be exempt from the warning.
  const commonHtmlAttributes = new Set(["href", "src", "alt", "title"]);

  // 1) Replace inline PHP blocks with whitespace, preserving offsets
  let noPhpText = text.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (phpBlock) =>
    " ".repeat(phpBlock.length)
  );

  // 1a) Remove // single-line comments
  noPhpText = noPhpText.replace(/\/\/[^\r\n]*/g, (comment) =>
    " ".repeat(comment.length)
  );

  // 1b) Remove /* ... */ multi-line comments
  noPhpText = noPhpText.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    " ".repeat(comment.length)
  );

  // 2) Blank out heredoc/nowdoc openers so `<<<HTML` won’t be parsed as <HTML>
  noPhpText = noPhpText.replace(/<<<[A-Za-z_][A-Za-z0-9_]*/g, (match) =>
    " ".repeat(match.length)
  );
  noPhpText = noPhpText.replace(/<<<'[A-Za-z_][A-Za-z0-9_]*'/g, (match) =>
    " ".repeat(match.length)
  );

  // 3) Find tags (including self-closing).
  //    Group 1: the tag name
  //    Group 2: the raw attribute text
  const tagRegex = /<(\w+)(?:"[^"]*"|'[^']*'|[^>"'])*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(noPhpText))) {
    const fullTag = match[0];
    const tagName = match[1];
    const attrText = match[2] || "";

    // Calculate where the attribute text begins (for diagnostic positioning).
    const attrTextIndex = match.index + fullTag.indexOf(attrText);

    // 4) Combined regex to detect normal attributes (name="..." or name='...') and dynamic placeholders.
    const combinedRegex =
      /([A-Za-z_:][A-Za-z0-9_.:\-]*)(\s*=\s*(["'“”])((?:(?!\3|<)[\s\S])*)\3)?|\{\$[^}]+\}|\$+\w+/g;

    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = combinedRegex.exec(attrText))) {
      // If group 1 is present, we have a normal attribute.
      if (attrMatch[1]) {
        const attrName = attrMatch[1];
        const attrAssignment = attrMatch[2];
        // Only trigger a warning if there's no assignment and the attribute isn't one of the common HTML ones.
        if (
          !attrAssignment &&
          !commonHtmlAttributes.has(attrName.toLowerCase())
        ) {
          const startIndex = attrTextIndex + (attrMatch.index ?? 0);
          const endIndex = startIndex + attrName.length;
          const startPos = document.positionAt(startIndex);
          const endPos = document.positionAt(endIndex);

          diagnostics.push(
            new vscode.Diagnostic(
              new vscode.Range(startPos, endPos),
              `In XML mode, attribute "${attrName}" in <${tagName}> must have an explicit value (e.g., ${attrName}="value")`,
              vscode.DiagnosticSeverity.Warning
            )
          );
        }
      }
      // Otherwise, skip dynamic placeholders (e.g., {$attributes} or $foo).
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

  // 1a) Remove // single-line comments
  noPhpText = noPhpText.replace(/\/\/[^\r\n]*/g, (comment) =>
    " ".repeat(comment.length)
  );

  // 1b) Remove /* ... */ multi-line comments
  noPhpText = noPhpText.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    " ".repeat(comment.length)
  );

  // 2) Blank out the heredoc/nowdoc opener itself
  noPhpText = noPhpText.replace(/<<<[A-Za-z_][A-Za-z0-9_]*/g, (match) =>
    " ".repeat(match.length)
  );
  noPhpText = noPhpText.replace(/<<<'[A-Za-z_][A-Za-z0-9_]*'/g, (match) =>
    " ".repeat(match.length)
  );

  // 3) Tag-pair validation using an improved tag regex
  const voidElements = new Set(["input", "br", "hr", "img", "meta", "link"]);
  const tagRegex =
    /<(\/?)([A-Za-z][A-Za-z0-9]*)(?:"[^"]*"|'[^']*'|[^>"'])*\s*(\/?)>/g;
  const stack: { tag: string; pos: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(noPhpText))) {
    // Optionally, log a debug substring:
    // console.log("Matched substring =>", noPhpText.substring(match.index, match.index + 50));

    const isClosing = match[1] === "/";
    const tagName = match[2]; // keep the original case
    const selfClosingIndicator = match[3];
    const matchIndex = match.index;

    // Determine if this tag is a known void element.
    // Only consider it a void element if its name is all lowercase.
    const isVoidElement =
      voidElements.has(tagName.toLowerCase()) &&
      tagName === tagName.toLowerCase();

    if (isClosing) {
      if (stack.length === 0) {
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
      if (isVoidElement) {
        // Void elements in XML mode must be self-closed.
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

// Called when your extension is deactivated
export function deactivate() {}
