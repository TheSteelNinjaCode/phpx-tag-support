import * as vscode from "vscode";

/* ────────────────────────────────────────────────────────────── *
 *                        INTERFACES & CONSTANTS                    *
 * ────────────────────────────────────────────────────────────── */

interface HeredocBlock {
  content: string;
  startIndex: number;
}

const PHP_LANGUAGE = "php";

// Command ID for auto-import.
const ADD_IMPORT_COMMAND = "phpx.addImport";

// Colors for decorations
const BRACE_COLOR = "#569CD6";
const NATIVE_FUNC_COLOR = "#D16969";
const NATIVE_PROP_COLOR = "#4EC9B0";

// Regex patterns
const PHP_TAG_REGEX = /<\/?[A-Z][A-Za-z0-9]*/;
const JS_EXPR_REGEX = /{{\s*(.*?)\s*}}/g;
const HEREDOC_PATTERN =
  /<<<(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2\s*;/gm;

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Modified auto-import command that groups use statements if a group import exists,
 * or if separate use statements for the same namespace exist.
 */
const addImportCommand = async (
  document: vscode.TextDocument,
  fullComponent: string
) => {
  const text = document.getText();

  // If already imported (as a single statement), do nothing.
  if (text.includes(`use ${fullComponent};`)) {
    return;
  }

  // Compute the group prefix and the short component name.
  const lastSlash = fullComponent.lastIndexOf("\\");
  const groupPrefix = fullComponent.substring(0, lastSlash);
  const componentName = fullComponent.substring(lastSlash + 1);

  const edit = new vscode.WorkspaceEdit();

  // Try to match a grouped import (with curly braces) first.
  const groupImportRegex = new RegExp(
    `use\\s+${escapeRegex(groupPrefix)}\\\\\\{([^}]+)\\};`,
    "m"
  );
  const groupMatch = groupImportRegex.exec(text);

  if (groupMatch) {
    // A grouped import already exists.
    let existingComponents = groupMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!existingComponents.includes(componentName)) {
      existingComponents.push(componentName);
      existingComponents.sort();
      // Note: only escape the opening curly brace; the closing brace stays as is.
      const newGroupImport = `use ${groupPrefix}\\{${existingComponents.join(
        ", "
      )}\};`;
      const startPos = document.positionAt(groupMatch.index);
      const endPos = document.positionAt(
        groupMatch.index + groupMatch[0].length
      );
      const groupRange = new vscode.Range(startPos, endPos);
      // Removed the extra "\n" appended.
      edit.replace(document.uri, groupRange, newGroupImport);
    }
  } else {
    // Look for separate use statements from the same group.
    const sepRegex = new RegExp(
      `use\\s+${escapeRegex(groupPrefix)}\\\\([A-Za-z0-9_]+);`,
      "gm"
    );
    const matchArray: { component: string; index: number; length: number }[] =
      [];
    let m;
    while ((m = sepRegex.exec(text)) !== null) {
      matchArray.push({
        component: m[1].trim(),
        index: m.index,
        length: m[0].length,
      });
    }
    if (matchArray.length > 0) {
      // One or more separate use statements exist; replace them with a grouped one.
      let existingComponents = matchArray.map((x) => x.component);
      if (!existingComponents.includes(componentName)) {
        existingComponents.push(componentName);
      }
      // Remove duplicates and sort.
      existingComponents = Array.from(new Set(existingComponents)).sort();
      const newGroupImport = `use ${groupPrefix}\\{${existingComponents.join(
        ", "
      )}\};`;
      // Determine the range covering all matching separate use statements.
      const firstMatch = matchArray[0];
      const lastMatch = matchArray[matchArray.length - 1];
      const startPos = document.positionAt(firstMatch.index);
      const endPos = document.positionAt(lastMatch.index + lastMatch.length);
      const groupRange = new vscode.Range(startPos, endPos);
      // Replace without adding an extra newline.
      edit.replace(document.uri, groupRange, newGroupImport);
    } else {
      // No existing group or separate imports found; insert a new use statement.
      let insertPosition: vscode.Position;
      if (/^\s*<\?php/.test(text)) {
        const namespaceRegex = /^namespace\s+.+?;/m;
        const nsMatch = namespaceRegex.exec(text);
        if (nsMatch) {
          const nsPosition = document.positionAt(nsMatch.index);
          insertPosition = new vscode.Position(nsPosition.line + 1, 0);
        } else {
          const firstLine = document.lineAt(0);
          insertPosition = new vscode.Position(firstLine.lineNumber + 1, 0);
        }
        // Insert without an extra newline.
        edit.insert(document.uri, insertPosition, `use ${fullComponent};\n`);
      } else {
        insertPosition = new vscode.Position(0, 0);
        const newPhpBlock = `<?php\nuse ${fullComponent};\n?>\n\n`;
        edit.insert(document.uri, insertPosition, newPhpBlock);
      }
    }
  }
  await vscode.workspace.applyEdit(edit);
};

/* ────────────────────────────────────────────────────────────── *
 *                       EXTENSION ACTIVATION                       *
 * ────────────────────────────────────────────────────────────── */

export function activate(context: vscode.ExtensionContext) {
  console.log("PHPX tag support is now active!");

  // Load the dynamic components from class-log.json.
  loadComponentsFromClassLog();

  // Force Peek Definition for Go to Definition globally.
  updateEditorConfiguration();

  // Create diagnostic collections.
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("phpx-tags");
  const jsVarDiagnostics =
    vscode.languages.createDiagnosticCollection("js-vars");
  context.subscriptions.push(diagnosticCollection, jsVarDiagnostics);

  // Register language features for PHP.
  context.subscriptions.push(
    registerPhpHoverProvider(),
    registerPhpDefinitionProvider(),
    registerPhpCompletionProvider()
  );

  // Register the command for auto-import.
  context.subscriptions.push(
    vscode.commands.registerCommand(ADD_IMPORT_COMMAND, addImportCommand)
  );

  // Register commands.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "phpx-tag-support.peekTagDefinition",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await vscode.commands.executeCommand("editor.action.peekDefinition");
        }
      }
    ),
    vscode.commands.registerCommand("phpx-tag-support.hoverProvider", () => {
      vscode.window.showInformationMessage(
        "Hello World from phpx-tag-support!"
      );
    })
  );

  // Create decoration types for curly braces and native tokens.
  const braceDecorationType = vscode.window.createTextEditorDecorationType({
    color: BRACE_COLOR,
  });
  const nativeFunctionDecorationType =
    vscode.window.createTextEditorDecorationType({
      color: NATIVE_FUNC_COLOR,
      fontWeight: "bold",
    });
  const nativePropertyDecorationType =
    vscode.window.createTextEditorDecorationType({
      color: NATIVE_PROP_COLOR,
    });

  // Combined update validations function.
  const updateAllValidations = (document: vscode.TextDocument): void => {
    updateJsVariableDecorations(document, braceDecorationType);
    validateJsVariablesInCurlyBraces(document, jsVarDiagnostics);
    updateNativeTokenDecorations(
      document,
      nativeFunctionDecorationType,
      nativePropertyDecorationType
    );
    validateMissingImports(document, diagnosticCollection);
  };

  // Register event listeners.
  vscode.workspace.onDidChangeTextDocument(
    (e) => updateAllValidations(e.document),
    null,
    context.subscriptions
  );
  vscode.workspace.onDidSaveTextDocument(
    updateAllValidations,
    null,
    context.subscriptions
  );
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      updateAllValidations(editor.document);
    }
  });
}

/* ────────────────────────────────────────────────────────────── *
 *                    EDITOR CONFIGURATION UPDATE                   *
 * ────────────────────────────────────────────────────────────── */

const updateEditorConfiguration = (): void => {
  const editorConfig = vscode.workspace.getConfiguration("editor");
  // Use peek for single and multiple go-to definition actions.
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
};

/* ────────────────────────────────────────────────────────────── *
 *                        LANGUAGE PROVIDERS                        *
 * ────────────────────────────────────────────────────────────── */

// Hover provider for PHP tags.
const registerPhpHoverProvider = () => {
  return vscode.languages.registerHoverProvider(PHP_LANGUAGE, {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position, PHP_TAG_REGEX);
      if (!range) {
        return;
      }
      const word = document.getText(range);
      const tagName = word.replace(/[</]/g, "");
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
};

// Definition provider for PHP tags.
const registerPhpDefinitionProvider = () => {
  return vscode.languages.registerDefinitionProvider(PHP_LANGUAGE, {
    async provideDefinition(document, position) {
      const range = document.getWordRangeAtPosition(position, PHP_TAG_REGEX);
      if (!range) {
        return;
      }
      const word = document.getText(range);
      const tagName = word.replace(/[</]/g, "");
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
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
  });
};

// Completion provider for PHP tags and custom snippet insertion.
const registerPhpCompletionProvider = () => {
  return vscode.languages.registerCompletionItemProvider(
    PHP_LANGUAGE,
    {
      provideCompletionItems(document, position) {
        const completions: vscode.CompletionItem[] = [];

        // Existing component completions from use statements.
        const useMap = parsePhpUseStatements(document.getText());
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
          completions.push(item);
        }

        // Add completions from the class-log.json data.
        // Inside registerPhpCompletionProvider:
        const componentsMap = getComponentsFromClassLog();
        componentsMap.forEach((fullComponent, shortName) => {
          const compItem = new vscode.CompletionItem(
            shortName,
            vscode.CompletionItemKind.Class
          );
          compItem.detail = `Component (from class-log)`;
          compItem.command = {
            title: "Add import",
            command: ADD_IMPORT_COMMAND,
            arguments: [document, fullComponent],
          };
          compItem.filterText = shortName;
          compItem.insertText = new vscode.SnippetString(`<${shortName}`);
          completions.push(compItem);
        });

        // Add the snippet completion for "phpxclass" template.
        const snippetCompletion = new vscode.CompletionItem(
          "phpxclass",
          vscode.CompletionItemKind.Snippet
        );
        snippetCompletion.detail = "PHPX Class Template";
        snippetCompletion.insertText = new vscode.SnippetString(
          `<?php

namespace \${1:Lib\\PHPX\\Components};

use Lib\\PHPX\\PHPX;

class \${2:ClassName} extends PHPX
{
    public function __construct(array \\$props = [])
    {
        parent::__construct(\\$props);
    }

    public function render(): string
    {
        \\$attributes = \\$this->getAttributes();
        \\$class = \\$this->getMergeClasses();

        return <<<HTML
        <div class="{\\$class}" {\\$attributes}>
            {\\$this->children}
        </div>
        HTML;
    }
}
`
        );
        snippetCompletion.filterText = "phpxclass";
        completions.push(snippetCompletion);

        return completions;
      },
    },
    "<" // Trigger character.
  );
};

/* ────────────────────────────────────────────────────────────── *
 *                     HELPER: READ COMPONENTS FROM CLASS LOG       *
 * ────────────────────────────────────────────────────────────── */

// Global cache for components
let componentsCache = new Map<string, string>();

/**
 * Asynchronously loads the components from class-log.json and caches them.
 */
async function loadComponentsFromClassLog(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }
  const workspaceFolder = workspaceFolders[0];
  const jsonUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    "settings",
    "class-log.json"
  );
  try {
    const data = await vscode.workspace.fs.readFile(jsonUri);
    const jsonStr = Buffer.from(data).toString("utf8").trim();
    if (jsonStr) {
      const jsonMapping = JSON.parse(jsonStr);
      // Iterate over each fully qualified component name in the JSON
      Object.keys(jsonMapping).forEach((fqcn) => {
        // Use your helper to get the short name (e.g. "Collapsible" from "Lib\\PHPX\\PHPXUI\\Collapsible")
        const shortName = getLastPart(fqcn);
        componentsCache.set(shortName, fqcn);
      });
    }
  } catch (error) {
    console.error("Error reading class-log.json:", error);
  }
}

/**
 * Returns the cached components map.
 */
function getComponentsFromClassLog(): Map<string, string> {
  return componentsCache;
}

/* ────────────────────────────────────────────────────────────── *
 *                     DECORATION AND VALIDATION                     *
 * ────────────────────────────────────────────────────────────── */

// Update curly brace decorations within JS expressions.
const updateJsVariableDecorations = (
  document: vscode.TextDocument,
  decorationType: vscode.TextEditorDecorationType
): void => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const text = document.getText();
  const decorations: vscode.DecorationOptions[] = [];
  let match: RegExpExecArray | null;
  while ((match = JS_EXPR_REGEX.exec(text)) !== null) {
    const startIndex = match.index;
    const matchLength = match[0].length;
    const leftStart = document.positionAt(startIndex);
    const leftEnd = document.positionAt(startIndex + 2);
    decorations.push({ range: new vscode.Range(leftStart, leftEnd) });
    const rightStart = document.positionAt(startIndex + matchLength - 2);
    const rightEnd = document.positionAt(startIndex + matchLength);
    decorations.push({ range: new vscode.Range(rightStart, rightEnd) });
  }
  editor.setDecorations(decorationType, decorations);
};

const isValidJsExpression = (expr: string): boolean => {
  try {
    new Function(`return (${expr});`);
    return true;
  } catch {
    return false;
  }
};

const validateJsVariablesInCurlyBraces = (
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
): void => {
  if (document.languageId !== PHP_LANGUAGE) {
    return;
  }
  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];
  let match: RegExpExecArray | null;
  while ((match = JS_EXPR_REGEX.exec(text)) !== null) {
    const expr = match[1].trim();
    if (!isValidJsExpression(expr)) {
      const startIndex = match.index + match[0].indexOf(expr);
      const endIndex = startIndex + expr.length;
      const startPos = document.positionAt(startIndex);
      const endPos = document.positionAt(endIndex);
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(startPos, endPos),
          `⚠️ Invalid JavaScript expression in {{ ... }}.`,
          vscode.DiagnosticSeverity.Warning
        )
      );
    }
  }
  diagnosticCollection.set(document.uri, diagnostics);
};

const updateNativeTokenDecorations = (
  document: vscode.TextDocument,
  funcDecoType: vscode.TextEditorDecorationType,
  propDecoType: vscode.TextEditorDecorationType
): void => {
  const editor = vscode.window.activeTextEditor;
  if (!editor || document.languageId !== PHP_LANGUAGE) {
    return;
  }
  const text = document.getText();
  const funcDecorations: vscode.DecorationOptions[] = [];
  const propDecorations: vscode.DecorationOptions[] = [];
  const nativeFuncRegex = /\b(toUpperCase|toLowerCase|trim|split)\b/g;
  const nativePropRegex = /\b(length|name|prototype)\b/g;
  let exprMatch: RegExpExecArray | null;
  while ((exprMatch = JS_EXPR_REGEX.exec(text)) !== null) {
    const jsExpr = exprMatch[1];
    const exprStartIndex = exprMatch.index + exprMatch[0].indexOf(jsExpr);
    let funcMatch: RegExpExecArray | null;
    while ((funcMatch = nativeFuncRegex.exec(jsExpr)) !== null) {
      const tokenStart = exprStartIndex + funcMatch.index;
      const tokenEnd = tokenStart + funcMatch[0].length;
      const startPos = document.positionAt(tokenStart);
      const endPos = document.positionAt(tokenEnd);
      funcDecorations.push({ range: new vscode.Range(startPos, endPos) });
    }
    let propMatch: RegExpExecArray | null;
    while ((propMatch = nativePropRegex.exec(jsExpr)) !== null) {
      const tokenStart = exprStartIndex + propMatch.index;
      const tokenEnd = tokenStart + propMatch[0].length;
      const startPos = document.positionAt(tokenStart);
      const endPos = document.positionAt(tokenEnd);
      propDecorations.push({ range: new vscode.Range(startPos, endPos) });
    }
  }
  editor.setDecorations(funcDecoType, funcDecorations);
  editor.setDecorations(propDecoType, propDecorations);
};

/* ────────────────────────────────────────────────────────────── *
 *                      PHP DIAGNOSTIC FUNCTIONS                    *
 * ────────────────────────────────────────────────────────────── */

const validateMissingImports = (
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
): void => {
  if (document.languageId !== PHP_LANGUAGE) {
    return;
  }
  const originalText = document.getText();
  let noCommentsText = removePhpComments(originalText);
  noCommentsText = blankOutHeredocOpeners(noCommentsText);
  const useMap = parsePhpUseStatements(originalText);
  const diagnostics: vscode.Diagnostic[] = [];
  const tagMatches = [...noCommentsText.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)];
  tagMatches.forEach((match) => {
    const tag = match[1];
    if (!useMap.has(tag)) {
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
  });
  const heredocBlocks = extractAllHeredocBlocks(originalText);
  heredocBlocks.forEach((block) => {
    let blockContent = blankOutHeredocOpeners(block.content);
    const blockTagMatches = [
      ...blockContent.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g),
    ];
    blockTagMatches.forEach((match) => {
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
    });
  });
  vscode.workspace.findFiles("prisma-php.json", null, 1).then((files) => {
    if (files.length > 0) {
      const xmlDiagnostics = getXmlAttributeDiagnostics(document).concat(
        getTagPairDiagnostics(document)
      );
      diagnostics.push(...xmlDiagnostics);
    }
    diagnosticCollection.set(document.uri, diagnostics);
  });
};

/* ────────────────────────────────────────────────────────────── *
 *                       PHP SANITIZATION UTILS                     *
 * ────────────────────────────────────────────────────────────── */

const extractAllHeredocBlocks = (text: string): HeredocBlock[] => {
  const blocks: HeredocBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = HEREDOC_PATTERN.exec(text)) !== null) {
    const blockContent = match[3];
    const group3Start = match.index + match[0].indexOf(blockContent);
    blocks.push({ content: blockContent, startIndex: group3Start });
  }
  return blocks;
};

const blankOutHeredocOpeners = (text: string): string =>
  text.replace(/<<<\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/g, (match) =>
    " ".repeat(match.length)
  );

const removePhpComments = (text: string): string => {
  let result = text;
  result = result.replace(
    /(^|[^:])\/\/[^\r\n]*/g,
    (match, prefix) =>
      prefix + " ".repeat(match.length - (prefix ? prefix.length : 0))
  );
  result = result.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    " ".repeat(comment.length)
  );
  return result;
};

const removePhpRegexLiterals = (text: string): string => {
  const pattern = /(['"])\/.*?\/[a-z]*\1/gi;
  return text.replace(pattern, (match) => " ".repeat(match.length));
};

const removePhpInterpolations = (text: string): string =>
  text.replace(/\{\$[^}]+\}|\$[A-Za-z_]\w*/g, (match) =>
    " ".repeat(match.length)
  );

const removeOperatorsAndBooleansOutsideQuotes = (text: string): string => {
  let result = "";
  let inString = false;
  let quoteChar = "";
  let i = 0;
  const startsWithToken = (token: string): boolean =>
    text.slice(i, i + token.length) === token;
  while (i < text.length) {
    const ch = text[i];
    if (!inString) {
      if (startsWithToken("false") && !/[A-Za-z0-9_]/.test(text[i + 5] || "")) {
        result += "     ";
        i += 5;
        continue;
      } else if (
        startsWithToken("true") &&
        !/[A-Za-z0-9_]/.test(text[i + 4] || "")
      ) {
        result += "    ";
        i += 4;
        continue;
      } else if (
        startsWithToken("null") &&
        !/[A-Za-z0-9_]/.test(text[i + 4] || "")
      ) {
        result += "    ";
        i += 4;
        continue;
      } else if (startsWithToken("!==")) {
        result += "   ";
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
        const questionPos = i;
        let localInString = false;
        let localQuote = "";
        let foundColon = -1;
        let j = i + 1;
        while (j < text.length) {
          const c2 = text[j];
          if (!localInString) {
            if (c2 === "'" || c2 === '"') {
              localInString = true;
              localQuote = c2;
            } else if (c2 === ":") {
              foundColon = j;
              break;
            }
          } else if (c2 === localQuote) {
            localInString = false;
          }
          j++;
        }
        if (foundColon !== -1) {
          const length = foundColon - questionPos + 1;
          result += " ".repeat(length);
          i = foundColon + 1;
          continue;
        } else {
          result += " ";
          i++;
          continue;
        }
      }
      if (ch === "'" || ch === '"') {
        inString = true;
        quoteChar = ch;
      }
      result += ch;
    } else {
      result += ch;
      if (ch === quoteChar) {
        inString = false;
      }
    }
    i++;
  }
  return result;
};

const removeNormalPhpStrings = (text: string): string =>
  text.replace(/\\(['"])/g, "$1");

const sanitizeForDiagnostics = (text: string): string => {
  text = text.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (block) =>
    " ".repeat(block.length)
  );
  text = removePhpComments(text);
  text = blankOutHeredocOpeners(text);
  text = removePhpRegexLiterals(text);
  text = removePhpInterpolations(text);
  text = removeNormalPhpStrings(text);
  text = removeOperatorsAndBooleansOutsideQuotes(text);
  return text;
};

/* ────────────────────────────────────────────────────────────── *
 *                    XML & TAG PAIR DIAGNOSTICS                    *
 * ────────────────────────────────────────────────────────────── */

const analyzeAttributes = (
  code: string,
  offset: number,
  document: vscode.TextDocument
): vscode.Diagnostic[] => {
  const diagnostics: vscode.Diagnostic[] = [];
  const tagRegex = /<(\w+)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(code)) !== null) {
    const fullTag = match[0];
    const tagName = match[1];
    const attrText = match[2] || "";
    const attrTextIndexInSnippet = fullTag.indexOf(attrText);
    const combinedRegex =
      /([A-Za-z_:][A-Za-z0-9_.:\-]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?|\{\$[^}]+\}|\$+\w+/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = combinedRegex.exec(attrText)) !== null) {
      const attrName = attrMatch[1];
      const attrAssignment = attrMatch[2];
      if (attrName && !attrAssignment) {
        const startIndexInSnippet =
          attrTextIndexInSnippet + (attrMatch.index ?? 0);
        const startIndex = offset + match.index + startIndexInSnippet;
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
};

const getXmlAttributeDiagnostics = (
  document: vscode.TextDocument
): vscode.Diagnostic[] => {
  const originalText = document.getText();
  let diagnostics: vscode.Diagnostic[] = [];
  const sanitizedMain = sanitizeForDiagnostics(originalText);
  diagnostics.push(...analyzeAttributes(sanitizedMain, 0, document));
  const heredocBlocks = extractAllHeredocBlocks(originalText);
  heredocBlocks.forEach((block) => {
    let blockContent = removePhpComments(block.content);
    blockContent = blankOutHeredocOpeners(blockContent);
    blockContent = removePhpRegexLiterals(blockContent);
    diagnostics.push(
      ...analyzeAttributes(blockContent, block.startIndex, document)
    );
  });
  return diagnostics;
};

const getTagPairDiagnostics = (
  document: vscode.TextDocument
): vscode.Diagnostic[] => {
  const diagnostics: vscode.Diagnostic[] = [];
  const sanitizedText = sanitizeForDiagnostics(document.getText());
  const voidElements = new Set(["input", "br", "hr", "img", "meta", "link"]);
  const tagRegex =
    /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s+(?:[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?))*\s*(\/?)>/g;
  const stack: { tag: string; pos: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(sanitizedText)) !== null) {
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
  stack.forEach((unclosed) => {
    const pos = document.positionAt(unclosed.pos);
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(pos, pos.translate(0, unclosed.tag.length)),
        `Missing closing tag for <${unclosed.tag}>.`,
        vscode.DiagnosticSeverity.Warning
      )
    );
  });
  return diagnostics;
};

/* ────────────────────────────────────────────────────────────── *
 *                    PHP IMPORT STATEMENT PARSING                   *
 * ────────────────────────────────────────────────────────────── */

const parsePhpUseStatements = (text: string): Map<string, string> => {
  const shortNameMap = new Map<string, string>();
  const useRegex = /use\s+([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = useRegex.exec(text)) !== null) {
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
      insideBraces.split(",").forEach((rawItem) => {
        const item = rawItem.trim();
        if (item) {
          processSingleImport(prefix, item, shortNameMap);
        }
      });
    } else {
      processSingleImport("", importBody, shortNameMap);
    }
  }
  return shortNameMap;
};

const processSingleImport = (
  prefix: string,
  item: string,
  shortNameMap: Map<string, string>
): void => {
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
};

const joinPath = (prefix: string, item: string): string =>
  prefix.endsWith("\\") ? prefix + item : prefix + "\\" + item;

const getLastPart = (path: string): string => {
  const parts = path.split("\\");
  return parts[parts.length - 1];
};

/* ────────────────────────────────────────────────────────────── *
 *                          EXTENSION DEACTIVATION                  *
 * ────────────────────────────────────────────────────────────── */

export function deactivate(): void {}
