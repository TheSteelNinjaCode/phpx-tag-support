import * as vscode from "vscode";

/**
 * Activates the PHPX extension.
 * Registers hover and definition providers as well as text document change listeners.
 */
export function activate(context: vscode.ExtensionContext) {
  console.log("PHPX tag support is now active!");

  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("phpx-tags");
  context.subscriptions.push(diagnosticCollection);

  // Register hover provider for PHP tags
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

  // Register definition provider for PHP tags
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

  // Listen for document changes and active editor changes
  vscode.workspace.onDidChangeTextDocument((e) => {
    highlightUseStatement(e.document);
    validateMissingImports(e.document, diagnosticCollection);
  });

  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      highlightUseStatement(editor.document);
      validateMissingImports(editor.document, diagnosticCollection);
    }
  });

  // Register command defined in package.json
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

function highlightUseStatement(document: vscode.TextDocument) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) {
    return;
  }

  const text = document.getText();

  // Find all JSX-like tag usages (e.g. <Dot>)
  const tagMatches = [...text.matchAll(/<([A-Z][A-Za-z0-9]*)\s?/g)];
  const tagNames = tagMatches.map((m) => m[1]);

  // Regex to match composer use statements, e.g. "use Lib\PHPX\PPIcons\Dot;"
  const useRegex = /use\s+([^\s;]+);/g;

  // We’ll collect ranges for each color category:
  const useKeywordRanges: vscode.DecorationOptions[] = [];
  const firstNamespaceRanges: vscode.DecorationOptions[] = [];
  const lastTokenUsedRanges: vscode.DecorationOptions[] = [];
  const lastTokenUnusedRanges: vscode.DecorationOptions[] = [];

  let match: RegExpExecArray | null;
  while ((match = useRegex.exec(text))) {
    // e.g. fullMatch = "use Lib\PHPX\PPIcons\Dot;"
    //      namespaceStr = "Lib\PHPX\PPIcons\Dot"
    const fullMatch = match[0];
    const namespaceStr = match[1];
    const tokens = namespaceStr.split("\\");
    const firstToken = tokens[0]; // e.g. "Lib"
    const lastToken = tokens[tokens.length - 1]; // e.g. "Dot"

    // ----- 1) "use" keyword range -----
    //   Always 3 characters from matchStart
    const matchStart = match.index!;
    const useKeywordStart = matchStart;
    const useKeywordRange = new vscode.Range(
      document.positionAt(useKeywordStart),
      document.positionAt(useKeywordStart + 3)
    );
    useKeywordRanges.push({ range: useKeywordRange });

    // ----- 2) First namespace token range -----
    //   Find where the namespace actually starts in the matched string
    const namespaceOffset = fullMatch.indexOf(namespaceStr);
    const firstTokenStart = matchStart + namespaceOffset; // e.g. after "use "
    const firstTokenRange = new vscode.Range(
      document.positionAt(firstTokenStart),
      document.positionAt(firstTokenStart + firstToken.length)
    );
    firstNamespaceRanges.push({ range: firstTokenRange });

    // ----- 3) Last token (short class name) range -----
    const lastTokenIndexInNamespace = namespaceStr.lastIndexOf(lastToken);
    const lastTokenStart =
      matchStart + namespaceOffset + lastTokenIndexInNamespace;
    const lastTokenRange = new vscode.Range(
      document.positionAt(lastTokenStart),
      document.positionAt(lastTokenStart + lastToken.length)
    );

    // If you want to color the last token differently based on whether it’s actually used,
    // check if the lastToken is in your list of <Tags>:
    if (tagNames.includes(lastToken)) {
      // The tag is actually used in the document
      lastTokenUsedRanges.push({ range: lastTokenRange });
    } else {
      // The tag is *not* used
      lastTokenUnusedRanges.push({ range: lastTokenRange });
    }
  }

  // --- Create decoration types with the specified colors ---
  const useDecorationType = vscode.window.createTextEditorDecorationType({
    color: "#569CD6", // "use" keyword
  });
  const libDecorationType = vscode.window.createTextEditorDecorationType({
    color: "#D4D4D4", // first namespace token, e.g. "Lib"
  });

  // If you want the same color for the last token whether used or not,
  // you can omit the separate “unused” color. Otherwise, pick a different color:
  const lastTokenUsedType = vscode.window.createTextEditorDecorationType({
    color: "#4EC9B0", // short class name (used)
  });
  const lastTokenUnusedType = vscode.window.createTextEditorDecorationType({
    color: "#C586C0", // short class name (unused) - or any color you like
  });

  // --- Apply the decorations ---
  editor.setDecorations(useDecorationType, useKeywordRanges);
  editor.setDecorations(libDecorationType, firstNamespaceRanges);
  editor.setDecorations(lastTokenUsedType, lastTokenUsedRanges);
  editor.setDecorations(lastTokenUnusedType, lastTokenUnusedRanges);
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
export function deactivate() {}
