import * as vscode from "vscode";

const useKeywordStyle = vscode.window.createTextEditorDecorationType({
  color: "#569CD6", // blue
});

const asKeywordStyle = vscode.window.createTextEditorDecorationType({
  color: "#569CD6", // blue
});

const firstNamespaceStyle = vscode.window.createTextEditorDecorationType({
  color: "#D4D4D4", // light gray
});

const shortClassUsedStyle = vscode.window.createTextEditorDecorationType({
  color: "#4EC9B0", // vivid teal
});

const shortClassUnusedStyle = vscode.window.createTextEditorDecorationType({
  color: "#C586C0", // dull purple
});

/**
 * Activates the PHPX extension.
 * Registers hover and definition providers as well as text document change listeners.
 */
export function activate(context: vscode.ExtensionContext) {
  console.log("PHPX tag support is now active!");

  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("phpx-tags");
  context.subscriptions.push(diagnosticCollection);

  // --- Register hover provider for PHP tags ---
  const hoverProvider = vscode.languages.registerHoverProvider("php", {
    provideHover(document, position, token) {
      const range = document.getWordRangeAtPosition(
        position,
        /<\/?[A-Z][A-Za-z0-9]*/
      );
      if (!range) {
        return;
      }

      const word = document.getText(range); // e.g. <Dot or Dot
      const tagName = word.replace(/[</]/g, ""); // Remove < or </

      const text = document.getText();
      const useRegex = new RegExp(`use\\s+([\\w\\\\]*${tagName});`, "g");
      const match = useRegex.exec(text);

      if (match) {
        const fullClass = match[1];
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
      provideDefinition(document, position, token) {
        const range = document.getWordRangeAtPosition(
          position,
          /<\/?[A-Z][A-Za-z0-9]*/
        );
        if (!range) {
          return;
        }

        const word = document.getText(range);
        const tagName = word.replace(/[</]/g, "");
        const text = document.getText();
        const useRegex = new RegExp(`use\\s+([\\w\\\\]*${tagName});`, "g");
        const match = useRegex.exec(text);

        if (!match) {
          return;
        }

        const fullClass = match[1];
        const filePath = fullClass.replace(/\\\\/g, "/") + ".php";

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
          document.uri
        );
        const baseDirs = [workspaceFolder?.uri.fsPath];

        for (const baseDir of baseDirs) {
          if (!baseDir) {
            continue;
          }
          const fullPath = vscode.Uri.file(`${baseDir}/${filePath}`);
          return new vscode.Location(fullPath, new vscode.Position(0, 0));
        }

        return;
      },
    }
  );
  context.subscriptions.push(definitionProvider);

  // --- Listen for document changes and active editor changes ---
  vscode.workspace.onDidChangeTextDocument((e) => {
    highlightUseStatement(e.document);
    validateMissingImports(e.document, diagnosticCollection);
  });

  vscode.workspace.onDidSaveTextDocument((doc) => {
    highlightUseStatement(doc);
  });

  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      highlightUseStatement(editor.document);
      validateMissingImports(editor.document, diagnosticCollection);
    }
  });

  // --- Register command defined in package.json ---
  const disposable = vscode.commands.registerCommand(
    "phpx-tag-support.hoverProvider",
    () => {
      vscode.window.showInformationMessage(
        "Hello World from phpx-tag-support!"
      );
    }
  );
  context.subscriptions.push(disposable);
}

/**
 * Highlights all import statements, including:
 *  - Simple:        use Dot;
 *  - Fully-qualified:  use Lib\PHPX\PPIcons\Dot;
 *  - Aliased:       use Lib\PHPX\PPIcons\Dot as Dot;
 *  - Group import:  use Lib\PHPX\PPIcons\{Dot, Dot2};
 *
 * Colors:
 *  - "use" / "as" keyword -> #569CD6
 *  - First namespace token -> #D4D4D4
 *  - Short class/alias -> #4EC9B0 if used, #C586C0 if unused
 */
function highlightUseStatement(document: vscode.TextDocument) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) {
    return;
  }

  const text = document.getText();

  // Find all JSX-like tag usages (e.g. <Dot>)
  const tagMatches = [...text.matchAll(/<([A-Z][A-Za-z0-9]*)\s?/g)];
  console.log("🚀 ~ highlightUseStatement ~ tagMatches:", tagMatches);
  const tagNames = tagMatches.map((m) => m[1]);
  console.log("🚀 ~ highlightUseStatement ~ tagNames:", tagNames);

  // Regex to match composer use statements, e.g. "use Lib\PHPX\PPIcons\Dot;"
  // including group imports "use Lib\PHPX\PPIcons\{Dot, Dot2};"
  const useRegex = /use\s+([^;]+);/g;

  // We'll collect ranges for each color category:
  const useKeywordRanges: vscode.DecorationOptions[] = [];
  const asKeywordRanges: vscode.DecorationOptions[] = [];
  const firstNamespaceRanges: vscode.DecorationOptions[] = [];
  // We'll keep separate arrays for short class names that are used vs unused
  const shortClassUsedRanges: vscode.DecorationOptions[] = [];
  const shortClassUnusedRanges: vscode.DecorationOptions[] = [];

  let match: RegExpExecArray | null;
  while ((match = useRegex.exec(text))) {
    // match[0] -> entire "use ...;" line
    // match[1] -> everything after "use " and before ";"
    const fullMatch = match[0];
    const importBody = match[1].trim();
    const matchStart = match.index!;

    // --- 1) Highlight the "use" keyword ---
    const useRange = new vscode.Range(
      document.positionAt(matchStart),
      document.positionAt(matchStart + 3) // 'use'.length
    );
    useKeywordRanges.push({ range: useRange });

    // --- Parse the rest of the import statement for first namespace, as keywords, and short classes ---
    const parsedHighlights = parseUseImport(
      fullMatch,
      importBody,
      matchStart,
      document
    );
    console.log(
      "🚀 ~ highlightUseStatement ~ parsedHighlights:",
      parsedHighlights
    );

    // For each highlight piece, determine if it's "as", "firstNamespace", or "shortClass".
    for (const item of parsedHighlights) {
      switch (item.colorType) {
        case "asKeyword":
          asKeywordRanges.push({ range: item.range });
          break;
        case "firstNamespace":
          firstNamespaceRanges.push({ range: item.range });
          break;
        case "shortClass":
          // We check if the shortName is used in the document (<Tag>)
          // item.shortName holds the actual class or alias text
          if (item.shortName && tagNames.includes(item.shortName)) {
            shortClassUsedRanges.push({ range: item.range });
          } else {
            shortClassUnusedRanges.push({ range: item.range });
          }
          break;
      }
    }
  }

  // --- Create decoration types with the specified colors ---
  const useKeywordStyle = vscode.window.createTextEditorDecorationType({
    color: "#569CD6", // blue
  });

  const asKeywordStyle = vscode.window.createTextEditorDecorationType({
    color: "#569CD6", // blue
  });

  const firstNamespaceStyle = vscode.window.createTextEditorDecorationType({
    color: "#D4D4D4", // light gray
  });

  const shortClassUsedStyle = vscode.window.createTextEditorDecorationType({
    color: "#4EC9B0", // vivid teal
  });

  const shortClassUnusedStyle = vscode.window.createTextEditorDecorationType({
    color: "#C586C0", // dull purple
  });

  // --- Apply the decorations ---
  editor.setDecorations(useKeywordStyle, useKeywordRanges);
  editor.setDecorations(asKeywordStyle, asKeywordRanges);
  editor.setDecorations(firstNamespaceStyle, firstNamespaceRanges);
  editor.setDecorations(shortClassUsedStyle, shortClassUsedRanges);
  editor.setDecorations(shortClassUnusedStyle, shortClassUnusedRanges);
}

/**
 * Parse a single "use ...;" import statement and return an array of highlight objects.
 * This handles:
 *  1) Simple:                 use Dot;
 *  2) Fully-qualified:        use Lib\PHPX\PPIcons\Dot;
 *  3) Aliased:                use Lib\PHPX\PPIcons\Dot as Dot;
 *  4) Group import:           use Lib\PHPX\PPIcons\{Dot, Dot2};
 */
function parseUseImport(
  fullMatch: string,
  importBody: string,
  matchStart: number,
  document: vscode.TextDocument
): Array<{
  range: vscode.Range;
  colorType: "asKeyword" | "firstNamespace" | "shortClass";
  shortName?: string; // store short class/alias name for usage checks
}> {
  const results: Array<{
    range: vscode.Range;
    colorType: "asKeyword" | "firstNamespace" | "shortClass";
    shortName?: string;
  }> = [];

  // Find where the importBody actually starts inside the full match
  const bodyIndexInFull = fullMatch.indexOf(importBody);
  if (bodyIndexInFull < 0) {
    return results;
  }

  // Absolute position in the document where 'importBody' starts
  const contentStartAbsolute = matchStart + bodyIndexInFull;

  // Check if it's a group import, e.g. "Lib\PHPX\PPIcons\{Dot, Dot2}"
  if (importBody.includes("{")) {
    // e.g. prefix = "Lib\PHPX\PPIcons\"
    // items inside braces => "Dot, Dot2"
    const braceOpenIndex = importBody.indexOf("{");
    const braceCloseIndex = importBody.lastIndexOf("}");
    if (braceOpenIndex < 0 || braceCloseIndex < 0) {
      return results; // invalid syntax
    }

    // The prefix before the curly brace (e.g. "Lib\PHPX\PPIcons\")
    const prefix = importBody.substring(0, braceOpenIndex).trim();
    highlightFirstNamespaceToken(
      prefix,
      contentStartAbsolute,
      document,
      results
    );

    // The comma-separated items inside { ... }
    const itemsStr = importBody
      .substring(braceOpenIndex + 1, braceCloseIndex)
      .trim();
    const items = itemsStr.split(",");

    // Track how far we’ve searched for each item to ensure we find them in the correct place
    let offsetSoFar = braceOpenIndex + 1;

    for (const rawItem of items) {
      const item = rawItem.trim();
      if (!item) {
        continue;
      }

      // e.g. "Dot", or "Dot as Something"
      const itemIndexInContent = importBody.indexOf(item, offsetSoFar);
      if (itemIndexInContent < 0) {
        continue;
      }
      offsetSoFar = itemIndexInContent + item.length; // move offset forward

      // If there's an " as " we highlight alias
      const asIndex = item.toLowerCase().indexOf(" as ");
      if (asIndex >= 0) {
        // e.g. "Dot as Dot2"
        const originalName = item.substring(0, asIndex).trim();
        const aliasName = item.substring(asIndex + 4).trim(); // skip " as "

        // short class highlight (originalName)
        addShortClassHighlight(
          originalName,
          contentStartAbsolute + itemIndexInContent,
          document,
          results
        );

        // highlight the "as" keyword
        const asAbsolute = contentStartAbsolute + itemIndexInContent + asIndex;
        const asRange = new vscode.Range(
          document.positionAt(asAbsolute),
          document.positionAt(asAbsolute + 2) // highlight just "as" (2 chars)
        );
        results.push({ range: asRange, colorType: "asKeyword" });

        // highlight the alias name
        const aliasAbsolute = asAbsolute + 3; // skip "as "
        const aliasRange = new vscode.Range(
          document.positionAt(aliasAbsolute),
          document.positionAt(aliasAbsolute + aliasName.length)
        );
        results.push({
          range: aliasRange,
          colorType: "shortClass",
          shortName: aliasName,
        });
      } else {
        // e.g. "Dot"
        addShortClassHighlight(
          item,
          contentStartAbsolute + itemIndexInContent,
          document,
          results
        );
      }
    }
  } else {
    // Single import or single alias import
    // e.g. "Dot", "Lib\PHPX\PPIcons\Dot", "Lib\PHPX\PPIcons\Dot as Dot"
    const asIndex = importBody.toLowerCase().indexOf(" as ");
    let mainPart = importBody;
    let aliasPart = "";

    if (asIndex >= 0) {
      mainPart = importBody.substring(0, asIndex).trim();
      aliasPart = importBody.substring(asIndex + 4).trim(); // skip " as "

      // highlight the "as" keyword
      const asAbsolute = contentStartAbsolute + asIndex;
      const asRange = new vscode.Range(
        document.positionAt(asAbsolute),
        document.positionAt(asAbsolute + 2) // highlight "as"
      );
      results.push({ range: asRange, colorType: "asKeyword" });
    }

    // Highlight the first namespace token (e.g. "Lib")
    highlightFirstNamespaceToken(
      mainPart,
      contentStartAbsolute,
      document,
      results
    );

    // Highlight the last token in mainPart as the short class name
    const tokens = mainPart.split("\\");
    const lastToken = tokens[tokens.length - 1];
    const lastTokenIndexInMainPart = mainPart.lastIndexOf(lastToken);
    if (lastTokenIndexInMainPart >= 0) {
      const absolute = contentStartAbsolute + lastTokenIndexInMainPart;
      const range = new vscode.Range(
        document.positionAt(absolute),
        document.positionAt(absolute + lastToken.length)
      );
      results.push({
        range,
        colorType: "shortClass",
        shortName: lastToken,
      });
    }

    // If there's an alias part, highlight it as a short class name
    if (aliasPart) {
      const aliasAbsolute = contentStartAbsolute + asIndex + 4;
      const aliasRange = new vscode.Range(
        document.positionAt(aliasAbsolute),
        document.positionAt(aliasAbsolute + aliasPart.length)
      );
      results.push({
        range: aliasRange,
        colorType: "shortClass",
        shortName: aliasPart,
      });
    }
  }

  return results;
}

/**
 * Highlights only the *first* token in a backslash-separated prefix.
 * E.g. prefix = "Lib\PHPX\PPIcons", it highlights "Lib".
 */
function highlightFirstNamespaceToken(
  prefix: string,
  contentStartAbsolute: number,
  document: vscode.TextDocument,
  results: Array<{
    range: vscode.Range;
    colorType: "asKeyword" | "firstNamespace" | "shortClass";
    shortName?: string;
  }>
) {
  // If there's no prefix or no backslash, it means there's no "namespace" portion to highlight.
  if (!prefix || !prefix.includes("\\")) {
    return;
  }

  const tokens = prefix.split("\\");
  if (!tokens.length) {
    return;
  }

  // Highlight only the first token (e.g. "Lib" in "Lib\PHPX\PPIcons")
  const firstToken = tokens[0];
  const firstTokenOffset = prefix.indexOf(firstToken);
  if (firstTokenOffset >= 0) {
    const absolute = contentStartAbsolute + firstTokenOffset;
    const range = new vscode.Range(
      document.positionAt(absolute),
      document.positionAt(absolute + firstToken.length)
    );
    results.push({ range, colorType: "firstNamespace" });
  }
}

/**
 * Helper to highlight a single short class name or item in group import.
 */
function addShortClassHighlight(
  shortName: string,
  absoluteOffset: number,
  document: vscode.TextDocument,
  results: Array<{
    range: vscode.Range;
    colorType: "asKeyword" | "firstNamespace" | "shortClass";
    shortName?: string;
  }>
) {
  const range = new vscode.Range(
    document.positionAt(absoluteOffset),
    document.positionAt(absoluteOffset + shortName.length)
  );
  results.push({ range, colorType: "shortClass", shortName });
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

  const text = document.getText();
  const tagMatches = [...text.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)];
  const useMatches = [...text.matchAll(/use\s+([^\s;]+);/g)];

  // Build a set of imported class short names
  const importedClasses = new Set(
    useMatches.map((match) => match[1].split("\\").pop())
  );

  const diagnostics: vscode.Diagnostic[] = [];
  for (const tagMatch of tagMatches) {
    const tag = tagMatch[1];
    if (!importedClasses.has(tag)) {
      const start = document.positionAt(tagMatch.index! + 1); // +1 to skip '<'
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

// This method is called when your extension is deactivated
export function deactivate() {
  useKeywordStyle.dispose();
  asKeywordStyle.dispose();
  firstNamespaceStyle.dispose();
  shortClassUsedStyle.dispose();
  shortClassUnusedStyle.dispose();
}
