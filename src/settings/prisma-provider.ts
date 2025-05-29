import * as vscode from "vscode";
import {
  Call,
  Entry,
  Node,
  Identifier,
  Array as PhpArray,
  PropertyLookup,
  Variable,
} from "php-parser";
import { phpEngine } from "../util/php-engine";
import { Diagnostic, TextDocument, Range } from "vscode";
import { findPrismaCalls } from "../analysis/php-ast";

// ❶ ▶︎ Declare once at the top:
const ROOT_KEYS_MAP = {
  create: ["data", "include", "omit", "select"] as const,
  createMany: ["data", "skipDuplicates"] as const,
  findMany: [
    "where",
    "select",
    "include",
    "orderBy",
    "take",
    "skip",
    "cursor",
    "distinct",
  ] as const,
  findFirst: [
    "where",
    "select",
    "include",
    "omit",
    "orderBy",
    "take",
    "skip",
    "cursor",
    "distinct",
  ] as const,
  findUnique: ["where", "include", "omit", "select"] as const,
  update: ["data", "where", "include", "omit", "select"] as const,
  updateMany: ["data", "where"],
  delete: ["where", "include", "omit", "select"] as const,
  deleteMany: ["where"],
  upsert: ["where", "update", "create"] as const,
  groupBy: [
    "by",
    "where",
    "orderBy",
    "having",
    "take",
    "skip",
    "_count",
    "_max",
    "_min",
    "_avg",
    "_sum",
  ],
  aggregate: [
    "_count",
    "_min",
    "_max",
    "_avg",
    "_sum",
    "where",
    "orderBy",
    "cursor",
    "take",
    "skip",
    "distinct",
  ] as const,
};
type PrismaOp = keyof typeof ROOT_KEYS_MAP;
type RootKey = (typeof ROOT_KEYS_MAP)[PrismaOp][number];

const FILTER_OPERATORS = [
  "contains",
  "startsWith",
  "endsWith",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "equals",
  "not",
] as const;
// ① add this helper somewhere accessible
function isEntry(node: any): node is Entry {
  return node.kind === "entry";
}

/**  Return "key", "value" or null for the given Entry + cursor  */
function sectionOfEntry(
  entry: Entry,
  curOffset: number,
  baseOffset: number
): "key" | "value" | null {
  /* ① key not written yet – PHP short‑form entry */
  if (!entry.key && entry.value?.loc) {
    const vs = baseOffset + entry.value.loc.start.offset;
    const ve = baseOffset + entry.value.loc.end.offset;
    if (curOffset >= vs && curOffset <= ve) {
      return "key"; // ← treat it as the *key* the user is typing
    }
  }

  /* ② normal key range */
  if (entry.key?.loc) {
    const ks = baseOffset + entry.key.loc.start.offset;
    const ke = baseOffset + entry.key.loc.end.offset;
    if (curOffset >= ks && curOffset <= ke) {
      return "key";
    }
  }

  /* ③ normal value range */
  if (entry.value?.loc) {
    const vs = baseOffset + entry.value.loc.start.offset;
    const ve = baseOffset + entry.value.loc.end.offset;
    if (curOffset >= vs && curOffset <= ve) {
      return "value";
    }
  }

  return null;
}

/**
 * Return the PhpArray literal in which the cursor sits,
 * starting from `argsArr` (the first call‑argument).
 */
function arrayUnderCursor(
  arr: PhpArray,
  cur: number,
  base: number
): PhpArray | null {
  if (!arr.loc) {
    return null;
  }

  const start = base + arr.loc.start.offset;
  const end = base + arr.loc.end.offset;
  if (cur < start || cur > end) {
    return null;
  } // cursor is outside

  // look first at every child‑array → return the *deepest* one
  for (const it of arr.items.filter(isEntry)) {
    if (isArray(it.value)) {
      const deeper = arrayUnderCursor(it.value, cur, base);
      if (deeper) {
        return deeper;
      }
    }
  }
  // none of the children matched ⇒ this literal is the host
  return arr;
}

function findParentKey(arr: PhpArray, target: PhpArray): string | null {
  for (const e of arr.items as Entry[]) {
    if (e.value === target && e.key?.kind === "string") {
      return (e.key as any).value as string;
    }
    if (isArray(e.value)) {
      const sub = findParentKey(e.value, target);
      if (sub) {
        return sub;
      }
    }
  }
  return null;
}

function makeReplaceRange(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  alreadyLen: number
): vscode.Range {
  const start = pos.translate(0, -alreadyLen);
  const tail = doc.getText(new vscode.Range(pos, pos.translate(0, 4)));
  const m = /^\s*=>\s*/.exec(tail);
  const end = m ? pos.translate(0, m[0].length) : pos.translate(0, 1);
  return new vscode.Range(start, end);
}

// ❷ ▶︎ In your provider:
export function registerPrismaFieldProvider(): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(
    "php",
    {
      async provideCompletionItems(doc, pos) {
        // ————— Extract snippet & parse AST (unchanged) —————
        const before = doc.getText(
          new vscode.Range(new vscode.Position(0, 0), pos)
        );
        const lastPrisma = before.lastIndexOf("$prisma->");
        if (lastPrisma === -1) {
          return;
        }
        const tail = before.slice(lastPrisma);
        let ast: Node;
        try {
          ast = phpEngine.parseEval(tail);
        } catch {
          return;
        }

        const alreadyMatch = /['"]([\w]*)$/.exec(before);
        const already = alreadyMatch ? alreadyMatch[1] : "";

        // ————— Find the call, the op and the model —————
        let callNode: Call | undefined,
          opName: PrismaOp | undefined,
          modelName: string | undefined;
        walk(ast, (n) => {
          if (callNode) {
            return;
          }
          if (n.kind !== "call") {
            return;
          }
          const c = n as Call;
          if (!isPropLookup(c.what)) {
            return;
          }
          const op = nodeName(c.what.offset) as PrismaOp;
          if (!(op in ROOT_KEYS_MAP)) {
            return;
          }
          const mChain = c.what.what;
          if (!isPropLookup(mChain)) {
            return;
          }
          const mdl = nodeName(mChain.offset);
          if (!mdl) {
            return;
          }
          callNode = c;
          opName = op;
          modelName = typeof mdl === "string" ? mdl.toLowerCase() : "";
        });
        if (!callNode || !opName || !modelName) {
          return;
        }

        const rootKeys = ROOT_KEYS_MAP[opName] as readonly RootKey[];
        const curOffset = doc.offsetAt(pos);

        // ————— Are we directly inside the top-level array? —————
        const argsArr = callNode.arguments?.[0];
        const hostArray = isArray(argsArr)
          ? arrayUnderCursor(argsArr, curOffset, lastPrisma)
          : null;

        if (!hostArray) {
          return;
        }

        // ── within that literal, which entry/side is it? ─────────────
        let entrySide: "key" | "value" | null = null;
        for (const ent of hostArray.items.filter(isEntry)) {
          entrySide = sectionOfEntry(ent, curOffset, lastPrisma);
          if (entrySide) {
            break;
          }
        }

        if (isArray(argsArr) && argsArr.loc) {
          const arrStart = lastPrisma + argsArr.loc.start.offset;
          const arrEnd = lastPrisma + argsArr.loc.end.offset;

          if (curOffset >= arrStart && curOffset <= arrEnd) {
            // check if we're *not* inside any nested block
            const inNested = (argsArr.items as Entry[]).some((item) => {
              if (item.key?.kind !== "string") {
                return false;
              }
              const k = (item.key as any).value as RootKey;
              if (!rootKeys.includes(k)) {
                return false;
              }
              if (!item.value?.loc) {
                return false;
              }
              const start = lastPrisma + item.value.loc.start.offset;
              const end = lastPrisma + item.value.loc.end.offset;
              return curOffset >= start && curOffset <= end;
            });
            if (!inNested) {
              // ▶︎ suggest root keys: "'where' => $0", etc.
              return rootKeys.map((rk): vscode.CompletionItem => {
                const it = new vscode.CompletionItem(
                  `${rk}`,
                  vscode.CompletionItemKind.Keyword
                );
                it.insertText = new vscode.SnippetString(`${rk}' => $0`);
                it.range = makeReplaceRange(doc, pos, already.length);
                return it;
              });
            }
          }
        }

        // ————— Are we inside a nested array for one of those rootKeys? —————
        // loop over first-level entries to see which block we’re in:
        let currentRoot: RootKey | undefined;
        let nestedArrLoc: { start: number; end: number } | undefined;
        for (const entry of (argsArr as PhpArray).items as Entry[]) {
          if (
            entry.key?.kind !== "string" ||
            !entry.value ||
            !entry.value.loc
          ) {
            continue;
          }
          const key = (entry.key as any).value as RootKey;
          if (!rootKeys.includes(key)) {
            continue;
          }
          const s = lastPrisma + entry.value.loc.start.offset;
          const e = lastPrisma + entry.value.loc.end.offset;
          if (curOffset >= s && curOffset <= e) {
            currentRoot = key;
            nestedArrLoc = { start: s, end: e };
            break;
          }
        }

        const fieldMap = (await getModelMap()).get(modelName);
        if (!fieldMap) {
          return;
        }

        // → instead, look *inside* the top-level `select` block:
        const nestedRoot = (() => {
          if (!currentRoot || !isArray(argsArr)) {
            return null;
          }
          // find the entry for our root key (e.g. 'select' => [...] )
          const rootEntry = (argsArr.items as Entry[]).find(
            (e) =>
              e.key?.kind === "string" &&
              (e.key as any).value === currentRoot &&
              isArray(e.value)
          );
          if (!rootEntry) {
            return null;
          }
          // now find which key *inside* that block holds your hostArray
          return findParentKey(rootEntry.value as PhpArray, hostArray!);
        })();

        // use nestedRoot if present, otherwise fall back to the top-level key
        const modelMap = await getModelMap();
        const modelNames = new Set(modelMap.keys());
        const rootMap = modelMap.get(modelName)!;
        const activeRoot = currentRoot;

        // ── special: handle both key & value for orderBy ────────────
        if (currentRoot === "orderBy") {
          const orderByEntry = (argsArr as PhpArray).items.find(
            (e): e is Entry =>
              e.kind === "entry" &&
              isEntry(e) &&
              e.key?.kind === "string" &&
              (e.key as any).value === "orderBy"
          );
          if (orderByEntry && isArray(orderByEntry.value)) {
            const orderArr = orderByEntry.value as PhpArray;
            const s = lastPrisma + orderArr.loc!.start.offset;
            const e = lastPrisma + orderArr.loc!.end.offset;
            if (curOffset >= s && curOffset <= e) {
              for (const itm of orderArr.items.filter(isEntry) as Entry[]) {
                const side = sectionOfEntry(itm, curOffset, lastPrisma);
                if (entrySide !== "key" && side === "value") {
                  return ["asc", "desc"].map((dir) => {
                    const it = new vscode.CompletionItem(
                      dir,
                      vscode.CompletionItemKind.Value
                    );
                    it.insertText = new vscode.SnippetString(`${dir}'`);
                    it.range = makeReplaceRange(doc, pos, already.length);
                    return it;
                  });
                }
              }
            }
          }
        }

        // special‐case boolean roots:
        if (activeRoot === "skipDuplicates" && entrySide === "value") {
          return ["true", "false"].map((v) => {
            const it = new vscode.CompletionItem(
              v,
              vscode.CompletionItemKind.Value
            );
            it.insertText = new vscode.SnippetString(`${v}`);
            it.range = makeReplaceRange(doc, pos, already.length);
            return it;
          });
        }

        // ── all other roots only on the *key* side ───────────────────
        if (!currentRoot || !nestedArrLoc || entrySide !== "key") {
          return;
        }

        if (currentRoot === "by") {
          return [...fieldMap.keys()].map((fld) => {
            const it = new vscode.CompletionItem(
              fld,
              vscode.CompletionItemKind.Keyword
            );
            it.insertText = new vscode.SnippetString(`${fld}', $0`);
            it.range = makeReplaceRange(doc, pos, already.length);
            return it;
          });
        }

        if (["_count", "_max", "_min", "_avg", "_sum"].includes(currentRoot)) {
          return [...fieldMap.keys()].map((fld) => {
            const it = new vscode.CompletionItem(
              fld,
              vscode.CompletionItemKind.Value
            );
            it.insertText = new vscode.SnippetString(`${fld}' => true, $0`);
            it.range = makeReplaceRange(doc, pos, already.length);
            return it;
          });
        }

        // ─── 1) If we’re in a `select` block on a _relation_ field …
        if (
          currentRoot === "select" &&
          nestedRoot &&
          entrySide === "key" &&
          fieldMap.has(nestedRoot) // it's a real field
        ) {
          const relInfo = fieldMap.get(nestedRoot)!;
          // only if that field’s type is another model
          if (modelNames.has(relInfo.type.toLowerCase())) {
            const nestedOps = ["select", "include", "omit", "where"] as const;
            return nestedOps.map((op) => {
              const it = new vscode.CompletionItem(
                op,
                vscode.CompletionItemKind.Keyword
              );
              // we want `'select' => [ 'user' => [ 'select' => ` ready to go
              it.insertText = new vscode.SnippetString(`${op}' => `);
              it.range = makeReplaceRange(doc, pos, already.length);
              return it;
            });
          }
        }

        // ── we’re inside a nested array for one of the rootKeys ───────
        // — detect the relation name when we're in a nested `select` ——
        let nestedRelation: string | undefined;
        if (currentRoot === "select" && isArray(argsArr)) {
          // find the first‐level `'select' => [ … ]` entry
          const selectEntry = (argsArr.items as Entry[]).find(
            (e) =>
              e.key?.kind === "string" &&
              (e.key as any).value === "select" &&
              isArray(e.value)
          );

          if (selectEntry) {
            const relArray = selectEntry.value as PhpArray;
            // scan each `'<relation>' => […]` inside that array…
            for (const ent of relArray.items.filter(isEntry) as Entry[]) {
              if (ent.key?.kind === "string" && ent.value?.loc) {
                const start = lastPrisma + ent.value.loc.start.offset;
                const end = lastPrisma + ent.value.loc.end.offset;
                // if my cursor is somewhere in that relation’s block…
                if (curOffset >= start && curOffset <= end) {
                  nestedRelation = (ent.key as any).value as string;
                  break;
                }
              }
            }
          }
        }

        // pick which fieldMap to use for suggestions:
        let suggestMap = rootMap;

        // if we’re in a `select` block and the key is a relation → swap in its map
        if (activeRoot === "select" && nestedRoot && rootMap.has(nestedRoot)) {
          const relInfo = rootMap.get(nestedRoot)!;
          const relMap = modelMap.get(relInfo.type.toLowerCase());
          if (relMap) {
            suggestMap = relMap;
          }
        }

        // now use `suggestMap` everywhere:
        const allFields = [...suggestMap.entries()];
        let suggestions: [string, FieldInfo][] = [];

        if (activeRoot === "_count") {
          // inside the _count => [ … ] block → only offer `select`
          const selectItem = new vscode.CompletionItem(
            "select",
            vscode.CompletionItemKind.Keyword
          );
          selectItem.insertText = new vscode.SnippetString(`select' => $0`);
          selectItem.documentation = new vscode.MarkdownString(
            "**Select** which fields to count"
          );
          selectItem.range = makeReplaceRange(doc, pos, already.length);
          return [selectItem];
        } else if (activeRoot === "select") {
          if (nestedRelation && fieldMap.has(nestedRelation)) {
            // it’s a relation → grab *that* model’s map
            const relInfo = fieldMap.get(nestedRelation)!;
            const relMap = modelMap.get(relInfo.type.toLowerCase());
            if (relMap) {
              suggestions = [...relMap.entries()];
            }
          } else {
            // top-level select → root model’s fields
            suggestions = allFields;
          }
        } else if (activeRoot === "include") {
          // back up to include → offer relations + _count
          suggestions = allFields.filter(([, info]) =>
            modelNames.has(info.type.toLowerCase())
          );
          suggestions.push([
            "_count",
            {
              type: "boolean",
              required: false,
              isList: false,
              nullable: true,
            },
          ]);
        } else {
          // your other roots (data, where, etc.)
          suggestions = allFields;
        }

        // ⑥ Only these roots ever get field suggestions:
        const fieldsRoots = [
          "data",
          "where",
          "select",
          "include",
          "orderBy",
          "distinct",
          "omit",
          "update",
          "create",
          "having",
          "by",
          "_count",
          "_max",
          "_min",
          "_avg",
          "_sum",
        ];
        if (!fieldsRoots.includes(currentRoot)) {
          return;
        }

        //
        // ── NON-WHERE ROOTS ──────────────────────────────────────
        //
        if (currentRoot !== "where") {
          return suggestions.map(([name, info]) => {
            const typeStr = `${info.type}${info.isList ? "[]" : ""}`;
            const optional = info.nullable; // <-- now only nullable fields get “?”
            const label: vscode.CompletionItemLabel = {
              label: optional ? `${name}?` : name,
              detail: `: ${typeStr}`,
            };
            const it = new vscode.CompletionItem(
              label,
              vscode.CompletionItemKind.Field
            );

            it.insertText = new vscode.SnippetString(`${name}' => $0`);
            it.documentation = new vscode.MarkdownString(
              `**Type**: \`${typeStr}\`\n\n- **Required**: ${!info.nullable}\n- **Nullable**: ${
                info.nullable
              }`
            );
            it.range = makeReplaceRange(doc, pos, already.length);
            return it;
          });
        }

        //
        // ── “where” root: split into three zones ──────────────────
        //
        const phpArgs = argsArr as PhpArray;
        const topWhereEnt = (phpArgs.items as Entry[]).find(
          (e) =>
            e.key?.kind === "string" &&
            (e.key as any).value === "where" &&
            isArray(e.value)
        );
        if (!topWhereEnt) {
          return;
        }
        const topWhereArr = topWhereEnt.value as PhpArray;
        const parentKey = findParentKey(phpArgs, hostArray);

        // A) Top-level WHERE: first columns, then AND|OR|NOT
        if (hostArray === topWhereArr) {
          const out: vscode.CompletionItem[] = [];

          // 1) columns
          for (const [name, info] of fieldMap.entries()) {
            const typeStr = `${info.type}${info.isList ? "[]" : ""}`;
            const optional = info.nullable;
            const label: vscode.CompletionItemLabel = {
              label: optional ? `${name}?` : name,
              detail: `: ${typeStr}`,
            };
            const col = new vscode.CompletionItem(
              label,
              vscode.CompletionItemKind.Field
            );
            col.sortText = `0_${name}`;
            col.insertText = new vscode.SnippetString(`${name}' => $0`);
            col.documentation = new vscode.MarkdownString(
              `**Type**: \`${typeStr}\`\n\n- **Required**: ${!info.nullable}\n- **Nullable**: ${
                info.nullable
              }`
            );
            col.range = makeReplaceRange(doc, pos, already.length);
            out.push(col);
          }

          // 2) combinators
          for (const c of ["AND", "OR", "NOT"] as const) {
            const it = new vscode.CompletionItem(
              c,
              vscode.CompletionItemKind.Keyword
            );
            it.sortText = `1_${c}`;
            it.insertText = new vscode.SnippetString(`${c}' => $0`);
            it.range = makeReplaceRange(doc, pos, already.length);
            out.push(it);
          }

          return out;
        }

        // B) inside an AND|OR|NOT block: only columns
        if (parentKey && ["AND", "OR", "NOT"].includes(parentKey)) {
          return [...fieldMap.entries()].map(([name, info]) => {
            const typeStr = `${info.type}${info.isList ? "[]" : ""}`;
            const optional = info.nullable;
            const label: vscode.CompletionItemLabel = {
              label: optional ? `${name}?` : name,
              detail: `: ${typeStr}`,
            };
            const col = new vscode.CompletionItem(
              label,
              vscode.CompletionItemKind.Field
            );
            col.sortText = `0_${name}`;
            col.insertText = new vscode.SnippetString(`${name}' => $0`);
            col.documentation = new vscode.MarkdownString(
              `**Type**: \`${typeStr}\`\n\n- **Required**: ${!info.nullable}\n- **Nullable**: ${
                info.nullable
              }`
            );
            col.range = makeReplaceRange(doc, pos, already.length);
            return col;
          });
        }

        // C) inside a specific field’s array: only filter ops
        return FILTER_OPERATORS.map((op) => {
          const it = new vscode.CompletionItem(
            op,
            vscode.CompletionItemKind.Keyword
          );
          it.sortText = `2_${op}`;
          it.insertText = new vscode.SnippetString(`${op}' => $0`);
          it.range = makeReplaceRange(doc, pos, already.length);
          return it;
        });
      },
    },
    "'", // single-quote trigger
    '"' // double-quote trigger
  );
}

export interface FieldInfo {
  type: string; // "String" | "Int" | ...
  required: boolean;
  isList: boolean;
  nullable: boolean;
}

export type ModelMap = Map<string, Map<string, FieldInfo>>; // model → field → info
let prismaSchemaCache: ModelMap | null = null;

export function clearPrismaSchemaCache(): void {
  prismaSchemaCache = null;
}

export async function getModelMap(): Promise<ModelMap> {
  // ➊ cache already built?
  if (prismaSchemaCache) {
    return prismaSchemaCache;
  }

  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    return new Map();
  }

  const schemaUri = vscode.Uri.joinPath(
    ws.uri,
    "settings",
    "prisma-schema.json"
  );

  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(schemaUri);
  } catch (err: unknown) {
    // ➋ File missing or unreadable – log & fall back gracefully
    console.warn(
      "[phpx] prisma-schema.json not found – schema‑aware " +
        "diagnostics disabled for now."
    );
    prismaSchemaCache = new Map();
    return prismaSchemaCache;
  }

  /* same as before – parse & build the map */
  try {
    const dmmf = JSON.parse(Buffer.from(raw).toString("utf8"));
    prismaSchemaCache = new Map();
    for (const model of dmmf.datamodel.models) {
      const fields = new Map<string, FieldInfo>();
      for (const f of model.fields) {
        fields.set(f.name, {
          type: f.type,
          required: f.isRequired && !f.hasDefaultValue && !f.relationName,
          isList: f.isList,
          nullable: !f.isRequired,
        });
      }
      prismaSchemaCache.set(model.name.toLowerCase(), fields);
    }
  } catch (e) {
    console.error("[phpx] Failed to parse prisma-schema.json:", e);
    prismaSchemaCache = new Map(); // ➌ malformed file → disable silently
  }

  return prismaSchemaCache;
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

/**
 * Walk a “key => rawValue” block and push diagnostics for
 *  • unknown columns
 *  • type mismatches
 */
function validateFieldAssignments(
  doc: vscode.TextDocument,
  literal: string,
  offset: number,
  fields: Map<string, FieldInfo>,
  modelName: string,
  diags: vscode.Diagnostic[]
) {
  const fieldRe = /['"](\w+)['"]\s*=>\s*([^,\]\r\n]+)/g;
  let m: RegExpExecArray | null;

  while ((m = fieldRe.exec(literal))) {
    const [, key, rawValue] = m;
    const info = fields.get(key);
    const startPos = doc.positionAt(offset + m.index);
    const range = new vscode.Range(startPos, startPos.translate(0, key.length));

    // unknown column
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

    // type-check
    const expr = rawValue.trim();
    if (!isValidPhpType(expr, info)) {
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

export function validateSelectBlock(
  doc: TextDocument,
  literal: string,
  offset: number,
  fields: Map<string, FieldInfo>,
  modelName: string,
  diags: vscode.Diagnostic[]
) {
  const selRe = /['"](\w+)['"]\s*=>\s*([^,\]\r\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = selRe.exec(literal))) {
    const [full, key, rawExpr] = m;
    const raw = rawExpr.trim();
    const info = fields.get(key);
    const startPos = doc.positionAt(offset + m.index);
    const range = new vscode.Range(startPos, startPos.translate(0, key.length));

    // unknown column
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

    // if it's an array literal, that's a nested‐select; skip here
    if (raw.startsWith("[") && raw.endsWith("]")) {
      continue;
    }

    // boolean check as before
    if (!/^(true|false)$/i.test(raw)) {
      diags.push(
        new vscode.Diagnostic(
          range,
          `\`select\` for "${key}" expects a boolean, but got "${raw}".`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }
}

function validateIncludeBlock(
  doc: TextDocument,
  includeEntry: Entry,
  fields: Map<string, FieldInfo>,
  modelName: string,
  diags: vscode.Diagnostic[]
) {
  // make sure we actually have an array literal:
  if (!isArray(includeEntry.value) || !includeEntry.value.loc) {
    return;
  }

  const arrNode = includeEntry.value as PhpArray;

  for (const item of arrNode.items as Entry[]) {
    if (item.key?.kind !== "string" || !item.value?.loc) {
      continue;
    }

    const keyName = (item.key as any).value as string;
    const keyRange = new vscode.Range(
      item.key.loc
        ? doc.positionAt(item.key.loc.start.offset)
        : doc.positionAt(0),
      item.key.loc ? doc.positionAt(item.key.loc.end.offset) : doc.positionAt(0)
    );

    // ——— 1) normal relation => boolean ———
    if (keyName !== "_count") {
      const raw = doc
        .getText(
          new vscode.Range(
            doc.positionAt(item.value.loc.start.offset),
            doc.positionAt(item.value.loc.end.offset)
          )
        )
        .trim();

      if (!fields.has(keyName)) {
        diags.push(
          new vscode.Diagnostic(
            keyRange,
            `The relation "${keyName}" does not exist on ${modelName}.`,
            vscode.DiagnosticSeverity.Error
          )
        );
      } else if (!/^(true|false)$/i.test(raw)) {
        diags.push(
          new vscode.Diagnostic(
            keyRange,
            `\`include\` for "${keyName}" expects a boolean, but got "${raw}".`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
      continue;
    }

    // ——— 2) special `_count` ———
    // a) boolean?
    if (!isArray(item.value)) {
      const raw = doc
        .getText(
          new vscode.Range(
            doc.positionAt(item.value.loc.start.offset),
            doc.positionAt(item.value.loc.end.offset)
          )
        )
        .trim();

      if (!/^(true|false)$/i.test(raw)) {
        diags.push(
          new vscode.Diagnostic(
            keyRange,
            "`include._count` expects a boolean or a nested [ 'select' => [...] ], but got " +
              JSON.stringify(raw),
            vscode.DiagnosticSeverity.Error
          )
        );
      }
      continue;
    }

    // b) array ⇒ must contain exactly a `select` entry whose values are booleans
    const countArr = item.value as PhpArray;
    const selEntry = (countArr.items as Entry[]).find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "select"
    );

    if (!selEntry) {
      diags.push(
        new vscode.Diagnostic(
          keyRange,
          "`include._count` array must contain a `select` entry.",
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }
    if (!isArray(selEntry.value) || !selEntry.value.loc) {
      diags.push(
        new vscode.Diagnostic(
          keyRange,
          "`include._count.select` must be an array literal.",
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }

    // c) finally, validate that each field => boolean in that inner select
    const innerArr = selEntry.value as PhpArray;
    if (!innerArr.loc) {
      return;
    }
    const start = innerArr.loc.start.offset;
    const end = innerArr.loc.end.offset;
    const innerText = doc.getText(
      new vscode.Range(doc.positionAt(start), doc.positionAt(end))
    );

    // re-use your boolean-only validator
    validateSelectBlock(doc, innerText, start, fields, modelName, diags);
  }
}

/**
 * Within a PhpArray literal, find both "select" and "include" entries
 * and run `validateSelectIncludeBlock` on them.
 */
export function validateSelectIncludeEntries(
  doc: TextDocument,
  arr: PhpArray,
  fields: Map<string, FieldInfo>,
  modelName: string,
  diags: Diagnostic[],
  modelMap: ModelMap
) {
  // look for the top‐level `select => [ … ]`
  const selectEntry = (arr.items as Entry[]).find(
    (e) => e.key?.kind === "string" && (e.key as any).value === "select"
  );
  if (selectEntry && isArray(selectEntry.value) && selectEntry.value.loc) {
    const selectArr = selectEntry.value as PhpArray;

    // ─── NEW: complain about any unknown field _before_ you recurse ───
    for (const ent of selectArr.items as Entry[]) {
      if (ent.key?.kind === "string") {
        const name = (ent.key as any).value as string;
        if (!fields.has(name)) {
          const { start, end } = ent.key.loc!;
          diags.push(
            new vscode.Diagnostic(
              new Range(
                doc.positionAt(start.offset),
                doc.positionAt(end.offset)
              ),
              `The column "${name}" does not exist in ${modelName}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }

    // ─── now recurse into any legit relation blocks ───
    for (const relEntry of selectArr.items as Entry[]) {
      if (
        relEntry.key?.kind === "string" &&
        isArray(relEntry.value) &&
        relEntry.value.loc
      ) {
        const relName = (relEntry.key as any).value as string;
        const relInfo = fields.get(relName);
        if (relInfo && modelMap.has(relInfo.type.toLowerCase())) {
          validateSelectIncludeEntries(
            doc,
            relEntry.value as PhpArray,
            modelMap.get(relInfo.type.toLowerCase())!,
            relInfo.type,
            diags,
            modelMap
          );
        }
      }
    }

    // ─── finally, only if this block has no nested arrays do we boolean‐check it ───
    const hasNested = (selectArr.items as Entry[]).some((e) =>
      isArray(e.value)
    );
    if (!hasNested) {
      const { start, end } = selectEntry.value.loc!;
      const literal = doc.getText(
        new Range(doc.positionAt(start.offset), doc.positionAt(end.offset))
      );
      validateSelectBlock(doc, literal, start.offset, fields, modelName, diags);
    }
  }

  // …then do exactly what you already had for `include`
  const includeEntry = (arr.items as Entry[]).find(
    (e) => e.key?.kind === "string" && (e.key as any).value === "include"
  );
  if (includeEntry) {
    validateIncludeBlock(doc, includeEntry, fields, modelName, diags);
  }
}

const PRISMA_OPERATORS = new Set([
  // logical combinators
  "AND",
  "OR",
  "NOT",
  // string matching
  "contains",
  "startsWith",
  "endsWith",
  // list membership
  "in",
  "notIn",
  // numeric
  "lt",
  "lte",
  "gt",
  "gte",
  // equality
  "equals",
  "not",
]);

/**
 * Encapsulate your big switch(...) in one place.
 */
function isValidPhpType(expr: string, info: FieldInfo): boolean {
  const allowed = phpDataTypes[info.type] ?? [];
  const isString = /^['"]/.test(expr);
  const isNumber = /^-?\d+(\.\d+)?$/.test(expr);
  const isBool = /^(true|false)$/i.test(expr);
  const isArray = /^\[.*\]$/.test(expr);
  const isVar = /^\$[A-Za-z_]\w*/.test(expr);
  const isFnCall = /^\s*(?:new\s+[A-Za-z_]\w*|\w+)\s*\(.*\)\s*$/.test(expr);
  const isNull = /^null$/i.test(expr);

  if (isVar) {
    return true;
  }

  if (isNull) {
    return info.nullable === true;
  }

  return allowed.some((t) => {
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
        return /^new\s+DateTime/.test(expr) || isFnCall || isString || isVar;
      case "BigInteger":
      case "BigDecimal":
        return isFnCall;
      case "enum":
        return isString;
      default:
        return isFnCall;
    }
  });
}

/* ---------- type‑guards ----------------------------------- */
const isPropLookup = (n: Node): n is PropertyLookup =>
  n.kind === "propertylookup";
const isIdentifier = (n: Node): n is Identifier => n.kind === "identifier";
const isVariable = (n: Node): n is Variable => n.kind === "variable";
const isArray = (n: Node): n is PhpArray => n.kind === "array";

const nodeName = (n: Node) =>
  isIdentifier(n) ? n.name : isVariable(n) ? n.name : null;

/* Loc → Range */
const rangeOf = (doc: vscode.TextDocument, loc: Node["loc"]) =>
  new vscode.Range(
    doc.positionAt(loc!.start.offset),
    doc.positionAt(loc!.end.offset)
  );

function walk(node: Node, visit: (n: Node) => void) {
  visit(node);
  for (const key of Object.keys(node)) {
    const child = (node as any)[key];
    if (!child) {
      continue;
    }
    if (Array.isArray(child)) {
      child.forEach((c) => c && walk(c, visit));
    } else if (typeof child === "object" && (child as Node).kind) {
      walk(child as Node, visit);
    }
  }
}

function locToRange(
  doc: vscode.TextDocument,
  loc: { start: { offset: number }; end: { offset: number } }
) {
  return new vscode.Range(
    doc.positionAt(loc!.start.offset),
    doc.positionAt(loc!.end.offset)
  );
}

function printArrayLiteral(arr: PhpArray): string {
  return printPhpArray(arr); // devuelve “[ 'foo' => 'bar' ]…”

  /**
   * Custom function to print PHP arrays.
   */
  function printPhpArray(arr: PhpArray): string {
    return JSON.stringify(
      arr.items.map((item) => ({
        ...(item.kind === "entry" &&
        "key" in item &&
        item.key?.kind === "string" &&
        "value" in item.key &&
        "value" in item.value
          ? { [String(item.key.value) || ""]: item.value.value || "" }
          : {}),
      }))
    );
  }
}

/**
 * Checks for simultaneous use of `select` and `include` at the top level
 * of a PhpArray literal. If both are found, pushes an Error diagnostic
 * on each key and returns true.
 */
function validateSelectIncludeExclusivity(
  arr: PhpArray,
  doc: vscode.TextDocument,
  diags: vscode.Diagnostic[]
): boolean {
  // do we have both blocks?
  const entries = arr.items as Entry[];
  const hasSelect = entries.some(
    (e) => e.key?.kind === "string" && (e.key as any).value === "select"
  );
  const hasInclude = entries.some(
    (e) => e.key?.kind === "string" && (e.key as any).value === "include"
  );
  if (!hasSelect || !hasInclude) {
    return false;
  }

  // push an error on each offending key
  for (const entry of entries) {
    if (entry.key?.kind === "string") {
      const keyName = (entry.key as any).value as string;
      if (keyName === "select" || keyName === "include") {
        const start = doc.positionAt(entry.key.loc!.start.offset);
        const end = doc.positionAt(entry.key.loc!.end.offset);
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(start, end),
            `You may not use both \`select\` and \`include\` in the same query. Choose one or the other.`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    }
  }

  return true;
}

/**
 * Validates an orderBy => [ 'field' => 'asc'|'desc', … ] block
 */
function validateOrderByEntries(
  doc: vscode.TextDocument,
  arr: PhpArray,
  fields: Map<string, FieldInfo>,
  modelName: string,
  diags: vscode.Diagnostic[]
) {
  // 1️⃣ only look at actual Entry nodes
  const entries = (arr.items as Node[]).filter(
    (node): node is Entry => node.kind === "entry"
  ) as Entry[];

  // 2️⃣ find the “orderBy” entry
  const orderByEntry = entries.find(
    (e) => e.key?.kind === "string" && (e.key as any).value === "orderBy"
  );
  if (!orderByEntry) {
    return;
  }

  // 3️⃣ guard against missing or non-array values
  if (!orderByEntry.value || orderByEntry.value.kind !== "array") {
    if (orderByEntry.key?.loc) {
      diags.push(
        new vscode.Diagnostic(
          rangeOf(doc, orderByEntry.key.loc),
          "`orderBy` must be an array literal of `{ field => 'asc'|'desc' }` entries.",
          vscode.DiagnosticSeverity.Error
        )
      );
    }
    return;
  }

  // 4️⃣ now it's safe to treat it as a PhpArray
  const orderArr = orderByEntry.value as PhpArray;
  for (const item of (orderArr.items as Node[]).filter(
    (node): node is Entry => node.kind === "entry"
  ) as Entry[]) {
    // a) skip anything without a string key or without a value loc
    if (item.key?.kind !== "string" || !item.value?.loc) {
      continue;
    }

    const fieldName = (item.key as any).value as string;
    const fieldLoc = item.key.loc!;
    const valLoc = item.value.loc!;

    // b) unknown field?
    if (!fields.has(fieldName)) {
      diags.push(
        new vscode.Diagnostic(
          rangeOf(doc, fieldLoc),
          `The column "${fieldName}" does not exist on ${modelName}.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }

    // c) check that the **value** is exactly 'asc' or 'desc'
    const raw = doc
      .getText(
        new vscode.Range(
          doc.positionAt(valLoc.start.offset),
          doc.positionAt(valLoc.end.offset)
        )
      )
      .trim()
      .replace(/^['"]|['"]$/g, "");

    if (raw !== "asc" && raw !== "desc") {
      diags.push(
        new vscode.Diagnostic(
          new vscode.Range(
            doc.positionAt(valLoc.start.offset),
            doc.positionAt(valLoc.end.offset)
          ),
          `Invalid sort direction "${raw}". Allowed values: "asc", "desc".`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }
}

export async function validateCreateCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const diagnostics: vscode.Diagnostic[] = [];
  const modelMap = await getModelMap();
  const ast = phpEngine.parseCode(doc.getText(), doc.fileName);

  /* ─── busca todas las llamadas $prisma->Model->create[…] ─── */
  walk(ast, (node) => {
    if (node.kind !== "call") {
      return;
    }

    const call = node as Call;
    if (!isPropLookup(call.what)) {
      return;
    }

    /* ① extraer op y modelo */
    const opName = nodeName(call.what.offset);
    if (opName !== "create" && opName !== "createMany") {
      return;
    }

    const modelChain = call.what.what;
    if (!isPropLookup(modelChain)) {
      return;
    }
    const modelName = nodeName(modelChain.offset);
    if (typeof modelName !== "string") {
      return;
    }

    /* ② asegurar que sea $prisma */
    const base = modelChain.what;
    if (!(isVariable(base) && base.name === "prisma")) {
      return;
    }

    /* ③ encontrar el bloque 'data' */
    const args = call.arguments?.[0];
    if (!isArray(args)) {
      return;
    }
    const dataEntry = (args.items as Entry[]).find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "data"
    );
    if (!dataEntry) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, call.loc),
          `${opName}() requires a 'data' block.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      collection.set(doc.uri, diagnostics);
      return;
    }
    if (!isArray(dataEntry.value)) {
      return;
    }

    /* ④ obtener esquema de campos del modelo */
    const fields =
      modelMap.get(modelName.toLowerCase()) ?? new Map<string, FieldInfo>();
    if (!fields.size) {
      return;
    }

    /* ⑤ para create(): un solo objeto */
    if (opName === "create") {
      for (const item of (dataEntry.value as PhpArray).items as Entry[]) {
        if (!item.key || item.key.kind !== "string") {
          continue;
        }

        if (validateSelectIncludeExclusivity(args, doc, diagnostics)) {
          break;
        }

        const key = (item.key as any).value as string;
        if (PRISMA_OPERATORS.has(key)) {
          continue;
        }

        const value = item.value;
        if (isArray(value)) {
          validateFieldAssignments(
            doc,
            printArrayLiteral(value),
            value.loc!.start.offset,
            fields,
            modelName,
            diagnostics
          );
          continue;
        }

        const info = fields.get(key);
        const keyRange = rangeOf(doc, item.key.loc!);
        if (!info) {
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `The column "${key}" does not exist in ${modelName}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        const raw = doc.getText(rangeOf(doc, value.loc!)).trim();
        if (!isValidPhpType(raw, info)) {
          const expected = info.isList ? `${info.type}[]` : info.type;
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `"${key}" expects ${expected}, but received "${raw}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }

      validateSelectIncludeEntries(
        doc,
        args,
        fields,
        modelName,
        diagnostics,
        modelMap
      );
    }

    /* ⑥ para createMany(): múltiples filas */
    if (opName === "createMany") {
      // cada elemento de data debe ser un array literal
      for (const rowItem of (dataEntry.value as PhpArray).items) {
        if (
          rowItem.kind !== "entry" ||
          !(rowItem as Entry).value ||
          !isArray((rowItem as Entry).value)
        ) {
          diagnostics.push(
            new vscode.Diagnostic(
              rangeOf(doc, rowItem.loc!),
              `Each element of 'data' in createMany() must be an array of column=>value pairs.`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        const rowArr = (rowItem as Entry).value as PhpArray;
        // validar cada campo de la fila igual que en create()
        for (const cell of rowArr.items as Entry[]) {
          if (!cell.key || cell.key.kind !== "string") {
            continue;
          }

          const key = (cell.key as any).value as string;
          if (PRISMA_OPERATORS.has(key)) {
            continue;
          }

          const info = fields.get(key);
          const keyRange = rangeOf(doc, cell.key.loc!);
          if (!info) {
            diagnostics.push(
              new vscode.Diagnostic(
                keyRange,
                `The column "${key}" does not exist in ${modelName}.`,
                vscode.DiagnosticSeverity.Error
              )
            );
            continue;
          }

          const raw = doc.getText(rangeOf(doc, cell.value.loc!)).trim();
          if (!isValidPhpType(raw, info)) {
            const expected = info.isList ? `${info.type}[]` : info.type;
            diagnostics.push(
              new vscode.Diagnostic(
                keyRange,
                `"${key}" expects ${expected}, but received "${raw}".`,
                vscode.DiagnosticSeverity.Error
              )
            );
          }
        }
      }
    }

    collection.set(doc.uri, diagnostics);
  });

  collection.set(doc.uri, diagnostics);
}

export async function validateReadCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
) {
  const diags: vscode.Diagnostic[] = [];
  const modelMap = await getModelMap();

  for (const call of findPrismaCalls(doc.getText())) {
    if (!["findMany", "findFirst", "findUnique"].includes(call.op)) {
      continue;
    }

    const fields = modelMap.get(call.model.toLowerCase());
    if (!fields) {
      continue;
    }

    /* ---- locate the ["where" => [ … ]] arg ---------------------- */
    const arr = call.args[0];
    if (!arr || arr.kind !== "array") {
      continue;
    }

    if (validateSelectIncludeExclusivity(arr as PhpArray, doc, diags)) {
      collection.set(doc.uri, diags);
      continue;
    }

    const whereEntry = (arr as any).items.find(
      (e: Entry) =>
        e.key?.kind === "string" &&
        (e.key as unknown as { value: string }).value === "where"
    ) as Entry | undefined;

    if (!whereEntry) {
      if (call.op === "findUnique") {
        diags.push(
          new vscode.Diagnostic(
            call.loc
              ? locToRange(doc, call.loc)
              : new vscode.Range(
                  new vscode.Position(0, 0),
                  new vscode.Position(0, 0)
                ),
            `findUnique() requires a 'where' block.`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }

      validateSelectIncludeEntries(
        doc,
        arr as PhpArray,
        fields,
        call.model,
        diags,
        modelMap
      );

      validateOrderByEntries(doc, arr as PhpArray, fields, call.model, diags);

      continue;
    }

    /* ---- now walk the nested array and check every field -------- */
    validateWhereArray(
      doc,
      whereEntry.value, // Node of the inner array literal
      fields,
      call.model,
      diags
    );

    validateSelectIncludeEntries(
      doc,
      arr as PhpArray,
      fields,
      call.model,
      diags,
      modelMap
    );

    validateOrderByEntries(doc, arr as PhpArray, fields, call.model, diags);
  }

  collection.set(doc.uri, diags);
}

function validateWhereArray(
  doc: vscode.TextDocument,
  node: Node,
  fields: Map<string, FieldInfo>,
  model: string,
  out: vscode.Diagnostic[]
) {
  if (node.kind !== "array") {
    return;
  }

  for (const item of (node as any).items as Entry[]) {
    if (!item.key || item.key.kind !== "string") {
      continue;
    }
    const key = (item.key as any).value as string;
    const keyRange = locToRange(doc, item.key.loc!);

    // 1) skip top-level Prisma combinators (AND, OR, NOT), but recurse into them
    if (PRISMA_OPERATORS.has(key) && ["AND", "OR", "NOT"].includes(key)) {
      if (item.value && isArray(item.value)) {
        validateWhereArray(doc, item.value, fields, model, out);
      }
      continue;
    }

    // 2) ensure this column actually exists
    const info = fields.get(key);
    if (!info) {
      out.push(
        new vscode.Diagnostic(
          keyRange,
          `The column "${key}" does not exist in ${model}.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }

    // 3) handle nested filter object: [ 'contains' => $search, … ]
    if (isArray(item.value)) {
      for (const opEntry of (item.value as PhpArray).items as Entry[]) {
        if (!opEntry.key || opEntry.key.kind !== "string") {
          continue;
        }
        const op = (opEntry.key as any).value as string;
        const opRange = locToRange(doc, opEntry.key.loc!);

        if (!PRISMA_OPERATORS.has(op)) {
          out.push(
            new vscode.Diagnostic(
              opRange,
              `Invalid filter operator "${op}" for "${key}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        // get the raw text of the operator’s value
        const valRange = locToRange(doc, opEntry.value.loc!);
        const raw = doc.getText(valRange).trim();

        // special-case array-valued filters
        if ((op === "in" || op === "notIn") && !/^\[.*\]$/.test(raw)) {
          out.push(
            new vscode.Diagnostic(
              opRange,
              `Filter "${op}" for "${key}" expects an array, but got "${raw}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        // everything else: use your existing isValidPhpType to check type
        // (e.g. "contains" on a String field must be a string or a var)
        if (!isValidPhpType(raw, info)) {
          out.push(
            new vscode.Diagnostic(
              opRange,
              `Filter "${op}" for "${key}" expects type ${info.type}, but received "${raw}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
      continue;
    }

    // 4) all other cases: e.g. simple equals => 123
    const valueRange = locToRange(doc, item.value.loc!);
    const rawExpr = doc.getText(valueRange).trim();
    if (!isValidPhpType(rawExpr, info)) {
      const expected = info.isList ? `${info.type}[]` : info.type;
      out.push(
        new vscode.Diagnostic(
          keyRange,
          `"${key}" expects ${expected}, but received "${rawExpr}".`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }
}

export async function validateUpdateCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const diagnostics: vscode.Diagnostic[] = [];
  const modelMap = await getModelMap();
  const ast = phpEngine.parseCode(doc.getText(), doc.fileName);

  walk(ast, (node) => {
    if (node.kind !== "call") {
      return;
    }
    const call = node as Call;
    if (!isPropLookup(call.what)) {
      return;
    }

    // only update() or updateMany()
    const opName = nodeName(call.what.offset);
    if (opName !== "update" && opName !== "updateMany") {
      return;
    }

    // extract model
    const mdlChain = call.what.what;
    if (!isPropLookup(mdlChain)) {
      return;
    }
    const modelName = nodeName(mdlChain.offset);
    if (typeof modelName !== "string") {
      return;
    }

    // must be $prisma
    if (!(isVariable(mdlChain.what) && mdlChain.what.name === "prisma")) {
      return;
    }

    // single argument must be an array literal
    const arg0 = call.arguments?.[0];
    if (!isArray(arg0)) {
      return;
    }

    // no mixing select/include
    if (validateSelectIncludeExclusivity(arg0, doc, diagnostics)) {
      collection.set(doc.uri, diagnostics);
      return;
    }

    const items = arg0.items as Entry[];
    const whereEntry = items.find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "where"
    ) as Entry | undefined;
    const dataEntry = items.find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "data"
    ) as Entry | undefined;

    // require both blocks
    if (!whereEntry || !dataEntry) {
      const missing = [
        !whereEntry ? "'where'" : null,
        !dataEntry ? "'data'" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, call.loc!),
          `${opName}() requires both ${missing} blocks.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      collection.set(doc.uri, diagnostics);
      return;
    }

    // lookup schema
    const fields =
      modelMap.get(modelName.toLowerCase()) ?? new Map<string, FieldInfo>();
    if (!fields.size) {
      return;
    }

    // ── validate WHERE
    if (!isArray(whereEntry.value)) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, whereEntry.key!.loc!),
          "`where` must be an array literal.",
          vscode.DiagnosticSeverity.Error
        )
      );
    } else {
      validateWhereArray(doc, whereEntry.value, fields, modelName, diagnostics);
    }

    // ── validate DATA
    if (!isArray(dataEntry.value)) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, dataEntry.key!.loc!),
          "`data` must be an array literal.",
          vscode.DiagnosticSeverity.Error
        )
      );
    } else {
      const entries = (dataEntry.value as PhpArray).items as Entry[];

      // ① make sure they’re actually updating at least one *column*
      const realUpdates = entries
        .filter(
          (e) =>
            e.key?.kind === "string" &&
            !PRISMA_OPERATORS.has((e.key as any).value)
        )
        .map((e) => (e.key as any).value as string);

      if (realUpdates.length === 0) {
        diagnostics.push(
          new vscode.Diagnostic(
            rangeOf(doc, dataEntry.key!.loc!),
            `${opName}() requires at least one real column to be updated in 'data'.`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }

      // ② then exactly the same per‐column checks you had before
      for (const item of entries) {
        if (!item.key || item.key.kind !== "string") {
          continue;
        }
        const key = (item.key as any).value as string;
        const value = item.value;

        // top-level Prisma operators (AND/OR/etc.) are always allowed
        if (PRISMA_OPERATORS.has(key)) {
          continue;
        }

        // nested object updates (e.g. push/set on list fields)
        if (isArray(value)) {
          validateFieldAssignments(
            doc,
            printArrayLiteral(value),
            value.loc!.start.offset,
            fields,
            modelName,
            diagnostics
          );
          continue;
        }

        // scalar column
        const info = fields.get(key);
        const keyRange = rangeOf(doc, item.key.loc!);
        if (!info) {
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `The column "${key}" does not exist in ${modelName}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        const raw = doc.getText(rangeOf(doc, value.loc!)).trim();
        if (!isValidPhpType(raw, info)) {
          const expected = info.isList ? `${info.type}[]` : info.type;
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `"${key}" expects ${expected}, but received "${raw}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }

    // ── finally, select/include sanity
    validateWhereArray(doc, whereEntry.value, fields, modelName, diagnostics);
    validateSelectIncludeEntries(
      doc,
      arg0,
      fields,
      modelName,
      diagnostics,
      modelMap
    );
  });

  // ensure we always set—clears out old results when you type
  collection.set(doc.uri, diagnostics);
}

export async function validateDeleteCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const diagnostics: vscode.Diagnostic[] = [];
  const modelMap = await getModelMap();
  const ast = phpEngine.parseCode(doc.getText(), doc.fileName);

  walk(ast, (node) => {
    if (node.kind !== "call") {
      return;
    }

    const call = node as Call;
    if (!isPropLookup(call.what)) {
      return;
    }

    // only delete() and deleteMany()
    const opName = nodeName(call.what.offset);
    if (opName !== "delete" && opName !== "deleteMany") {
      return;
    }

    // $prisma->Model
    const mdlChain = call.what.what;
    if (!isPropLookup(mdlChain)) {
      return;
    }
    const modelName = nodeName(mdlChain.offset);
    if (typeof modelName !== "string") {
      return;
    }

    // ensure it's prisma
    const base = mdlChain.what;
    if (!(isVariable(base) && base.name === "prisma")) {
      return;
    }

    // first argument must be array literal
    const arrayArg = call.arguments?.[0];
    if (!isArray(arrayArg)) {
      return;
    }

    // cannot mix select/include
    if (validateSelectIncludeExclusivity(arrayArg, doc, diagnostics)) {
      collection.set(doc.uri, diagnostics);
      return;
    }

    // find the where entry
    const items = arrayArg.items as Entry[];
    const whereEntry = items.find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "where"
    ) as Entry | undefined;

    // require 'where'
    if (!whereEntry) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, call.loc!),
          `${opName}() requires a 'where' block.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      collection.set(doc.uri, diagnostics);
      return;
    }
    if (!isArray(whereEntry.value)) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, whereEntry.key!.loc!),
          "`where` must be an array literal.",
          vscode.DiagnosticSeverity.Error
        )
      );
      collection.set(doc.uri, diagnostics);
      return;
    }

    // schema lookup
    const fields =
      modelMap.get(modelName.toLowerCase()) ?? new Map<string, FieldInfo>();
    if (!fields.size) {
      return;
    }

    // validate the where filters
    validateWhereArray(doc, whereEntry.value, fields, modelName, diagnostics);

    // still forbid mixing select/include
    validateSelectIncludeEntries(
      doc,
      arrayArg,
      fields,
      modelName,
      diagnostics,
      modelMap
    );
  });

  collection.set(doc.uri, diagnostics);
}

export async function validateUpsertCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const diagnostics: vscode.Diagnostic[] = [];
  const modelMap = await getModelMap();
  const ast = phpEngine.parseCode(doc.getText(), doc.fileName);

  walk(ast, (node) => {
    if (node.kind !== "call") {
      return;
    }

    const call = node as Call;
    if (!isPropLookup(call.what)) {
      return;
    }

    // only upsert()
    const opName = nodeName(call.what.offset);
    if (opName !== "upsert") {
      return;
    }

    // get Model
    const mdlChain = call.what.what;
    if (!isPropLookup(mdlChain)) {
      return;
    }
    const modelName = nodeName(mdlChain.offset);
    if (typeof modelName !== "string") {
      return;
    }

    // must be prisma
    const base = mdlChain.what;
    if (!(isVariable(base) && base.name === "prisma")) {
      return;
    }

    // first arg must be an array literal
    const arg0 = call.arguments?.[0];
    if (!isArray(arg0)) {
      return;
    }

    // forbid mixing select/include
    if (validateSelectIncludeExclusivity(arg0, doc, diagnostics)) {
      collection.set(doc.uri, diagnostics);
      return;
    }

    const items = arg0.items as Entry[];

    // pick out where, update & create
    const whereEntry = items.find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "where"
    ) as Entry | undefined;
    const updateEntry = items.find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "update"
    ) as Entry | undefined;
    const createEntry = items.find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "create"
    ) as Entry | undefined;

    // require all three
    if (!whereEntry || !updateEntry || !createEntry) {
      const missing = [
        !whereEntry ? "'where'" : null,
        !updateEntry ? "'update'" : null,
        !createEntry ? "'create'" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, call.loc!),
          `upsert() requires ${missing}.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      return;
    }

    // lookup schema
    const fields =
      modelMap.get(modelName.toLowerCase()) ?? new Map<string, FieldInfo>();
    if (!fields.size) {
      return;
    }

    // ── validate WHERE ──
    if (!isArray(whereEntry.value)) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, whereEntry.key!.loc!),
          "`where` must be an array literal.",
          vscode.DiagnosticSeverity.Error
        )
      );
    } else {
      validateWhereArray(doc, whereEntry.value, fields, modelName, diagnostics);
    }

    // ── validate UPDATE ──
    if (!isArray(updateEntry.value)) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, updateEntry.key!.loc!),
          "`update` must be an array literal.",
          vscode.DiagnosticSeverity.Error
        )
      );
    } else {
      for (const item of (updateEntry.value as PhpArray).items as Entry[]) {
        if (!item.key || item.key.kind !== "string") {
          continue;
        }
        const key = (item.key as any).value as string;

        // top‐level Prisma ops
        if (PRISMA_OPERATORS.has(key)) {
          continue;
        }

        const value = item.value;
        if (isArray(value)) {
          validateFieldAssignments(
            doc,
            printArrayLiteral(value),
            value.loc!.start.offset,
            fields,
            modelName,
            diagnostics
          );
          continue;
        }

        const info = fields.get(key);
        const keyRange = rangeOf(doc, item.key.loc!);
        if (!info) {
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `The column "${key}" does not exist in ${modelName}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        const raw = doc.getText(rangeOf(doc, value.loc!)).trim();
        if (!isValidPhpType(raw, info)) {
          const expected = info.isList ? `${info.type}[]` : info.type;
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `"${key}" expects ${expected}, but received "${raw}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }

    // ── validate CREATE ──
    if (!isArray(createEntry.value)) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, createEntry.key!.loc!),
          "`create` must be an array literal.",
          vscode.DiagnosticSeverity.Error
        )
      );
    } else {
      for (const item of (createEntry.value as PhpArray).items as Entry[]) {
        if (!item.key || item.key.kind !== "string") {
          continue;
        }
        const key = (item.key as any).value as string;

        if (PRISMA_OPERATORS.has(key)) {
          continue;
        }

        const value = item.value;
        if (isArray(value)) {
          validateFieldAssignments(
            doc,
            printArrayLiteral(value),
            value.loc!.start.offset,
            fields,
            modelName,
            diagnostics
          );
          continue;
        }

        const info = fields.get(key);
        const keyRange = rangeOf(doc, item.key.loc!);
        if (!info) {
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `The column "${key}" does not exist in ${modelName}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        const raw = doc.getText(rangeOf(doc, value.loc!)).trim();
        if (!isValidPhpType(raw, info)) {
          const expected = info.isList ? `${info.type}[]` : info.type;
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `"${key}" expects ${expected}, but received "${raw}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }

    // ── validate select/include at top level ──
    validateSelectIncludeEntries(
      doc,
      arg0,
      fields,
      modelName,
      diagnostics,
      modelMap
    );
  });

  collection.set(doc.uri, diagnostics);
}

export async function validateGroupByCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const diagnostics: vscode.Diagnostic[] = [];
  const modelMap = await getModelMap();
  const ast = phpEngine.parseCode(doc.getText(), doc.fileName);

  walk(ast, (node) => {
    if (node.kind !== "call") {
      return;
    }
    const call = node as Call;
    if (!isPropLookup(call.what)) {
      return;
    }

    // only groupBy()
    if (nodeName(call.what.offset) !== "groupBy") {
      return;
    }

    // $prisma->Model
    const mdlChain = call.what.what;
    if (!isPropLookup(mdlChain)) {
      return;
    }
    const modelName = nodeName(mdlChain.offset);
    if (typeof modelName !== "string") {
      return;
    }

    // ensure prisma
    if (!(isVariable(mdlChain.what) && mdlChain.what.name === "prisma")) {
      return;
    }

    // args must be array
    const arg0 = call.arguments?.[0];
    if (!isArray(arg0)) {
      return;
    }

    // forbid select/include
    if (validateSelectIncludeExclusivity(arg0, doc, diagnostics)) {
      collection.set(doc.uri, diagnostics);
      return;
    }

    const items = arg0.items as Entry[];

    // require 'by'
    const byEntry = items.find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "by"
    ) as Entry | undefined;
    if (!byEntry) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, call.loc!),
          "groupBy() requires a 'by' block.",
          vscode.DiagnosticSeverity.Error
        )
      );
      return;
    }

    // the value of 'by' can be:
    //  • an array literal of string or variable/property
    //  • OR a bare variable/property itself
    const byValue = byEntry.value;

    // fetch your model’s fields once
    const fields =
      modelMap.get(modelName.toLowerCase()) ?? new Map<string, FieldInfo>();

    if (isArray(byValue)) {
      // array literal: allow strings or vars/props
      for (const ent of (byValue as PhpArray).items as Entry[]) {
        const v = ent.value;
        // ① string literal → verify it’s a real column
        if (v.kind === "string") {
          const col = (v as any).value as string;
          if (!fields.has(col)) {
            diagnostics.push(
              new vscode.Diagnostic(
                rangeOf(doc, v.loc!),
                `The column "${col}" does not exist in ${modelName}.`,
                vscode.DiagnosticSeverity.Error
              )
            );
          }
          continue;
        }
        // ② variable or property lookup → accept dynamically
        if (isVariable(v) || isPropLookup(v)) {
          continue;
        }
        // otherwise it’s invalid
        diagnostics.push(
          new vscode.Diagnostic(
            rangeOf(doc, ent.loc!),
            "`by` elements must be string literals or a PHP variable/property.",
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    } else if (isVariable(byValue) || isPropLookup(byValue)) {
      // bare variable/property → ok
    } else {
      // neither array nor var/prop → error
      diagnostics.push(
        new vscode.Diagnostic(
          rangeOf(doc, byValue.loc!),
          "`by` must be either an array of column names (or PHP vars) or a PHP variable/property.",
          vscode.DiagnosticSeverity.Error
        )
      );
    }
    // ------------------------------------------------------------

    // schema lookup once
    if (!fields.size) {
      return;
    }

    // optional 'where'
    const whereEntry = items.find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "where"
    );
    if (whereEntry) {
      if (!isArray(whereEntry.value)) {
        diagnostics.push(
          new vscode.Diagnostic(
            rangeOf(doc, whereEntry.key!.loc!),
            "`where` must be an array literal.",
            vscode.DiagnosticSeverity.Error
          )
        );
      } else {
        validateWhereArray(
          doc,
          whereEntry.value,
          fields,
          modelName,
          diagnostics
        );
      }
    }

    // **custom orderBy validation**
    const orderEntry = items.find(
      (e) => e.key?.kind === "string" && (e.key as any).value === "orderBy"
    );
    if (orderEntry) {
      if (!isArray(orderEntry.value)) {
        diagnostics.push(
          new vscode.Diagnostic(
            rangeOf(doc, orderEntry.key!.loc!),
            "`orderBy` must be an array literal.",
            vscode.DiagnosticSeverity.Error
          )
        );
      } else {
        const arr = orderEntry.value as PhpArray;
        for (const cell of arr.items as Entry[]) {
          if (!cell.key || cell.key.kind !== "string") {
            continue;
          }
          const col = (cell.key as any).value as string;
          const keyRange = rangeOf(doc, cell.key.loc!);
          if (!fields.has(col)) {
            diagnostics.push(
              new vscode.Diagnostic(
                keyRange,
                `The column "${col}" does not exist in ${modelName}.`,
                vscode.DiagnosticSeverity.Error
              )
            );
            continue;
          }
          // value must be 'asc' or 'desc'
          const raw = doc
            .getText(rangeOf(doc, cell.value.loc!))
            .trim()
            .replace(/^['"]|['"]$/g, "");
          if (raw !== "asc" && raw !== "desc") {
            diagnostics.push(
              new vscode.Diagnostic(
                rangeOf(doc, cell.value.loc!),
                `Invalid sort direction "${raw}" for "${col}". Allowed: "asc", "desc".`,
                vscode.DiagnosticSeverity.Error
              )
            );
          }
        }
      }
    }

    // aggregations (_count, _max, …)
    const validateAgg = (keyName: string) => {
      const entry = items.find(
        (e) => e.key?.kind === "string" && (e.key as any).value === keyName
      ) as Entry | undefined;
      if (!entry) {
        return;
      }
      if (!isArray(entry.value)) {
        diagnostics.push(
          new vscode.Diagnostic(
            rangeOf(doc, entry.key!.loc!),
            `\`${keyName}\` must be an array literal.`,
            vscode.DiagnosticSeverity.Error
          )
        );
        return;
      }
      const arr = entry.value as PhpArray;
      for (const cell of arr.items as Entry[]) {
        if (!cell.key || cell.key.kind !== "string") {
          continue;
        }
        const col = (cell.key as any).value as string;
        const keyRange = rangeOf(doc, cell.key.loc!);
        if (!fields.has(col)) {
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `The column "${col}" does not exist in ${modelName}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }
        const raw = doc.getText(rangeOf(doc, cell.value.loc!)).trim();
        if (!/^(true|false)$/i.test(raw)) {
          diagnostics.push(
            new vscode.Diagnostic(
              rangeOf(doc, cell.value.loc!),
              `\`${keyName}.${col}\` expects a boolean, but got "${raw}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    };
    for (const agg of ["_count", "_max", "_min", "_avg", "_sum"] as const) {
      validateAgg(agg);
    }

    // final select/include check
    validateSelectIncludeEntries(
      doc,
      arg0,
      fields,
      modelName,
      diagnostics,
      modelMap
    );
  });

  collection.set(doc.uri, diagnostics);
}

export async function validateAggregateCall(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const diagnostics: vscode.Diagnostic[] = [];
  const modelMap = await getModelMap();
  const ast = phpEngine.parseCode(doc.getText(), doc.fileName);

  walk(ast, (node) => {
    if (node.kind !== "call") {
      return;
    }
    const call = node as Call;
    if (!isPropLookup(call.what)) {
      return;
    }

    // only $prisma->Model->aggregate()
    const opName = nodeName(call.what.offset);
    if (opName !== "aggregate") {
      return;
    }

    // …->Model
    const mdlChain = call.what.what;
    if (!isPropLookup(mdlChain)) {
      return;
    }
    const modelName = nodeName(mdlChain.offset);
    if (typeof modelName !== "string") {
      return;
    }

    // must be prisma
    const base = mdlChain.what;
    if (!(isVariable(base) && base.name === "prisma")) {
      return;
    }

    // first arg must be an array literal
    const arg0 = call.arguments?.[0];
    if (!isArray(arg0)) {
      return;
    }
    const items = arg0.items as Entry[];

    // lookup schema fields
    const fields =
      modelMap.get(modelName.toLowerCase()) ?? new Map<string, FieldInfo>();
    if (!fields.size) {
      return;
    }

    // keys we support
    const AGG_KEYS = ["_avg", "_count", "_min", "_max", "_sum"] as const;

    for (const agg of AGG_KEYS) {
      const entry = items.find(
        (e) => e.key?.kind === "string" && (e.key as any).value === agg
      ) as Entry | undefined;
      if (!entry) {
        continue;
      }

      // must be array literal
      if (!isArray(entry.value)) {
        diagnostics.push(
          new vscode.Diagnostic(
            rangeOf(doc, entry.key!.loc!),
            `\`${agg}\` must be an array literal.`,
            vscode.DiagnosticSeverity.Error
          )
        );
        continue;
      }

      // validate each column => boolean
      const arr = entry.value as PhpArray;
      for (const cell of arr.items as Entry[]) {
        if (!cell.key || cell.key.kind !== "string") {
          continue;
        }
        const col = (cell.key as any).value as string;
        const keyRange = rangeOf(doc, cell.key.loc!);

        // unknown column?
        if (!fields.has(col)) {
          diagnostics.push(
            new vscode.Diagnostic(
              keyRange,
              `The column "${col}" does not exist in ${modelName}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
          continue;
        }

        // value must be true|false
        const raw = doc.getText(rangeOf(doc, cell.value.loc!)).trim();
        if (!/^(true|false)$/i.test(raw)) {
          diagnostics.push(
            new vscode.Diagnostic(
              rangeOf(doc, cell.value.loc!),
              `\`${agg}.${col}\` expects a boolean, but got "${raw}".`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }
  });

  collection.set(doc.uri, diagnostics);
}
