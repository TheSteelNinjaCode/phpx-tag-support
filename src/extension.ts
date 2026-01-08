import path from "path";
import * as vscode from "vscode";
import fs from "fs";
import { PulsePointAttributeCompletionProvider } from "./providers/pulsepoint-attributes-completion";
import { PulsePointCompletionProvider } from "./providers/pulsepoint-methods-completion";
import { PulsePointHoverProvider } from "./providers/pulsepoint-methods-hover";
import { registerMustacheValidator } from "./validators/mustache-validator";
import {
  FetchFunctionCompletionProvider,
  FetchFunctionDefinitionProvider,
  FetchFunctionDiagnosticProvider,
  FetchFunctionHoverProvider,
} from "./providers/fetch-function";
import {
  RouteProvider,
  HrefCompletionProvider,
  HrefDefinitionProvider,
  HrefDiagnosticProvider,
  HrefHoverProvider,
  PhpRedirectCompletionProvider,
  PhpRedirectDefinitionProvider,
  PhpRedirectDiagnosticProvider,
  PhpRedirectHoverProvider,
  PphpScriptRedirectCompletionProvider,
  PphpScriptRedirectDefinitionProvider,
  PphpScriptRedirectDiagnosticProvider,
  PphpScriptRedirectHoverProvider,
  SrcCompletionProvider,
  SrcDefinitionProvider,
  SrcDiagnosticProvider,
  SrcHoverProvider,
} from "./providers/routes-completion";

// Modified: Only targeting PHP language ID
const SELECTORS = {
  PHP: { language: "php" } as vscode.DocumentSelector,
  PLAINTEXT: { language: "plaintext" } as vscode.DocumentSelector,
};

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return;
  }

  const rootPath = workspaceFolders[0].uri.fsPath;
  const configPath = path.join(rootPath, "prisma-php.json");

  if (!fs.existsSync(configPath)) {
    console.log(
      "Prisma PHP: prisma-php.json not found. Extension features standing by."
    );
  } else {
    console.log('Prisma PHP: Found "prisma-php.json". Extension active.');
  }

  // Initialize Route Provider
  const routeProvider = new RouteProvider(workspaceFolders[0]);

  // Watch for changes in files-list.json
  const fileListWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolders[0], "settings/files-list.json")
  );
  fileListWatcher.onDidChange(() => routeProvider.refresh());
  fileListWatcher.onDidCreate(() => routeProvider.refresh());
  fileListWatcher.onDidDelete(() => routeProvider.refresh());
  context.subscriptions.push(fileListWatcher);

  // Setup Features
  setupPPHPFeatures(context);
  setupRouteFeatures(context, routeProvider, workspaceFolders[0]);

  // Note: Ensure your mustache validator also checks for 'php' languageId internally if needed
  registerMustacheValidator(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("pphp.init", async () => {
      if (fs.existsSync(configPath)) {
        vscode.window.showInformationMessage(
          "prisma-php.json already exists in the workspace."
        );
        return;
      }
    })
  );
}

function setupPPHPFeatures(context: vscode.ExtensionContext) {
  // --- Existing PulsePoint Features (PHP Only) ---
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      new PulsePointCompletionProvider(),
      "."
    ),
    vscode.languages.registerHoverProvider(
      SELECTORS.PHP,
      new PulsePointHoverProvider()
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      new PulsePointAttributeCompletionProvider(),
      " ",
      "-"
    )
  );

  // --- Fetch Function Features (PHP Only) ---
  const fetchFunctionCompletionProvider = new FetchFunctionCompletionProvider();
  const fetchFunctionDefinitionProvider = new FetchFunctionDefinitionProvider();
  const fetchFunctionHoverProvider = new FetchFunctionHoverProvider();
  const fetchFunctionDiagnosticProvider = new FetchFunctionDiagnosticProvider();

  const fetchDiagnostics =
    vscode.languages.createDiagnosticCollection("pp-fetch-function");

  const updateFetchDiagnostics = (document: vscode.TextDocument) => {
    // Check exclusively for PHP
    if (document.languageId === "php") {
      const diagnostics =
        fetchFunctionDiagnosticProvider.validateDocument(document);
      fetchDiagnostics.set(document.uri, diagnostics);
    } else {
      fetchDiagnostics.delete(document.uri);
    }
  };

  context.subscriptions.push(
    fetchDiagnostics,
    vscode.workspace.onDidOpenTextDocument(updateFetchDiagnostics),
    vscode.workspace.onDidSaveTextDocument(updateFetchDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) =>
      updateFetchDiagnostics(e.document)
    ),

    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      fetchFunctionCompletionProvider,
      "'",
      '"'
    ),
    vscode.languages.registerDefinitionProvider(
      SELECTORS.PHP,
      fetchFunctionDefinitionProvider
    ),
    vscode.languages.registerHoverProvider(
      SELECTORS.PHP,
      fetchFunctionHoverProvider
    )
  );
}

function setupRouteFeatures(
  context: vscode.ExtensionContext,
  routeProvider: RouteProvider,
  workspaceFolder: vscode.WorkspaceFolder
) {
  // 1. Initialize Providers
  const hrefCompletion = new HrefCompletionProvider(routeProvider);
  const hrefHover = new HrefHoverProvider(routeProvider);
  const hrefDefinition = new HrefDefinitionProvider(
    routeProvider,
    workspaceFolder
  );
  const hrefDiagnostic = new HrefDiagnosticProvider(routeProvider);

  const srcCompletion = new SrcCompletionProvider(routeProvider);
  const srcHover = new SrcHoverProvider(routeProvider);
  const srcDefinition = new SrcDefinitionProvider(
    routeProvider,
    workspaceFolder
  );
  const srcDiagnostic = new SrcDiagnosticProvider(routeProvider);

  const phpRedirectCompletion = new PhpRedirectCompletionProvider(
    routeProvider
  );
  const phpRedirectHover = new PhpRedirectHoverProvider(routeProvider);
  const phpRedirectDefinition = new PhpRedirectDefinitionProvider(
    routeProvider,
    workspaceFolder
  );
  const phpRedirectDiagnostic = new PhpRedirectDiagnosticProvider(
    routeProvider
  );

  const scriptRedirectCompletion = new PphpScriptRedirectCompletionProvider(
    routeProvider
  );
  const scriptRedirectHover = new PphpScriptRedirectHoverProvider(
    routeProvider
  );
  const scriptRedirectDefinition = new PphpScriptRedirectDefinitionProvider(
    routeProvider,
    workspaceFolder
  );
  const scriptRedirectDiagnostic = new PphpScriptRedirectDiagnosticProvider(
    routeProvider
  );

  // 2. Register Diagnostics
  const routeDiagnostics =
    vscode.languages.createDiagnosticCollection("pp-routes");

  const updateRouteDiagnostics = (document: vscode.TextDocument) => {
    // Validate ONLY if the file is PHP
    if (document.languageId === "php") {
      const diagnostics: vscode.Diagnostic[] = [];

      // Accumulate diagnostics from all providers
      diagnostics.push(...hrefDiagnostic.validateDocument(document));
      diagnostics.push(...srcDiagnostic.validateDocument(document));
      diagnostics.push(...phpRedirectDiagnostic.validateDocument(document));
      diagnostics.push(...scriptRedirectDiagnostic.validateDocument(document));

      routeDiagnostics.set(document.uri, diagnostics);
    } else {
      routeDiagnostics.delete(document.uri);
    }
  };

  context.subscriptions.push(
    routeDiagnostics,
    vscode.workspace.onDidOpenTextDocument(updateRouteDiagnostics),
    vscode.workspace.onDidSaveTextDocument(updateRouteDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) =>
      updateRouteDiagnostics(e.document)
    )
  );

  // Trigger diagnostics for active editor on start
  if (vscode.window.activeTextEditor) {
    updateRouteDiagnostics(vscode.window.activeTextEditor.document);
  }

  // 3. Register Language Features (PHP Only)
  context.subscriptions.push(
    // Completions
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      hrefCompletion,
      '"',
      "/",
      "."
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      srcCompletion,
      '"',
      "/",
      "."
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      phpRedirectCompletion,
      "'",
      '"',
      "/",
      "."
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      scriptRedirectCompletion,
      "'",
      '"',
      "/",
      "."
    ),

    // Hovers
    vscode.languages.registerHoverProvider(SELECTORS.PHP, hrefHover),
    vscode.languages.registerHoverProvider(SELECTORS.PHP, srcHover),
    vscode.languages.registerHoverProvider(SELECTORS.PHP, phpRedirectHover),
    vscode.languages.registerHoverProvider(SELECTORS.PHP, scriptRedirectHover),

    // Definitions
    vscode.languages.registerDefinitionProvider(SELECTORS.PHP, hrefDefinition),
    vscode.languages.registerDefinitionProvider(SELECTORS.PHP, srcDefinition),
    vscode.languages.registerDefinitionProvider(
      SELECTORS.PHP,
      phpRedirectDefinition
    ),
    vscode.languages.registerDefinitionProvider(
      SELECTORS.PHP,
      scriptRedirectDefinition
    )
  );
}

export function deactivate() {}
