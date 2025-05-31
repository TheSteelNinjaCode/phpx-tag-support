import { XMLValidator } from "fast-xml-parser";
import * as fs from "fs";
import * as path from "path";
import ts, { CallExpression, SyntaxKind as S } from "typescript";
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

export function parseGlobalsWithTS(source: string) {
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

    // detect whether there’s a rest-parameter (e.g. "...prefixes: string[]")
    const hasRest = expectedParams.some((p) => p.startsWith("..."));
    // everything that isn’t the rest-param
    const nonRest = expectedParams.filter((p) => !p.startsWith("..."));

    // count what the user actually passed
    const parsedArgs = parseArgsWithTs(argsText);
    const passedCount = parsedArgs.length;

    // only non-rest params contribute to “required” count
    const requiredCount = nonRest.filter((p) => !p.includes("?")).length;
    // if there *is* a rest param, there’s no upper limit
    const maxCount = hasRest ? Infinity : expectedParams.length;

    if (passedCount < requiredCount || passedCount > maxCount) {
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
    wsFolder,
    ".pphp/phpx-mustache.d.ts"
  );
  const stubWatcher = vscode.workspace.createFileSystemWatcher(stubPattern);
  context.subscriptions.push(stubWatcher);

  const stubPath = context.asAbsolutePath("resources/types/pphp.d.txt");
  const stubText = fs.readFileSync(stubPath, "utf8");
  parseStubsWithTS(stubText);

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: "php", scheme: "file" },
      {
        provideDefinition(document, position) {
          // 1) Are we on an identifier?
          const wordRange = document.getWordRangeAtPosition(
            position,
            /[A-Za-z_]\w*/
          );
          if (!wordRange) {
            return;
          }

          const word = document.getText(wordRange);
          const line = document.lineAt(position).text;
          // 2) Are we inside an onXXX="…"?  (simple check)
          const beforeCursor = line.slice(0, position.character + 1);
          if (!/\bon[A-Za-z]+\s*=\s*"[^"]*$/.test(beforeCursor)) {
            return;
          }

          // 3) Look for `function <word>(` somewhere in the file
          const text = document.getText();
          const fnRegex = new RegExp(`function\\s+${word}\\s*\\(`, "g");
          let match: RegExpExecArray | null;
          while ((match = fnRegex.exec(text))) {
            // positionAt(match.index) is at the `f` of `function`
            // but we want to point at the start of the identifier:
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
          // 1) Only when inside onXXX="…"
          const line = document
            .lineAt(position.line)
            .text.slice(0, position.character);
          if (!/\bon[A-Za-z]+\s*=\s*"[^"]*$/.test(line)) {
            return;
          }

          // 2) What the user’s already typed
          const wordRange = document.getWordRangeAtPosition(
            position,
            /[A-Za-z_]\w*/
          );
          const partial = wordRange ? document.getText(wordRange) : "";

          // 3) Grab the full document text
          const text = document.getText();
          const names = new Set<string>();

          // 4) Scan only your PHP blocks for functions (skip any starting with “_”)
          const phpBlockRe = /<\?php\b([\s\S]*?)\?>/gi;
          for (const block of text.matchAll(phpBlockRe)) {
            const phpCode = block[1];
            for (const fn of phpCode.matchAll(
              /function\s+([A-Za-z]\w*)\s*\(/g
            )) {
              names.add(fn[1]);
            }
          }

          // 5) Build and return CompletionItems for those PHP functions
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
      `"` // trigger inside on…=""
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: "php" },
      {
        provideCompletionItems(doc, pos) {
          const line = doc.lineAt(pos.line).text;
          const uptoCursor = line.slice(0, pos.character);

          /* ① must be inside an open tag -------------------------------- */
          const lt = uptoCursor.lastIndexOf("<");
          if (lt === -1 || uptoCursor[lt + 1] === "/") {
            return;
          }
          if (uptoCursor.slice(lt).includes(">")) {
            return;
          }

          /* 0️⃣  bail out if we’re already inside an attribute value  */
          /* look for the *last* equal‑sign before the cursor *inside* the tag */
          const eq = uptoCursor.lastIndexOf("=");
          if (eq > lt) {
            // any quote after that “=” that hasn’t been closed yet?
            const afterEq = uptoCursor.slice(eq + 1);
            const openQuote = afterEq.match(/['"]/); // first quote
            const closeQuote = afterEq.match(/(['"])[^'"]*\1\s*$/); // matching closer
            if (openQuote && !closeQuote) {
              return; // ↩︎  we’re inside  foo="|"
            }
          }

          /* ② figure out which <Tag … ---------------------------------- */
          const tagMatch = uptoCursor.slice(lt).match(/^<\s*([A-Za-z0-9_]+)/);
          const tagName = tagMatch ? tagMatch[1] : null;

          /* ③ attributes already written -------------------------------- */
          const written = new Set<string>(
            uptoCursor.slice(lt).match(/\b[\w-]+(?==)/g) || []
          );

          /* ④ what’s the user typing right now? ------------------------- */
          const word = doc.getWordRangeAtPosition(pos, /[\w-]+/);
          const partial = word ? doc.getText(word) : "";

          /* ⑤ STATIC completions – the list you already had ------------- */
          const staticItems = buildAttrCompletions()
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

          /* ⑥ DYNAMIC completions – public props of the component -------- */
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

          /* ⑦ return both lists – COMPONENT props first, pp- attributes later */
          dynamicItems.forEach((it) => {
            // "0_" makes them sort *before* everything that starts with "1_"
            it.sortText = `0_${it.label}`;
          });
          staticItems.forEach((it) => {
            it.sortText = `1_${it.label}`;
          });

          return [...dynamicItems, ...staticItems]; // ← changed line
        },
      },
      " ",
      ":",
      "\t", // disparadores típicos mientras escribes attrs
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
  watcher.onDidChange(() => {
    loadComponentsFromClassLog();
    propsProvider.clear();
  });
  watcher.onDidCreate(() => loadComponentsFromClassLog());
  watcher.onDidDelete(() => componentsCache.clear());
  context.subscriptions.push(watcher);

  // ── <Tag  attr="…">  HOVER  ────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerHoverProvider("php", {
      provideHover(doc, pos) {
        /* ① Make sure we are inside an opening tag,   <Tag …          */
        const line = doc.lineAt(pos.line).text;
        const uptoCur = line.slice(0, pos.character);
        const lt = uptoCur.lastIndexOf("<");
        if (lt === -1 || uptoCur[lt + 1] === "/") {
          return;
        }
        if (uptoCur.slice(lt).includes(">")) {
          return;
        }

        /* ② What tag are we in?   <Button … */
        const tagMatch = uptoCur.slice(lt).match(/^<\s*([A-Za-z0-9_]+)/);
        const tagName = tagMatch?.[1];
        if (!tagName) {
          return;
        }

        /* ③ Which *word* are we hovering?  (php matches attr names well) */
        const wr = doc.getWordRangeAtPosition(pos, /[\w-]+/);
        if (!wr) {
          return;
        }
        const attr = doc.getText(wr);

        /* ④ Ask our props‑provider for meta */
        const meta = propsProvider
          .getProps(tagName)
          .find((p) => p.name === attr);
        if (!meta) {
          return;
        }

        /* ⑤ Build the Markdown tooltip */
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

  /* ── attr="…" VALUE completion ─────────────────────────────── */
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      "php",
      {
        provideCompletionItems(doc, pos) {
          const line = doc.lineAt(pos.line).text;
          const uptoCur = line.slice(0, pos.character);

          /* ① we must be inside  … name="|" …  ------------------- */
          const attrValRe =
            /<\s*([A-Za-z0-9_]+)[^>]*\b([A-Za-z0-9_-]+)\s*=\s*"([^"]*)$/;
          const m = attrValRe.exec(uptoCur);
          if (!m) {
            return;
          }

          const [, tag, attrName, partial] = m;

          /* ② find the prop meta (has name, type, default, doc) -- */
          const meta = propsProvider
            .getProps(tag)
            .find((p) => p.name === attrName);
          if (!meta?.default) {
            return;
          }

          /* ③ collect options ----------------------------------- */
          let options: string[];
          if (Array.isArray(meta.default)) {
            // future‑proof: default stored as an array
            options = meta.default;
          } else {
            // pipe‑separated string  'a|b|c'
            options = String(meta.default).split("|");
          }

          return options
            .filter((opt) => opt.startsWith(partial)) // honour prefix
            .map((opt) => {
              const it = new vscode.CompletionItem(
                opt,
                vscode.CompletionItemKind.EnumMember
              );
              it.insertText = opt; // just the value
              it.range = new vscode.Range(
                pos.translate(0, -partial.length),
                pos
              );
              return it;
            });
        },
      },
      '"' // trigger when user types a quote inside attr value
    )
  );

  const fqcnToFile: FqcnToFile = (fqcn) => {
    const entry = getComponentsFromClassLog().get(getLastPart(fqcn));
    if (!entry) {
      return undefined;
    }

    const sourceRoot = vscode.workspace
      .getConfiguration("phpx-tag-support")
      .get("sourceRoot", "src");

    return path.join(
      vscode.workspace.workspaceFolders![0].uri.fsPath,
      sourceRoot,
      entry.replace(/\\/g, "/") + ".php"
    );
  };

  const propsProvider = new ComponentPropsProvider(
    getComponentsFromClassLog(), // tag → FQCN
    fqcnToFile // FQCN → file
  );

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

          const special = new Set(["pphp", "store", "searchParams"]);
          if (special.has(root)) {
            // let your dedicated pphp/store/searchParams provider handle it
            return;
          }

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

  context.subscriptions.push(
    stringDecorationType,
    numberDecorationType,
    registerPrismaFieldProvider()
  );

  const createDiags =
    vscode.languages.createDiagnosticCollection("prisma-create");
  const readDiags = vscode.languages.createDiagnosticCollection("prisma-read");
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

    // one timer per document
    const key = doc.uri.toString();
    clearTimeout(pendingTimers.get(key));

    pendingTimers.set(
      key,
      setTimeout(() => {
        validatePphpCalls(doc, pphpSigDiags);
        validateStateTupleUsage(doc, pphpSigDiags);
        rebuildMustacheStub(doc);
        validateComponentPropValues(doc, propsProvider);
        pendingTimers.delete(key);
      }, 500)
    );
  }

  // Combined update validations function.
  const updateAllValidations = async (document: vscode.TextDocument) => {
    scheduleValidation(document);

    await validateCreateCall(document, createDiags);
    await validateReadCall(document, readDiags);
    await validateUpdateCall(document, updateDiags);
    await validateDeleteCall(document, deleteDiags);
    await validateUpsertCall(document, upsertDiags);
    await validateGroupByCall(document, groupByDiags);
    await validateAggregateCall(document, aggregateDiags);

    updateStringDecorations(document);
    validateJsVariablesInCurlyBraces(document, jsVarDiagnostics);
    updateNativeTokenDecorations(
      document,
      nativeFunctionDecorationType,
      nativePropertyDecorationType
    );
    updateJsVariableDecorations(document, braceDecorationType);
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
        updateAllValidations(editor.document);
      }
    },
    null,
    context.subscriptions
  );
}

/* ────────────────────────────────────────────────────────────── *
 *        1️⃣  A tiny validator for component‑prop *values*        *
 * ────────────────────────────────────────────────────────────── */

const ATTR_VALUE_DIAG =
  vscode.languages.createDiagnosticCollection("phpx-attr-values");

function validateComponentPropValues(
  doc: vscode.TextDocument,
  propsProvider: ComponentPropsProvider
) {
  if (doc.languageId !== "php") {
    return;
  }

  const text = doc.getText();
  const diags: vscode.Diagnostic[] = [];

  /*           <Tag  foo="bar"  other="…">                            */
  const tagRe = /<\s*([A-Z][A-Za-z0-9_]*)\b([^>]*?)\/?>/g; // entire opening tag
  const attrRe = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g; // every attr="val"

  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(text))) {
    const [, tag, attrPart] = tagMatch;
    const props = propsProvider.getProps(tag);
    if (!props.length) {
      continue;
    }

    /* record which attrs we actually saw in this tag */
    const present = new Set<string>();

    /* ── 1️⃣  validate values that ARE present ─────────────────── */
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(attrPart))) {
      const [, attrName, value] = attrMatch;
      present.add(attrName);

      const meta = props.find((p) => p.name === attrName);
      if (!meta?.default) {
        continue; // nothing to validate for this attr
      }

      const allowed = String(meta.default).split("|").filter(Boolean);
      if (allowed.length && !allowed.includes(value)) {
        const tagStart = tagMatch.index; // where "<Tag" is
        const attrRelOffset = tagMatch[0].indexOf(attrMatch[0]);
        const absStart = tagStart + attrRelOffset + attrMatch[0].indexOf(value);
        const absEnd = absStart + value.length;

        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(doc.positionAt(absStart), doc.positionAt(absEnd)),
            `Invalid value "${value}". Allowed: ${allowed.join(", ")}`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }

    /* ── 2️⃣  flag *missing* required props ─────────────────────── */
    for (const p of props) {
      if (!p.optional && !present.has(p.name)) {
        // highlight the tag name itself for visibility
        const tagNamePos = doc.positionAt(tagMatch.index + 1); // skip '<'
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(tagNamePos, tagNamePos.translate(0, tag.length)),
            `Missing required attribute "${p.name}".`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    }
  }

  ATTR_VALUE_DIAG.set(doc.uri, diags);
}

/* ────────────────────────────────────────────────────────────── *
 *                 Native‑JS hover & signature‑help               *
 * ────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────── *
 *                        LANGUAGE PROVIDERS                        *
 * ────────────────────────────────────────────────────────────── */

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
      async provideCompletionItems(document, position) {
        const fullBefore = document.getText(
          new vscode.Range(new vscode.Position(0, 0), position)
        );

        // ── EARLY EXIT if cursor is inside a $prisma->…( … ) block ───────
        const prismaIndex = fullBefore.lastIndexOf("$prisma->");
        if (prismaIndex !== -1) {
          // find the first "(" after that
          const parenIndex = fullBefore.indexOf("(", prismaIndex);
          if (parenIndex !== -1) {
            // slice from that "(" to the cursor and count parens
            const between = fullBefore.slice(parenIndex);
            const opens = (between.match(/\(/g) || []).length;
            const closes = (between.match(/\)/g) || []).length;
            if (opens > closes) {
              // still inside the call
              return [];
            }
          }
        }

        const line = document.lineAt(position.line).text;
        const uptoCursor = line.slice(0, position.character);

        /* ⬅️  EARLY EXIT while user is still typing "<?php" or "<?="  */
        if (/^\s*<\?[A-Za-z=]*$/i.test(uptoCursor)) {
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

        // ────────── Bail out if inside a PHP tag <…> or </…> ───────────────
        const lt = uptoCursor.lastIndexOf("<");
        if (lt !== -1) {
          const afterLt = uptoCursor.slice(lt + 1);
          if (/\s/.test(afterLt)) {
            return; // ← NEW EARLY EXIT
          }
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
    for (const ph of findPlaceholders(wholeMatch)) {
      // opening “${”
      decorations.push({
        range: new vscode.Range(
          document.positionAt(blockStart + ph.start),
          document.positionAt(blockStart + ph.start + 2)
        ),
      });

      // matching “}”
      decorations.push({
        range: new vscode.Range(
          document.positionAt(blockStart + ph.end - 1),
          document.positionAt(blockStart + ph.end)
        ),
      });
    }
  }

  editor.setDecorations(decorationType, decorations);
}

const isValidJsExpression = (expr: string): boolean => {
  if (containsJsAssignment(expr)) {
    return false;
  }
  try {
    new Function(`return (${expr});`);
    return true;
  } catch {
    return false;
  }
};

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

/**
 * Devuelve true si la expresión contiene **cualquier** operador de asignación.
 * Usa el AST de TypeScript, sin dependencias internas.
 */
export function containsJsAssignment(expr: string): boolean {
  // envolvemos la expresión para garantizar código completo
  const sf = ts.createSourceFile(
    "tmp.ts",
    `(${expr});`,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    ts.ScriptKind.TSX
  );

  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    } // corto‑circuito

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

/**
 * Turn PHP-style variables into JS identifiers:
 *   {$foo} → foo
 *   $bar   → bar
 */
function preNormalizePhpVars(text: string): string {
  return text.replace(
    /{{([\s\S]*?)}}/g,
    (_, inside) =>
      "{{" +
      inside
        .replace(/\{\s*\$([A-Za-z_]\w*)\s*\}/g, "$1")
        .replace(/\$([A-Za-z_]\w*)/g, "$1") +
      "}}"
  );
}

const validateJsVariablesInCurlyBraces = (
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
): void => {
  if (document.languageId !== PHP_LANGUAGE) {
    return;
  }

  const originalText = document.getText();
  // 1️⃣ blank out *all* PHP literals/comments/regex so we don't pick up "{{…}}" inside them

  // ① normalize away PHP vars
  const normalized = preNormalizePhpVars(originalText);

  const sanitizedText = sanitizeForDiagnostics(normalized);

  const diagnostics: vscode.Diagnostic[] = [];
  let match: RegExpExecArray | null;
  // 2️⃣ run your existing JS_EXPR_REGEX *against* the sanitized text
  while ((match = JS_EXPR_REGEX.exec(sanitizedText)) !== null) {
    const expr = match[1].trim();

    // 🚩 1)  Asignaciones prohibidas
    if (containsJsAssignment(expr)) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(
            document.positionAt(match.index + 2), // «{{»
            document.positionAt(match.index + match[0].length - 2) // «}}»
          ),
          "⚠️  Assignments are not allowed inside {{ … }}. Use values or pure expressions.",
          vscode.DiagnosticSeverity.Warning
        )
      );
      // No sigas con las demás comprobaciones para esta expresión
      continue;
    }

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

export function* findPlaceholders(src: string) {
  for (let i = 0; i < src.length - 1; i++) {
    if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1;
      let j = i + 2; // jump *after* the opening “{”
      while (j < src.length && depth) {
        const ch = src[j++];
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
        }
      }
      if (depth === 0) {
        yield { start: i, end: j }; // j is already past the “}”
        i = j - 1; // resume scanning *after* it
      }
    }
  }
}

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
      const tplBase = baseIndex + tl.index!;
      const raw = tl[0];
      const inner = raw.slice(1, -1);

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

      let last = 0;
      for (const ph of findPlaceholders(inner)) {
        const litStart = tplBase + 1 + last;
        const litEnd = tplBase + 1 + ph.start;
        if (litEnd > litStart) {
          stringSpans.push({
            range: new vscode.Range(
              document.positionAt(litStart),
              document.positionAt(litEnd)
            ),
          });
        }
        last = ph.end;
      }

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

export function parseArgsWithTs(args: string): string[] {
  // ① envolver en una llamada ficticia
  const wrapper = `__dummy__(${args});`;

  // ② parsear a AST
  const sf = ts.createSourceFile(
    "args.ts",
    wrapper,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    ts.ScriptKind.TS
  );

  // ③ localizar el CallExpression
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
  } // nunca debería ocurrir

  // ④ extraer texto de cada argumento
  return call.arguments.map((arg) => arg.getText(sf));
}

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
