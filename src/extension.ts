import path from "path";
import * as vscode from "vscode";
import fs from "fs";

// --- PulsePoint Providers ---
import { PulsePointAttributeCompletionProvider } from "./providers/pulsepoint-attributes-completion";
import { PulsePointCompletionProvider } from "./providers/pulsepoint-methods-completion";
import { PulsePointHoverProvider } from "./providers/pulsepoint-methods-hover";

// --- Validators ---
import { registerMustacheValidator } from "./validators/mustache-validator";

// --- Global Functions (New) ---
import { GlobalFunctionsLoader } from "./services/global-functions-loader";
import { GlobalFunctionCompletionProvider } from "./providers/global-function-completion";
import { GlobalFunctionHoverProvider } from "./providers/global-function-hover";

// --- Fetch Function Providers ---
import {
  FetchFunctionCompletionProvider,
  FetchFunctionDefinitionProvider,
  FetchFunctionDiagnosticProvider,
  FetchFunctionHoverProvider,
} from "./providers/fetch-function";

// --- Route Providers ---
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

// --- Mustache Providers ---
import { MustacheCompletionProvider } from "./providers/mustache-completion";
import {
  ComponentDefinitionProvider,
  GlobalFunctionDefinitionProvider,
  PulseDefinitionProvider,
} from "./providers/go-to-definition";
import { MustacheHoverProvider } from "./providers/mustache-hover";

// --- Snippet Providers ---
import { PhpxClassSnippetProvider } from "./providers/phpx-class-snippet";

// --- Prisma ORM Imports ---
import {
  registerPrismaFieldProvider,
  validateReadCall,
  validateCreateCall,
  validateUpdateCall,
  validateDeleteCall,
  validateUpsertCall,
  validateGroupByCall,
  validateAggregateCall,
  clearPrismaSchemaCache,
} from "./providers/prisma-orm";

// --- Component Props Imports ---
import {
  ComponentPropsProvider,
  validateComponentPropValues,
  buildDynamicAttrItems,
} from "./providers/component-props";

// --- Component Import Imports ---
import {
  ComponentImportCodeActionProvider,
  importComponentCommand,
  validateMissingImports,
  COMMAND_ADD_IMPORT,
} from "./providers/component-import";
import { registerXmlValidator } from "./validators/xml-validator";
import { ComponentTagCompletionProvider } from "./providers/component-tag-completion";
import { ComponentHoverProvider } from "./providers/component-hover";
import { ComponentAttributeValueProvider } from "./providers/component-attribute-value";

// Modified: Only targeting PHP language ID
const SELECTORS = {
  PHP: { language: "php" } as vscode.DocumentSelector,
  PLAINTEXT: { language: "plaintext" } as vscode.DocumentSelector,
};

// --- Globals for Component Props ---
let componentsCache = new Map<string, string>(); // Tag -> FQCN
let allProjectFiles: string[] = []; // List of all files from files-list.json
const fileAnalysisCache = new Map<string, FileAnalysisCache>();

interface FileAnalysisCache {
  version: number;
  hasMixedContent: boolean;
  hasHeredocs: boolean;
  heredocRanges: Array<{ start: number; end: number }>;
}

const FS_WALK_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".casp",
  "caches",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
]);

function walkPhpFilesForClassSearch(
  startDir: string,
  opts: {
    shortName: string;
    namespacePart: string;
    classDeclRe: RegExp;
    maxFiles: number;
  },
): string | undefined {
  const stack: string[] = [startDir];
  let checked = 0;

  while (stack.length) {
    const dir = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (checked >= opts.maxFiles) return undefined;

      const full = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        if (FS_WALK_EXCLUDED_DIRS.has(ent.name)) continue;
        if (ent.name.startsWith(".")) continue;
        stack.push(full);
        continue;
      }

      if (!ent.isFile() || !ent.name.endsWith(".php")) continue;

      checked++;

      let content: string;
      try {
        const stat = fs.statSync(full);
        if (stat.size > 2_000_000) continue;
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }

      if (!content.includes(opts.shortName)) continue;

      if (opts.namespacePart) {
        const nsMatch = /^\s*namespace\s+([^;]+);/m.exec(content);
        const fileNs = nsMatch?.[1]?.trim();
        if (fileNs && fileNs !== opts.namespacePart) continue;
      }

      if (opts.classDeclRe.test(content)) return full;
    }
  }

  return undefined;
}

function resolveClassFileByWalkingWorkspace(
  fqcn: string,
  rootPath: string,
): string | undefined {
  const parts = fqcn.split("\\").filter(Boolean);
  const shortName = parts.at(-1);
  if (!shortName) return undefined;

  const namespacePart = parts.slice(0, -1).join("\\");
  const namespacePath = namespacePart.replace(/\\/g, "/");

  const classDeclRe = new RegExp(
    `\\b(?:final\\s+|abstract\\s+)?class\\s+${escapeRegExp(shortName)}\\b`,
    "m",
  );

  const startDirs = [
    namespacePath ? path.join(rootPath, namespacePath) : "",
    path.join(rootPath, "src"),
    path.join(rootPath, "lib"),
    path.join(rootPath, "app"),
    path.join(rootPath, "components"),
    path.join(rootPath, "vendor"),
    rootPath,
  ].filter(Boolean);

  const seen = new Set<string>();
  for (const dir of startDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (!fs.existsSync(dir)) continue;

    const hit = walkPhpFilesForClassSearch(dir, {
      shortName,
      namespacePart,
      classDeclRe,
      maxFiles: 8000,
    });

    if (hit) return hit;
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return;
  }

  const rootPath = workspaceFolders[0].uri.fsPath;
  const configPath = path.join(rootPath, "prisma-php.json");

  if (!fs.existsSync(configPath)) {
    console.log(
      "Prisma PHP: prisma-php.json not found. Extension features standing by.",
    );
  } else {
    console.log('Prisma PHP: Found "prisma-php.json". Extension active.');
  }

  // --- Initialize Route Provider ---
  const routeProvider = new RouteProvider(workspaceFolders[0]);

  // --- Initialize Global Functions Loader (New) ---
  // This starts watching .pp/global-functions.d.ts for changes
  GlobalFunctionsLoader.getInstance().initialize(
    context,
    workspaceFolders[0].uri,
  );

  // --- Global File List Management (Shared by Routes & Component Props) ---
  const filesListUri = vscode.Uri.joinPath(
    workspaceFolders[0].uri,
    "settings",
    "files-list.json",
  );

  const updateFilesList = async () => {
    try {
      if (fs.existsSync(filesListUri.fsPath)) {
        const content = await vscode.workspace.fs.readFile(filesListUri);
        allProjectFiles = JSON.parse(Buffer.from(content).toString("utf8"));
        routeProvider.refresh(); // Also refresh route provider
      }
    } catch (e) {
      console.error("Error reading files-list.json:", e);
    }
  };

  // Initial load
  updateFilesList();

  // Watch for changes in files-list.json
  const fileListWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolders[0], "settings/files-list.json"),
  );
  fileListWatcher.onDidChange(updateFilesList);
  fileListWatcher.onDidCreate(updateFilesList);
  fileListWatcher.onDidDelete(updateFilesList);
  context.subscriptions.push(fileListWatcher);

  // --- Watch class-log.json for Component Props ---
  loadComponentsFromClassLog(); // Initial load
  const classLogWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolders[0], "settings/class-log.json"),
  );
  classLogWatcher.onDidChange(loadComponentsFromClassLog);
  classLogWatcher.onDidCreate(loadComponentsFromClassLog);
  classLogWatcher.onDidDelete(loadComponentsFromClassLog);
  context.subscriptions.push(classLogWatcher);

  // Setup Features
  setupPPHPFeatures(context);
  setupRouteFeatures(context, routeProvider, workspaceFolders[0]);
  setupPrismaFeatures(context, workspaceFolders[0]);
  setupComponentPropsFeatures(context, rootPath);
  setupComponentImportFeatures(context);
  setupGlobalFunctionFeatures(context);

  // Note: Ensure your mustache validator also checks for 'php' languageId internally if needed
  registerMustacheValidator(context);
  registerXmlValidator(context);

  vscode.window.setStatusBarMessage("Prisma PHP Active", 3000);
}

// ─────────────────────────────────────────────────────────────────────────────
//   GLOBAL FUNCTIONS FEATURE (New)
// ─────────────────────────────────────────────────────────────────────────────

function setupGlobalFunctionFeatures(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    // 1. Completion Provider for Global Functions
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      new GlobalFunctionCompletionProvider(),
    ),

    // 2. Hover Provider for Global Functions
    vscode.languages.registerHoverProvider(
      SELECTORS.PHP,
      new GlobalFunctionHoverProvider(),
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//   COMPONENT IMPORT FEATURE
// ─────────────────────────────────────────────────────────────────────────────

function setupComponentImportFeatures(context: vscode.ExtensionContext) {
  // 1. Register Code Action Provider (The "Quick Fix" lightbulb)
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      SELECTORS.PHP,
      new ComponentImportCodeActionProvider(() => getComponentsFromClassLog()),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  // 2. Register the Command (Triggered by the Quick Fix)
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ADD_IMPORT, importComponentCommand),
  );

  // 3. Register Diagnostics (Finds the missing imports)
  const importDiagnostics =
    vscode.languages.createDiagnosticCollection("pp-imports");

  const updateDiagnostics = (doc: vscode.TextDocument) => {
    const { shouldAnalyze } = shouldAnalyzeFile(doc);
    validateMissingImports(
      doc,
      shouldAnalyze,
      importDiagnostics,
      getComponentsFromClassLog(),
    );
  };

  context.subscriptions.push(
    importDiagnostics,
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
    vscode.workspace.onDidSaveTextDocument(updateDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) =>
      updateDiagnostics(e.document),
    ),
  );

  // Initial validation
  if (vscode.window.activeTextEditor) {
    updateDiagnostics(vscode.window.activeTextEditor.document);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//   COMPONENT PROPS & ATTRIBUTES FEATURE
// ─────────────────────────────────────────────────────────────────────────────

function resolveClassFileByScanningProject(
  fqcn: string,
  rootPath: string,
): string | undefined {
  const parts = fqcn.split("\\").filter(Boolean);
  const shortName = parts.at(-1);
  if (!shortName) return undefined;

  const namespacePart = parts.slice(0, -1).join("\\");
  const namespacePath = namespacePart.replace(/\\/g, "/");

  const phpFiles = allProjectFiles.filter((f) => f.endsWith(".php"));

  const classDeclRe = new RegExp(
    `\\b(?:final\\s+|abstract\\s+)?class\\s+${escapeRegExp(shortName)}\\b`,
    "m",
  );

  if (phpFiles.length > 0) {
    const scored = phpFiles
      .map((rel) => {
        const cleanRel = rel.startsWith("./") ? rel.slice(2) : rel;
        const relNorm = cleanRel.replace(/\\/g, "/");
        const base = path.posix.basename(relNorm);

        let score = 0;
        if (namespacePath && relNorm.includes(namespacePath)) score += 3;
        if (base.toLowerCase().includes(shortName.toLowerCase())) score += 2;
        if (relNorm.toLowerCase().includes("component")) score += 1;

        return { rel: cleanRel, score };
      })
      .sort((a, b) => b.score - a.score);

    for (const item of scored) {
      const abs = path.join(rootPath, item.rel);
      if (!fs.existsSync(abs)) continue;

      let content: string;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }

      if (!content.includes(shortName)) continue;

      if (namespacePart) {
        const nsMatch = /^\s*namespace\s+([^;]+);/m.exec(content);
        const fileNs = nsMatch?.[1]?.trim();
        if (fileNs && fileNs !== namespacePart) continue;
      }

      if (classDeclRe.test(content)) return abs;
    }
  }

  return resolveClassFileByWalkingWorkspace(fqcn, rootPath);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setupComponentPropsFeatures(
  context: vscode.ExtensionContext,
  rootPath: string,
) {
  const classFileFallbackCache = new Map<string, string>();
  const fqcnToFile = (fqcn: string): string | undefined => {
    const shortName = fqcn.split("\\").pop();
    if (!shortName) return undefined;

    // 1) Fast path: conventional 1-class-per-file
    const expectedEnd = `/${shortName}.php`;
    const foundRelative = allProjectFiles.find((f) => f.endsWith(expectedEnd));

    if (foundRelative) {
      const cleanRel = foundRelative.startsWith("./")
        ? foundRelative.slice(2)
        : foundRelative;
      return path.join(rootPath, cleanRel);
    }

    // 2) Fallback: multi-class-per-file or non-matching filenames.
    const cached = classFileFallbackCache.get(fqcn);
    if (cached && fs.existsSync(cached)) return cached;

    const resolved = resolveClassFileByScanningProject(fqcn, rootPath);
    if (resolved) {
      classFileFallbackCache.set(fqcn, resolved);
      return resolved;
    }

    return undefined;
  };

  const resolveFqcnFromUseStatements = (
    text: string,
    shortName: string,
  ): string | undefined => {
    // Group use: use Namespace\{A, B as C};
    const groupRe = /\buse\s+([^;{]+)\{([^}]+)\}\s*;/g;
    let m: RegExpExecArray | null;

    while ((m = groupRe.exec(text)) !== null) {
      const prefix = m[1].trim();
      const list = m[2]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      for (const item of list) {
        const asParts = item.split(/\s+as\s+/i).map((x) => x.trim());
        const className = asParts[0];
        const alias = asParts[1] || "";

        if (alias === shortName || className === shortName) {
          const cleanPrefix = prefix.endsWith("\\") ? prefix : prefix + "\\";
          return cleanPrefix + className;
        }
      }
    }

    // Simple use: use Namespace\Class; (optionally comma-separated)
    const simpleRe = /\buse\s+([^;{]+);/g;
    while ((m = simpleRe.exec(text)) !== null) {
      const raw = m[1].trim();
      const parts = raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      for (const part of parts) {
        const asParts = part.split(/\s+as\s+/i).map((x) => x.trim());
        const fqcn = asParts[0];
        const alias = asParts[1] || "";
        const cls = fqcn.split("\\").pop() || "";

        if (alias === shortName || cls === shortName) return fqcn;
      }
    }

    return undefined;
  };

  // 2. Initialize Provider
  const componentPropsProvider = new ComponentPropsProvider(
    componentsCache,
    fqcnToFile,
  );

  // 3. Register Attribute Completion Provider
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      {
        provideCompletionItems(
          document: vscode.TextDocument,
          position: vscode.Position,
        ) {
          const { shouldAnalyze } = shouldAnalyzeFile(document);
          if (!shouldAnalyze) return undefined;

          const linePrefix = document
            .lineAt(position)
            .text.substr(0, position.character);

          const tagMatch = /<([A-Z][a-zA-Z0-9_]*)\s+([^>]*)$/.exec(linePrefix);

          if (!tagMatch) {
            return undefined;
          }

          const tagName = tagMatch[1];
          const existingAttrsText = tagMatch[2];

          const writtenAttributes = new Set<string>();
          const attrRegex = /([a-zA-Z0-9_-]+)(?:=|$)/g;
          let match;
          while ((match = attrRegex.exec(existingAttrsText)) !== null) {
            writtenAttributes.add(match[1]);
          }

          const isTypingNew = linePrefix.endsWith(" ");
          const currentWord = isTypingNew
            ? ""
            : existingAttrsText.split(" ").pop() || "";

          if (
            existingAttrsText.match(/="[^"]*$/) ||
            existingAttrsText.match(/='[^']*$/)
          ) {
            return undefined;
          }

          return buildDynamicAttrItems(
            tagName,
            writtenAttributes,
            currentWord,
            componentPropsProvider,
          );
        },
      },
      " ",
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      new ComponentTagCompletionProvider(() => getComponentsFromClassLog()),
      "<",
    ),
    vscode.languages.registerDefinitionProvider(
      SELECTORS.PHP,
      new ComponentDefinitionProvider((document, shortName) => {
        const fqcn =
          componentsCache.get(shortName) ||
          resolveFqcnFromUseStatements(document.getText(), shortName);

        if (!fqcn) return undefined;
        return fqcnToFile(fqcn);
      }),
    ),
    vscode.languages.registerHoverProvider(
      SELECTORS.PHP,
      new ComponentHoverProvider(() => getComponentsFromClassLog(), fqcnToFile),
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      new ComponentAttributeValueProvider(componentPropsProvider),
      '"',
      "'",
    ),
  );

  // 4. Register Diagnostics
  const compPropsDiag =
    vscode.languages.createDiagnosticCollection("pp-component-props");

  const updateDiagnostics = (doc: vscode.TextDocument) => {
    validateComponentPropValues(doc, componentPropsProvider);
  };

  context.subscriptions.push(
    compPropsDiag,
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
    vscode.workspace.onDidSaveTextDocument(updateDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) =>
      updateDiagnostics(e.document),
    ),
  );

  // Initial run
  if (vscode.window.activeTextEditor) {
    updateDiagnostics(vscode.window.activeTextEditor.document);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//   HELPER FUNCTIONS (File Analysis & Caching)
// ─────────────────────────────────────────────────────────────────────────────

async function loadComponentsFromClassLog(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }
  const workspaceFolder = workspaceFolders[0];
  const jsonUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    "settings",
    "class-log.json",
  );
  try {
    if (fs.existsSync(jsonUri.fsPath)) {
      const data = await vscode.workspace.fs.readFile(jsonUri);
      const jsonStr = Buffer.from(data).toString("utf8").trim();
      if (jsonStr) {
        const jsonMapping = JSON.parse(jsonStr);
        componentsCache.clear();
        Object.keys(jsonMapping).forEach((fqcn) => {
          const shortName = getLastPart(fqcn);
          componentsCache.set(shortName, fqcn);
        });
      }
    }
  } catch (error) {
    console.error("Error reading class-log.json:", error);
  }
}

export function getComponentsFromClassLog(): Map<string, string> {
  return componentsCache;
}

function getLastPart(fqcn: string): string {
  return fqcn.split("\\").pop() || "";
}

export function shouldAnalyzeFile(document: vscode.TextDocument): {
  shouldAnalyze: boolean;
  cache: FileAnalysisCache;
} {
  const cached = fileAnalysisCache.get(document.uri.toString());

  if (cached && cached.version === document.version) {
    return {
      shouldAnalyze: cached.hasMixedContent || cached.hasHeredocs,
      cache: cached,
    };
  }

  const text = document.getText();
  const lineCount = document.lineCount;

  if (lineCount > 5000) {
    const cache: FileAnalysisCache = {
      version: document.version,
      hasMixedContent: false,
      hasHeredocs: false,
      heredocRanges: [],
    };
    fileAnalysisCache.set(document.uri.toString(), cache);
    return { shouldAnalyze: false, cache };
  }

  const hasMixedContent = detectMixedContent(text);
  const heredocInfo = detectHtmlHeredocs(text);

  const cache: FileAnalysisCache = {
    version: document.version,
    hasMixedContent,
    hasHeredocs: heredocInfo.length > 0,
    heredocRanges: heredocInfo,
  };

  fileAnalysisCache.set(document.uri.toString(), cache);

  return {
    shouldAnalyze: hasMixedContent || heredocInfo.length > 0,
    cache,
  };
}

function detectMixedContent(text: string): boolean {
  const htmlTagPattern =
    /<(?:html|head|body|div|span|p|h[1-6]|a|img|ul|li|table|form|input|button|nav|header|footer|section|article|template|Fragment|[A-Z][A-Za-z0-9_]*)\b/i;

  if (!htmlTagPattern.test(text)) {
    return false;
  }

  const phpBlocks = extractPhpBlockRanges(text);
  const htmlRegex =
    /<(?:html|head|body|div|span|p|h[1-6]|a|img|ul|li|table|form|input|button|nav|header|footer|section|article|template|Fragment|[A-Z][A-Za-z0-9_]*)\b/gi;

  let match: RegExpExecArray | null;
  while ((match = htmlRegex.exec(text)) !== null) {
    const matchIndex = match.index;
    const isOutsidePhp = !phpBlocks.some(
      (block) => matchIndex >= block.start && matchIndex < block.end,
    );

    if (isOutsidePhp) {
      return true;
    }
  }

  return false;
}

function detectHtmlHeredocs(
  text: string,
): Array<{ start: number; end: number }> {
  const heredocs: Array<{ start: number; end: number }> = [];

  const heredocRegex =
    /<<<(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2\s*;/gm;

  let match: RegExpExecArray | null;
  while ((match = heredocRegex.exec(text)) !== null) {
    const content = match[3];
    if (/<[a-z]/i.test(content)) {
      const contentStart = match.index + match[0].indexOf(content);
      heredocs.push({
        start: contentStart,
        end: contentStart + content.length,
      });
    }
  }

  return heredocs;
}

function extractPhpBlockRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges = [];
  const regex = /<\?(?:php|=)[\s\S]*?\?>/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

// ─────────────────────────────────────────────────────────────────────────────
//   EXISTING FEATURES (PulsePoint, Routes, Prisma)
// ─────────────────────────────────────────────────────────────────────────────

function setupPPHPFeatures(context: vscode.ExtensionContext) {
  // --- Existing PulsePoint Features (PHP Only) ---
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      new PulsePointCompletionProvider(),
      ".",
    ),
    vscode.languages.registerHoverProvider(
      SELECTORS.PHP,
      new PulsePointHoverProvider(),
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      new PulsePointAttributeCompletionProvider(),
      " ",
      "-",
    ),
  );

  // --- Snippet Registration (PHP & Plaintext) ---
  const phpxSnippetProvider = new PhpxClassSnippetProvider();
  context.subscriptions.push(
    // Register for PHP
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      phpxSnippetProvider,
    ),
    // Register for Plaintext (Untitled files)
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PLAINTEXT,
      phpxSnippetProvider,
    ),
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
      updateFetchDiagnostics(e.document),
    ),

    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      fetchFunctionCompletionProvider,
      "'",
      '"',
    ),
    vscode.languages.registerDefinitionProvider(
      SELECTORS.PHP,
      fetchFunctionDefinitionProvider,
    ),
    vscode.languages.registerHoverProvider(
      SELECTORS.PHP,
      fetchFunctionHoverProvider,
    ),
    vscode.languages.registerDefinitionProvider(
      SELECTORS.PHP,
      new PulseDefinitionProvider(),
    ),
    vscode.languages.registerDefinitionProvider(
      SELECTORS.PHP,
      new GlobalFunctionDefinitionProvider(
        vscode.workspace.workspaceFolders![0].uri,
      ),
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      {
        provideCompletionItems(document, position) {
          const line = document.lineAt(position.line).text;
          const beforeCursor = line.slice(0, position.character);

          if (beforeCursor.endsWith("<!")) {
            const item = new vscode.CompletionItem(
              "![CDATA[",
              vscode.CompletionItemKind.Snippet,
            );

            const replaceStart = position.translate(0, -1);
            const replaceRange = new vscode.Range(replaceStart, position);

            item.insertText = new vscode.SnippetString("![CDATA[$0]]>");
            item.range = replaceRange;
            item.detail = "XML CDATA Section";
            item.documentation = new vscode.MarkdownString(
              "Insert a CDATA section to escape special characters in XML/HTML content",
            );
            item.sortText = "0";

            return [item];
          }

          return undefined;
        },
      },
      "!",
    ),
  );
}

function setupRouteFeatures(
  context: vscode.ExtensionContext,
  routeProvider: RouteProvider,
  workspaceFolder: vscode.WorkspaceFolder,
) {
  // 1. Initialize Providers
  const hrefCompletion = new HrefCompletionProvider(routeProvider);
  const hrefHover = new HrefHoverProvider(routeProvider);
  const hrefDefinition = new HrefDefinitionProvider(
    routeProvider,
    workspaceFolder,
  );
  const hrefDiagnostic = new HrefDiagnosticProvider(routeProvider);

  const srcCompletion = new SrcCompletionProvider(routeProvider);
  const srcHover = new SrcHoverProvider(routeProvider);
  const srcDefinition = new SrcDefinitionProvider(
    routeProvider,
    workspaceFolder,
  );
  const srcDiagnostic = new SrcDiagnosticProvider(routeProvider);

  const phpRedirectCompletion = new PhpRedirectCompletionProvider(
    routeProvider,
  );
  const phpRedirectHover = new PhpRedirectHoverProvider(routeProvider);
  const phpRedirectDefinition = new PhpRedirectDefinitionProvider(
    routeProvider,
    workspaceFolder,
  );
  const phpRedirectDiagnostic = new PhpRedirectDiagnosticProvider(
    routeProvider,
  );

  const scriptRedirectCompletion = new PphpScriptRedirectCompletionProvider(
    routeProvider,
  );
  const scriptRedirectHover = new PphpScriptRedirectHoverProvider(
    routeProvider,
  );
  const scriptRedirectDefinition = new PphpScriptRedirectDefinitionProvider(
    routeProvider,
    workspaceFolder,
  );
  const scriptRedirectDiagnostic = new PphpScriptRedirectDiagnosticProvider(
    routeProvider,
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
      updateRouteDiagnostics(e.document),
    ),
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
      ".",
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      srcCompletion,
      '"',
      "/",
      ".",
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      phpRedirectCompletion,
      "'",
      '"',
      "/",
      ".",
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      scriptRedirectCompletion,
      "'",
      '"',
      "/",
      ".",
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
      phpRedirectDefinition,
    ),
    vscode.languages.registerDefinitionProvider(
      SELECTORS.PHP,
      scriptRedirectDefinition,
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTORS.PHP,
      new MustacheCompletionProvider(),
      "{",
      ".",
    ),
    vscode.languages.registerHoverProvider(
      SELECTORS.PHP,
      new MustacheHoverProvider(),
    ),
  );
}

function setupPrismaFeatures(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
) {
  // 1. Register Auto-Completion
  context.subscriptions.push(registerPrismaFieldProvider());

  // 2. Schema Watching
  const schemaWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, "settings/prisma-schema.json"),
  );

  const reloadPrismaSchema = () => {
    clearPrismaSchemaCache();
    if (
      vscode.window.activeTextEditor &&
      vscode.window.activeTextEditor.document.languageId === "php"
    ) {
      updatePrismaDiagnostics(vscode.window.activeTextEditor.document);
    }
  };

  schemaWatcher.onDidChange(reloadPrismaSchema);
  schemaWatcher.onDidCreate(reloadPrismaSchema);
  schemaWatcher.onDidDelete(reloadPrismaSchema);
  context.subscriptions.push(schemaWatcher);

  // 3. Register Diagnostics
  const diagRead = vscode.languages.createDiagnosticCollection("prisma-read");
  const diagCreate =
    vscode.languages.createDiagnosticCollection("prisma-create");
  const diagUpdate =
    vscode.languages.createDiagnosticCollection("prisma-update");
  const diagDelete =
    vscode.languages.createDiagnosticCollection("prisma-delete");
  const diagUpsert =
    vscode.languages.createDiagnosticCollection("prisma-upsert");
  const diagGroupBy =
    vscode.languages.createDiagnosticCollection("prisma-groupby");
  const diagAgg =
    vscode.languages.createDiagnosticCollection("prisma-aggregate");

  const updatePrismaDiagnostics = async (document: vscode.TextDocument) => {
    if (document.languageId !== "php") {
      diagRead.delete(document.uri);
      diagCreate.delete(document.uri);
      diagUpdate.delete(document.uri);
      diagDelete.delete(document.uri);
      diagUpsert.delete(document.uri);
      diagGroupBy.delete(document.uri);
      diagAgg.delete(document.uri);
      return;
    }

    await validateReadCall(document, diagRead);
    await validateCreateCall(document, diagCreate);
    await validateUpdateCall(document, diagUpdate);
    await validateDeleteCall(document, diagDelete);
    await validateUpsertCall(document, diagUpsert);
    await validateGroupByCall(document, diagGroupBy);
    await validateAggregateCall(document, diagAgg);
  };

  context.subscriptions.push(
    diagRead,
    diagCreate,
    diagUpdate,
    diagDelete,
    diagUpsert,
    diagGroupBy,
    diagAgg,
    vscode.workspace.onDidOpenTextDocument(updatePrismaDiagnostics),
    vscode.workspace.onDidSaveTextDocument(updatePrismaDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) =>
      updatePrismaDiagnostics(e.document),
    ),
  );

  if (vscode.window.activeTextEditor) {
    updatePrismaDiagnostics(vscode.window.activeTextEditor.document);
  }
}

export function deactivate() {}
