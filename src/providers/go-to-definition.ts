import * as vscode from "vscode";
import { parseHTMLDocument, parseScriptForState } from "../utils/html-parser";
import { GlobalFunctionsLoader } from "../services/global-functions-loader";
import * as path from "path";
import * as fs from "fs";

export class PulseDefinitionProvider implements vscode.DefinitionProvider {
  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | undefined> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);

    // =========================================================
    // SCENARIO C: State Variables (Legacy Support)
    // =========================================================
    const htmlDoc = parseHTMLDocument(document.getText());
    const stateVars = parseScriptForState(document.getText());
    const targetVar = stateVars.find((v) => v.name === word);

    if (targetVar && htmlDoc.scripts.length > 0) {
      const scriptStart = htmlDoc.scripts[0].start;
      const fullText = document.getText();
      const scriptTagText = fullText.slice(scriptStart, htmlDoc.scripts[0].end);
      const contentMatch = scriptTagText.match(/^<script[^>]*>/i);
      const openTagLength = contentMatch ? contentMatch[0].length : 8;

      const scriptContentStart = scriptStart + openTagLength;
      const absoluteStart = scriptContentStart + targetVar.start;
      const absoluteEnd = scriptContentStart + targetVar.end;

      if (!isNaN(absoluteStart) && !isNaN(absoluteEnd)) {
        const startPos = document.positionAt(absoluteStart);
        const endPos = document.positionAt(absoluteEnd);
        return new vscode.Location(
          document.uri,
          new vscode.Range(startPos, endPos)
        );
      }
    }

    return undefined;
  }
}

// =========================================================
// 7. GLOBAL FUNCTION DEFINITION PROVIDER
// =========================================================

export class GlobalFunctionDefinitionProvider
  implements vscode.DefinitionProvider
{
  constructor(private workspaceRoot: vscode.Uri) {}

  public provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Definition> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);

    // 1. Get function metadata from Loader
    const fn = GlobalFunctionsLoader.getInstance().getFunction(word);
    if (!fn || !fn.rawImportPath) return undefined;

    // 2. Resolve Path
    // Paths in .d.ts (via @source) are relative to the 'main.ts' location in the project structure
    // or are bare module specifiers (e.g. "echarts")

    // We assume the generator used import paths found in `ts/main.ts`.
    // So relative paths start from `ts/`.

    let targetPath: string;

    if (fn.rawImportPath.startsWith(".")) {
      // It's a relative path found in ts/main.ts, so resolve from {projectRoot}/ts
      targetPath = path.resolve(
        this.workspaceRoot.fsPath,
        "ts",
        fn.rawImportPath
      );
    } else {
      // It's a node module
      targetPath = path.join(
        this.workspaceRoot.fsPath,
        "node_modules",
        fn.rawImportPath
      );
    }

    // 3. Find the actual file
    // Check direct file (rare), then extensions, then package.json (for node modules)

    // Case A: Node Module
    if (!fn.rawImportPath.startsWith(".")) {
      const pkgJson = path.join(targetPath, "package.json");
      if (fs.existsSync(pkgJson)) {
        return new vscode.Location(
          vscode.Uri.file(pkgJson),
          new vscode.Position(0, 0)
        );
      }
    }

    // Case B: Local File
    const extensions = ["", ".ts", ".js"];
    for (const ext of extensions) {
      const candidate = targetPath + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return new vscode.Location(
          vscode.Uri.file(candidate),
          new vscode.Position(0, 0)
        );
      }
    }

    return undefined;
  }
}

// =========================================================
// 8. COMPONENT DEFINITION PROVIDER (New)
// =========================================================

export class ComponentDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private resolvePath: (componentName: string) => string | undefined
  ) {}

  public provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Definition> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return undefined;

    // Get the word (e.g., "Card")
    const word = document.getText(wordRange);

    // Resolve path using the callback provided during registration
    const parsedPath = this.resolvePath(word);

    if (parsedPath && fs.existsSync(parsedPath)) {
      return new vscode.Location(
        vscode.Uri.file(parsedPath),
        new vscode.Position(0, 0)
      );
    }

    return undefined;
  }
}
