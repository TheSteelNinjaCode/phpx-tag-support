// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  console.log("PHPX tag support is now active!");

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
      console.log("🚀 ~ provideHover ~ word:", word);
      const tagName = word.replace(/[</]/g, ""); // Remove < or </
      console.log("🚀 ~ provideHover ~ tagName:", tagName);

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
        console.log("🚀 ~ provideDefinition ~ fullClass:", fullClass);

        const filePath = fullClass.replace(/\\\\/g, "/") + ".php";
        console.log("🚀 ~ provideDefinition ~ filePath:", filePath);

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
          document.uri
        );
		console.log("🚀 ~ provideDefinition ~ workspaceFolder:", workspaceFolder);
        const baseDirs = [workspaceFolder?.uri.fsPath];
        console.log("🚀 ~ provideDefinition ~ baseDirs:", baseDirs);

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

  context.subscriptions.push(hoverProvider);
  context.subscriptions.push(definitionProvider);

  // Highlight matching use imports when a JSX-like tag is found
  function highlightUseStatement(document: vscode.TextDocument) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document) {
      return;
    }

    const text = document.getText();
    const tagMatches = [...text.matchAll(/<([A-Z][A-Za-z0-9]*)\s?/g)];
    console.log("🚀 ~ highlightUseStatement ~ tagMatches:", tagMatches);
    const useMatches = [...text.matchAll(/use\s+([^\s;]+);/g)];
    console.log("🚀 ~ highlightUseStatement ~ useMatches:", useMatches);

    const tagNames = tagMatches.map((m) => m[1]);
    const decorations: vscode.DecorationOptions[] = [];

    for (const match of useMatches) {
      const fullMatch = match[0];
      const className = match[1];
      const classParts = className.split("\\");
      const shortName = classParts[classParts.length - 1];

      if (tagNames.includes(shortName)) {
        const startPos = document.positionAt(
          match.index! + fullMatch.indexOf(shortName)
        );
        const endPos = startPos.translate(0, shortName.length);
        decorations.push({ range: new vscode.Range(startPos, endPos) });
      }
    }

    const highlight = vscode.window.createTextEditorDecorationType({
      textDecoration: "underline",
    });

    editor.setDecorations(highlight, decorations);
  }

  vscode.workspace.onDidChangeTextDocument((e) => {
    highlightUseStatement(e.document);
  });

  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      highlightUseStatement(editor.document);
    }
  });

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const disposable = vscode.commands.registerCommand(
    "phpx-tag-support.hoverProvider",
    () => {
      // The code you place here will be executed every time your command is executed
      // Display a message box to the user
      vscode.window.showInformationMessage(
        "Hello World from phpx-tag-support!"
      );
    }
  );

  context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
