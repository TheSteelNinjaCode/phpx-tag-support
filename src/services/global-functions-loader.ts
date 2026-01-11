import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface GlobalFunctionDefinition {
  name: string;
  signature: string;
  rawImportPath?: string;
}

export class GlobalFunctionsLoader {
  private static instance: GlobalFunctionsLoader;
  private functions: Map<string, GlobalFunctionDefinition> = new Map();
  private watcher: vscode.FileSystemWatcher | undefined;

  private constructor() {}

  public static getInstance(): GlobalFunctionsLoader {
    if (!this.instance) {
      this.instance = new GlobalFunctionsLoader();
    }
    return this.instance;
  }

  public getFunctions(): GlobalFunctionDefinition[] {
    return Array.from(this.functions.values());
  }

  public getFunction(name: string): GlobalFunctionDefinition | undefined {
    return this.functions.get(name);
  }

  public async initialize(
    context: vscode.ExtensionContext,
    rootUri: vscode.Uri
  ) {
    const dtsPath = path.join(rootUri.fsPath, ".pp", "global-functions.d.ts");

    this.loadFile(dtsPath);

    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootUri, ".pp/global-functions.d.ts")
    );

    const reload = () => this.loadFile(dtsPath);

    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(() => this.functions.clear());

    context.subscriptions.push(this.watcher);
  }

  private loadFile(filePath: string) {
    try {
      if (!fs.existsSync(filePath)) {
        this.functions.clear();
        return;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      this.parseDts(content);
      console.log(`[PPHP] Loaded ${this.functions.size} global functions.`);
    } catch (e) {
      console.error("[PPHP] Failed to load global functions", e);
    }
  }

  private parseDts(content: string) {
    this.functions.clear();
    const regex =
      /\/\/\s*@source:\s*([^\n]+)\s+const\s+([a-zA-Z0-9_]+)\s*:\s*([^;]+);/gm;

    let match;
    while ((match = regex.exec(content)) !== null) {
      const rawImportPath = match[1].trim();
      const name = match[2];
      const signature = match[3].trim();

      this.functions.set(name, { name, signature, rawImportPath });
    }
  }
}
