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
  result = result.replace(/(^|[^:])\/\/[^\r\n]*/g, (match, prefix) => {
    // keep prefix, blank out rest
    return prefix + " ".repeat(match.length - prefix.length);
  });

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
 * Detect and remove (blank out) PHP regex strings of the form
 * '/.../[a-z]*' or "/.../[a-z]*" to prevent them from being scanned as tags.
 *
 * This is a naive implementation assuming your regex literals:
 *   - Start with a single or double quote
 *   - Followed immediately by a forward slash
 *   - Contain zero or more characters (non-greedy) until the next slash
 *   - Possibly end with one or more flags (like `i`, `m`, `s`, etc.)
 *   - End with the same quote character you started with
 */
function removePhpRegexLiterals(text: string): string {
  // Explanation of the regex:
  // (['"])       => capture a single or double quote in group #1
  // \/           => a literal slash
  // .*?          => any characters (non-greedy) until the next slash
  // \/[a-z]*     => a slash followed by zero or more letters (flags)
  // \1           => match the same quote character as captured in group #1
  const pattern = /(['"])\/.*?\/[a-z]*\1/gi;
  return text.replace(pattern, (match) => " ".repeat(match.length));
}

/**
 * Replaces both "{$variable}" and "$variable" occurrences with spaces
 * so that they won't be mistaken for tags by the regex parser.
 */
function removePhpInterpolations(text: string): string {
  // Pattern explanation:
  //   \{\$[^}]+\}  ->  matches things like {$attributes}, {$foo}, etc.
  //   |            ->  OR
  //   \$[A-Za-z_]\w*
  //         ->  matches $foo, $bar, $someVar123, etc. (basic case)
  return text.replace(/\{\$[^}]+\}|\$[A-Za-z_]\w*/g, (match) => {
    return " ".repeat(match.length);
  });
}

/**
 * Removes certain PHP keywords/operators (false, true, null, ? :, =>, ->, !==, ===)
 * *outside* of quoted strings. This prevents them from appearing as HTML attributes
 * if they're near `<svg>` or any other tag.
 */
function removeOperatorsAndBooleansOutsideQuotes(text: string): string {
  let result = "";
  let inString = false;
  let quoteChar = "";
  let i = 0;

  // Helper to see if the next chunk of text matches a token
  function startsWithToken(token: string): boolean {
    return text.slice(i, i + token.length) === token;
  }

  while (i < text.length) {
    const ch = text[i];

    if (!inString) {
      // We are outside of any string. Check for known tokens:
      // (1) false | true | null
      // (2) !== | === | -> | =>
      // (3) ? : (with optional spaces)
      if (startsWithToken("false")) {
        // Make sure the next char isn't a letter/digit so we don't clobber "falsely".
        if (!/[A-Za-z0-9_]/.test(text[i + 5] || "")) {
          result += "     "; // 5 letters
          i += 5;
          continue;
        }
      } else if (startsWithToken("true")) {
        if (!/[A-Za-z0-9_]/.test(text[i + 4] || "")) {
          result += "    "; // 4 letters
          i += 4;
          continue;
        }
      } else if (startsWithToken("null")) {
        if (!/[A-Za-z0-9_]/.test(text[i + 4] || "")) {
          result += "    "; // 4 letters
          i += 4;
          continue;
        }
      } else if (startsWithToken("!==")) {
        result += "   "; // 3 chars
        i += 3;
        continue;
      } else if (startsWithToken("===")) {
        result += "   ";
        i += 3;
        continue;
      } else if (startsWithToken("->")) {
        result += "  ";
        i += 2;
        continue;
      } else if (startsWithToken("=>")) {
        result += "  ";
        i += 2;
        continue;
      } else if (ch === "?") {
        // We found a "?" outside quotes. Now we'll see if there's a ":" outside quotes
        // that matches this question mark (i.e. it's a ternary operator).
        let questionPos = i;
        let localInString = false;
        let localQuote = "";
        let foundColon = -1;

        // We start scanning from the next character after '?'
        let j = i + 1;

        // We'll parse until we either find a colon ':' outside quotes OR hit the end of text.
        while (j < text.length) {
          const c2 = text[j];
          if (!localInString) {
            // Are we starting a quoted string inside the ternary chunk?
            if (c2 === "'" || c2 === '"') {
              localInString = true;
              localQuote = c2;
            } else if (c2 === ":") {
              // Found the matching colon outside of any nested quotes
              foundColon = j;
              break;
            }
          } else {
            // We are inside a local string, so we only exit if we see the matching close-quote
            if (c2 === localQuote) {
              localInString = false;
              localQuote = "";
            }
          }
          j++;
        }

        if (foundColon !== -1) {
          // We found a real ternary "? ... :". Remove everything from
          // the question mark up to and including the colon:
          const length = foundColon - questionPos + 1;
          result += " ".repeat(length);
          i = foundColon + 1; // jump past the colon
          continue;
        } else {
          // No colon was found outside quotes. Treat this "?" as just a single char to blank out
          result += " ";
          i++;
          continue;
        }
      }

      // Not a removable token, so check if we’re starting a quote
      if (ch === "'" || ch === '"') {
        inString = true;
        quoteChar = ch;
        result += ch;
      } else {
        result += ch;
      }
    } else {
      // We are inside a quoted string—copy verbatim
      result += ch;
      if (ch === quoteChar) {
        inString = false;
      }
    }

    i++;
  }

  return result;
}

/**
 * Sanitizes text for diagnostics by removing inline PHP blocks, comments,
 * blanking out heredoc/nowdoc openers, and also removing PHP regex literal strings.
 * This helps ensure our <tag> scanning won't be fooled by things in comments or regexes.
 */
function sanitizeForDiagnostics(text: string): string {
  // 1) Remove inline PHP blocks like <?php ... ?> or <?= ... ?>
  text = text.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (block) =>
    " ".repeat(block.length)
  );

  // 2) Remove single-line comments (but skip those with ://)
  text = removePhpComments(text);

  // 3) Blank out heredoc/nowdoc openers
  text = blankOutHeredocOpeners(text);

  // 4) Remove PHP regex literals (e.g. /foo/i)
  text = removePhpRegexLiterals(text);

  // 5) Remove/blank out any {$variable} so it is not seen as a tag
  text = removePhpInterpolations(text);

  // 6) Use the new robust outside-quote stripper
  text = removeOperatorsAndBooleansOutsideQuotes(text);

  return text;
}

function analyzeAttributes(
  code: string,
  offset: number,
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const tagRegex = /<(\w+)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(code))) {
    const fullTag = match[0];
    const tagName = match[1];
    const attrText = match[2] ?? "";

    // similarly for attribute text
    const attrTextIndexInSnippet = fullTag.indexOf(attrText);

    // Now do the combinedRegex for each attribute
    const combinedRegex =
      /([A-Za-z_:][A-Za-z0-9_.:\-]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?|\{\$[^}]+\}|\$+\w+/g;

    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = combinedRegex.exec(attrText))) {
      const attrName = attrMatch[1];
      const attrAssignment = attrMatch[2];

      // If the attribute is missing a value, we create a Diagnostic
      if (attrName && !attrAssignment) {
        // position in snippet:
        const startIndexInSnippet =
          attrTextIndexInSnippet + (attrMatch.index ?? 0);
        // absolute position in real file
        const startIndex = offset + match.index + startIndexInSnippet;

        // Build the range
        const startPos = document.positionAt(startIndex);
        const endPos = document.positionAt(startIndex + attrName.length);

        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(startPos, endPos),
            `In XML mode, attribute "${attrName}" in <${tagName}> must have an explicit value (e.g., ${attrName}="value")`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }
  }
  return diagnostics;
}

/**
 * Returns diagnostics for XML attributes without an explicit value.
 * Uses the sanitized text to avoid false positives from PHP blocks, comments, or heredoc openers.
 */
function getXmlAttributeDiagnostics(
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const originalText = document.getText();
  let diagnostics: vscode.Diagnostic[] = [];

  //
  // (A) Analyze main code outside heredocs
  //
  // 1) Create a copy of text where the *heredoc bodies* are removed,
  //    but everything else is sanitized. That way your main HTML/JSX
  //    code is cleanly analyzed.
  //
  //    – This is what sanitizeForDiagnostics() already does.
  //    – But do NOT remove the entire heredoc block from the originalText here.
  //      Just remove them in the sanitized copy used for "main" analysis.
  //
  const sanitizedMain = sanitizeForDiagnostics(originalText);

  // 2) Run your existing “find tags + check attributes” logic on `sanitizedMain`.
  //    That code sees no heredoc content, which is good.
  const mainDiagnostics = analyzeAttributes(sanitizedMain, 0, document);
  diagnostics.push(...mainDiagnostics);

  //
  // (B) Analyze each heredoc block *as if* it’s separate HTML
  //
  const heredocBlocks = extractAllHeredocBlocks(originalText);

  for (const block of heredocBlocks) {
    // 1) Make a sanitized copy of just that heredoc’s content
    let blockContent = block.content;
    // Optionally remove nested comments, remove nested heredoc openers, etc.
    blockContent = removePhpComments(blockContent);
    blockContent = blankOutHeredocOpeners(blockContent);
    blockContent = removePhpRegexLiterals(blockContent);

    // 2) Analyze the block as if it’s standalone HTML
    //    But we must shift *all positions* by block.startIndex
    //    so that your diagnostics point to correct lines in the original doc.
    const blockDiagnostics = analyzeAttributes(
      blockContent,
      block.startIndex,
      document
    );
    diagnostics.push(...blockDiagnostics);
  }

  return diagnostics;
}

/**
 * Returns diagnostics for mismatched or unclosed tag pairs.
 * Also uses the sanitized text to prevent misinterpreting PHP blocks or heredoc content as tags.
 */
function getTagPairDiagnostics(
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const sanitizedText = sanitizeForDiagnostics(document.getText());

  const voidElements = new Set(["input", "br", "hr", "img", "meta", "link"]);
  // Regex for matching tag pairs.
  const tagRegex =
    /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s+(?:[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?))*\s*(\/?)>/g;

  const stack: { tag: string; pos: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(sanitizedText))) {
    const isClosing = match[1] === "/";
    const tagName = match[2];
    const selfClosingIndicator = match[3];
    const matchIndex = match.index;

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
      if (voidElements.has(tagName)) {
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
      } else if (selfClosingIndicator !== "/") {
        stack.push({ tag: tagName, pos: matchIndex });
      }
    }
  }

  // Report any unclosed tags remaining in the stack.
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
