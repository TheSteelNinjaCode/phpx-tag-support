import * as vscode from "vscode";

/**
 * Activates the PHPX extension.
 * Registers hover and definition providers as well as document change listeners.
 */
export function activate(context: vscode.ExtensionContext) {
  console.log("PHPX tag support is now active!");

  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("phpx-tags");
  context.subscriptions.push(diagnosticCollection);

  // --- Register hover provider for PHP tags ---
  const hoverProvider = vscode.languages.registerHoverProvider("php", {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(
        position,
        /<\/?[A-Z][A-Za-z0-9]*/
      );
      if (!range) {
        return;
      }

      const word = document.getText(range); // e.g. "<Dot" or "Dot"
      const tagName = word.replace(/[</]/g, ""); // Remove '<' or '</'

      const text = document.getText();
      const useRegex = new RegExp(`use\\s+([\\w\\\\]*${tagName});`);
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
      provideDefinition(document, position) {
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
        const useRegex = new RegExp(`use\\s+([\\w\\\\]*${tagName});`);
        const match = useRegex.exec(text);

        if (!match) {
          return;
        }

        const fullClass = match[1];
        const filePath = fullClass.replace(/\\\\/g, "/") + ".php";

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
          document.uri
        );
        if (workspaceFolder) {
          const fullPath = vscode.Uri.file(
            `${workspaceFolder.uri.fsPath}/${filePath}`
          );
          return new vscode.Location(fullPath, new vscode.Position(0, 0));
        }
        return;
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
