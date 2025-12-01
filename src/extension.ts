import { XMLValidator } from "fast-xml-parser";
import * as fs from "fs";
import * as path from "path";
import ts, { CallExpression } from "typescript";
import * as vscode from "vscode";
import {
  CancellationToken,
  CodeAction,
  CodeActionContext,
  CodeActionKind,
  CodeActionProvider,
  ParameterInformation,
  Range,
  SignatureHelp,
  SignatureHelpProvider,
  SignatureInformation,
  TextDocument,
} from "vscode";
import type { FqcnToFile } from "./analysis/component-props";
import {
  ComponentPropsProvider,
  buildDynamicAttrItems,
  validateComponentPropValues,
} from "./analysis/component-props";
import { buildAttrCompletions } from "./settings/pp-attributes";
import {
  clearPrismaSchemaCache,
  registerPrismaFieldProvider,
  validateAggregateCall,
  validateCreateCall,
  validateDeleteCall,
  validateGroupByCall,
  validateReadCall,
  validateUpdateCall,
  validateUpsertCall,
} from "./settings/prisma-provider";
import { validateStateTupleUsage } from "./analysis/state";
import { rebuildMustacheStub } from "./analysis/mustache-stub";
import {
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
  RouteProvider,
  SrcCompletionProvider,
  SrcDefinitionProvider,
  SrcDiagnosticProvider,
  SrcHoverProvider,
} from "./settings/route-provider";
import {
  FetchFunctionCompletionProvider,
  FetchFunctionDefinitionProvider,
  FetchFunctionDiagnosticProvider,
  FetchFunctionHoverProvider,
} from "./analysis/fetch-function";
import {
  getTypeCache,
  InferredType,
  TypeInfo,
  updateTypeCacheFromSimpleTypes,
  updateTypeCacheFromTS,
} from "./analysis/type-chache";
import { validateMustacheExpressions } from "./analysis/mustache-validation";
import { getMustacheDecorations } from "./analysis/mustache-decorations";

interface HeredocBlock {
  content: string;
  startIndex: number;
}

const classNameMap: Record<
  VarName,
  "PPHP" | "PPHPLocalStore" | "SearchParamsManager" | "PPHPUtilities"
> = {
  pp: "PPHPUtilities",
  store: "PPHPLocalStore",
  searchParams: "SearchParamsManager",
};
const PHP_LANGUAGE = "php";

const ADD_IMPORT_COMMAND = "phpx.addImport";

let classStubs: Record<
  "PPHP" | "PPHPLocalStore" | "SearchParamsManager" | "PPHPUtilities",
  { name: string; signature: string }[]
> = {
  PPHP: [],
  PPHPUtilities: [],
  PPHPLocalStore: [],
  SearchParamsManager: [],
};
let globalStubs: Record<string, string[]> = {};
let globalStubTypes: Record<string, ts.TypeLiteralNode | ts.TypeNode> = {};

const PHP_TAG_REGEX = /<\/?[A-Z][A-Za-z0-9]*/;
const HEREDOC_PATTERN =
  /<<<(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2\s*;/gm;

const _STRING_PROTO_KEYS = Object.getOwnPropertyNames(String.prototype);
const NATIVE_STRING_METHODS = _STRING_PROTO_KEYS.filter(
  (key) => typeof ("" as any)[key] === "function"
);
const NATIVE_STRING_PROPS = _STRING_PROTO_KEYS.filter(
  (key) => typeof ("" as any)[key] !== "function"
);

const _NUMBER_PROTO_KEYS = Object.getOwnPropertyNames(Number.prototype);
const NATIVE_NUMBER_METHODS = _NUMBER_PROTO_KEYS.filter(
  (key) => typeof (0 as any)[key] === "function"
);
const NATIVE_NUMBER_PROPS = _NUMBER_PROTO_KEYS.filter(
  (key) => typeof (0 as any)[key] !== "function"
);

const _ARRAY_PROTO_KEYS = Object.getOwnPropertyNames(Array.prototype);
const NATIVE_ARRAY_METHODS = _ARRAY_PROTO_KEYS.filter(
  (key) => typeof ([] as any)[key] === "function"
);

const ALL_NATIVE_METHODS = [
  ...NATIVE_STRING_METHODS,
  ...NATIVE_NUMBER_METHODS,
  ...NATIVE_ARRAY_METHODS,
].filter((k) => /^[a-z]/i.test(k));

const ALL_NATIVE_PROPS = [
  ...NATIVE_STRING_PROPS,
  ...NATIVE_NUMBER_PROPS,
].filter((k) => /^[a-z]/i.test(k));

class PphpHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const wr = document.getWordRangeAtPosition(
      position,
      /(pp|store|searchParams)\.(\w+)/
    );
    if (!wr) {
      return;
    }
    const text = document.getText(wr);
    const [, varName, methodName] = text.match(
      /(pp|store|searchParams)\.(\w+)/
    )! as [string, VarName, string];
    const cls = classNameMap[varName];
    const entry = classStubs[cls].find((e) => e.name === methodName);
    if (!entry) {
      return;
    }

    const md = new vscode.MarkdownString();
    md.appendCodeblock(
      `${methodName}${entry.signature.slice(methodName.length)}`,
      "typescript"
    );
    return new vscode.Hover(md, wr);
  }
}

class PphpSignatureHelpProvider implements SignatureHelpProvider {
  provideSignatureHelp(
    document: TextDocument,
    position: vscode.Position,
    token: CancellationToken
  ): SignatureHelp | null {
    const line = document
      .lineAt(position.line)
      .text.slice(0, position.character);
    const m = /(pp|store|searchParams)\.(\w+)\($/.exec(line);
    if (!m) {
      return null;
    }
    const [_, varName, methodName] = m as unknown as [string, VarName, string];
    const cls = classNameMap[varName];
    const entry = classStubs[cls].find((e) => e.name === methodName);
    if (!entry) {
      return null;
    }

    const sigText = entry.signature;
    const params = sigText
      .replace(/^[^(]+\((.*)\):.*$/, "$1")
      .split(/\s*,\s*/)
      .map((p) => new ParameterInformation(p));
    const si = new SignatureInformation(
      `${methodName}(${params.map((pi) => pi.label).join(", ")})`
    );
    si.parameters = params;

    const help = new SignatureHelp();
    help.signatures = [si];
    help.activeSignature = 0;
    help.activeParameter = 0;
    return help;
  }
}

class ImportComponentCodeActionProvider implements CodeActionProvider {
  public provideCodeActions(
    document: TextDocument,
    range: Range,
    context: CodeActionContext
  ): CodeAction[] {
    const fixes: CodeAction[] = [];
    const missingImportRe =
      /Missing import for component\s+<([A-Za-z0-9_]+)\s*\/?>/;

    for (const diag of context.diagnostics) {
      const m = diag.message.match(missingImportRe);
      if (!m) {
        continue;
      }

      const tagName = m[1];
      const fullComponent = getComponentsFromClassLog().get(tagName);
      if (!fullComponent) {
        continue;
      }

      const action = new CodeAction(
        `Import <${tagName}/> from ${fullComponent}`,
        CodeActionKind.QuickFix
      );
      action.command = {
        title: "Import component",
        command: ADD_IMPORT_COMMAND,
        arguments: [document, fullComponent],
      };
      action.diagnostics = [diag];
      fixes.push(action);
    }

    return fixes;
  }
}

export function parseGlobalsWithTS(source: string) {
  const sf = ts.createSourceFile(
    "mustache.d.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );

  globalStubs = {};
  globalStubTypes = {};

  const simpleTypes = new Map<string, string>();

  sf.forEachChild((node) => {
    if (
      !ts.isVariableStatement(node) ||
      !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      return;
    }
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const name = decl.name.text;
        const type = decl.type;

        if (type && ts.isTypeLiteralNode(type)) {
          globalStubs[name] = type.members
            .filter(ts.isPropertySignature)
            .map((ps) => (ps.name as ts.Identifier).text);
          globalStubTypes[name] = type;
        } else if (type) {
          globalStubs[name] = [];
          globalStubTypes[name] = type;
          simpleTypes.set(name, type.getText());
        } else {
          globalStubs[name] = [];
        }
      }
    }
  });

  updateTypeCacheFromTS(globalStubTypes);
  updateTypeCacheFromSimpleTypes(simpleTypes);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const addImportCommand = async (
  document: vscode.TextDocument,
  fullComponent: string
) => {
  const text = document.getText();

  if (text.includes(`use ${fullComponent};`)) {
    return;
  }

  const lastSlash = fullComponent.lastIndexOf("\\");
  const groupPrefix = fullComponent.substring(0, lastSlash);
  const componentName = fullComponent.substring(lastSlash + 1);

  const edit = new vscode.WorkspaceEdit();

  const groupImportRegex = new RegExp(
    `use\\s+${escapeRegex(groupPrefix)}\\\\\\{([^}]+)\\};`,
    "m"
  );
  const groupMatch = groupImportRegex.exec(text);

  if (groupMatch) {
    let existingComponents = groupMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!existingComponents.includes(componentName)) {
      existingComponents.push(componentName);
      existingComponents.sort();
      const newGroupImport = `use ${groupPrefix}\\{${existingComponents.join(
        ", "
      )}\};`;
      const startPos = document.positionAt(groupMatch.index);
      const endPos = document.positionAt(
        groupMatch.index + groupMatch[0].length
      );
      const groupRange = new vscode.Range(startPos, endPos);
      edit.replace(document.uri, groupRange, newGroupImport);
    }
  } else {
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
      let existingComponents = matchArray.map((x) => x.component);
      if (!existingComponents.includes(componentName)) {
        existingComponents.push(componentName);
      }
      existingComponents = Array.from(new Set(existingComponents)).sort();
      const newGroupImport = `use ${groupPrefix}\\{${existingComponents.join(
        ", "
      )}\};`;
      const firstMatch = matchArray[0];
      const lastMatch = matchArray[matchArray.length - 1];
      const startPos = document.positionAt(firstMatch.index);
      const endPos = document.positionAt(lastMatch.index + lastMatch.length);
      const groupRange = new vscode.Range(startPos, endPos);
      edit.replace(document.uri, groupRange, newGroupImport);
    } else {
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

function validatePphpCalls(
  document: vscode.TextDocument,
  diagCollection: vscode.DiagnosticCollection
) {
  const original = document.getText();
  const text = sanitizeForDiagnostics(original);
  const diags: vscode.Diagnostic[] = [];

  const callRe = /\b(pp|store|searchParams)\.(\w+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text))) {
    const [, varName, methodName, argsText] = m as unknown as [
      string,
      VarName,
      string,
      string
    ];
    const classNameMap: Record<VarName, keyof typeof classStubs> = {
      pp: "PPHP",
      store: "PPHPLocalStore",
      searchParams: "SearchParamsManager",
    };
    const stubList = classStubs[classNameMap[varName]];
    const entry = stubList.find((e) => e.name === methodName);
    if (!entry) {
      continue;
    }

    const paramsPart = entry.signature.replace(/^[^(]+\(([^)]*)\):.*$/, "$1");
    const expectedParams = paramsPart
      .split(",")
      .map((p) => p.trim())
      .filter((p) => !!p);

    const hasRest = expectedParams.some((p) => p.startsWith("..."));
    const nonRest = expectedParams.filter((p) => !p.startsWith("..."));

    const parsedArgs = parseArgsWithTs(argsText);
    const passedCount = parsedArgs.length;

    const requiredCount = nonRest.filter((p) => !p.includes("?")).length;
    const maxCount = hasRest ? Infinity : expectedParams.length;

    if (passedCount < requiredCount || passedCount > maxCount) {
      const callStart = document.positionAt(m.index);
      const callEnd = document.positionAt(m.index + m[0].length);
      const range = new vscode.Range(callStart, callEnd);

      diags.push(
        new vscode.Diagnostic(
          range,
          `\`${methodName}()\` expects ${requiredCount}${
            requiredCount !== expectedParams.length
              ? ` to ${expectedParams.length}`
              : ""
          } arguments, but got ${passedCount}.`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }

  diagCollection.set(document.uri, diags);
}

interface FileAnalysisCache {
  version: number;
  hasMixedContent: boolean;
  hasHeredocs: boolean;
  heredocRanges: Array<{ start: number; end: number }>;
}

const fileAnalysisCache = new Map<string, FileAnalysisCache>();

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
    console.log(
      `[PHPX] Skipping large file (${lineCount} lines): ${document.fileName}`
    );
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

  let match: RegExpExecArray | null;
  const htmlRegex =
    /<(?:html|head|body|div|span|p|h[1-6]|a|img|ul|li|table|form|input|button|nav|header|footer|section|article|template|Fragment|[A-Z][A-Za-z0-9_]*)\b/gi;

  while ((match = htmlRegex.exec(text)) !== null) {
    const matchIndex = match.index;

    const isOutsidePhp = !phpBlocks.some(
      (block) => matchIndex >= block.start && matchIndex < block.end
    );

    if (isOutsidePhp) {
      return true;
    }
  }

  return false;
}

function detectHtmlHeredocs(
  text: string
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
  text: string
): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];

  const phpRegex = /<\?(?:php|=)?([\s\S]*?)(?:\?>|$)/g;
  let match: RegExpExecArray | null;

  while ((match = phpRegex.exec(text)) !== null) {
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return blocks;
}

export async function activate(context: vscode.ExtensionContext) {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return;
    }

    const isPrismaPhpProject = await Promise.any(
      folders.map(async (folder) => {
        try {
          const uri = vscode.Uri.joinPath(folder.uri, "prisma-php.json");
          await vscode.workspace.fs.stat(uri);
          return true;
        } catch {
          return false;
        }
      })
    ).catch(() => false);

    if (!isPrismaPhpProject) {
      return;
    }

    console.log("PHPX tag support is now active!");

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const ws = vscode.workspace.workspaceFolders?.[0];

    if (!wsFolder) {
      console.warn("No workspace!");
      return;
    }

    if (ws) {
      const pattern = new vscode.RelativePattern(
        ws,
        "settings/prisma-schema.json"
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      const clear = () => {
        clearPrismaSchemaCache();
        console.log("🔄 Prisma schema changed – cache cleared");
      };

      watcher.onDidChange(clear);
      watcher.onDidCreate(clear);
      watcher.onDidDelete(clear);

      context.subscriptions.push(watcher);
    }

    activateNativeJsHelp(context);

    const globalStubFsPath = path.join(
      wsFolder.uri.fsPath,
      ".pp",
      "phpx-mustache.d.ts"
    );

    const ppDir = path.join(wsFolder.uri.fsPath, ".pp");
    try {
      if (!fs.existsSync(ppDir)) {
        fs.mkdirSync(ppDir, { recursive: true });
        console.log("✅ Created .pp directory");
      }

      if (!fs.existsSync(globalStubFsPath)) {
        const defaultStubContent = "// Auto-generated by PHPX extension\n";
        fs.writeFileSync(globalStubFsPath, defaultStubContent, "utf8");
        console.log("✅ Created default phpx-mustache.d.ts");
      }

      const globalsText = fs.readFileSync(globalStubFsPath, "utf8");
      parseGlobalsWithTS(globalsText);
    } catch (err) {
      console.warn(
        `Failed to initialize mustache stubs: ${err}. Continuing with empty stubs.`
      );
      parseGlobalsWithTS("");
    }

    const stubPattern = new vscode.RelativePattern(
      wsFolder,
      ".pp/phpx-mustache.d.ts"
    );
    const stubWatcher = vscode.workspace.createFileSystemWatcher(stubPattern);
    context.subscriptions.push(stubWatcher);

    const reloadMustacheStubs = (uri?: vscode.Uri) => {
      try {
        const fsPath =
          uri?.fsPath ??
          path.join(wsFolder.uri.fsPath, ".pp", "phpx-mustache.d.ts");
        const next = fs.readFileSync(fsPath, "utf8");
        parseGlobalsWithTS(next);
        console.log("✅ Reloaded phpx-mustache.d.ts into type cache");
      } catch (e) {
        console.error("Failed to reload phpx-mustache.d.ts", e);
      }
    };

    stubWatcher.onDidChange(reloadMustacheStubs, null, context.subscriptions);
    stubWatcher.onDidCreate(reloadMustacheStubs, null, context.subscriptions);

    const stubPath = context.asAbsolutePath("resources/types/pphp.d.txt");
    const stubText = fs.readFileSync(stubPath, "utf8");
    parseStubsWithTS(stubText);

    const variableDecorationType = vscode.window.createTextEditorDecorationType(
      {
        color: "#9CDCFE",
      }
    );

    const propertyDecorationType = vscode.window.createTextEditorDecorationType(
      {
        color: "#4EC9B0",
      }
    );

    const nativeFunctionDecorationType =
      vscode.window.createTextEditorDecorationType({
        color: "#DCDCAA",
      });

    const nativePropertyDecorationType =
      vscode.window.createTextEditorDecorationType({
        color: "#4EC9B0",
      });

    const braceDecorationType = vscode.window.createTextEditorDecorationType({
      color: "#569CD6",
    });

    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        fileAnalysisCache.delete(document.uri.toString());
      })
    );

    context.subscriptions.push(
      vscode.languages.registerDefinitionProvider(
        { language: "php", scheme: "file" },
        {
          provideDefinition(document, position) {
            const wordRange = document.getWordRangeAtPosition(
              position,
              /[A-Za-z_]\w*/
            );
            if (!wordRange) {
              return;
            }

            const word = document.getText(wordRange);
            const line = document.lineAt(position).text;
            const beforeCursor = line.slice(0, position.character + 1);
            if (!/\bon[A-Za-z]+\s*=\s*"[^"]*$/.test(beforeCursor)) {
              return;
            }

            const text = document.getText();
            const fnRegex = new RegExp(`function\\s+${word}\\s*\\(`, "g");
            let match: RegExpExecArray | null;
            while ((match = fnRegex.exec(text))) {
              const idOffset = match.index + match[0].indexOf(word);
              const loc = document.positionAt(idOffset);
              return new vscode.Location(document.uri, loc);
            }
          },
        }
      )
    );

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { language: "php", scheme: "file" },
        {
          provideCompletionItems(document, position) {
            const line = document
              .lineAt(position.line)
              .text.slice(0, position.character);
            if (!/\bon[A-Za-z]+\s*=\s*"[^"]*$/.test(line)) {
              return;
            }

            const wordRange = document.getWordRangeAtPosition(
              position,
              /[A-Za-z_]\w*/
            );
            const partial = wordRange ? document.getText(wordRange) : "";

            const text = document.getText();
            const names = new Set<string>();

            const phpBlockRe = /<\?php\b([\s\S]*?)\?>/gi;
            for (const block of text.matchAll(phpBlockRe)) {
              const phpCode = block[1];
              for (const fn of phpCode.matchAll(
                /function\s+([A-Za-z]\w*)\s*\(/g
              )) {
                names.add(fn[1]);
              }
            }

            return Array.from(names)
              .filter((fn) => !partial || fn.startsWith(partial))
              .map((fn) => {
                const item = new vscode.CompletionItem(
                  fn,
                  vscode.CompletionItemKind.Function
                );
                if (wordRange) {
                  item.range = wordRange;
                }
                return item;
              });
          },
        },
        `"`
      )
    );

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { language: "php", scheme: "file" },
        {
          provideCompletionItems(document, position) {
            const line = document.lineAt(position.line).text;
            const beforeCursor = line.slice(0, position.character);

            if (beforeCursor.endsWith("<!")) {
              const item = new vscode.CompletionItem(
                "![CDATA[",
                vscode.CompletionItemKind.Snippet
              );

              const replaceStart = position.translate(0, -1);
              const replaceRange = new vscode.Range(replaceStart, position);

              item.insertText = new vscode.SnippetString("![CDATA[$0]]>");
              item.range = replaceRange;
              item.detail = "XML CDATA Section";
              item.documentation = new vscode.MarkdownString(
                "Insert a CDATA section to escape special characters in XML/HTML content"
              );
              item.sortText = "0";

              return [item];
            }

            return undefined;
          },
        },
        "!"
      )
    );

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { language: "php" },
        {
          provideCompletionItems(doc, pos) {
            const line = doc.lineAt(pos.line).text;
            const uptoCursor = line.slice(0, pos.character);

            const lt = uptoCursor.lastIndexOf("<");
            if (lt === -1) {
              return;
            }

            if (/^<\?(php|=)?/.test(uptoCursor.slice(lt))) {
              return;
            }

            if (uptoCursor[lt + 1] === "/") {
              return;
            }

            if (uptoCursor.slice(lt).includes(">")) {
              return;
            }

            const eq = uptoCursor.lastIndexOf("=");
            if (eq > lt) {
              const afterEq = uptoCursor.slice(eq + 1);
              const openQuote = afterEq.match(/['"]/);
              const closeQuote = afterEq.match(/(['"])[^'"]*\1\s*$/);
              if (openQuote && !closeQuote) {
                return;
              }
            }

            const tagMatch = uptoCursor.slice(lt).match(/^<\s*([A-Za-z0-9_]+)/);
            const tagName = tagMatch ? tagMatch[1] : null;

            const written = new Set<string>(
              uptoCursor.slice(lt).match(/\b[\w-]+(?==)/g) || []
            );

            const word = doc.getWordRangeAtPosition(pos, /[\w-]+/);
            const partial = word ? doc.getText(word) : "";

            let staticCompletions = buildAttrCompletions();

            if (tagName === "template") {
              staticCompletions = staticCompletions.filter(
                (item) => item.label === "pp-for"
              );
            } else {
              staticCompletions = staticCompletions.filter(
                (item) => item.label !== "pp-for"
              );
            }

            const staticItems = staticCompletions
              .filter(
                (it) =>
                  !written.has(it.label as string) &&
                  (it.label as string).startsWith(partial)
              )
              .map((it) => {
                if (word) {
                  it.range = word;
                }
                return it;
              });

            const dynamicItems = tagName
              ? buildDynamicAttrItems(
                  tagName,
                  written,
                  partial,
                  propsProvider
                ).map((it) => {
                  if (word) {
                    it.range = word;
                  }
                  return it;
                })
              : [];

            dynamicItems.forEach((it) => (it.sortText = `0_${it.label}`));
            staticItems.forEach((it) => (it.sortText = `1_${it.label}`));

            return [...dynamicItems, ...staticItems];
          },
        },
        " ",
        ":",
        "\t",
        ..."abcdefghijklmnopqrstuvwxyz".split("")
      )
    );

    context.subscriptions.push(
      vscode.languages.registerHoverProvider(
        { language: "php" },
        new PphpHoverProvider()
      )
    );

    context.subscriptions.push(
      vscode.languages.registerSignatureHelpProvider(
        { language: "php" },
        new PphpSignatureHelpProvider(),
        "(",
        ","
      )
    );

    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        PHP_LANGUAGE,
        new ImportComponentCodeActionProvider(),
        { providedCodeActionKinds: [CodeActionKind.QuickFix] }
      )
    );

    loadComponentsFromClassLog();

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.workspace.workspaceFolders![0],
        "settings/class-log.json"
      )
    );
    watcher.onDidChange(() => {
      loadComponentsFromClassLog();
      propsProvider.clear();
    });
    watcher.onDidCreate(() => loadComponentsFromClassLog());
    watcher.onDidDelete(() => componentsCache.clear());
    context.subscriptions.push(watcher);

    context.subscriptions.push(
      vscode.languages.registerHoverProvider("php", {
        provideHover(doc, pos) {
          const line = doc.lineAt(pos.line).text;
          const uptoCur = line.slice(0, pos.character);
          const lt = uptoCur.lastIndexOf("<");
          if (lt === -1 || uptoCur[lt + 1] === "/") {
            return;
          }
          if (uptoCur.slice(lt).includes(">")) {
            return;
          }

          const tagMatch = uptoCur.slice(lt).match(/^<\s*([A-Za-z0-9_]+)/);
          const tagName = tagMatch?.[1];
          if (!tagName) {
            return;
          }

          const wr = doc.getWordRangeAtPosition(pos, /[\w-]+/);
          if (!wr) {
            return;
          }
          const attr = doc.getText(wr);

          const meta = propsProvider
            .getProps(tagName)
            .find((p) => p.name === attr);
          if (!meta) {
            return;
          }

          const md = new vscode.MarkdownString();
          md.appendCodeblock(
            meta.default
              ? `${meta.name}: ${meta.type} = ${meta.default}`
              : `${meta.name}: ${meta.type}`,
            "php"
          );
          if (meta.doc) {
            md.appendMarkdown("\n\n" + meta.doc);
          }

          return new vscode.Hover(md, wr);
        },
      })
    );

    const fqcnToFile: FqcnToFile = (fqcn) => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        return undefined;
      }

      const jsonUri = vscode.Uri.joinPath(
        wsFolder.uri,
        "settings",
        "class-log.json"
      );

      try {
        const data = fs.readFileSync(jsonUri.fsPath, "utf8");
        const jsonMapping = JSON.parse(data);
        const entry = jsonMapping[fqcn];
        if (!entry) {
          return undefined;
        }

        const sourceRoot = vscode.workspace
          .getConfiguration("phpx-tag-support")
          .get("sourceRoot", "src");

        const filePath = path.join(
          wsFolder.uri.fsPath,
          sourceRoot,
          entry.filePath.replace(/\\/g, "/")
        );

        return filePath;
      } catch (error) {
        return undefined;
      }
    };

    const propsProvider = new ComponentPropsProvider(
      getComponentsFromClassLog(),
      fqcnToFile
    );

    updateEditorConfiguration();

    const diagnosticCollection =
      vscode.languages.createDiagnosticCollection("phpx-tags");
    const jsVarDiagnostics =
      vscode.languages.createDiagnosticCollection("js-vars");
    context.subscriptions.push(diagnosticCollection, jsVarDiagnostics);

    context.subscriptions.push(
      registerPhpHoverProvider(),
      registerPhpDefinitionProvider(),
      registerPhpMarkupCompletionProvider(),
      registerPhpScriptCompletionProvider()
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(ADD_IMPORT_COMMAND, addImportCommand)
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "phpx-tag-support.peekTagDefinition",
        async () => {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            await vscode.commands.executeCommand(
              "editor.action.peekDefinition"
            );
          }
        }
      ),
      vscode.commands.registerCommand("phpx-tag-support.hoverProvider", () => {
        vscode.window.showInformationMessage(
          "Hello World from phpx-tag-support!"
        );
      })
    );

    const pphpSigDiags =
      vscode.languages.createDiagnosticCollection("pphp-signatures");
    context.subscriptions.push(pphpSigDiags);

    const selector: vscode.DocumentSelector = [{ language: "php" }];

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        selector,
        {
          provideCompletionItems(doc, pos) {
            if (!insideMustache(doc, pos)) return;

            const line = doc.lineAt(pos.line).text.slice(0, pos.character);

            const m =
              /([A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*|\[[^\]]+\])*)\.\s*(\w*)$/.exec(
                line
              );

            if (!m) return;

            const [, root, partial] = m;
            const parts = tokenizeChain(root);

            const typeInfo = getTypeInfoForChainParts(parts);

            const inferredType: InferredType | "any" | undefined = (() => {
              if (typeInfo?.type) return typeInfo.type;
              return getInferredTypeForChain(parts);
            })();

            const out: vscode.CompletionItem[] = [];

            if (typeInfo?.properties?.size) {
              for (const [propName] of typeInfo.properties) {
                if (!partial || propName.startsWith(partial)) {
                  out.push(
                    new vscode.CompletionItem(
                      propName,
                      vscode.CompletionItemKind.Property
                    )
                  );
                }
              }
            }

            const isIndexingIntoArray = parts.includes("[index]");
            if (
              isIndexingIntoArray &&
              (!typeInfo?.properties || typeInfo.properties.size === 0)
            ) {
              const rootName = parts[0];
              const mined = extractPropsFromStateWithTS(
                doc.getText(),
                rootName
              );
              for (const propName of mined) {
                if (!partial || propName.startsWith(partial)) {
                  out.push(
                    new vscode.CompletionItem(
                      propName,
                      vscode.CompletionItemKind.Property
                    )
                  );
                }
              }
            }

            if (inferredType === "string") {
              for (const method of [
                "toUpperCase",
                "toLowerCase",
                "trim",
                "split",
                "slice",
              ].filter((x) => x.startsWith(partial))) {
                const it = new vscode.CompletionItem(
                  method,
                  vscode.CompletionItemKind.Method
                );
                it.insertText = new vscode.SnippetString(`${method}()$0`);
                it.detail = `(method) string.${method}()`;
                out.push(it);
              }
            } else if (inferredType === "number") {
              for (const method of [
                "toFixed",
                "toPrecision",
                "toString",
              ].filter((x) => x.startsWith(partial))) {
                const it = new vscode.CompletionItem(
                  method,
                  vscode.CompletionItemKind.Method
                );
                it.insertText = new vscode.SnippetString(`${method}()$0`);
                it.detail = `(method) number.${method}()`;
                out.push(it);
              }
            } else if (inferredType === "array") {
              for (const method of [
                "map",
                "filter",
                "reduce",
                "forEach",
                "join",
                "slice",
              ].filter((x) => x.startsWith(partial))) {
                const it = new vscode.CompletionItem(
                  method,
                  vscode.CompletionItemKind.Method
                );
                it.insertText = new vscode.SnippetString(`${method}()$0`);
                it.detail = `(method) array.${method}()`;
                out.push(it);
              }
            } else if (out.length === 0) {
              for (const k of JS_NATIVE_MEMBERS.filter((k) =>
                k.startsWith(partial)
              )) {
                const kind =
                  typeof ("" as any)[k] === "function"
                    ? vscode.CompletionItemKind.Method
                    : vscode.CompletionItemKind.Property;
                const item = new vscode.CompletionItem(k, kind);
                if (kind === vscode.CompletionItemKind.Method) {
                  item.insertText = new vscode.SnippetString(`${k}()$0`);
                }
                out.push(item);
              }
            }

            return out;
          },
        },
        ".",
        "["
      )
    );

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(selector, {
        provideCompletionItems(document, position) {
          const line = document
            .lineAt(position.line)
            .text.slice(0, position.character);

          const propMatch = /([A-Za-z_$]\w*)\.(\w*)$/.exec(line);
          if (propMatch) {
            const [, root, partial] = propMatch;
            const props = globalStubs[root] || [];
            return props
              .filter((p) => p.startsWith(partial))
              .map(
                (p) =>
                  new vscode.CompletionItem(
                    p,
                    vscode.CompletionItemKind.Property
                  )
              );
          }

          const rootMatch = /([A-Za-z_$]\w*)$/.exec(line);
          if (rootMatch) {
            const prefix = rootMatch[1];
            return Object.keys(globalStubs)
              .filter((v) => v.startsWith(prefix))
              .map(
                (v) =>
                  new vscode.CompletionItem(
                    v,
                    vscode.CompletionItemKind.Variable
                  )
              );
          }

          return undefined;
        },
      })
    );

    context.subscriptions.push(
      stringDecorationType,
      numberDecorationType,
      registerPrismaFieldProvider(),
      registerAttributeValueCompletionProvider(propsProvider)
    );

    const fetchFunctionCompletionProvider =
      new FetchFunctionCompletionProvider();
    const fetchFunctionDefinitionProvider =
      new FetchFunctionDefinitionProvider();
    const fetchFunctionHoverProvider = new FetchFunctionHoverProvider();
    const fetchFunctionDiagnosticProvider =
      new FetchFunctionDiagnosticProvider();

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { language: "php", scheme: "file" },
        fetchFunctionCompletionProvider,
        "'",
        '"'
      ),
      vscode.languages.registerDefinitionProvider(
        { language: "php", scheme: "file" },
        fetchFunctionDefinitionProvider
      ),
      vscode.languages.registerHoverProvider(
        { language: "php", scheme: "file" },
        fetchFunctionHoverProvider
      )
    );

    const fetchFunctionDiagnostics =
      vscode.languages.createDiagnosticCollection("fetch-function");
    context.subscriptions.push(fetchFunctionDiagnostics);

    const createDiags =
      vscode.languages.createDiagnosticCollection("prisma-create");
    const readDiags =
      vscode.languages.createDiagnosticCollection("prisma-read");
    const updateDiags =
      vscode.languages.createDiagnosticCollection("prisma-update");
    const deleteDiags =
      vscode.languages.createDiagnosticCollection("prisma-delete");
    const upsertDiags =
      vscode.languages.createDiagnosticCollection("prisma-upsert");
    const groupByDiags =
      vscode.languages.createDiagnosticCollection("prisma-groupBy");
    const aggregateDiags =
      vscode.languages.createDiagnosticCollection("prisma-aggregate");

    const pendingTimers = new Map<string, NodeJS.Timeout>();
    function scheduleValidation(doc: vscode.TextDocument) {
      if (doc.languageId !== PHP_LANGUAGE) {
        return;
      }

      const { shouldAnalyze } = shouldAnalyzeFile(doc);

      if (!shouldAnalyze) {
        pphpSigDiags.clear();
        diagnosticCollection.clear();
        mustacheTypeDiags.clear();
        return;
      }

      const key = doc.uri.toString();
      clearTimeout(pendingTimers.get(key));

      pendingTimers.set(
        key,
        setTimeout(() => {
          const currentAnalysis = shouldAnalyzeFile(doc);
          if (!currentAnalysis.shouldAnalyze) {
            pendingTimers.delete(key);
            return;
          }

          validatePphpCalls(doc, pphpSigDiags);
          validateStateTupleUsage(doc, pphpSigDiags);
          rebuildMustacheStub(doc);
          validateComponentPropValues(doc, propsProvider);
          validateRoutes(doc);
          updateMustacheDecorationsAST(doc);
          pendingTimers.delete(key);
        }, 200)
      );
    }

    context.subscriptions.push(
      vscode.commands.registerCommand("phpx-tag-support.refreshRoutes", () => {
        try {
          const filesListPath = path.join(
            wsFolder.uri.fsPath,
            "settings",
            "files-list.json"
          );
          delete require.cache[filesListPath];

          routeProvider.refresh();

          vscode.workspace.textDocuments.forEach((doc) => {
            if (doc.languageId === "php") {
              validateRoutes(doc);
              updateDiagnostics(doc);
            }
          });

          vscode.window.showInformationMessage(
            `✅ Manually refreshed: ${
              routeProvider.getRoutes().length
            } routes, ` +
              `${routeProvider.getStaticAssets().length} static assets`
          );
        } catch (error) {
          vscode.window.showErrorMessage("Failed to refresh routes: " + error);
        }
      })
    );

    const mustacheTypeDiags =
      vscode.languages.createDiagnosticCollection("mustache-types");
    context.subscriptions.push(mustacheTypeDiags);

    const updateAllValidations = async (document: vscode.TextDocument) => {
      const { shouldAnalyze } = shouldAnalyzeFile(document);

      if (!shouldAnalyze) {
        createDiags.clear();
        readDiags.clear();
        updateDiags.clear();
        deleteDiags.clear();
        upsertDiags.clear();
        groupByDiags.clear();
        aggregateDiags.clear();
        mustacheTypeDiags.clear();
        diagnosticCollection.clear();
        fetchFunctionDiagnostics.clear();
        return;
      }

      scheduleValidation(document);

      await validateCreateCall(document, createDiags);
      await validateReadCall(document, readDiags);
      await validateUpdateCall(document, updateDiags);
      await validateDeleteCall(document, deleteDiags);
      await validateUpsertCall(document, upsertDiags);
      await validateGroupByCall(document, groupByDiags);
      await validateAggregateCall(document, aggregateDiags);

      validateMustacheTypeSafety(document, mustacheTypeDiags);
      const mustacheDiags = validateMustacheExpressions(document);
      mustacheTypeDiags.set(document.uri, mustacheDiags);

      validateMissingImports(document, diagnosticCollection);
      const fetchFunctionDiags =
        fetchFunctionDiagnosticProvider.validateDocument(document);
      fetchFunctionDiagnostics.set(document.uri, fetchFunctionDiags);
    };

    context.subscriptions.push(propertyDecorationType);

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

    vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor) {
          scheduleValidation(editor.document);
        }
      },
      null,
      context.subscriptions
    );

    const routeProvider = new RouteProvider(wsFolder);
    const hrefCompletionProvider = new HrefCompletionProvider(routeProvider);
    const hrefHoverProvider = new HrefHoverProvider(routeProvider);
    const hrefDiagnosticProvider = new HrefDiagnosticProvider(routeProvider);
    const hrefDefinitionProvider = new HrefDefinitionProvider(
      routeProvider,
      wsFolder
    );
    const srcDiagnosticProvider = new SrcDiagnosticProvider(routeProvider);
    const srcHoverProvider = new SrcHoverProvider(routeProvider);
    const srcCompletionProvider = new SrcCompletionProvider(routeProvider);
    const srcDefinitionProvider = new SrcDefinitionProvider(
      routeProvider,
      wsFolder
    );

    const phpRedirectDiagnosticProvider = new PhpRedirectDiagnosticProvider(
      routeProvider
    );
    const phpRedirectHoverProvider = new PhpRedirectHoverProvider(
      routeProvider
    );
    const phpRedirectCompletionProvider = new PhpRedirectCompletionProvider(
      routeProvider
    );
    const phpRedirectDefinitionProvider = new PhpRedirectDefinitionProvider(
      routeProvider,
      wsFolder
    );

    const pphpScriptRedirectDiagnosticProvider =
      new PphpScriptRedirectDiagnosticProvider(routeProvider);
    const pphpScriptRedirectHoverProvider = new PphpScriptRedirectHoverProvider(
      routeProvider
    );
    const pphpScriptRedirectCompletionProvider =
      new PphpScriptRedirectCompletionProvider(routeProvider);
    const pphpScriptRedirectDefinitionProvider =
      new PphpScriptRedirectDefinitionProvider(routeProvider, wsFolder);

    context.subscriptions.push(
      vscode.languages.registerHoverProvider(
        { language: "php", scheme: "file" },
        hrefHoverProvider
      )
    );

    context.subscriptions.push(
      vscode.languages.registerDefinitionProvider(
        { language: "php", scheme: "file" },
        hrefDefinitionProvider
      )
    );

    const hrefDiagnostics =
      vscode.languages.createDiagnosticCollection("phpx-href");
    const validateRoutes = (document: vscode.TextDocument) => {
      if (document.languageId !== "php") {
        return;
      }

      const diagnostics = hrefDiagnosticProvider.validateDocument(document);
      hrefDiagnostics.set(document.uri, diagnostics);
    };

    const filesListPattern = new vscode.RelativePattern(
      wsFolder,
      "settings/files-list.json"
    );
    const filesListWatcher =
      vscode.workspace.createFileSystemWatcher(filesListPattern);

    const refreshRoutes = () => {
      routeProvider.refresh();
      console.log("🔄 Routes refreshed from files-list.json");
      vscode.workspace.textDocuments.forEach(validateRoutes);
    };

    filesListWatcher.onDidChange(refreshRoutes);
    filesListWatcher.onDidCreate(refreshRoutes);
    filesListWatcher.onDidDelete(refreshRoutes);

    context.subscriptions.push(filesListWatcher);

    vscode.workspace.onDidChangeTextDocument(
      (e) => validateRoutes(e.document),
      null,
      context.subscriptions
    );

    vscode.workspace.onDidSaveTextDocument(
      validateRoutes,
      null,
      context.subscriptions
    );

    const phpRoutesDiagnosticCollection =
      vscode.languages.createDiagnosticCollection("routes");

    const updateDiagnostics = (document: vscode.TextDocument) => {
      if (!document) {
        return;
      }
      if (document.languageId !== "php") {
        return;
      }

      const diagnostics: vscode.Diagnostic[] = [];
      diagnostics.push(...hrefDiagnosticProvider.validateDocument(document));
      diagnostics.push(
        ...phpRedirectDiagnosticProvider.validateDocument(document)
      );
      diagnostics.push(
        ...pphpScriptRedirectDiagnosticProvider.validateDocument(document)
      );
      diagnostics.push(...srcDiagnosticProvider.validateDocument(document));

      phpRoutesDiagnosticCollection.set(document.uri, diagnostics);
    };

    const phpSelector = { scheme: "file", language: "php" };

    context.subscriptions.push(
      vscode.languages.registerHoverProvider(phpSelector, hrefHoverProvider),
      vscode.languages.registerHoverProvider(phpSelector, srcHoverProvider),
      vscode.languages.registerCompletionItemProvider(
        phpSelector,
        srcCompletionProvider,
        '"',
        "'",
        "=",
        " ",
        "/"
      ),
      vscode.languages.registerDefinitionProvider(
        ["php"],
        srcDefinitionProvider
      ),

      vscode.languages.registerCompletionItemProvider(
        phpSelector,
        hrefCompletionProvider,
        '"',
        "'",
        "=",
        " ",
        "/"
      ),

      vscode.languages.registerDefinitionProvider(
        phpSelector,
        hrefDefinitionProvider
      ),

      vscode.languages.registerHoverProvider(
        phpSelector,
        phpRedirectHoverProvider
      ),

      vscode.languages.registerCompletionItemProvider(
        phpSelector,
        phpRedirectCompletionProvider,
        '"',
        "'",
        "(",
        " ",
        "/"
      ),

      vscode.languages.registerDefinitionProvider(
        phpSelector,
        phpRedirectDefinitionProvider
      ),

      vscode.languages.registerHoverProvider(
        phpSelector,
        pphpScriptRedirectHoverProvider
      ),
      vscode.languages.registerCompletionItemProvider(
        phpSelector,
        pphpScriptRedirectCompletionProvider,
        '"',
        "'",
        "(",
        " ",
        "/"
      ),
      vscode.languages.registerDefinitionProvider(
        phpSelector,
        pphpScriptRedirectDefinitionProvider
      ),

      phpRoutesDiagnosticCollection,

      vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
      vscode.workspace.onDidChangeTextDocument((event) => {
        updateDiagnostics(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument(updateDiagnostics),

      vscode.commands.registerCommand("routes.refresh", () => {
        routeProvider.refresh();
        vscode.workspace.textDocuments.forEach(updateDiagnostics);
        vscode.window.showInformationMessage("Routes refreshed successfully!");
      })
    );

    vscode.workspace.textDocuments.forEach(updateDiagnostics);

    context.subscriptions.push(
      vscode.commands.registerCommand("phpx-tag-support.showRoutes", () => {
        const routes = routeProvider.getRoutes();
        const routeList = routes
          .map((route) => `• ${route.url} → ${route.filePath}`)
          .join("\n");

        vscode.window.showInformationMessage(
          `Available Routes (${routes.length}):\n\n${routeList}`,
          { modal: true }
        );
      })
    );

    context.subscriptions.push(
      braceDecorationType,
      variableDecorationType,
      propertyDecorationType,
      nativeFunctionDecorationType,
      nativePropertyDecorationType,
      stringDecorationType,
      numberDecorationType
    );

    function updateMustacheDecorationsAST(document: vscode.TextDocument) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== document) {
        return;
      }

      const decorations = getMustacheDecorations(document);

      editor.setDecorations(braceDecorationType, decorations.braces);
      editor.setDecorations(variableDecorationType, decorations.variables);
      editor.setDecorations(propertyDecorationType, decorations.properties);
      editor.setDecorations(nativeFunctionDecorationType, decorations.methods);
      editor.setDecorations(stringDecorationType, decorations.strings);
      editor.setDecorations(numberDecorationType, decorations.numbers);
    }
  } catch (error) {
    console.error("❌ Error during PHPX extension activation:", error);
    // Don't throw - just log and continue
    // This prevents VS Code from showing "activation failed" for unrelated errors
  }
}

function extractPropsFromStateWithTS(
  source: string,
  varName: string
): string[] {
  const sanitized = (source as any)
    .replace(/<\?=\s*[^?]*\?>/g, '"__PHP_VALUE__"')
    .replace(/<\?php\s+[^?]*\?>/g, '"__PHP_VALUE__"')
    .replace(/<\?php\s+[^?]*$/g, '"__PHP_VALUE__"')
    .replace(/<\?[^?]*\?>/g, '"__PHP_VALUE__"');

  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(
      "pphp-mixed.ts",
      sanitized,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
  } catch {
    return [];
  }

  const keys = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isPropertyAccessExpression(node.initializer.expression) &&
      ts.isIdentifier(node.initializer.expression.expression) &&
      node.initializer.expression.expression.text === "pp" &&
      node.initializer.expression.name.text === "state"
    ) {
      const elems = node.name.elements;
      if (
        elems.length >= 1 &&
        ts.isBindingElement(elems[0]) &&
        ts.isIdentifier(elems[0].name) &&
        elems[0].name.text === varName
      ) {
        const firstArg = node.initializer.arguments[0];
        if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
          const firstEl = firstArg.elements[0];
          if (firstEl && ts.isObjectLiteralExpression(firstEl)) {
            for (const prop of firstEl.properties) {
              if (
                ts.isPropertyAssignment(prop) ||
                ts.isShorthandPropertyAssignment(prop)
              ) {
                const name = prop.name;
                if (ts.isIdentifier(name)) keys.add(name.text);
                else if (ts.isStringLiteral(name)) keys.add(name.text);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return [...keys];
}

function tokenizeChain(expr: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "[") {
      const j = expr.indexOf("]", i + 1);
      parts.push("[index]");
      i = j === -1 ? expr.length : j + 1;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i));
      if (m) {
        parts.push(m[0]);
        i += m[0].length;
      } else if (expr.slice(i, i + 2) === "?.") {
        i += 2;
      } else if (expr[i] === ".") {
        i += 1;
      } else {
        i += 1;
      }
    }
  }
  return parts;
}

function getTypeInfoForChainParts(parts: string[]): TypeInfo | undefined {
  const typeMap = getTypeCache();
  let current = typeMap.get(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === "[index]") {
      current = current?.element ?? current;
    } else {
      current = current?.properties?.get(seg);
    }
    if (!current) break;
  }
  return current;
}

function validateMustacheTypeSafety(
  document: vscode.TextDocument,
  diagCollection: vscode.DiagnosticCollection
) {
  const text = document.getText();
  const diags: vscode.Diagnostic[] = [];

  const typeMap = getTypeCache();

  const exprRegex =
    /\{([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.([A-Za-z_$][\w$]*)\([^)]*\))\}/g;

  let match: RegExpExecArray | null;
  while ((match = exprRegex.exec(text))) {
    const fullExpr = match[1];
    const methodName = match[2];

    const parts = fullExpr.split(".");
    const root = parts[0];

    let currentType = typeMap.get(root);
    for (let i = 1; i < parts.length - 1; i++) {
      const prop = parts[i];
      currentType = currentType?.properties?.get(prop);
    }

    if (currentType) {
      const inferredType = currentType.type as InferredType;
      const isValidMethod = isMethodValidForType(methodName, inferredType);

      if (!isValidMethod) {
        const startPos = document.positionAt(match.index + 1);
        const endPos = document.positionAt(match.index + match[0].length - 1);

        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(startPos, endPos),
            `⚠️ Method '${methodName}()' does not exist on type '${inferredType}'.\n` +
              `Available methods: ${getMethodsForType(inferredType).join(
                ", "
              )}`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }
  }

  diagCollection.set(document.uri, diags);
}

function isMethodValidForType(
  method: string,
  type: InferredType | "any"
): boolean {
  const stringMethods = [
    "toUpperCase",
    "toLowerCase",
    "trim",
    "split",
    "slice",
    "substring",
  ];
  const numberMethods = ["toFixed", "toPrecision", "toString"];
  const arrayMethods = ["map", "filter", "reduce", "forEach", "join"];

  switch (type) {
    case "string":
      return stringMethods.includes(method);
    case "number":
      return numberMethods.includes(method);
    case "array":
      return arrayMethods.includes(method);
    default:
      return true;
  }
}

function getMethodsForType(type: InferredType | "any"): string[] {
  switch (type) {
    case "string":
      return ["toUpperCase", "toLowerCase", "trim", "split", "substring"];
    case "number":
      return ["toFixed", "toPrecision", "toString"];
    case "array":
      return ["map", "filter", "join", "slice"];
    default:
      return [];
  }
}

function getInferredTypeForChain(
  parts: string[]
): InferredType | "any" | undefined {
  const typeMap = getTypeCache();
  let current = typeMap.get(parts[0]);

  for (let i = 1; i < parts.length; i++) {
    current = current?.properties?.get(parts[i]);
  }

  return current?.type;
}

function registerAttributeValueCompletionProvider(
  propsProvider: ComponentPropsProvider
): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(
    "php",
    {
      provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
      ): vscode.CompletionItem[] {
        const line = document.lineAt(position.line).text;
        const cursorOffset = position.character;

        const valueContext = getAttributeValueContext(line, cursorOffset);
        if (!valueContext) {
          return [];
        }

        const { tagName, attributeName } = valueContext;

        const props = propsProvider.getProps(tagName);
        const propMeta = props.find((p) => p.name === attributeName);

        if (!propMeta || !propMeta.allowed) {
          return [];
        }

        const combinedValues = new Set<string>();

        if (propMeta.allowed) {
          if (propMeta.allowed.includes("|")) {
            propMeta.allowed.split("|").forEach((val) => {
              const trimmedVal = val.trim();
              if (trimmedVal) {
                combinedValues.add(trimmedVal);
              }
            });
          } else {
            const trimmedVal = propMeta.allowed.trim();
            if (trimmedVal) {
              combinedValues.add(trimmedVal);
            }
          }
        }

        if (
          propMeta.default &&
          propMeta.default !== "null" &&
          propMeta.default.trim()
        ) {
          combinedValues.add(propMeta.default.trim());
        }

        let finalValues: string[];
        if (
          propMeta.default &&
          propMeta.default !== "null" &&
          combinedValues.has(propMeta.default.trim())
        ) {
          const def = propMeta.default.trim();
          finalValues = [
            def,
            ...Array.from(combinedValues)
              .filter((v) => v !== def)
              .sort(),
          ];
        } else {
          finalValues = Array.from(combinedValues).sort();
        }

        return finalValues.map((value) => {
          const item = new vscode.CompletionItem(
            value,
            vscode.CompletionItemKind.Value
          );
          item.insertText = value;
          item.detail = `${propMeta.type} value`;

          const md = new vscode.MarkdownString();
          md.appendCodeblock(`${attributeName}="${value}"`, "php");
          md.appendMarkdown(
            `\n\nValid value for **${attributeName}** property`
          );

          if (propMeta.default && propMeta.default.trim() === value) {
            md.appendMarkdown(`\n\n✨ _This is the default value_`);
            item.preselect = true;
            item.detail = `${propMeta.type} value (default)`;
          }

          item.documentation = md;
          return item;
        });
      },
    },
    '"',
    "'",
    " "
  );
}

function getAttributeValueContext(
  line: string,
  cursorOffset: number
): {
  tagName: string;
  attributeName: string;
  currentValue: string;
} | null {
  const beforeCursor = line.substring(0, cursorOffset);
  const afterCursor = line.substring(cursorOffset);

  const tagMatch = /<\s*([A-Z][A-Za-z0-9_]*)\b[^>]*$/.exec(beforeCursor);
  if (!tagMatch) {
    return null;
  }

  const tagName = tagMatch[1];

  const attrMatch = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*?)$/.exec(beforeCursor);
  if (!attrMatch) {
    return null;
  }

  const attributeName = attrMatch[1];
  const currentValue = attrMatch[2];

  const nextQuoteIndex = afterCursor.indexOf('"');
  if (nextQuoteIndex === -1) {
    return null;
  }

  return { tagName, attributeName, currentValue };
}

type NativeInfo = { sig: string; jsDoc?: string };

const NATIVE_CACHE = new Map<string, NativeInfo>();
const PARAM_TABLE: Record<string, string[]> = {
  substring: ["start", "end"],
  substr: ["start", "length"],
  slice: ["start", "end"],
  indexOf: ["searchString", "position"],
  lastIndexOf: ["searchString", "position"],
  padStart: ["targetLength", "padString"],
  padEnd: ["targetLength", "padString"],
  replace: ["searchValue", "replaceValue"],
  replaceAll: ["searchValue", "replaceValue"],
  split: ["separator", "limit"],
  concat: ["stringN"],
  repeat: ["count"],
  includes: ["searchString", "position"],
};

function nativeInfo(name: string): NativeInfo | undefined {
  if (NATIVE_CACHE.has(name)) {
    return NATIVE_CACHE.get(name);
  }

  const hosts: any[] = [
    String.prototype,
    Array.prototype,
    Number.prototype,
    Boolean.prototype,
    Object,
    Math,
  ];

  for (const host of hosts) {
    const value = host[name];
    if (typeof value === "function") {
      const paramNames =
        PARAM_TABLE[name] ??
        Array.from({ length: value.length }, (_, i) => `arg${i + 1}`);
      const sig = `${name}(${paramNames.join(", ")})`;
      const info: NativeInfo = { sig };
      NATIVE_CACHE.set(name, info);
      return info;
    }
    if (value !== undefined) {
      const info: NativeInfo = { sig: `${name}: ${typeof value}` };
      NATIVE_CACHE.set(name, info);
      return info;
    }
  }
}

export function activateNativeJsHelp(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider("php", {
      provideHover(doc, pos) {
        if (!insideMustache(doc, pos)) {
          return;
        }

        const wr = doc.getWordRangeAtPosition(pos, /\w+/);
        if (!wr) {
          return;
        }
        const word = doc.getText(wr);
        const info = nativeInfo(word);
        if (!info) {
          return;
        }

        const md = new vscode.MarkdownString();
        md.appendCodeblock(info.sig, "javascript");
        if (info.jsDoc) {
          md.appendMarkdown("\n" + info.jsDoc);
        }
        return new vscode.Hover(md, wr);
      },
    })
  );

  ctx.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(
      "php",
      {
        provideSignatureHelp(doc, pos) {
          if (!insideMustache(doc, pos)) {
            return null;
          }

          const line = doc.lineAt(pos.line).text.slice(0, pos.character);
          const m = /(?:\.)([A-Za-z_$][\w$]*)\(/.exec(line);
          if (!m) {
            return null;
          }

          const name = m[1];
          const info = nativeInfo(name);
          if (!info) {
            return null;
          }

          const paramLabels = info.sig
            .replace(/^[^(]+\(([^)]*)\).*/, "$1")
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);

          const sig = new SignatureInformation(info.sig);
          sig.parameters = paramLabels.map((p) => new ParameterInformation(p));

          const callSoFar = line.slice(line.lastIndexOf("(") + 1);
          const active = Math.min(
            callSoFar.split(",").length - 1,
            paramLabels.length - 1
          );

          const sh = new SignatureHelp();
          sh.signatures = [sig];
          sh.activeSignature = 0;
          sh.activeParameter = active;
          return sh;
        },
      },
      "(",
      ","
    )
  );
}

const updateEditorConfiguration = (): void => {
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
};

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

const PHP_SELECTOR: vscode.DocumentSelector = [
  { language: PHP_LANGUAGE, scheme: "file" },
  { language: PHP_LANGUAGE, scheme: "untitled" },
  { language: "plaintext", scheme: "untitled" },
];

const VAR_NAMES = ["pp", "store", "searchParams"] as const;
type VarName = (typeof VAR_NAMES)[number];

const CLS_MAP: Record<VarName, keyof typeof classStubs> = {
  pp: "PPHPUtilities",
  store: "PPHPLocalStore",
  searchParams: "SearchParamsManager",
};

const insideScript = (doc: vscode.TextDocument, pos: vscode.Position) => {
  const txt = doc.getText();
  const offset = doc.offsetAt(pos);
  const before = txt.slice(0, offset);
  return (
    (before.match(/<script\b/gi) || []).length >
    (before.match(/<\/script>/gi) || []).length
  );
};

const variableItems = (prefix: string) =>
  VAR_NAMES.filter((v) => v.startsWith(prefix)).map(
    (v) => new vscode.CompletionItem(v, vscode.CompletionItemKind.Variable)
  );

const memberItems = (line: string) => {
  const m = /(pp|store|searchParams)\.\w*$/.exec(line);
  if (!m) {
    return;
  }
  const cls = CLS_MAP[m[1] as VarName];
  return classStubs[cls].map((stub) => {
    const kind = stub.signature.includes("(")
      ? vscode.CompletionItemKind.Method
      : vscode.CompletionItemKind.Property;
    const it = new vscode.CompletionItem(stub.name, kind);
    it.detail = stub.signature;
    return it;
  });
};

const registerPhpScriptCompletionProvider = () =>
  vscode.languages.registerCompletionItemProvider(
    PHP_SELECTOR,
    {
      provideCompletionItems(doc, pos) {
        if (!insideScript(doc, pos)) {
          return;
        }

        const line = doc.lineAt(pos.line).text;
        const uptoCursor = line.slice(0, pos.character);
        const mem = memberItems(uptoCursor);
        if (mem?.length) {
          return mem;
        }

        const prefix = uptoCursor.match(/([A-Za-z_]*)$/)?.[1] ?? "";
        if (prefix.length) {
          return variableItems(prefix);
        }

        return;
      },
    },
    ".",
    ..."abcdefghijklmnopqrstuvwxyz".split("")
  );

const registerPhpMarkupCompletionProvider = () =>
  vscode.languages.registerCompletionItemProvider(
    PHP_SELECTOR,
    {
      async provideCompletionItems(doc, pos) {
        if (insideScript(doc, pos)) {
          return;
        }

        const fullBefore = doc.getText(
          new vscode.Range(new vscode.Position(0, 0), pos)
        );
        const line = doc.lineAt(pos.line).text;
        const uptoCursor = line.slice(0, pos.character);

        if (isInsidePrismaCall(fullBefore)) {
          return [];
        }
        if (/^\s*<\?[A-Za-z=]*$/i.test(uptoCursor)) {
          return [];
        }
        if (isInsideMustacheText(fullBefore)) {
          return [];
        }

        const mem = memberItems(uptoCursor);
        if (mem?.length) {
          return mem;
        }

        const prefix = uptoCursor.match(/([A-Za-z_]*)$/)?.[1] ?? "";
        if (prefix.length) {
          const vars = variableItems(prefix);
          if (vars.length) {
            return vars;
          }
        }

        const items = await buildComponentCompletions(doc, line, pos);
        items.push(...maybeAddPhpXClassSnippet(doc, line, pos));
        return items;
      },
    },
    ".",
    "p",
    "s",
    "_"
  );

function isInsidePrismaCall(fullBefore: string): boolean {
  const prismaIndex = fullBefore.lastIndexOf("$prisma->");
  if (prismaIndex !== -1) {
    const parenIndex = fullBefore.indexOf("(", prismaIndex);
    if (parenIndex !== -1) {
      const between = fullBefore.slice(parenIndex);
      const opens = (between.match(/\(/g) || []).length;
      const closes = (between.match(/\)/g) || []).length;
      return opens > closes;
    }
  }
  return false;
}

function isInsideMustacheText(before: string): boolean {
  const lastOpen = before.lastIndexOf("{");
  const lastClose = before.lastIndexOf("}");
  if (lastOpen <= lastClose) {
    return false;
  }
  return before[lastOpen - 1] !== "{";
}

async function buildComponentCompletions(
  document: vscode.TextDocument,
  line: string,
  position: vscode.Position
): Promise<vscode.CompletionItem[]> {
  await loadComponentsFromClassLog();

  const lineText = line.slice(0, position.character);
  const lt = lineText.lastIndexOf("<");

  if (lt !== -1) {
    let head = lineText.slice(lt + 1);
    if (head.startsWith("/")) {
      head = head.slice(1);
    }
    if (/\s|['"]/.test(head)) {
      return [];
    }
  } else {
    if (!/^\s*$/.test(lineText.replace(/\w*$/, ""))) {
      return [];
    }
  }

  const completions: vscode.CompletionItem[] = [];

  const useMap: Map<string, string> = parsePhpUseStatements(document.getText());
  const lessThan: number = line.lastIndexOf("<", position.character);
  let replaceRange: vscode.Range | undefined;

  const hasOpeningBracket = lessThan !== -1;

  if (hasOpeningBracket) {
    replaceRange = new vscode.Range(
      new vscode.Position(position.line, lessThan),
      position
    );
  }

  for (const [shortName, fullClass] of useMap.entries()) {
    const item: vscode.CompletionItem = new vscode.CompletionItem(
      shortName,
      vscode.CompletionItemKind.Class
    );
    item.detail = `Component from ${fullClass}`;
    item.insertText = new vscode.SnippetString(
      hasOpeningBracket ? shortName : `<${shortName}`
    );
    item.filterText = `<${shortName}`;
    item.range = replaceRange;
    completions.push(item);
  }

  const componentsMap: Map<string, string> = getComponentsFromClassLog();
  componentsMap.forEach((fullComponent: string, shortName: string) => {
    const compItem: vscode.CompletionItem = new vscode.CompletionItem(
      shortName,
      vscode.CompletionItemKind.Class
    );
    compItem.detail = `Component (from class-log)`;
    compItem.insertText = new vscode.SnippetString(
      hasOpeningBracket ? shortName : `<${shortName}`
    );
    compItem.command = {
      title: "Add import",
      command: ADD_IMPORT_COMMAND,
      arguments: [document, fullComponent],
    };
    completions.push(compItem);
  });

  return completions;
}

function maybeAddPhpXClassSnippet(
  document: vscode.TextDocument,
  line: string,
  position: vscode.Position
): vscode.CompletionItem[] {
  const prefixLine: string = line.match(/([A-Za-z_]*)$/)![1];
  if (!/^\s*phpx?c?l?a?s?s?$/i.test(prefixLine)) {
    return [];
  }

  const wsFolder: vscode.WorkspaceFolder | undefined =
    vscode.workspace.getWorkspaceFolder(document.uri);
  const cfg: vscode.WorkspaceConfiguration =
    vscode.workspace.getConfiguration("phpx-tag-support");
  const sourceRoot: string = cfg.get<string>("sourceRoot", "src");
  let namespacePlaceholder: string = "${1:Lib\\\\PHPX\\\\Components}";
  if (
    !document.isUntitled &&
    wsFolder &&
    document.uri.fsPath.endsWith(".php")
  ) {
    const rel: string = path.relative(
      path.join(wsFolder.uri.fsPath, sourceRoot),
      path.dirname(document.uri.fsPath)
    );
    const parts: string[] = rel
      .split(path.sep)
      .filter(Boolean)
      .map((s) => s.replace(/[^A-Za-z0-9_]/g, ""));
    namespacePlaceholder = parts.length
      ? parts.join("\\\\")
      : namespacePlaceholder;
  }
  const classNamePlaceholder: string =
    !document.isUntitled && document.uri.fsPath.endsWith(".php")
      ? path.basename(document.uri.fsPath, ".php")
      : "${2:ClassName}";

  const snippet: vscode.SnippetString = new vscode.SnippetString(`<?php

declare(strict_types=1);

namespace ${namespacePlaceholder};

use PP\\\\PHPX\\\\PHPX;

class ${classNamePlaceholder} extends PHPX
{
    public ?string \\$class = '';
    public mixed \\$children = null;

    public function __construct(array \\$props = [])
    {
        parent::__construct(\\$props);
    }

    public function render(): string
    {
        \\$class = \\$this->getMergeClasses(\\$this->class);
        \\$attributes = \\$this->getAttributes([
            'class' => \\$class,
        ]);

        return <<<HTML
        <div {\\$attributes}>
            {\\$this->children}
        </div>
        HTML;
    }
}`);

  const start: vscode.Position = position.translate(
    0,
    -prefixLine.trim().length
  );
  const item: vscode.CompletionItem = new vscode.CompletionItem(
    "phpxclass",
    vscode.CompletionItemKind.Snippet
  );
  item.detail = "PHPX Class Template";
  item.insertText = snippet;
  item.range = new vscode.Range(start, position);

  return [item];
}

function prettifyXmlError(raw: string): string {
  let m = /Expected closing tag '([^']+)'/.exec(raw);
  if (m) {
    return `Missing closing tag: </${m[1]}> is required to match an opening tag.`;
  }

  m = /attribute '([^']+)' is without value/i.exec(raw);
  if (m) {
    return `Attribute ${m[1]} needs a value (e.g. ${m[1]}="…")`;
  }

  m = /duplicate attribute '([^']+)'/i.exec(raw);
  if (m) {
    return `Attribute ${m[1]} is repeated`;
  }

  m = /boolean attribute '([^']+)' is not allowed/i.exec(raw);
  if (m) {
    return `Attribute ${m[1]} must have a value ` + `(e.g. ${m[1]}="true")`;
  }

  return raw.replace(/^.*XML:?/i, "XML error:");
}

export const getFxpDiagnostics = (
  doc: vscode.TextDocument
): vscode.Diagnostic[] => {
  const raw = doc.getText();

  if (doc.languageId === "php" && !hasRealClosingTagOrHeredocHtml(raw)) {
    return [];
  }

  const sanitized = sanitizeForDiagnosticsXML(raw);

  if (!/[<][A-Za-z][A-Za-z0-9-]*(\s|>)/.test(sanitized)) {
    return [];
  }

  const voided = sanitized.replace(
    /<\s*(meta)\b([^>]*?)(?<!\/)>/gi,
    (_m, tag, attrs) => `<${tag}${attrs}/>`
  );
  const xml = `<__root>\n${voided}\n</__root>`;
  const res = XMLValidator.validate(xml);
  if (res === true) {
    return [];
  }

  const { line, col, msg } = (res as any).err as {
    line: number;
    col: number;
    msg: string;
  };
  const pretty = prettifyXmlError(msg);

  const xmlLines = xml.split("\n");
  let xmlOffset = 0;
  for (let i = 0; i < line - 1; i++) {
    xmlOffset += xmlLines[i].length + 1;
  }
  xmlOffset += col - 1;
  const wrapIndex = xml.indexOf(voided);
  let errorOffset = xmlOffset - wrapIndex;
  errorOffset = Math.max(0, Math.min(errorOffset, raw.length - 1));

  const attrMatch = /^Attribute (\w+)/.exec(pretty);
  if (attrMatch) {
    const badAttr = attrMatch[1];

    const tagStart = sanitized.lastIndexOf("<", errorOffset);
    const tagEnd = sanitized.indexOf(">", errorOffset);
    if (tagStart !== -1 && tagEnd !== -1 && tagEnd > tagStart) {
      const tagSlice = sanitized.slice(tagStart, tagEnd);

      const localIdx = tagSlice.search(new RegExp("\\b" + badAttr + "\\b"));
      if (localIdx !== -1) {
        const absIdx = tagStart + localIdx;
        const start = doc.positionAt(absIdx);
        const end = start.translate(0, badAttr.length);

        return [
          new vscode.Diagnostic(
            new vscode.Range(start, end),
            pretty,
            vscode.DiagnosticSeverity.Error
          ),
        ];
      }
    }

    const attrRe = new RegExp(`\\b${badAttr}\\b\\s*=`, "g");
    let bestIdx = -1;
    for (const m of sanitized.matchAll(attrRe)) {
      const idx = m.index!;
      if (idx <= errorOffset && idx > bestIdx) {
        bestIdx = idx;
      }
    }
    if (bestIdx < 0) {
      bestIdx = sanitized.search(attrRe);
    }
    if (bestIdx >= 0) {
      const start = doc.positionAt(bestIdx);
      const end = start.translate(0, badAttr.length);
      return [
        new vscode.Diagnostic(
          new vscode.Range(start, end),
          pretty,
          vscode.DiagnosticSeverity.Error
        ),
      ];
    }
  }

  let start = doc.positionAt(errorOffset);
  let end = start.translate(0, 1);
  let range = new vscode.Range(start, end);

  const closeMatch = /^Missing closing tag: <\/([^>]+)>/.exec(pretty);
  if (closeMatch) {
    const tag = closeMatch[1];
    const openRe = new RegExp(`<${tag}\\b([^>]*?)(?<!\\/)\\>`, "g");
    const opens = Array.from(raw.matchAll(openRe), (m) => m.index!).sort(
      (a, b) => a - b
    );
    const closeRe = new RegExp(`</${tag}>`, "g");
    const closes = Array.from(raw.matchAll(closeRe), (m) => m.index!).sort(
      (a, b) => a - b
    );

    const unmatched = [...opens];
    for (const c of closes) {
      for (let i = unmatched.length - 1; i >= 0; i--) {
        if (unmatched[i] < c) {
          unmatched.splice(i, 1);
          break;
        }
      }
    }

    const badOpen = unmatched[0];
    if (badOpen !== null) {
      const pos = doc.positionAt(badOpen + 1);
      range = new vscode.Range(pos, pos.translate(0, tag.length));
    }
  }

  return [
    new vscode.Diagnostic(range, pretty, vscode.DiagnosticSeverity.Error),
  ];
};

function hasRealClosingTagOrHeredocHtml(src: string): boolean {
  if (hasRealClosingTag(src)) {
    return true;
  }
  if (hasHtmlInHeredoc(src)) {
    return true;
  }

  const sanitized = sanitizeForDiagnosticsXML(src);
  const hasHtmlTags = /[<][A-Za-z][A-Za-z0-9-]*(\s|>)/.test(sanitized);
  if (hasHtmlTags) {
    const htmlLikePattern = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[^>]*)?>/;
    return htmlLikePattern.test(sanitized);
  }
  return false;
}

function hasRealClosingTag(src: string): boolean {
  let inS = "",
    esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inS) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === inS) {
        inS = "";
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inS = ch;
      continue;
    }

    if (ch === "?" && src[i + 1] === ">") {
      return true;
    }
  }
  return false;
}

function hasHtmlInHeredoc(src: string): boolean {
  const heredocRE =
    /<<<['"]?([A-Za-z_]\w*)['"]?\r?\n([\s\S]*?)\r?\n\s*\1\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = heredocRE.exec(src))) {
    const body = m[2];
    if (/[<][A-Za-z]/.test(body)) {
      return true;
    }
  }
  return false;
}

const spacer = (s: string) => s.replace(/[^\n]/g, " ");

const stripInlineSlashes = (txt: string): string =>
  txt.replace(
    /(^|>|[)\]}"'` \t])\s*\/\/.*?(?=<|\r?\n|$)/g,
    (m, p) => p + spacer(m.slice(p.length))
  );

const blankMustaches = (txt: string) =>
  txt.replace(/\{([\s\S]*?)\}/g, (m, inner, idx, full) => {
    if (full[idx - 1] === "{" || full[idx + m.length] === "}") {
      return m;
    }
    return "{" + spacer(inner) + "}";
  });

function sanitizeForDiagnosticsXML(raw: string): string {
  let text = raw;

  text = preprocessFragmentShortSyntax(text);

  text = text.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (m) => " ".repeat(m.length));
  text = text.replace(/<\?(?:php|=)?(?:[^?]|\?(?!>))*$/g, (m) =>
    " ".repeat(m.length)
  );

  text = text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (full, body) =>
    full.replace(body, spacer(body))
  );

  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (full, body) =>
    full.replace(body, spacer(body))
  );
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (full, body) =>
    full.replace(body, spacer(body))
  );

  text = sanitizePhpVariableAssignments(text);

  text = text.replace(
    /<<<['"]?([A-Za-z_]\w*)['"]?\r?\n([\s\S]*?)\r?\n\s*\1\s*;?/g,
    (fullMatch) => {
      const lines = fullMatch.split(/\r?\n/);
      return lines
        .map((line, i) =>
          i === 0 || i === lines.length - 1 ? " ".repeat(line.length) : line
        )
        .join("\n");
    }
  );

  text = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  text = text.replace(/^[ \t]*\/\/.*$/gm, (m) => " ".repeat(m.length));
  text = text.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (m) => " ".repeat(m.length));
  text = text.replace(/<\?(?:php|=)?/g, (m) => " ".repeat(m.length));
  text = stripInlineSlashes(text);
  text = text.replace(
    /(['"])(?:\\.|[^\\])*?\1/g,
    (m, q) => q + " ".repeat(m.length - 2) + q
  );
  text = blankMustaches(text);
  text = text.replace(/\{\$[^}]+\}/g, (m) => " ".repeat(m.length));
  text = text.replace(/&&|&/g, (match) => " ".repeat(match.length));
  return text;
}

const preprocessFragmentShortSyntax = (text: string): string => {
  let result = text;
  result = result.replace(/<>/g, "<Fragment>");
  result = result.replace(/<\/>/g, "</Fragment>");
  return result;
};

const sanitizePhpVariableAssignments = (text: string): string =>
  text.replace(
    /\$[A-Za-z_]\w*\s*=\s*(['"])\/.*?\/[gimsuyx]*\1\s*;/gi,
    (match) => " ".repeat(match.length)
  );

let componentsCache = new Map<string, string>();

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
      Object.keys(jsonMapping).forEach((fqcn) => {
        const shortName = getLastPart(fqcn);
        componentsCache.set(shortName, fqcn);
      });
    }
  } catch (error) {
    console.error("Error reading class-log.json:", error);
  }
}

export function getComponentsFromClassLog(): Map<string, string> {
  return componentsCache;
}

const JS_NATIVE_MEMBERS = [...ALL_NATIVE_METHODS, ...ALL_NATIVE_PROPS].filter(
  (k) => /^[a-z]/i.test(k)
);

function insideMustache(
  doc: vscode.TextDocument,
  pos: vscode.Position
): boolean {
  const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), pos));
  const open = before.lastIndexOf("{");
  const close = before.lastIndexOf("}");
  if (open === -1 || open <= close) {
    return false;
  }
  return before[open - 1] !== "{";
}

const ASSIGNMENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

export function containsJsAssignment(expr: string): boolean {
  const sf = ts.createSourceFile(
    "tmp.ts",
    `(${expr});`,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX
  );

  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_KINDS.has(node.operatorToken.kind)
    ) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };

  sf.forEachChild(visit);
  return found;
}

const STRING_COLOR = "#CE9178";
const stringDecorationType = vscode.window.createTextEditorDecorationType({
  color: STRING_COLOR,
});
const numberDecorationType = vscode.window.createTextEditorDecorationType({
  color: "#B5CEA8",
});

export function* findPlaceholders(src: string) {
  for (let i = 0; i < src.length - 1; i++) {
    if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth) {
        const ch = src[j++];
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
        }
      }
      if (depth === 0) {
        yield { start: i, end: j };
        i = j - 1;
      }
    }
  }
}

const validateMissingImports = (
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
): void => {
  if (document.languageId !== PHP_LANGUAGE) {
    return;
  }

  const { shouldAnalyze } = shouldAnalyzeFile(document);
  if (!shouldAnalyze) {
    diagnosticCollection.set(document.uri, []);
    return;
  }

  const originalText = document.getText();
  const useMap = parsePhpUseStatements(originalText);

  let noCommentsText = removePhpComments(originalText);

  noCommentsText = noCommentsText.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (m) =>
    " ".repeat(m.length)
  );
  noCommentsText = noCommentsText.replace(
    /<\?(?:php|=)?(?:[^?]|\?(?!>))*$/g,
    (m) => " ".repeat(m.length)
  );

  noCommentsText = blankOutHeredocOpeners(noCommentsText);
  noCommentsText = removePhpStringLiterals(noCommentsText);

  const BUILTIN_COMPONENTS = new Set(["Fragment"]);

  const diagnostics: vscode.Diagnostic[] = [];
  const tagMatches = [...noCommentsText.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)];
  tagMatches.forEach((match) => {
    const tag = match[1];
    if (!useMap.has(tag) && !BUILTIN_COMPONENTS.has(tag)) {
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
    blockContent = removePhpStringLiterals(blockContent);

    const blockTagMatches = [
      ...blockContent.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g),
    ];
    blockTagMatches.forEach((match) => {
      const tag = match[1];
      if (!useMap.has(tag) && !BUILTIN_COMPONENTS.has(tag)) {
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

  diagnostics.push(...getFxpDiagnostics(document));
  diagnosticCollection.set(document.uri, diagnostics);
};

const removePhpStringLiterals = (text: string): string => {
  text = text.replace(/'(?:[^'\\]|\\.)*'/g, (match) =>
    " ".repeat(match.length)
  );
  text = text.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    " ".repeat(match.length)
  );
  return text;
};

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
  let result = text;
  result = result.replace(
    /\$\w+\s*=\s*(['"])\/.*?\/[gimsuyx]*\1\s*;/gi,
    (match) => " ".repeat(match.length)
  );
  result = result.replace(
    /\b(preg_\w+)\s*\(\s*(['"])\/.*?\/[gimsuyx]*\2/gi,
    (match) => " ".repeat(match.length)
  );
  result = result.replace(
    /(['"])\/(?:\\.|[^\\\/\r\n])*?\/[gimsuyx]*\1/gi,
    (match) => " ".repeat(match.length)
  );
  return result;
};

const removePhpInterpolations = (text: string): string =>
  text.replace(/\{\$[^}]+\}|\$[A-Za-z_]\w*/g, (match) =>
    " ".repeat(match.length)
  );

const removeNormalPhpStrings = (text: string): string =>
  text.replace(/\\(['"])/g, "$1");

const sanitizeForDiagnostics = (text: string): string => {
  text = text.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (block) =>
    " ".repeat(block.length)
  );
  text = text.replace(/<\?(?:php|=)?(?:[^?]|\?(?!>))*$/g, (m) =>
    " ".repeat(m.length)
  );

  text = removePhpComments(text);
  text = blankOutHeredocOpeners(text);
  text = removePhpRegexLiterals(text);
  text = removePhpInterpolations(text);
  text = removePhpStringLiterals(text);
  text = removeNormalPhpStrings(text);

  return text;
};

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

export function parseArgsWithTs(args: string): string[] {
  const wrapper = `__dummy__(${args});`;

  const sf = ts.createSourceFile(
    "args.ts",
    wrapper,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  );

  let call: CallExpression | undefined;
  sf.forEachChild((node) => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression)
    ) {
      call = node.expression;
    }
  });

  if (!call) {
    return [];
  }

  return call.arguments.map((arg) => arg.getText(sf));
}

function parseStubsWithTS(source: string) {
  const stubNames = new Set<keyof typeof classStubs>(
    Object.keys(classStubs) as (keyof typeof classStubs)[]
  );

  const sf = ts.createSourceFile(
    "pphp.d.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );

  const extendsMap = new Map<string, string>();
  const tempStubs: Record<string, { name: string; signature: string }[]> = {};

  sf.statements.forEach((stmt) => {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) {
      return;
    }

    const name = stmt.name.text;
    if (!stubNames.has(name as keyof typeof classStubs)) {
      return;
    }

    if (stmt.heritageClauses) {
      for (const clause of stmt.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          const parentType = clause.types[0];
          if (ts.isIdentifier(parentType.expression)) {
            extendsMap.set(name, parentType.expression.text);
          }
        }
      }
    }

    const members: { name: string; signature: string }[] = [];

    stmt.members.forEach((member) => {
      const modifiers = ts.canHaveModifiers(member)
        ? ts.getModifiers(member)
        : undefined;

      if (
        modifiers?.some(
          (m) =>
            m.kind === ts.SyntaxKind.PrivateKeyword ||
            m.kind === ts.SyntaxKind.ProtectedKeyword ||
            m.kind === ts.SyntaxKind.StaticKeyword
        )
      ) {
        return;
      }

      if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
        const mName = (member.name as ts.Identifier).text;
        const sig = member.getText(sf).trim();
        members.push({ name: mName, signature: sig });
      } else if (
        ts.isPropertySignature(member) ||
        ts.isPropertyDeclaration(member)
      ) {
        const pName = (member.name as ts.Identifier).text;
        const pType = member.type?.getText(sf).trim() ?? "any";
        members.push({ name: pName, signature: `: ${pType}` });
      }
    });

    tempStubs[name] = members;
  });

  const getMembersWithInheritance = (
    className: string,
    visited = new Set<string>()
  ): { name: string; signature: string }[] => {
    if (visited.has(className)) {
      return [];
    }
    visited.add(className);

    const ownMembers = tempStubs[className] || [];
    const parentName = extendsMap.get(className);

    if (!parentName || !tempStubs[parentName]) {
      return ownMembers;
    }

    const parentMembers = getMembersWithInheritance(parentName, visited);
    const memberMap = new Map<string, { name: string; signature: string }>();

    parentMembers.forEach((m) => memberMap.set(m.name, m));
    ownMembers.forEach((m) => memberMap.set(m.name, m));

    return Array.from(memberMap.values());
  };

  stubNames.forEach((name) => {
    const key = name as keyof typeof classStubs;
    classStubs[key] = getMembersWithInheritance(name);
  });
}

export function deactivate(): void {}
