import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { XMLValidator } from "fast-xml-parser";
import ts from "typescript";
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

/* ────────────────────────────────────────────────────────────── *
 *                        INTERFACES & CONSTANTS                    *
 * ────────────────────────────────────────────────────────────── */

interface HeredocBlock {
  content: string;
  startIndex: number;
}
interface PrismaFieldProviderConfig {
  /**
   * A regex to pick up all calls of this op and capture the model name in group 1.
   * Should match up to ( but not include the final quote/[… trigger.
   */
  callRegex: RegExp;
  /**
   * The human-friendly label used in the Markdown docs:
   * e.g. "*optional field*" vs "*required filter*"
   */
  optionalLabel: string;
  requiredLabel: string;
  /**
   * Characters that should trigger this provider (e.g. "'" and '"')
   */
  triggerChars: string[];
}

type VarName = "pphp" | "store" | "searchParams";
type PrismaOp = "create" | "find" | "updateData" | "updateWhere" | "delete";

const classNameMap: Record<
  VarName,
  "PPHP" | "PPHPLocalStore" | "SearchParamsManager"
> = {
  pphp: "PPHP",
  store: "PPHPLocalStore",
  searchParams: "SearchParamsManager",
};

const PHP_LANGUAGE = "php";

// Command ID for auto-import.
const ADD_IMPORT_COMMAND = "phpx.addImport";

// Colors for decorations
const BRACE_COLOR = "#569CD6";
const NATIVE_FUNC_COLOR = "#D16969";
const NATIVE_PROP_COLOR = "#4EC9B0";
let classStubs: Record<
  "PPHP" | "PPHPLocalStore" | "SearchParamsManager",
  { name: string; signature: string }[]
> = {
  PPHP: [],
  PPHPLocalStore: [],
  SearchParamsManager: [],
};
let globalStubs: Record<string, string[]> = {};

// Regex patterns
const PHP_TAG_REGEX = /<\/?[A-Z][A-Za-z0-9]*/;
const JS_EXPR_REGEX = /{{\s*(.*?)\s*}}/g;
const HEREDOC_PATTERN =
  /<<<(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2\s*;/gm;
// grab every key on String.prototype…
const _STRING_PROTO_KEYS = Object.getOwnPropertyNames(String.prototype);
// methods vs. non-method props
const NATIVE_STRING_METHODS = _STRING_PROTO_KEYS.filter(
  (key) => typeof ("" as any)[key] === "function"
);
const NATIVE_STRING_PROPS = _STRING_PROTO_KEYS.filter(
  (key) => typeof ("" as any)[key] !== "function"
);

class PphpHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const wr = document.getWordRangeAtPosition(
      position,
      /(pphp|store|searchParams)\.(\w+)/
    );
    if (!wr) {
      return;
    }
    const text = document.getText(wr);
    const [, varName, methodName] = text.match(
      /(pphp|store|searchParams)\.(\w+)/
    )! as [string, VarName, string];
    const cls = classNameMap[varName];
    const entry = classStubs[cls].find((e) => e.name === methodName);
    if (!entry) {
      return;
    }

    // show the full signature in a markdown hover
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
    // look backwards to see if we’re in a pphp.*(…) call
    const line = document
      .lineAt(position.line)
      .text.slice(0, position.character);
    const m = /(pphp|store|searchParams)\.(\w+)\($/.exec(line);
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

function parseGlobalsWithTS(source: string) {
  const sf = ts.createSourceFile(
    "mustache.d.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  globalStubs = {};

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
          // collect all the property names
          globalStubs[name] = type.members
            .filter(ts.isPropertySignature)
            .map((ps) => (ps.name as ts.Identifier).text);
        } else {
          globalStubs[name] = [];
        }
      }
    }
  });
}

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

function splitArgs(str: string): string[] {
  const out: string[] = [];
  let buf = "";
  let level = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "{" || ch === "(" || ch === "[") {
      level++;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      level--;
    }

    if (ch === "," && level === 0) {
      out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }

  if (buf.trim() !== "") {
    out.push(buf.trim());
  }
  return out;
}

function validatePphpCalls(
  document: vscode.TextDocument,
  diagCollection: vscode.DiagnosticCollection
) {
  const original = document.getText();
  const text = sanitizeForDiagnostics(original);
  const diags: vscode.Diagnostic[] = [];

  // match pphp.foo(arg1, arg2, …)
  const callRe = /\b(pphp|store|searchParams)\.(\w+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text))) {
    const [, varName, methodName, argsText] = m as unknown as [
      string,
      VarName,
      string,
      string
    ];
    const classNameMap: Record<VarName, keyof typeof classStubs> = {
      pphp: "PPHP",
      store: "PPHPLocalStore",
      searchParams: "SearchParamsManager",
    };
    const stubList = classStubs[classNameMap[varName]];
    const entry = stubList.find((e) => e.name === methodName);
    if (!entry) {
      continue;
    }

    // extract the parameter list from the signature string
    // e.g. "fetchFunction(functionName: string, data?: Record<string, any>, abortPrevious?: boolean)"
    const paramsPart = entry.signature.replace(/^[^(]+\(([^)]*)\):.*$/, "$1");
    const expectedParams = paramsPart
      .split(",")
      .map((p) => p.trim())
      .filter((p) => !!p);

    // count what the user actually passed
    const passedCount = argsText.trim() === "" ? 0 : splitArgs(argsText).length;

    // figure out how many *required* parameters there are
    const requiredCount = expectedParams.filter((p) => !p.includes("?")).length;

    if (passedCount < requiredCount || passedCount > expectedParams.length) {
      // figure out where in the document this call happened
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

function createPrismaFieldProvider({
  callRegex,
  optionalLabel,
  requiredLabel,
  triggerChars,
}: PrismaFieldProviderConfig) {
  return vscode.languages.registerCompletionItemProvider(
    "php",
    {
      async provideCompletionItems(doc, pos) {
        const before = doc.getText(
          new vscode.Range(new vscode.Position(0, 0), pos)
        );

        // 1️⃣ grab what they’ve already typed in the quoted key
        const quoteMatch = /['"]([\w]*)$/.exec(before);
        if (!quoteMatch) {
          return;
        }
        const alreadyTyped = quoteMatch[1];

        // bail if they just typed the => already
        if (
          /\=>\s*$/.test(
            before.slice(Math.max(0, quoteMatch.index - 5), quoteMatch.index)
          )
        ) {
          return;
        }

        // 2️⃣ only look *before* that key for your callRegex
        const sliceUpToKeyStart = before.slice(0, quoteMatch.index);
        const all = [...sliceUpToKeyStart.matchAll(callRegex)];
        if (!all.length) {
          return;
        }
        const modelName = all[all.length - 1][1];
        const fields = (await getModelMap()).get(modelName.toLowerCase());
        if (!fields) {
          return;
        }

        // 3️⃣ detect quote style & whether there's already a closing quote
        const quote = /["']$/.exec(before)?.[0] ?? "'";
        const nextChar = doc.getText(
          new vscode.Range(pos, pos.translate(0, 1))
        );
        const hasClose = nextChar === quote;

        // helper to format the type
        const fmt = (f: FieldInfo) =>
          `${f.type}${f.isList ? "[]" : ""}${f.nullable ? " | null" : ""}`;

        // 4️⃣ finally build your CompletionItems
        return [...fields.entries()].map(([name, info]) => {
          const isOptional = !info.required;
          const label: vscode.CompletionItemLabel = {
            label: isOptional ? `${name}?` : name,
            detail: `: ${fmt(info)}`,
          };

          const item = new vscode.CompletionItem(
            label,
            vscode.CompletionItemKind.Field
          );
          item.documentation = new vscode.MarkdownString(
            `\`${label.label}${label.detail}\`\n\n` +
              (isOptional ? optionalLabel : requiredLabel)
          );

          // use what they’d already typed to compute the replace range
          const start = pos.translate(0, -alreadyTyped.length - 1);
          const end = hasClose ? pos.translate(0, 1) : pos;
          item.range = new vscode.Range(start, end);

          item.insertText = new vscode.SnippetString(
            `${quote}${name}${quote} => $0`
          );
          item.sortText = `0_${name}`;
          item.filterText = `${quote}${name}`;

          return item;
        });
      },
    },
    ...triggerChars
  );
}

/* ────────────────────────────────────────────────────────────── *
 *                       EXTENSION ACTIVATION                       *
 * ────────────────────────────────────────────────────────────── */

export async function activate(context: vscode.ExtensionContext) {
  // ── 0️⃣  Make sure we’re in a workspace ─────────────────────────
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return; // no folder → bail out silently
  }

  // ── 1️⃣  Check every root for prisma-php.json ───────────────────
  const isPrismaPhpProject = await Promise.any(
    folders.map(async (folder) => {
      try {
        const uri = vscode.Uri.joinPath(folder.uri, "prisma-php.json");
        await vscode.workspace.fs.stat(uri); // throws if it doesn’t exist
        return true; // found → good
      } catch {
        return false; // not here → keep looking
      }
    })
  ).catch(() => false); // all threw → false

  if (!isPrismaPhpProject) {
    return; // not a Prisma PHP project
  }

  console.log("PHPX tag support is now active!");

  activateNativeJsHelp(context);

  // instead of context.asAbsolutePath:
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    console.warn("No workspace!");
    return;
  }

  // build the *project*-relative path
  const globalStubFsPath = path.join(
    wsFolder.uri.fsPath,
    ".pphp",
    "phpx-mustache.d.ts"
  );

  let globalsText = "";
  try {
    globalsText = fs.readFileSync(globalStubFsPath, "utf8");
  } catch (err) {
    console.error(`couldn't load mustache stubs from ${globalStubFsPath}`, err);
  }

  parseGlobalsWithTS(globalsText);

  // watch for changes to your mustache stub
  const stubPattern = new vscode.RelativePattern(
    wsFolder, // whatever you used for your workspace folder
    ".pphp/phpx-mustache.d.ts"
  );
  const stubWatcher = vscode.workspace.createFileSystemWatcher(stubPattern);
  stubWatcher.onDidChange(async (uri) => {
    // 1) re-read & re-parse into `globalStubs`
    const data = await vscode.workspace.fs.readFile(uri);
    parseGlobalsWithTS(data.toString());

    // 2) tell the TS server to reload all .d.ts files
    await vscode.commands.executeCommand("typescript.restartTsServer");
  });
  stubWatcher.onDidCreate(async (uri) => {
    // Reuse the logic from onDidChange
    const data = await vscode.workspace.fs.readFile(uri);
    parseGlobalsWithTS(data.toString());
    await vscode.commands.executeCommand("typescript.restartTsServer");
  });
  stubWatcher.onDidDelete(() => {
    globalStubs = {};
    vscode.commands.executeCommand("typescript.restartTsServer");
  });
  context.subscriptions.push(stubWatcher);

  const stubPath = context.asAbsolutePath("resources/types/pphp.d.txt");
  const stubText = fs.readFileSync(stubPath, "utf8");
  parseStubsWithTS(stubText);

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
      "," // trigger on open-paren and comma
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      PHP_LANGUAGE,
      new ImportComponentCodeActionProvider(),
      { providedCodeActionKinds: [CodeActionKind.QuickFix] }
    )
  );

  // Load the dynamic components from class-log.json.
  loadComponentsFromClassLog();

  // watch for changes to class‑log.json
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.workspace.workspaceFolders![0],
      "settings/class-log.json"
    )
  );
  watcher.onDidChange(() => loadComponentsFromClassLog());
  watcher.onDidCreate(() => loadComponentsFromClassLog());
  watcher.onDidDelete(() => componentsCache.clear());
  context.subscriptions.push(watcher);

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
    });
  const nativePropertyDecorationType =
    vscode.window.createTextEditorDecorationType({
      color: NATIVE_PROP_COLOR,
    });

  const pphpSigDiags =
    vscode.languages.createDiagnosticCollection("pphp-signatures");
  context.subscriptions.push(pphpSigDiags);

  // ③ *** register your mustache‐stub completion provider here ***
  const selector: vscode.DocumentSelector = [
    { language: "php" },
    { language: "javascript" },
    { language: "typescript" },
  ];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems(doc, pos) {
          /* ① grab `root` + current `partial` --------------------------- */
          const line = doc.lineAt(pos.line).text;
          const uptoCursor = line.slice(0, pos.character);
          const lastOpen = uptoCursor.lastIndexOf("{{");
          const exprPrefix = uptoCursor.slice(lastOpen + 2); // «user.na»

          const m = /([A-Za-z_$][\w$]*)\.\s*(\w*)$/.exec(exprPrefix);
          if (!m) {
            return;
          }

          const [, root, partial] = m; // root = "user"
          const stubProps = globalStubs[root] ?? [];

          /* ② build the list – project props first ---------------------- */
          const out: vscode.CompletionItem[] = [];
          const seen = new Set<string>();

          for (const p of stubProps.filter((p) => p.startsWith(partial))) {
            const it = new vscode.CompletionItem(
              p,
              vscode.CompletionItemKind.Property
            );
            it.sortText = "0_" + p; // before natives
            out.push(it);
            seen.add(p);
          }

          /* ③ add JS native members *only* for “scalar” stubs ----------- */
          const treatAsScalar = stubProps.length <= 1; // length │ 0 props

          if (treatAsScalar) {
            for (const k of JS_NATIVE_MEMBERS) {
              if (!k.startsWith(partial) || seen.has(k)) {
                continue;
              }

              const kind =
                typeof ("" as any)[k] === "function"
                  ? vscode.CompletionItemKind.Method
                  : vscode.CompletionItemKind.Property;

              const it = new vscode.CompletionItem(k, kind);
              if (kind === vscode.CompletionItemKind.Method) {
                it.insertText = new vscode.SnippetString(`${k}()$0`);
              }
              it.sortText = "1_" + k; // after project members
              out.push(it);
            }
          }

          return out;
        },
      },
      "." // trigger character
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems(document, position) {
        const line = document
          .lineAt(position.line)
          .text.slice(0, position.character);

        // 1️⃣ property‐level: foo.partial → props[foo]
        const propMatch = /([A-Za-z_$]\w*)\.(\w*)$/.exec(line);
        if (propMatch) {
          const [, root, partial] = propMatch;
          const props = globalStubs[root] || [];
          return props
            .filter((p) => p.startsWith(partial))
            .map(
              (p) =>
                new vscode.CompletionItem(p, vscode.CompletionItemKind.Property)
            );
        }

        // 2️⃣ root‐level: partial → variable names
        const rootMatch = /([A-Za-z_$]\w*)$/.exec(line);
        if (rootMatch) {
          const prefix = rootMatch[1];
          return Object.keys(globalStubs)
            .filter((v) => v.startsWith(prefix))
            .map(
              (v) =>
                new vscode.CompletionItem(v, vscode.CompletionItemKind.Variable)
            );
        }

        return undefined;
      },
    })
  );

  /* ---------------- live pphp.foo(...) validation ---------------- */

  const pendingTimers = new Map<string, NodeJS.Timeout>();

  function schedulePphpValidation(doc: vscode.TextDocument) {
    if (doc.languageId !== PHP_LANGUAGE) {
      return;
    }

    // one timer per document
    const key = doc.uri.toString();
    clearTimeout(pendingTimers.get(key));

    pendingTimers.set(
      key,
      setTimeout(() => {
        validatePphpCalls(doc, pphpSigDiags);
        pendingTimers.delete(key);
      }, 150) // 150 ms feels snappy without being heavy
    );
  }

  // ── unified Prisma field‐completion ───────────────────────────
  function registerPrismaFieldProvider() {
    // 1️⃣ list your Prisma ops in one place
    const prismaOps = [
      "create",
      "findMany",
      "findFirst",
      "findUnique",
      "update",
      "delete",
      // …you can add more here later
    ];

    // 2️⃣ build a `foo|bar|baz` alternation for your regex
    const opsPattern = prismaOps.join("|");

    // 3️⃣ construct the RegExp once, from the dynamic ops list
    //    — note we double-escape backslashes in a string literal
    const invocationRe = new RegExp(
      "\\$prisma->([A-Za-z_]\\w*)" + // capture the model name
        "->(" +
        opsPattern +
        ")\\(" + // capture the op (from your array)
        "[\\s\\S]*?['\"]" + // anything up to a quoted data|where
        "(data|where)['\"]\\s*=>\\s*\\[\\s*['\"]" + // capture which block
        "([\\w]*)$" // capture what they’ve already typed
    );

    return vscode.languages.registerCompletionItemProvider(
      "php",
      {
        async provideCompletionItems(doc, pos) {
          const before = doc.getText(
            new vscode.Range(0, 0, pos.line, pos.character)
          );

          // only look at the very last "$prisma->…" so you don't accidentally match earlier calls
          const tail = before.slice(before.lastIndexOf("$prisma->"));
          const m = invocationRe.exec(tail);
          if (!m) {
            return;
          }

          // [ fullMatch, modelName, op, blockKey, alreadyTyped ]
          const [, modelName, op, blockKey, alreadyTyped] = m;

          // …the rest of your logic is unchanged
          const map = await getModelMap();
          const fields = map.get(modelName.toLowerCase());
          if (!fields) {
            return;
          }

          const isWhere = blockKey === "where";
          const optionalLabel = isWhere
            ? "*optional filter*"
            : "*optional field*";
          const requiredLabel = isWhere
            ? "*required filter*"
            : "*required field*";

          const quote = /["']$/.exec(tail)?.[0] ?? "'";
          const nextChar = doc.getText(
            new vscode.Range(pos, pos.translate(0, 1))
          );
          const hasClose = nextChar === quote;

          const fmt = (f: FieldInfo) =>
            `${f.type}${f.isList ? "[]" : ""}${f.nullable ? " | null" : ""}`;

          return [...fields.entries()].map(([name, info]) => {
            const optional = !info.required;
            const label: vscode.CompletionItemLabel = {
              label: optional ? `${name}?` : name,
              detail: `: ${fmt(info)}`,
            };

            const item = new vscode.CompletionItem(
              label,
              vscode.CompletionItemKind.Field
            );
            item.documentation = new vscode.MarkdownString(
              `\`${label.label}${label.detail}\`\n\n` +
                (optional ? optionalLabel : requiredLabel)
            );

            const replaceStart = pos.translate(0, -alreadyTyped.length - 1);
            const replaceEnd = hasClose ? pos.translate(0, 1) : pos;
            item.range = new vscode.Range(replaceStart, replaceEnd);

            item.insertText = new vscode.SnippetString(
              `${quote}${name}${quote} => $0`
            );
            item.sortText = `0_${name}`;
            item.filterText = `${quote}${name}`;

            return item;
          });
        },
      },
      "'",
      `"` // trigger only inside quotes
    );
  }

  context.subscriptions.push(
    stringDecorationType,
    numberDecorationType,
    templateLiteralDecorationType,
    registerPrismaFieldProvider()
  );

  const createDiags =
    vscode.languages.createDiagnosticCollection("prisma-create");
  const readDiags = vscode.languages.createDiagnosticCollection("prisma-read");
  const updateDiags =
    vscode.languages.createDiagnosticCollection("prisma-update");
  const deleteDiags =
    vscode.languages.createDiagnosticCollection("prisma-delete");

  // Combined update validations function.
  const updateAllValidations = async (document: vscode.TextDocument) => {
    schedulePphpValidation(document);
    await validateCreateCall(document, createDiags);
    await validateReadCall(document, readDiags);
    await validateUpdateCall(document, updateDiags);
    await validateDeleteCall(document, deleteDiags);
    updateJsVariableDecorations(document, braceDecorationType);
    updateStringDecorations(document);
    validateJsVariablesInCurlyBraces(document, jsVarDiagnostics);
    updateNativeTokenDecorations(
      document,
      nativeFunctionDecorationType,
      nativePropertyDecorationType
    );
    validateMissingImports(document, diagnosticCollection);
  };

  context.subscriptions.push(objectPropertyDecorationType);

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

  vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      if (editor) {
        validatePphpCalls(editor.document, pphpSigDiags);
        updateAllValidations(editor.document);
      }
    },
    null,
    context.subscriptions
  );

  vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.languageId === "php") {
      rebuildMustacheStub(doc);
    }
  });
}

/* ────────────────────────────────────────────────────────────── *
 *                 Native‑JS hover & signature‑help               *
 * ────────────────────────────────────────────────────────────── */

export interface FieldInfo {
  type: string; // "String" | "Int" | ...
  required: boolean;
  isList: boolean;
  nullable: boolean;
}

export type ModelMap = Map<string, Map<string, FieldInfo>>; // model → field → info
let cache: ModelMap | null = null;

export async function getModelMap(): Promise<ModelMap> {
  if (cache) {
    return cache;
  }

  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    return new Map();
  }

  const uri = vscode.Uri.joinPath(ws.uri, "settings", "prisma-schema.json");
  const raw = await vscode.workspace.fs.readFile(uri);
  const dmmf = JSON.parse(Buffer.from(raw).toString("utf8"));

  cache = new Map();

  for (const model of dmmf.datamodel.models) {
    const fields = new Map<string, FieldInfo>();
    for (const f of model.fields) {
      fields.set(f.name, {
        type: f.type,
        required: !f.isNullable && !f.hasDefaultValue && !f.relationName,
        isList: f.isList,
        nullable: f.isNullable,
      });
    }
    cache.set(model.name.toLowerCase(), fields); // user → …
  }
  return cache;
}

// at top‐of‐file, or wherever you keep your constants:
const phpDataTypes: Record<string, string[]> = {
  String: ["string"],
  Int: ["int"],
  Boolean: ["bool"],
  Float: ["float"],
  BigInt: ["BigInteger", "int"],
  Decimal: ["BigDecimal", "float"],
  DateTime: ["DateTime", "string"],
  Json: ["array", "string"],
  Bytes: ["string"],
  Enum: ["enum", "string"],
};

export async function validateCreateCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const text = doc.getText();
  const diags: vscode.Diagnostic[] = [];

  // 1️⃣ Match every $prisma->Model->create([ … ])
  const callRe = /\$prisma->(\w+)->create\(\s*\[([\s\S]*?)\]\s*\)/g;
  let m: RegExpExecArray | null;
  const modelMap = await getModelMap();

  while ((m = callRe.exec(text))) {
    const [fullMatch, modelName, argsLiteral] = m;
    const fields = modelMap.get(modelName.toLowerCase());
    if (!fields) {
      continue;
    }

    // Range of the entire create(...) call
    const callStart = doc.positionAt(m.index);
    const callEnd = doc.positionAt(m.index + fullMatch.length);
    const callRange = new vscode.Range(callStart, callEnd);

    // 2️⃣ If there's no 'data' => [...] at all, emit a single error
    if (!/['"]data['"]\s*=>\s*\[/.test(argsLiteral)) {
      diags.push(
        new vscode.Diagnostic(
          callRange,
          `create() requires a 'data' block.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue; // skip the per-field pass
    }

    // 3️⃣ Otherwise extract the data literal and run your existing checks
    const dataMatch = /['"]data['"]\s*=>\s*\[([\s\S]*?)\]/m.exec(argsLiteral)!;
    const dataLiteral = dataMatch[1];
    const dataOffset =
      m.index +
      fullMatch.indexOf(dataMatch[0]) +
      dataMatch[0].indexOf(dataLiteral);

    const fieldRe = /['"](\w+)['"]\s*=>\s*([^,\]\r\n]+)/g;
    let f: RegExpExecArray | null;

    while ((f = fieldRe.exec(dataLiteral))) {
      const [, key, rawValue] = f;
      const info = fields.get(key);

      const start = doc.positionAt(dataOffset + f.index);
      const range = new vscode.Range(start, start.translate(0, key.length));

      // a) unknown column
      if (!info) {
        diags.push(
          new vscode.Diagnostic(
            range,
            `The column "${key}" does not exist in ${modelName}.`,
            vscode.DiagnosticSeverity.Error
          )
        );
        continue;
      }

      // b) type‐check against phpDataTypes
      const expr = rawValue.trim();
      const allowed = phpDataTypes[info.type] ?? [];
      const isString = /^['"]/.test(expr);
      const isNumber = /^-?\d+(\.\d+)?$/.test(expr);
      const isBool = /^(true|false)$/i.test(expr);
      const isArray = /^\[.*\]$/.test(expr);
      const isVar = /^\$[A-Za-z_]\w*/.test(expr);
      const isFnCall = /^\s*(?:new\s+[A-Za-z_]\w*|\w+)\s*\(.*\)\s*$/.test(expr);

      const typeOK = allowed.some((t) => {
        switch (t) {
          case "string":
            return isString || isVar;
          case "int":
            return isNumber && !expr.includes(".");
          case "float":
            return isNumber;
          case "bool":
            return isBool;
          case "array":
            return isArray;
          case "DateTime":
            return (
              /^new\s+DateTime/.test(expr) || isFnCall || isString || isVar
            );
          case "BigInteger":
          case "BigDecimal":
            return isFnCall;
          case "enum":
            return isString;
          default:
            return isFnCall;
        }
      });

      if (!typeOK) {
        const expected = info.isList ? `${info.type}[]` : info.type;
        diags.push(
          new vscode.Diagnostic(
            range,
            `"${key}" expects ${expected}, but received "${expr}".`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    }
  }

  collection.set(doc.uri, diags);
}

/**
 * Validate $prisma->X->find*(…) calls by checking
 * each `where: [ key => value ]` against your Prisma schema.
 */
export async function validateReadCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const text = doc.getText();
  const diags: vscode.Diagnostic[] = [];

  // match e.g. $prisma->user->findMany([ … ]), findFirst, or findUnique
  const readRe =
    /\$prisma->(\w+)->(findMany|findFirst|findUnique)\(\s*\[([\s\S]*?)\]\s*\)/g;
  let m: RegExpExecArray | null;
  const modelMap = await getModelMap();

  while ((m = readRe.exec(text))) {
    const [fullMatch, modelName, op, argsLiteral] = m;
    const fields = modelMap.get(modelName.toLowerCase());
    if (!fields) {
      continue;
    }

    // range covering the entire call
    const callStart = doc.positionAt(m.index);
    const callEnd = doc.positionAt(m.index + fullMatch.length);
    const callRange = new vscode.Range(callStart, callEnd);

    // look for a 'where' => [ … ] block
    const whereMatch = /['"]where['"]\s*=>\s*\[([\s\S]*?)\](?=,|\s*$)/m.exec(
      argsLiteral
    );

    // ◼︎ if it's a findUnique and there's no where => […], that's an error
    if (op === "findUnique" && !whereMatch) {
      diags.push(
        new vscode.Diagnostic(
          callRange,
          `findUnique() requires a 'where' block.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }

    // otherwise, if there's no where at all (for findMany/findFirst), skip checks
    if (!whereMatch) {
      continue;
    }

    // pull out the actual contents of the where array
    const whereLiteral = whereMatch[1];
    // compute its offset in the full document
    const baseOffset =
      m.index +
      fullMatch.indexOf(whereMatch[0]) +
      whereMatch[0].indexOf(whereLiteral);

    // iterate each `'key' => value` inside that block
    const fieldRe = /['"](\w+)['"]\s*=>\s*([^,\]\r\n]+)/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(whereLiteral))) {
      const [, key, rawValue] = f;
      const info = fields.get(key);

      // build a diagnostic range pointing at the key
      const start = doc.positionAt(baseOffset + f.index);
      const range = new vscode.Range(start, start.translate(0, key.length));

      // 1) unknown field?
      if (!info) {
        diags.push(
          new vscode.Diagnostic(
            range,
            `The column "${key}" does not exist in ${modelName}.`,
            vscode.DiagnosticSeverity.Error
          )
        );
        continue;
      }

      // 2) type‐check against your phpDataTypes map
      const expr = rawValue.trim();
      const allowed = phpDataTypes[info.type] ?? [];
      const isString = /^['"]/.test(expr);
      const isNumber = /^-?\d+(\.\d+)?$/.test(expr);
      const isBool = /^(true|false)$/i.test(expr);
      const isArray = /^\[.*\]$/.test(expr);
      const isVar = /^\$[A-Za-z_]\w*/.test(expr);
      const isFnCall = /^\s*(?:new\s+[A-Za-z_]\w*|\w+)\s*\(.*\)\s*$/.test(expr);

      const typeOK = allowed.some((t) => {
        switch (t) {
          case "string":
            return isString || isVar;
          case "int":
            return isNumber && !expr.includes(".");
          case "float":
            return isNumber;
          case "bool":
            return isBool;
          case "array":
            return isArray;
          case "DateTime":
            return (
              /^new\s+DateTime/.test(expr) || isFnCall || isString || isVar
            );
          case "BigInteger":
          case "BigDecimal":
            return isFnCall;
          case "enum":
            return isString;
          default:
            return isFnCall;
        }
      });

      if (!typeOK) {
        const expected = info.isList ? `${info.type}[]` : info.type;
        diags.push(
          new vscode.Diagnostic(
            range,
            `"${key}" expects ${expected}, but received "${expr}".`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    }
  }

  collection.set(doc.uri, diags);
}

/**
 * Validate $prisma->X->update([...]) calls:
 *  – the `data` block exactly like create
 *  – the `where` block exactly like find*
 */
export async function validateUpdateCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const text = doc.getText();
  const diags: vscode.Diagnostic[] = [];
  const updateRe = /\$prisma->(\w+)->update\(\s*\[([\s\S]*?)\]\s*\)/g;
  let m: RegExpExecArray | null;
  const modelMap = await getModelMap();

  while ((m = updateRe.exec(text))) {
    const [fullMatch, modelName, argsLiteral] = m;
    const fields = modelMap.get(modelName.toLowerCase());
    if (!fields) {
      continue;
    }

    // compute the Range of the entire update(...) call
    const callStart = doc.positionAt(m.index);
    const callEnd = doc.positionAt(m.index + fullMatch.length);
    const callRange = new vscode.Range(callStart, callEnd);

    // find 'data' and 'where' clauses
    const dataMatch = /['"]data['"]\s*=>\s*\[([\s\S]*?)\]/m.exec(argsLiteral);
    const whereMatch = /['"]where['"]\s*=>\s*\[([\s\S]*?)\]/m.exec(argsLiteral);

    // ❗ require both
    if (!dataMatch || !whereMatch) {
      const missing = [
        !dataMatch ? "'data'" : null,
        !whereMatch ? "'where'" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      diags.push(
        new vscode.Diagnostic(
          callRange,
          `update() requires both ${missing} blocks.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue; // skip per-field checks if one is missing
    }

    // base offset for inner slices
    const baseOffset = m.index + fullMatch.indexOf(argsLiteral);

    // ── 1) validate `data` just like create ──────────────────────
    {
      const dataLiteral = dataMatch[1];
      const dataOffset =
        baseOffset +
        argsLiteral.indexOf(dataMatch[0]) +
        dataMatch[0].indexOf(dataLiteral);

      const fieldRe = /['"](\w+)['"]\s*=>\s*([^,\]\r\n]+)/g;
      let f: RegExpExecArray | null;
      while ((f = fieldRe.exec(dataLiteral))) {
        const [, key, rawValue] = f;
        const info = fields.get(key);
        const start = doc.positionAt(dataOffset + f.index);
        const range = new vscode.Range(start, start.translate(0, key.length));

        if (!info) {
          diags.push(
            new vscode.Diagnostic(
              range,
              `The column "${key}" does not exist in ${modelName}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        // your phpDataTypes-based type check here…
        const expr = rawValue.trim();
        const allowed = phpDataTypes[info.type] ?? [];
        const isString = /^['"]/.test(expr);
        const isNumber = /^-?\d+(\.\d+)?$/.test(expr);
        const isBool = /^(true|false)$/i.test(expr);
        const isArray = /^\[.*\]$/.test(expr);
        const isVar = /^\$[A-Za-z_]\w*/.test(expr);
        const isFnCall = /^\s*(?:new\s+[A-Za-z_]\w*|\w+)\s*\(.*\)\s*$/.test(
          expr
        );

        const typeOK = allowed.some((t) => {
          switch (t) {
            case "string":
              return isString || isVar;
            case "int":
              return isNumber && !expr.includes(".");
            case "float":
              return isNumber;
            case "bool":
              return isBool;
            case "array":
              return isArray;
            case "DateTime":
              return (
                /^new\s+DateTime/.test(expr) || isFnCall || isString || isVar
              );
            case "BigInteger":
            case "BigDecimal":
              return isFnCall;
            case "enum":
              return isString;
            default:
              return isFnCall;
          }
        });

        if (!typeOK) {
          const expected = info.isList ? `${info.type}[]` : info.type;
          diags.push(
            new vscode.Diagnostic(
              range,
              `"${key}" expects ${expected}, but received "${expr}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }

    // ── 2) validate `where` just like read ──────────────────────
    {
      const whereLiteral = whereMatch[1];
      const whereOffset =
        baseOffset +
        argsLiteral.indexOf(whereMatch[0]) +
        whereMatch[0].indexOf(whereLiteral);

      const fieldRe = /['"](\w+)['"]\s*=>\s*([^,\]\r\n]+)/g;
      let f: RegExpExecArray | null;
      while ((f = fieldRe.exec(whereLiteral))) {
        const [, key, rawValue] = f;
        const info = fields.get(key);
        const start = doc.positionAt(whereOffset + f.index);
        const range = new vscode.Range(start, start.translate(0, key.length));

        if (!info) {
          diags.push(
            new vscode.Diagnostic(
              range,
              `The column "${key}" does not exist in ${modelName}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        // same type-check as above
        const expr = rawValue.trim();
        const allowed = phpDataTypes[info.type] ?? [];
        const isString = /^['"]/.test(expr);
        const isNumber = /^-?\d+(\.\d+)?$/.test(expr);
        const isBool = /^(true|false)$/i.test(expr);
        const isArray = /^\[.*\]$/.test(expr);
        const isVar = /^\$[A-Za-z_]\w*/.test(expr);
        const isFnCall = /^\s*(?:new\s+[A-Za-z_]\w*|\w+)\s*\(.*\)\s*$/.test(
          expr
        );

        const typeOK = allowed.some((t) => {
          switch (t) {
            case "string":
              return isString || isVar;
            case "int":
              return isNumber && !expr.includes(".");
            case "float":
              return isNumber;
            case "bool":
              return isBool;
            case "array":
              return isArray;
            case "DateTime":
              return (
                /^new\s+DateTime/.test(expr) || isFnCall || isString || isVar
              );
            case "BigInteger":
            case "BigDecimal":
              return isFnCall;
            case "enum":
              return isString;
            default:
              return isFnCall;
          }
        });

        if (!typeOK) {
          const expected = info.isList ? `${info.type}[]` : info.type;
          diags.push(
            new vscode.Diagnostic(
              range,
              `"${key}" expects ${expected}, but received "${expr}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }
  }

  collection.set(doc.uri, diags);
}

export async function validateDeleteCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const text = doc.getText();
  const diags: vscode.Diagnostic[] = [];
  const deleteRe = /\$prisma->(\w+)->delete\(\s*\[([\s\S]*?)\]\s*\)/g;
  let m: RegExpExecArray | null;
  const modelMap = await getModelMap();

  while ((m = deleteRe.exec(text))) {
    const [fullMatch, modelName, argsLiteral] = m;
    const fields = modelMap.get(modelName.toLowerCase());
    if (!fields) {
      continue;
    }

    // range covering the entire delete(...) call
    const callStart = doc.positionAt(m.index);
    const callEnd = doc.positionAt(m.index + fullMatch.length);
    const callRange = new vscode.Range(callStart, callEnd);

    // ❌ require a 'where' => [ … ]
    if (!/['"]where['"]\s*=>\s*\[/.test(argsLiteral)) {
      diags.push(
        new vscode.Diagnostic(
          callRange,
          `delete() requires a 'where' block.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }

    // extract the inside of where => [ … ]
    const whereMatch = /['"]where['"]\s*=>\s*\[([\s\S]*?)\]/m.exec(
      argsLiteral
    )!;
    const whereLiteral = whereMatch[1];
    const whereOffset =
      m.index +
      fullMatch.indexOf(whereMatch[0]) +
      whereMatch[0].indexOf(whereLiteral);

    // same per-field checks as read/update
    const fieldRe = /['"](\w+)['"]\s*=>\s*([^,\]\r\n]+)/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(whereLiteral))) {
      const [, key, rawValue] = f;
      const info = fields.get(key);
      const start = doc.positionAt(whereOffset + f.index);
      const range = new vscode.Range(start, start.translate(0, key.length));

      if (!info) {
        diags.push(
          new vscode.Diagnostic(
            range,
            `The column "${key}" does not exist in ${modelName}.`,
            vscode.DiagnosticSeverity.Error
          )
        );
        continue;
      }

      // type‐check against phpDataTypes (just copy your existing logic here)
      const expr = rawValue.trim();
      const allowed = phpDataTypes[info.type] ?? [];
      const isString = /^['"]/.test(expr);
      const isNumber = /^-?\d+(\.\d+)?$/.test(expr);
      const isBool = /^(true|false)$/i.test(expr);
      const isArray = /^\[.*\]$/.test(expr);
      const isVar = /^\$[A-Za-z_]\w*/.test(expr);
      const isFnCall = /^\s*(?:new\s+[A-Za-z_]\w*|\w+)\s*\(.*\)\s*$/.test(expr);

      const typeOK = allowed.some((t) => {
        switch (t) {
          case "string":
            return isString || isVar;
          case "int":
            return isNumber && !expr.includes(".");
          case "float":
            return isNumber;
          case "bool":
            return isBool;
          case "array":
            return isArray;
          case "DateTime":
            return (
              /^new\s+DateTime/.test(expr) || isFnCall || isString || isVar
            );
          case "BigInteger":
          case "BigDecimal":
            return isFnCall;
          case "enum":
            return isString;
          default:
            return isFnCall;
        }
      });

      if (!typeOK) {
        const expected = info.isList ? `${info.type}[]` : info.type;
        diags.push(
          new vscode.Diagnostic(
            range,
            `"${key}" expects ${expected}, but received "${expr}".`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    }
  }

  collection.set(doc.uri, diags);
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

/** Build (or return) the info for a given member name */
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
  // ── Hover inside {{ … }} ─────────────────────────────────────
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

  // ── Signature‑help: foo.substring(|) ─────────────────────────
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

          /* which arg? – count commas since the last '(' */
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
      "(", // trigger when user types “(”
      "," // update on “,”
    )
  );
}

/* ────────────────────────────────────────────────────────────── *
 *                    EDITOR CONFIGURATION UPDATE                   *
 * ────────────────────────────────────────────────────────────── */

/* ── 0️⃣  A flat list of native members you want to offer ───────────── */
const JS_NATIVE_MEMBERS = [
  ...NATIVE_STRING_METHODS,
  ...NATIVE_STRING_PROPS,
  ...Object.getOwnPropertyNames(Array.prototype),
  ...Object.getOwnPropertyNames(Number.prototype),
  ...Object.getOwnPropertyNames(Boolean.prototype),
].filter((k) => /^[a-z]/i.test(k)); // ignore the weird symbols

/* ── 1️⃣  Utility: is the position inside an *open* {{ … }} pair? ───── */
function insideMustache(
  doc: vscode.TextDocument,
  pos: vscode.Position
): boolean {
  const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), pos));
  const open = before.lastIndexOf("{{");
  const close = before.lastIndexOf("}}");
  return open !== -1 && open > close;
}

function updateStringDecorations(document: vscode.TextDocument) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) {
    return;
  }
  const text = document.getText();
  const decos: vscode.DecorationOptions[] = [];
  let mustacheMatch: RegExpExecArray | null;
  // reuse your JS_EXPR_REGEX = /{{\s*(.*?)\s*}}/g
  while ((mustacheMatch = JS_EXPR_REGEX.exec(text))) {
    const inner = mustacheMatch[1];
    const baseOffset = mustacheMatch.index + mustacheMatch[0].indexOf(inner);
    // match single or double-quoted strings
    const stringRegex = /(['"])(?:(?=(\\?))\2.)*?\1/g;
    let strMatch: RegExpExecArray | null;
    while ((strMatch = stringRegex.exec(inner))) {
      const start = baseOffset + strMatch.index;
      const end = start + strMatch[0].length;
      decos.push({
        range: new vscode.Range(
          document.positionAt(start),
          document.positionAt(end)
        ),
      });
    }
  }
  editor.setDecorations(stringDecorationType, decos);
}

async function rebuildMustacheStub(document: TextDocument) {
  const text = document.getText();
  // match {{ … }} and capture only the leading identifier or dotted path
  const mustacheRe =
    /{{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[\s\S]*?}}/g;
  const map = new Map<string, Set<string>>();
  let m: RegExpExecArray | null;
  while ((m = mustacheRe.exec(text))) {
    const parts = m[1].split(".");
    const root = parts[0];
    const prop = parts[1];
    if (!map.has(root)) {
      map.set(root, new Set());
    }
    if (prop) {
      map.get(root)!.add(prop);
    }
  }

  const lines: string[] = [];
  for (const [root, props] of map) {
    if (props.size === 0) {
      lines.push(`declare var ${root}: any;`);
    } else {
      const entries = Array.from(props)
        .map((p) => `${p}: any`)
        .join(";\n  ");
      lines.push(`declare var ${root}: {
  ${entries};
  [key: string]: any;
};`);
    }
  }

  const stubUri = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders![0].uri,
    ".pphp",
    "phpx-mustache.d.ts"
  );
  await vscode.workspace.fs.writeFile(
    stubUri,
    Buffer.from(lines.join("\n\n") + "\n", "utf8")
  );
}

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
      async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
      ): Promise<vscode.CompletionItem[] | undefined> {
        const line = document.lineAt(position.line).text;
        const uptoCursor = line.slice(0, position.character);
        // grab *all* the text up to the cursor
        const fullBefore = document.getText(
          new vscode.Range(new vscode.Position(0, 0), position)
        );

        // ─── EARLY EXIT if *anywhere* above you did a `->prisma->…` chain
        if (/\$prisma->/.test(fullBefore)) {
          return [];
        }

        /* ⬅️  EARLY EXIT while user is still typing "<?php" or "<?="  */
        if (/^\s*<\?(?:php|=)?$/i.test(uptoCursor)) {
          return [];
        }

        // 0️⃣ Top-level variable suggestions ("pphp", "store", "searchParams")
        const varNames = ["pphp", "store", "searchParams"] as const;
        const prefixLine = line.match(/([A-Za-z_]*)$/)![1];
        if (prefixLine.length > 0) {
          const matches = varNames.filter((v) => v.startsWith(prefixLine));
          if (matches.length) {
            return matches.map((v) => {
              const item = new vscode.CompletionItem(
                v,
                vscode.CompletionItemKind.Variable
              );
              item.insertText = v;
              return item;
            });
          }
        }

        // 1️⃣ pphp|store|searchParams member completions
        const memberMatch = line.match(/(pphp|store|searchParams)\.\w*$/);
        if (memberMatch) {
          const varName = memberMatch[1] as VarName;
          const clsName = {
            pphp: "PPHP",
            store: "PPHPLocalStore",
            searchParams: "SearchParamsManager",
          }[varName] as keyof typeof classStubs;

          return classStubs[clsName].map((m) => {
            const kind = m.signature.includes("(")
              ? vscode.CompletionItemKind.Method
              : vscode.CompletionItemKind.Property;
            const item = new vscode.CompletionItem(m.name, kind);
            item.detail = m.signature;
            return item;
          });
        }

        // 2️⃣ Don’t fire inside "<?…"
        const prefix = prefixLine.substring(0, position.character);
        if (/^[ \t]*<\?[=a-z]*$/.test(prefix)) {
          return [];
        }

        // ────────── Bail out if inside a <script>…</script> block ──────────
        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const before = fullText.slice(0, offset);
        const scriptOpens = (before.match(/<script\b/gi) || []).length;
        const scriptCloses = (before.match(/<\/script>/gi) || []).length;
        if (scriptOpens > scriptCloses) {
          return [];
        }

        // ────────── Bail out if inside a mustache {{ … }} expression ──────────
        // (we just check whether the last "{{" before the cursor
        // is unmatched by a "}}" before it)
        const lastOpen = before.lastIndexOf("{{");
        const lastClose = before.lastIndexOf("}}");
        if (lastOpen > lastClose) {
          return [];
        }

        // 3️⃣ Load class-log and build component completions
        await loadComponentsFromClassLog();
        const completions: vscode.CompletionItem[] = [];

        // a) from explicit `use` statements
        const useMap = parsePhpUseStatements(document.getText());
        const lessThan = line.lastIndexOf("<", position.character);
        let replaceRange: vscode.Range | undefined;
        if (lessThan !== -1) {
          replaceRange = new vscode.Range(
            new vscode.Position(position.line, lessThan),
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
          item.range = replaceRange;
          completions.push(item);
        }

        // b) from class-log.json
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

        // 4️⃣ phpxclass snippet
        if (/^\s*phpx?c?l?a?s?s?$/i.test(prefixLine)) {
          // determine namespace placeholder
          const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
          const cfg = vscode.workspace.getConfiguration("phpx-tag-support");
          const sourceRoot = cfg.get<string>("sourceRoot", "src");
          let namespacePlaceholder: string;
          if (
            !document.isUntitled &&
            wsFolder &&
            document.uri.fsPath.endsWith(".php")
          ) {
            const fullFs = document.uri.fsPath;
            const fileDir = path.dirname(fullFs);
            const base = path.join(wsFolder.uri.fsPath, sourceRoot);
            const rel = path.relative(base, fileDir);
            const parts = rel
              .split(path.sep)
              .filter(Boolean)
              .map((seg) => seg.replace(/[^A-Za-z0-9_]/g, ""));
            namespacePlaceholder = parts.length
              ? parts.join("\\\\")
              : "${1:Lib\\\\PHPX\\\\Components}";
          } else {
            namespacePlaceholder = "${1:Lib\\\\PHPX\\\\Components}";
          }

          // determine class name placeholder
          let classNamePlaceholder: string;
          if (!document.isUntitled && document.uri.fsPath.endsWith(".php")) {
            classNamePlaceholder = path.basename(document.uri.fsPath, ".php");
          } else {
            classNamePlaceholder = "${2:ClassName}";
          }

          // snippet body
          const snippet = new vscode.SnippetString(
            `<?php

namespace ${namespacePlaceholder};

use Lib\\\\PHPX\\\\PHPX;

class ${classNamePlaceholder} extends PHPX
{
    public function __construct(array \\$props = [])
    {
        parent::__construct(\\$props);
    }

    public function render(): string
    {
        \\$attributes = \\$this->getAttributes();
        \\$class      = \\$this->getMergeClasses();

        return <<<HTML
        <div class="{\\$class}" {\\$attributes}>
            {\\$this->children}
        </div>
        HTML;
    }
}`
          );

          const start = position.translate(0, -prefixLine.trim().length);
          const item = new vscode.CompletionItem(
            "phpxclass",
            vscode.CompletionItemKind.Snippet
          );
          item.detail = "PHPX Class Template";
          item.insertText = snippet;
          item.range = new vscode.Range(start, position);
          completions.push(item);
        }

        return completions;
      },
    },
    ".",
    "p",
    "s",
    "_" // now fires on those keys too
  );
};

/* ────────────────────────────────────────────────────────────── *
 *                     HELPER: READ COMPONENTS FROM CLASS LOG       *
 * ────────────────────────────────────────────────────────────── */

/**
 * Converts fast-xml-parser error strings to simpler, IDE-friendly text.
 */
function prettifyXmlError(raw: string): string {
  // ①  Unclosed tag
  let m = /Expected closing tag '([^']+)'/.exec(raw);
  if (m) {
    return `Missing closing tag: </${m[1]}> is required to match an opening tag.`;
  }

  // ②  Attribute w/out value
  m = /attribute '([^']+)' is without value/i.exec(raw);
  if (m) {
    return `Attribute ${m[1]} needs a value (e.g. ${m[1]}="…")`;
  }

  // ③  Duplicate attribute
  m = /duplicate attribute '([^']+)'/i.exec(raw);
  if (m) {
    return `Attribute ${m[1]} is repeated`;
  }

  // ④  Boolean attribute no permitido
  m = /boolean attribute '([^']+)' is not allowed/i.exec(raw);
  if (m) {
    return `Attribute ${m[1]} must have a value ` + `(e.g. ${m[1]}="true")`;
  }

  // ④  Generic fallback
  return raw.replace(/^.*XML:?/i, "XML error:");
}

/* ────────────────────────────────────────────────────────────── *
 *                    XML & TAG PAIR DIAGNOSTICS                    *
 * ────────────────────────────────────────────────────────────── */

export const getFxpDiagnostics = (
  doc: vscode.TextDocument
): vscode.Diagnostic[] => {
  const raw = doc.getText();

  // 0️⃣ build a sanitized copy for both XML‐validation and our own searches
  const sanitized = sanitizeForDiagnosticsXML(raw);

  // 1️⃣ wrap & void void‐tags for the XML validator
  const voided = sanitized.replace(
    /<\s*(meta)\b([^>]*?)(?<!\/)>/gi,
    (_m, tag, attrs) => `<${tag}${attrs}/>`
  );
  const xml = `<__root>\n${voided}\n</__root>`;
  const res = XMLValidator.validate(xml);
  if (res === true) {
    return [];
  }

  // 2️⃣ extract parser error
  const { line, col, msg } = (res as any).err as {
    line: number;
    col: number;
    msg: string;
  };
  const pretty = prettifyXmlError(msg);

  // 3️⃣ map (line, col) → offset in `voided` → back into raw/sanitized
  const xmlLines = xml.split("\n");
  let xmlOffset = 0;
  for (let i = 0; i < line - 1; i++) {
    xmlOffset += xmlLines[i].length + 1;
  }
  xmlOffset += col - 1;
  const wrapIndex = xml.indexOf(voided);
  let errorOffset = xmlOffset - wrapIndex;
  errorOffset = Math.max(0, Math.min(errorOffset, raw.length - 1));

  // 4️⃣ special‐case attribute‐needs‐value
  const attrMatch = /^Attribute (\w+)/.exec(pretty);
  if (attrMatch) {
    const badAttr = attrMatch[1];
    const attrRe = new RegExp(`\\b${badAttr}\\b\\s*=`, "g");
    let bestIdx = -1;
    // search **sanitized** so we catch heredoc and other dynamic places
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
      // use the same offset in the real document
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

  // 5️⃣ otherwise it’s a missing‐closing‐tag—highlight exactly the unclosed opening
  let start = doc.positionAt(errorOffset);
  let end = start.translate(0, 1);
  let range = new vscode.Range(start, end);

  const closeMatch = /^Missing closing tag: <\/([^>]+)>/.exec(pretty);
  if (closeMatch) {
    const tag = closeMatch[1];
    // all `<tag...>` without a slash before `>`
    const openRe = new RegExp(`<${tag}\\b([^>]*?)(?<!\\/)\\>`, "g");
    const opens = Array.from(raw.matchAll(openRe), (m) => m.index!).sort(
      (a, b) => a - b
    );
    // all `</tag>`
    const closeRe = new RegExp(`</${tag}>`, "g");
    const closes = Array.from(raw.matchAll(closeRe), (m) => m.index!).sort(
      (a, b) => a - b
    );

    // pair closes off against opens
    const unmatched = [...opens];
    for (const c of closes) {
      for (let i = unmatched.length - 1; i >= 0; i--) {
        if (unmatched[i] < c) {
          unmatched.splice(i, 1);
          break;
        }
      }
    }

    // first leftover open is the culprit
    const badOpen = unmatched[0];
    if (badOpen !== null) {
      const pos = doc.positionAt(badOpen + 1); // skip the '<'
      range = new vscode.Range(pos, pos.translate(0, tag.length));
    }
  }

  return [
    new vscode.Diagnostic(range, pretty, vscode.DiagnosticSeverity.Error),
  ];
};

/* ------------------------------------------------------------- */
/*  sanitizeForDiagnostics  ——  ejemplo mínimo con el helper     */
/* ------------------------------------------------------------- */

/**
 * Return a string of identical length – every character except newlines
 * becomes a space.
 */
const spacer = (s: string) => s.replace(/[^\n]/g, " ");

/** Blanks “// …” sequences that live in the HTML part (outside PHP). */
const stripInlineSlashes = (txt: string): string =>
  txt.replace(
    /(^|>|[)\]}"'` \t])\s*\/\/.*?(?=<|\r?\n|$)/g,
    (m, p) => p + spacer(m.slice(p.length))
  );

/** Blanks the interior of a {{ … }} expression but keeps the braces. */
const blankMustaches = (txt: string) =>
  txt.replace(/{{([\s\S]*?)}}/g, (_m, inner) => "{{" + spacer(inner) + "}}");

function sanitizeForDiagnosticsXML(raw: string): string {
  let text = raw;

  // ── 1️⃣ Preserve heredoc/nowdoc interior ─────────────────────────
  // Blank only the opening <<<… and closing …; lines; keep the real HTML intact.
  text = text.replace(
    /<<<['"]?([A-Za-z_]\w*)['"]?\r?\n([\s\S]*?)\r?\n\s*\1\s*;?/g,
    (fullMatch) => {
      const lines = fullMatch.split(/\r?\n/);
      return lines
        .map(
          (line, i) =>
            i === 0 || i === lines.length - 1
              ? " ".repeat(line.length) // blank only the markers
              : line // keep interior
        )
        .join("\n");
    }
  );

  // ── 2️⃣ Strip out PHP-style /* … */ comments ────────────────────
  text = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  // ── 3️⃣ Strip out single-line // comments in PHP ────────────────
  text = text.replace(/^[ \t]*\/\/.*$/gm, (m) => " ".repeat(m.length));

  // ── 4️⃣ Strip any <?php … ?> blocks but only the tags ─────────────
  //    (we blank the <?php / ?> markers, not the entire content)
  text = text.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (m) => " ".repeat(m.length));
  text = text.replace(/<\?(?:php|=)?/g, (m) => " ".repeat(m.length));

  // ── 5️⃣ Strip HTML-style “//…” comments (outside PHP) ────────────
  text = stripInlineSlashes(text);

  // ── 6️⃣ Blank out all normal '…' and "…" string literals ─────────
  text = text.replace(
    /(['"])(?:\\.|[^\\])*?\1/g,
    (m, q) => q + " ".repeat(m.length - 2) + q
  );

  // ── 7️⃣ Blank {{ … }} JS-in-Mustache ─────────────────────────────
  text = blankMustaches(text);

  // ── 8️⃣ Blank any PHP interpolation `{$…}` ───────────────────────
  text = text.replace(/\{\$[^}]+\}/g, (m) => " ".repeat(m.length));

  // ── 9️⃣ Remove && and single & operators ─────────────────────────────
  text = text.replace(/&&|&/g, (match) => " ".repeat(match.length));
  return text;
}

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
const PLACEHOLDER_REGEX = /\$\{([\s\S]*?)\}/g;

// Update curly brace decorations within JS expressions.
function updateJsVariableDecorations(
  document: vscode.TextDocument,
  decorationType: vscode.TextEditorDecorationType
): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const text = document.getText();
  const decorations: vscode.DecorationOptions[] = [];
  let m: RegExpExecArray | null;

  // 1️⃣ for each {{ … }} block
  while ((m = JS_EXPR_REGEX.exec(text)) !== null) {
    const wholeMatch = m[0];
    const blockStart = m.index;
    const blockLength = wholeMatch.length;

    // highlight the "{{"
    decorations.push({
      range: new vscode.Range(
        document.positionAt(blockStart),
        document.positionAt(blockStart + 2)
      ),
    });

    // highlight the "}}"
    decorations.push({
      range: new vscode.Range(
        document.positionAt(blockStart + blockLength - 2),
        document.positionAt(blockStart + blockLength)
      ),
    });

    // 2️⃣ *inside* that same mustache text, look for `${…}`
    let ph: RegExpExecArray | null;
    while ((ph = PLACEHOLDER_REGEX.exec(wholeMatch)) !== null) {
      const phRelStart = ph.index;
      const phLen = ph[0].length;
      const phAbsStart = blockStart + phRelStart;

      // highlight "${"
      decorations.push({
        range: new vscode.Range(
          document.positionAt(phAbsStart),
          document.positionAt(phAbsStart + 2)
        ),
      });

      // highlight the closing "}"
      decorations.push({
        range: new vscode.Range(
          document.positionAt(phAbsStart + phLen - 1),
          document.positionAt(phAbsStart + phLen)
        ),
      });
    }
  }

  editor.setDecorations(decorationType, decorations);
}

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

  const originalText = document.getText();
  // 1️⃣ blank out *all* PHP literals/comments/regex so we don't pick up "{{…}}" inside them
  const sanitizedText = sanitizeForDiagnostics(originalText);

  const diagnostics: vscode.Diagnostic[] = [];
  let match: RegExpExecArray | null;
  // 2️⃣ run your existing JS_EXPR_REGEX *against* the sanitized text
  while ((match = JS_EXPR_REGEX.exec(sanitizedText)) !== null) {
    const expr = match[1].trim();
    if (!isValidJsExpression(expr)) {
      // calculate positions *in* the original text (indexes line up thanks to blanking)
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

// ── at module‐scope ────────────────────────────────────────────────

// build your two regexes once…
const nativeFuncRegex = new RegExp(
  `\\b(${NATIVE_STRING_METHODS.join("|")})\\b`,
  "g"
);
const nativePropRegex = new RegExp(
  `\\b(${NATIVE_STRING_PROPS.join("|")})\\b`,
  "g"
);

// a generic “object.property” regex to catch anything else
const objectPropRegex = /(?<=\.)[A-Za-z_$][\w$]*/g;

// ── in your activate (or wherever) ─────────────────────────────────
const objectPropertyDecorationType =
  vscode.window.createTextEditorDecorationType({
    color: "#9CDCFE", // pick whatever color you like
  });

// 1️⃣ at the top of activate()
const STRING_COLOR = "#CE9178"; // or whatever your theme’s string color is
const stringDecorationType = vscode.window.createTextEditorDecorationType({
  color: STRING_COLOR,
});
const tplLiteralDecorationType = vscode.window.createTextEditorDecorationType({
  color: STRING_COLOR,
});

// integer or decimal, e.g. 42 or 3.1415
const numberRegex = /\b\d+(\.\d+)?\b/g;
const numberDecorationType = vscode.window.createTextEditorDecorationType({
  color: "#B5CEA8",
});

// catch anything between back-ticks, including escaped ones
const templateLiteralRegex = /`(?:\\[\s\S]|[^\\`])*`/g;
const placeholderRegex = /\$\{[^}]*\}/g;

// decoration for template literals inside {{ … }}
const templateLiteralDecorationType =
  vscode.window.createTextEditorDecorationType({
    color: STRING_COLOR,
  });

// ── the updated function ────────────────────────────────────────────

function updateNativeTokenDecorations(
  document: vscode.TextDocument,
  funcDecoType: vscode.TextEditorDecorationType,
  propDecoType: vscode.TextEditorDecorationType
): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || document.languageId !== PHP_LANGUAGE) {
    return;
  }

  const text = document.getText();
  const funcDecorations: vscode.DecorationOptions[] = [];
  const nativePropDecorations: vscode.DecorationOptions[] = [];
  const objectPropDecorations: vscode.DecorationOptions[] = [];
  const numberDecorations: vscode.DecorationOptions[] = [];
  const stringSpans: vscode.DecorationOptions[] = [];

  for (const exprMatch of text.matchAll(JS_EXPR_REGEX)) {
    const jsExpr = exprMatch[1];
    const baseIndex = exprMatch.index! + exprMatch[0].indexOf(jsExpr);

    // — highlight native string *methods* as before
    for (const m of jsExpr.matchAll(nativeFuncRegex)) {
      const start = baseIndex + m.index!;
      const end = start + m[0].length;
      funcDecorations.push({
        range: new vscode.Range(
          document.positionAt(start),
          document.positionAt(end)
        ),
      });
    }

    // — highlight native string *properties* as before
    for (const m of jsExpr.matchAll(nativePropRegex)) {
      const start = baseIndex + m.index!;
      const end = start + m[0].length;
      nativePropDecorations.push({
        range: new vscode.Range(
          document.positionAt(start),
          document.positionAt(end)
        ),
      });
    }

    // — now highlight **only** your own object.property
    for (const m of jsExpr.matchAll(objectPropRegex)) {
      // m[0] is the property name after the dot
      // skip if it’s one of the native‐string props or methods
      if (
        NATIVE_STRING_METHODS.includes(m[0]) ||
        NATIVE_STRING_PROPS.includes(m[0])
      ) {
        continue;
      }
      const start = baseIndex + m.index!;
      const end = start + m[0].length;
      objectPropDecorations.push({
        range: new vscode.Range(
          document.positionAt(start),
          document.positionAt(end)
        ),
      });
    }

    for (const numMatch of jsExpr.matchAll(numberRegex)) {
      const start = baseIndex + numMatch.index!;
      const end = start + numMatch[0].length;
      numberDecorations.push({
        range: new vscode.Range(
          document.positionAt(start),
          document.positionAt(end)
        ),
      });
    }

    for (const tl of jsExpr.matchAll(templateLiteralRegex)) {
      const tplBase = baseIndex + tl.index!; //  ← NEW
      const raw = tl[0];
      const inner = raw.slice(1, -1); // strip the back‑ticks
      let last = 0;

      // at the top of the loop, just after tplBase is defined
      stringSpans.push({
        range: new vscode.Range(
          document.positionAt(tplBase),
          document.positionAt(tplBase + 1)
        ),
      });
      stringSpans.push({
        range: new vscode.Range(
          document.positionAt(tplBase + raw.length - 1),
          document.positionAt(tplBase + raw.length)
        ),
      });

      let ph: RegExpExecArray | null;
      while ((ph = placeholderRegex.exec(inner))) {
        // literal chunk **before** this placeholder
        const litStart = tplBase + 1 + last; // tplBase, not baseIndex
        const litEnd = tplBase + 1 + ph.index;
        if (litEnd > litStart) {
          stringSpans.push({
            range: new vscode.Range(
              document.positionAt(litStart),
              document.positionAt(litEnd)
            ),
          });
        }
        last = ph.index + ph[0].length;
      }

      // trailing literal **after** the last placeholder
      if (last < inner.length) {
        const litStart = tplBase + 1 + last;
        const litEnd = tplBase + 1 + inner.length;
        stringSpans.push({
          range: new vscode.Range(
            document.positionAt(litStart),
            document.positionAt(litEnd)
          ),
        });
      }
    }
  }

  editor.setDecorations(funcDecoType, funcDecorations);
  editor.setDecorations(propDecoType, nativePropDecorations);
  editor.setDecorations(objectPropertyDecorationType, objectPropDecorations);
  editor.setDecorations(numberDecorationType, numberDecorations);
  editor.setDecorations(tplLiteralDecorationType, stringSpans);
}

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

  // Use the sanitized version (without comments) to parse imports.
  const useMap = parsePhpUseStatements(noCommentsText);

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
  diagnostics.push(...getFxpDiagnostics(document));
  diagnosticCollection.set(document.uri, diagnostics);
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
  return text;
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

function parseStubsWithTS(source: string) {
  // 1) build a lookup of the class-names we care about
  const stubNames = new Set<keyof typeof classStubs>(
    Object.keys(classStubs) as (keyof typeof classStubs)[]
  );

  // 2) parse into a TS SourceFile
  const sf = ts.createSourceFile(
    "pphp.d.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true
  );

  // 3) scan every top-level declaration
  sf.statements.forEach((stmt) => {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) {
      return;
    }

    const name = stmt.name.text as keyof typeof classStubs;
    if (!stubNames.has(name)) {
      return;
    }

    // 4) for each member in that class…
    stmt.members.forEach((member) => {
      // skip any private members
      if (
        ts.canHaveModifiers(member) &&
        ts
          .getModifiers(member)
          ?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
      ) {
        return;
      }

      // METHOD?
      if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
        const mName = (member.name as ts.Identifier).text;
        const sig = member.getText(sf).trim();
        classStubs[name].push({ name: mName, signature: sig });
      }
      // PROPERTY?
      else if (
        ts.isPropertySignature(member) ||
        ts.isPropertyDeclaration(member)
      ) {
        const pName = (member.name as ts.Identifier).text;
        const pType = member.type?.getText(sf).trim() ?? "any";
        // avoid duplicate if a method of same name already ran
        if (!classStubs[name].some((e) => e.name === pName)) {
          classStubs[name].push({ name: pName, signature: `: ${pType}` });
        }
      }
    });
  });
}

/* ────────────────────────────────────────────────────────────── *
 *                          EXTENSION DEACTIVATION                  *
 * ────────────────────────────────────────────────────────────── */

export function deactivate(): void {}
