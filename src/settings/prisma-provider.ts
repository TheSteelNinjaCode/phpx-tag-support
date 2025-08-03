import {
  Call,
  Entry,
  Identifier,
  Node,
  Array as PhpArray,
  PropertyLookup,
  Variable,
} from "php-parser";
import * as vscode from "vscode";
import { Diagnostic, Range, TextDocument } from "vscode";
import { findPrismaCalls } from "../analysis/php-ast";
import { phpEngine } from "../util/php-engine";

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

interface CompletionContext {
  doc: vscode.TextDocument;
  pos: vscode.Position;
  callNode: Call;
  opName: PrismaOp;
  modelName: string;
  rootKeys: readonly RootKey[];
  curOffset: number;
  lastPrisma: number;
  already: string;
  modelMap: ModelMap;
  fieldMap: Map<string, FieldInfo>;
}

interface ArrayContext {
  hostArray: PhpArray;
  entrySide: "key" | "value" | null;
  currentRoot?: RootKey;
  nestedRoot?: string;
  parentKey?: string;
}

interface NestedContext {
  relation?: string;
  parentKey?: string;
  operation?: "select" | "include" | "where" | "omit";
  relationModel?: string;
  relationChain?: RelationChainItem[]; // NEW: Full relation chain
}

interface ArrayContext {
  hostArray: PhpArray;
  entrySide: "key" | "value" | null;
  currentRoot?: RootKey;
  nestedRoot?: string;
  parentKey?: string;
  nestedOperation?: "select" | "include" | "where" | "omit";
  relationChain?: RelationChainItem[]; // NEW: Full chain of relations
}

interface RelationChainItem {
  relationName: string;
  operation: "select" | "include" | "where" | "omit";
  modelType: string; // The target model type
}

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
const RELATION_OPERATORS = ["every", "none", "some"] as const;
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

function findParentKey(arr: PhpArray, target: PhpArray): string | undefined {
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
  return undefined;
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

// ========== MAIN PROVIDER FUNCTION ==========
export function registerPrismaFieldProvider(): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(
    "php",
    {
      async provideCompletionItems(doc, pos) {
        const context = await parseCompletionContext(doc, pos);
        if (!context) {
          return;
        }

        const arrayContext = analyzeArrayContext(context);
        if (!arrayContext) {
          return;
        }

        return generateCompletions(context, arrayContext);
      },
    },
    "'", // single-quote trigger
    '"' // double-quote trigger
  );
}

// ========== CONTEXT PARSING ==========
async function parseCompletionContext(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<CompletionContext | null> {
  const parsedCode = extractAndParseCode(doc, pos);
  if (!parsedCode) {
    return null;
  }

  const { ast, lastPrisma, already } = parsedCode;

  const callInfo = findPrismaCall(ast);
  if (!callInfo) {
    return null;
  }

  const { callNode, opName, modelName } = callInfo;
  const rootKeys = ROOT_KEYS_MAP[opName] as readonly RootKey[];
  const curOffset = doc.offsetAt(pos);
  const modelMap = await getModelMap();
  const fieldMap = modelMap.get(modelName.toLowerCase());

  if (!fieldMap) {
    return null;
  }

  return {
    doc,
    pos,
    callNode,
    opName,
    modelName,
    rootKeys,
    curOffset,
    lastPrisma,
    already,
    modelMap,
    fieldMap,
  };
}

function extractAndParseCode(doc: vscode.TextDocument, pos: vscode.Position) {
  const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), pos));
  const lastPrisma = before.lastIndexOf("$prisma->");

  if (lastPrisma === -1) {
    return null;
  }

  const tail = before.slice(lastPrisma);
  const alreadyMatch = /['"]([\w]*)$/.exec(before);
  const already = alreadyMatch ? alreadyMatch[1] : "";

  try {
    const ast = phpEngine.parseEval(tail);
    return { ast, lastPrisma, already };
  } catch {
    return null;
  }
}

function findPrismaCall(
  ast: Node
): { callNode: Call; opName: PrismaOp; modelName: string } | null {
  let result: {
    callNode: Call;
    opName: PrismaOp;
    modelName: string;
  } | null = null;

  walk(ast, (node) => {
    if (result || node.kind !== "call") {
      return;
    }

    const call = node as Call;
    if (!isPropLookup(call.what)) {
      return;
    }

    const op = nodeName(call.what.offset) as PrismaOp;
    if (!(op in ROOT_KEYS_MAP)) {
      return;
    }

    const modelChain = call.what.what;
    if (!isPropLookup(modelChain)) {
      return;
    }

    const model = nodeName(modelChain.offset);
    if (!model || typeof model !== "string") {
      return;
    }

    result = {
      callNode: call,
      opName: op,
      modelName: model, // keep as string, lowercase later if needed
    };
  });

  return result;
}

// ========== ARRAY CONTEXT ANALYSIS ==========
function analyzeArrayContext(context: CompletionContext): ArrayContext | null {
  const { callNode, curOffset, lastPrisma } = context;

  const argsArr = callNode.arguments?.[0];
  if (!isArray(argsArr)) {
    return null;
  }

  const hostArray = arrayUnderCursor(argsArr, curOffset, lastPrisma);
  if (!hostArray) {
    return null;
  }

  const entrySide = determineEntrySide(hostArray, curOffset, lastPrisma);
  const currentRoot = findCurrentRoot(
    argsArr,
    curOffset,
    lastPrisma,
    context.rootKeys
  );

  // **FIXED**: Enhanced nested context detection
  const nestedContext = findNestedContext(argsArr, hostArray, currentRoot);

  // **FIXED**: Better relation chain resolution
  const relationChain = nestedContext?.relationChain
    ? resolveRelationChain(nestedContext.relationChain, context)
    : [];

  return {
    hostArray,
    entrySide,
    currentRoot,
    nestedRoot: nestedContext?.relation,
    parentKey: nestedContext?.parentKey,
    nestedOperation: nestedContext?.operation,
    relationChain,
  };
}

function resolveRelationChain(
  chain: RelationChainItem[],
  context: CompletionContext
): RelationChainItem[] {
  const { modelMap, fieldMap } = context;
  const resolvedChain: RelationChainItem[] = [];

  let currentFields = fieldMap; // Start with the base model fields

  for (const item of chain) {
    const relationInfo = currentFields.get(item.relationName);

    if (relationInfo) {
      const modelType = relationInfo.type;
      const resolvedItem = {
        ...item,
        modelType,
      };
      resolvedChain.push(resolvedItem);

      // Move to the next model's fields for the next iteration
      currentFields = modelMap.get(modelType.toLowerCase()) || new Map();
    } else {
      // If we can't resolve, stop the chain here
      break;
    }
  }

  return resolvedChain;
}

function findNestedContext(
  argsArr: PhpArray,
  hostArray: PhpArray,
  currentRoot?: RootKey
): NestedContext | null {
  if (!currentRoot || !isArray(argsArr) || hostArray === argsArr) {
    return null;
  }

  // Get the full path from root to current array
  const path = findArrayPath(argsArr, hostArray);
  if (!path || path.length === 0) {
    return null;
  }

  // **NEW: Special handling for _count**
  if (isCountContext(path)) {
    const countIndex = path.indexOf("_count");
    if (countIndex !== -1 && countIndex < path.length - 1) {
      // We're inside _count, the next element should be the operation (like "select")
      const operation = path[countIndex + 1];
      if (["select", "where", "orderBy"].includes(operation)) {
        return {
          relation: "_count",
          operation: operation as "select" | "include" | "where" | "omit",
          parentKey: "_count",
          relationChain: [
            {
              relationName: "_count",
              operation: operation as "select" | "include" | "where" | "omit",
              modelType: "Count",
            },
          ],
        };
      }
    }
  }

  // Parse the path to build relation chain (existing logic)
  const relationChain = parsePathToRelationChain(path, currentRoot);

  if (relationChain.length > 0) {
    const lastRelation = relationChain[relationChain.length - 1];
    return {
      relation: lastRelation.relationName,
      operation: lastRelation.operation,
      parentKey: lastRelation.relationName,
      relationChain,
    };
  }

  return null;
}

function isCountContext(path: string[]): boolean {
  // Check if we're inside a _count block
  return path.includes("_count");
}

function parsePathToRelationChain(
  path: string[],
  rootOperation: RootKey
): RelationChainItem[] {
  const chain: RelationChainItem[] = [];

  // Example paths:
  // ["select", "userRole"] -> userRole relation, operation = "select" (parent operation)
  // ["select", "userRole", "select"] -> userRole relation, operation = "select" (explicit)
  // ["select", "userRole", "select", "menu"] -> menu relation in userRole.select
  // ["select", "userRole", "select", "menu", "select"] -> menu relation, operation = "select"

  let i = 1; // Skip the root operation (like "select")

  while (i < path.length) {
    const segment = path[i];

    // Skip if this segment is an operation keyword
    if (["select", "include", "where", "omit", "orderBy"].includes(segment)) {
      i++;
      continue;
    }

    // This must be a relation name
    const relationName = segment;

    // **FIXED**: Determine the operation context
    let operation: "select" | "include" | "where" | "omit";

    // Check if next segment is an operation
    if (
      i + 1 < path.length &&
      ["select", "include", "where", "omit"].includes(path[i + 1])
    ) {
      operation = path[i + 1] as "select" | "include" | "where" | "omit";
      i++; // Skip the operation in next iteration
    } else {
      // No explicit operation yet, use parent operation
      operation = rootOperation as "select" | "include" | "where" | "omit";
    }

    chain.push({
      relationName,
      operation,
      modelType: "", // Will be resolved later
    });

    i++;
  }

  return chain;
}

function buildRelationChainFromPath(
  path: string[],
  rootOperation: RootKey
): RelationChainItem[] {
  const chain: RelationChainItem[] = [];

  // Path structure examples:
  // ["select", "userRole"] -> userRole relation with select operation
  // ["select", "userRole", "select"] -> userRole.select
  // ["select", "userRole", "select", "menu"] -> userRole.select.menu
  // ["select", "userRole", "select", "menu", "select"] -> userRole.select.menu.select

  if (path.length < 2) {
    return chain;
  }

  // Start from index 1 (skip root operation like "select")
  for (let i = 1; i < path.length; i++) {
    const segment = path[i];

    // If this segment is an operation, skip it (it applies to the previous relation)
    if (["select", "include", "where", "omit", "orderBy"].includes(segment)) {
      continue;
    }

    // This is a relation name
    const relationName = segment;

    // Look ahead to see if there's an operation after this relation
    let operation: "select" | "include" | "where" | "omit" =
      rootOperation as any;
    if (
      i + 1 < path.length &&
      ["select", "include", "where", "omit"].includes(path[i + 1])
    ) {
      operation = path[i + 1] as "select" | "include" | "where" | "omit";
    }

    chain.push({
      relationName,
      operation,
      modelType: "", // Will be resolved later
    });
  }

  return chain;
}

function determineFieldSuggestions(
  context: CompletionContext,
  arrayContext: ArrayContext
): [string, FieldInfo][] {
  const { fieldMap, modelMap } = context;
  const { currentRoot, relationChain, nestedOperation, nestedRoot } =
    arrayContext;

  // **FIXED: Handle _count -> select context first**
  if (relationChain && relationChain.length > 0) {
    const lastRelation = relationChain[relationChain.length - 1];

    if (
      lastRelation.relationName === "_count" &&
      lastRelation.operation === "select"
    ) {
      // For _count -> select, show only relations (not scalar fields) and NOT _count itself
      const allFields = [...fieldMap.entries()];
      const relations = filterFieldsByOperation(allFields, "include", modelMap);

      // **IMPORTANT: Don't add _count here since we're already inside _count**
      return relations;
    }
  }

  // **Case 1: Deep nested relations using the relation chain**
  if (relationChain && relationChain.length > 0) {
    let currentFields = fieldMap; // Start with base model
    let targetFields = currentFields;

    // Walk through the chain to find the target model
    for (let i = 0; i < relationChain.length; i++) {
      const relation = relationChain[i];

      // Skip _count processing in the chain since it's handled above
      if (relation.relationName === "_count") {
        continue;
      }

      const relationInfo = currentFields.get(relation.relationName);

      if (relationInfo) {
        const targetModelName = relationInfo.type.toLowerCase();
        const targetModel = modelMap.get(targetModelName);

        if (targetModel) {
          // Update the relation's model type
          relation.modelType = relationInfo.type;
          targetFields = targetModel;
          currentFields = targetModel; // Move to next level for nested relations
        }
      }
    }

    // Return fields from the final target model
    const allFields = [...targetFields.entries()];
    const lastRelation = relationChain[relationChain.length - 1];
    return filterFieldsByOperation(allFields, lastRelation.operation, modelMap);
  }

  // **Case 2: Simple nested relation (backward compatibility)**
  if (nestedRoot && nestedRoot !== "_count" && fieldMap.has(nestedRoot)) {
    const relationInfo = fieldMap.get(nestedRoot);
    if (relationInfo) {
      const relationModelName = relationInfo.type.toLowerCase();
      const relationFields = modelMap.get(relationModelName);
      if (relationFields) {
        const allFields = [...relationFields.entries()];
        const operation = nestedOperation || currentRoot || "select";
        return filterFieldsByOperation(allFields, operation, modelMap);
      }
    }
  }

  // **Case 3: Special cases**
  if (currentRoot === "_count") {
    return [
      [
        "select",
        { type: "boolean", required: false, isList: false, nullable: true },
      ],
    ];
  }

  // **Case 4: Include at root level - only show relations**
  if (currentRoot === "include") {
    // **CHECK: Make sure we're not inside a nested _count context**
    const path = findArrayPath(
      context.callNode.arguments?.[0] as PhpArray,
      arrayContext.hostArray
    );

    // If we're inside _count, don't add _count again
    if (path && isCountContext(path)) {
      const allFields = [...fieldMap.entries()];
      return filterFieldsByOperation(allFields, "include", modelMap);
    }

    // Normal include at root level - add _count
    const allFields = [...fieldMap.entries()];
    const relations = filterFieldsByOperation(allFields, "include", modelMap);
    relations.push([
      "_count",
      { type: "boolean", required: false, isList: false, nullable: true },
    ]);
    return relations;
  }

  // **Case 5: Default - return base model fields**
  const allFields = [...fieldMap.entries()];
  return filterFieldsByOperation(allFields, currentRoot || "select", modelMap);
}

function findArrayPath(
  rootArray: PhpArray,
  targetArray: PhpArray,
  currentPath: string[] = []
): string[] | null {
  if (rootArray === targetArray) {
    return currentPath;
  }

  for (const entry of rootArray.items as Entry[]) {
    if (entry.key?.kind === "string") {
      const keyName = (entry.key as any).value as string;
      const newPath = [...currentPath, keyName];

      if (entry.value === targetArray) {
        return newPath;
      }

      if (isArray(entry.value)) {
        const subPath = findArrayPath(
          entry.value as PhpArray,
          targetArray,
          newPath
        );
        if (subPath) {
          return subPath;
        }
      }
    }
  }

  return null;
}

function determineEntrySide(
  hostArray: PhpArray,
  curOffset: number,
  lastPrisma: number
): "key" | "value" | null {
  for (const entry of hostArray.items.filter(isEntry)) {
    const side = sectionOfEntry(entry, curOffset, lastPrisma);
    if (side) {
      return side;
    }
  }
  return null;
}

function findCurrentRoot(
  argsArr: PhpArray,
  curOffset: number,
  lastPrisma: number,
  rootKeys: readonly RootKey[]
): RootKey | undefined {
  for (const entry of argsArr.items as Entry[]) {
    if (entry.key?.kind !== "string" || !entry.value?.loc) {
      continue;
    }

    const key = (entry.key as any).value as RootKey;
    if (!rootKeys.includes(key)) {
      continue;
    }

    const start = lastPrisma + entry.value.loc.start.offset;
    const end = lastPrisma + entry.value.loc.end.offset;

    if (curOffset >= start && curOffset <= end) {
      return key;
    }
  }
  return undefined;
}

// ========== COMPLETION GENERATION ==========
function generateCompletions(
  context: CompletionContext,
  arrayContext: ArrayContext
): vscode.CompletionItem[] {
  const { currentRoot, entrySide, parentKey } = arrayContext;

  // Root key completions (top-level array)
  if (shouldProvideRootKeys(context, arrayContext)) {
    return createRootKeyCompletions(context);
  }

  if (
    entrySide === "key" &&
    parentKey &&
    RELATION_OPERATORS.includes(parentKey as any)
  ) {
    return createFieldCompletions(context, arrayContext);
  }

  // Where clause completions
  if (entrySide === "key" && currentRoot === "where") {
    // Check if we're in a relation field context
    const parentField = getParentFieldName(context, arrayContext);
    if (parentField && context.fieldMap.has(parentField)) {
      const fieldInfo = context.fieldMap.get(parentField)!;
      if (isRelationField(fieldInfo, context.modelMap)) {
        // We're inside a relation field's where clause - show relation operators
        return createRelationOperatorCompletions(
          context,
          parentField,
          fieldInfo
        );
      }
    }

    // Otherwise, use the standard where completions
    return createWhereCompletions(context, arrayContext);
  }

  const specialCompletions = handleSpecialCompletions(context, arrayContext);
  if (specialCompletions) {
    return specialCompletions;
  }

  if (shouldProvideFieldCompletions(currentRoot, entrySide)) {
    return createFieldCompletions(context, arrayContext);
  }

  return [];
}

/**
 * Gets the immediate parent field name for the current array context
 */
function getParentFieldName(
  context: CompletionContext,
  arrayContext: ArrayContext
): string | null {
  const { callNode } = context;
  const { hostArray } = arrayContext;

  const argsArray = callNode.arguments?.[0] as PhpArray;
  if (!argsArray) {
    return null;
  }

  // Look for the parent entry that contains our host array
  function findParentField(
    arr: PhpArray,
    target: PhpArray,
    currentPath: string[] = []
  ): string | null {
    for (const item of arr.items as Entry[]) {
      if (!item.key || item.key.kind !== "string") {
        continue;
      }

      const keyName = (item.key as any).value as string;
      const newPath = [...currentPath, keyName];

      if (item.value === target) {
        // Found our target - return the last non-operator field in the path
        for (let i = newPath.length - 1; i >= 0; i--) {
          const segment = newPath[i];
          if (
            !["where", "AND", "OR", "NOT", "every", "none", "some"].includes(
              segment
            )
          ) {
            return segment;
          }
        }
      }

      if (isArray(item.value)) {
        const result = findParentField(item.value as PhpArray, target, newPath);
        if (result) {
          return result;
        }
      }
    }
    return null;
  }

  return findParentField(argsArray, hostArray);
}

function shouldProvideRootKeys(
  context: CompletionContext,
  arrayContext: ArrayContext
): boolean {
  const { callNode, curOffset, lastPrisma } = context;
  const { hostArray } = arrayContext;

  const argsArr = callNode.arguments?.[0];
  if (!isArray(argsArr) || !argsArr.loc) {
    return false;
  }

  const arrStart = lastPrisma + argsArr.loc.start.offset;
  const arrEnd = lastPrisma + argsArr.loc.end.offset;

  if (curOffset < arrStart || curOffset > arrEnd) {
    return false;
  }
  if (hostArray !== argsArr) {
    return false;
  }

  // Check if we have any unused root keys available
  const usedKeys = getUsedKeys(context);
  const hasAvailableKeys = context.rootKeys.some((key) => !usedKeys.has(key));

  if (!hasAvailableKeys) {
    return false; // All keys are already used
  }

  // Check if we're not inside any nested block
  return !(argsArr.items as Entry[]).some((item) => {
    if (item.key?.kind !== "string") {
      return false;
    }

    const key = (item.key as any).value as RootKey;
    if (!context.rootKeys.includes(key)) {
      return false;
    }
    if (!item.value?.loc) {
      return false;
    }

    const start = lastPrisma + item.value.loc.start.offset;
    const end = lastPrisma + item.value.loc.end.offset;
    return curOffset >= start && curOffset <= end;
  });
}

function createRootKeyCompletions(
  context: CompletionContext
): vscode.CompletionItem[] {
  const { rootKeys, pos, already, doc, callNode, lastPrisma } = context;

  // Get already used keys from the current array
  const usedKeys = getUsedKeys(context);

  // Filter out already used keys
  const availableKeys = rootKeys.filter((key) => !usedKeys.has(key));

  return availableKeys.map((rootKey): vscode.CompletionItem => {
    const item = new vscode.CompletionItem(
      `${rootKey}`,
      vscode.CompletionItemKind.Keyword
    );
    item.insertText = new vscode.SnippetString(`${rootKey}' => $0`);
    item.range = makeReplaceRange(doc, pos, already.length);
    return item;
  });
}

function getUsedKeys(context: CompletionContext): Set<RootKey> {
  const { callNode } = context;
  const usedKeys = new Set<RootKey>();

  const argsArr = callNode.arguments?.[0];
  if (!isArray(argsArr)) {
    return usedKeys;
  }

  // Check all entries in the top-level array
  for (const item of argsArr.items as Entry[]) {
    if (item.key?.kind === "string") {
      const keyName = (item.key as any).value as string;
      if (context.rootKeys.includes(keyName as RootKey)) {
        usedKeys.add(keyName as RootKey);
      }
    }
  }

  return usedKeys;
}

function handleSpecialCompletions(
  context: CompletionContext,
  arrayContext: ArrayContext
): vscode.CompletionItem[] | null {
  const { currentRoot, entrySide, nestedOperation, relationChain } =
    arrayContext;

  // OrderBy value completions
  if (currentRoot === "orderBy" && entrySide === "value") {
    return createOrderByValueCompletions(context);
  }

  // Boolean value completions
  if (currentRoot === "skipDuplicates" && entrySide === "value") {
    return createBooleanCompletions(context);
  }

  // Where clause completions
  if (currentRoot === "where") {
    return createWhereCompletions(context, arrayContext);
  }

  return null;
}

function createOrderByValueCompletions(
  context: CompletionContext
): vscode.CompletionItem[] {
  const { pos, already, doc } = context;

  return ["asc", "desc"].map((direction) => {
    const item = new vscode.CompletionItem(
      direction,
      vscode.CompletionItemKind.Value
    );
    item.insertText = new vscode.SnippetString(`${direction}'`);
    item.range = makeReplaceRange(doc, pos, already.length);
    return item;
  });
}

function createBooleanCompletions(
  context: CompletionContext
): vscode.CompletionItem[] {
  const { pos, already, doc } = context;

  return ["true", "false"].map((value) => {
    const item = new vscode.CompletionItem(
      value,
      vscode.CompletionItemKind.Value
    );
    item.insertText = new vscode.SnippetString(`${value}`);
    item.range = makeReplaceRange(doc, pos, already.length);
    return item;
  });
}

function createWhereCompletions(
  context: CompletionContext,
  arrayContext: ArrayContext
): vscode.CompletionItem[] {
  const { fieldMap, pos, already, doc, modelMap } = context;
  const { hostArray, parentKey } = arrayContext;

  // Top-level WHERE: columns + combinators
  if (isTopLevelWhere(context, arrayContext)) {
    return [
      ...createFieldCompletions(context, arrayContext),
      ...createCombinatorCompletions(context),
    ];
  }

  // Inside AND|OR|NOT: only columns
  if (parentKey && ["AND", "OR", "NOT"].includes(parentKey)) {
    return createFieldCompletions(context, arrayContext);
  }

  // **FIXED: Check if we're inside a relation field**
  const relationContext = getRelationContext(context, arrayContext);
  if (relationContext) {
    const { fieldName, fieldInfo } = relationContext;

    if (isRelationField(fieldInfo, modelMap)) {
      // We're in a relation field - suggest relation operators
      return createRelationOperatorCompletions(context, fieldName, fieldInfo);
    }
  }

  // Inside field filter: only operators (existing logic)
  return FILTER_OPERATORS.filter(
    (op) => !RELATION_OPERATORS.includes(op as any) // Don't show relation operators for scalar fields
  ).map((operator) => {
    const item = new vscode.CompletionItem(
      operator,
      vscode.CompletionItemKind.Keyword
    );
    item.sortText = `2_${operator}`;
    item.insertText = new vscode.SnippetString(`${operator}' => $0`);
    item.range = makeReplaceRange(doc, pos, already.length);
    return item;
  });
}

function isRelationField(fieldInfo: FieldInfo, modelMap: ModelMap): boolean {
  if (!fieldInfo) {
    return false;
  }

  // Check if the field type exists as a model in our modelMap
  return modelMap.has(fieldInfo.type.toLowerCase());
}

function getRelationContext(
  context: CompletionContext,
  arrayContext: ArrayContext
): { fieldName: string; fieldInfo: FieldInfo } | null {
  const { fieldMap, callNode } = context;
  const { hostArray } = arrayContext;

  const argsArray = callNode.arguments?.[0] as PhpArray;
  if (!argsArray) {
    return null;
  }

  // Find the path from root to current array
  function findPathToArray(
    arr: PhpArray,
    target: PhpArray,
    path: string[] = []
  ): string[] | null {
    if (arr === target) {
      return path;
    }

    for (const item of arr.items as Entry[]) {
      if (!item.key || item.key.kind !== "string") {
        continue;
      }

      const keyName = (item.key as any).value as string;
      const newPath = [...path, keyName];

      if (isArray(item.value)) {
        const result = findPathToArray(item.value as PhpArray, target, newPath);
        if (result) {
          return result;
        }
      }
    }
    return null;
  }

  const path = findPathToArray(argsArray, hostArray);
  if (!path || path.length < 2) {
    return null;
  }

  // Look for the relation field name - skip operators
  for (let i = path.length - 1; i >= 0; i--) {
    const segment = path[i];

    // Skip all Prisma operators and relation operators
    if (
      [
        "where",
        "AND",
        "OR",
        "NOT",
        "every",
        "none",
        "some",
        "include",
        "select",
        "omit",
      ].includes(segment)
    ) {
      continue;
    }

    // Check if this segment is a field in our model
    const fieldInfo = fieldMap.get(segment);
    if (fieldInfo) {
      return { fieldName: segment, fieldInfo };
    }
  }

  return null;
}

function createRelationOperatorCompletions(
  context: CompletionContext,
  fieldName: string,
  fieldInfo: FieldInfo
): vscode.CompletionItem[] {
  const { pos, already, doc } = context;

  return RELATION_OPERATORS.map((operator) => {
    const item = new vscode.CompletionItem(
      operator,
      vscode.CompletionItemKind.Keyword
    );

    item.sortText = `1_${operator}`; // Higher priority than regular operators
    item.insertText = new vscode.SnippetString(`${operator}' => [\n\t$0\n]`);
    item.range = makeReplaceRange(doc, pos, already.length);

    // Add documentation
    const descriptions = {
      every: `All related ${fieldInfo.type} records must match the condition`,
      none: `No related ${fieldInfo.type} records should match the condition`,
      some: `At least one related ${fieldInfo.type} record must match the condition`,
    };

    item.documentation = new vscode.MarkdownString(
      `**${operator}** - ${descriptions[operator]}\n\n` +
        `Use this to filter ${fieldName} relation where ${descriptions[
          operator
        ].toLowerCase()}.`
    );

    return item;
  });
}

function isTopLevelWhere(
  context: CompletionContext,
  arrayContext: ArrayContext
): boolean {
  const { callNode, lastPrisma } = context;
  const { hostArray } = arrayContext;

  const argsArr = callNode.arguments?.[0] as PhpArray;
  const topWhereEntry = (argsArr.items as Entry[]).find(
    (e) =>
      e.key?.kind === "string" &&
      (e.key as any).value === "where" &&
      isArray(e.value)
  );

  return topWhereEntry?.value === hostArray;
}

function createCombinatorCompletions(
  context: CompletionContext
): vscode.CompletionItem[] {
  const { pos, already, doc } = context;

  return ["AND", "OR", "NOT"].map((combinator) => {
    const item = new vscode.CompletionItem(
      combinator,
      vscode.CompletionItemKind.Keyword
    );
    item.sortText = `1_${combinator}`;
    item.insertText = new vscode.SnippetString(`${combinator}' => $0`);
    item.range = makeReplaceRange(doc, pos, already.length);
    return item;
  });
}

function createRelationOperationCompletions(
  context: CompletionContext,
  relationName: string,
  relationModelType: string
): vscode.CompletionItem[] {
  const { pos, already, doc } = context;

  // Enhanced relation operations
  const relationOps = [
    "select",
    "include",
    "omit",
    "where",
    "orderBy",
  ] as const;

  return relationOps.map((op) => {
    const item = new vscode.CompletionItem(
      op,
      vscode.CompletionItemKind.Keyword
    );

    // Provide better snippets based on operation
    switch (op) {
      case "select":
        item.insertText = new vscode.SnippetString(`${op}' => [\n\t$0\n]`);
        item.documentation = new vscode.MarkdownString(
          `**${op}** - Select specific fields from **${relationName}**`
        );
        break;
      case "include":
        item.insertText = new vscode.SnippetString(`${op}' => [\n\t$0\n]`);
        item.documentation = new vscode.MarkdownString(
          `**${op}** - Include related data from **${relationName}**`
        );
        break;
      default:
        item.insertText = new vscode.SnippetString(`${op}' => [\n\t$0\n]`);
    }

    item.range = makeReplaceRange(doc, pos, already.length);

    // Add sort priority
    item.sortText =
      op === "select" ? "0_select" : op === "include" ? "0_include" : `1_${op}`;

    return item;
  });
}

function shouldProvideFieldCompletions(
  currentRoot?: RootKey,
  entrySide?: "key" | "value" | null
): boolean {
  if (!currentRoot || entrySide !== "key") {
    return false;
  }

  const fieldRoots = [
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

  return fieldRoots.includes(currentRoot);
}

function createFieldCompletions(
  context: CompletionContext,
  arrayContext: ArrayContext
): vscode.CompletionItem[] {
  const { fieldMap, pos, already, doc, modelMap } = context;
  const { parentKey } = arrayContext;

  let fieldsToUse = fieldMap;

  // **NEW: Check if we're inside a relation operator context**
  if (parentKey && RELATION_OPERATORS.includes(parentKey as any)) {
    // We're inside every/none/some - get the relation context
    const relationContext = getRelationContext(context, arrayContext);
    if (
      relationContext &&
      isRelationField(relationContext.fieldInfo, modelMap)
    ) {
      const relatedFields = getRelatedModelFields(
        relationContext.fieldInfo,
        modelMap
      );
      if (relatedFields) {
        fieldsToUse = relatedFields; // Use related model's fields instead
      }
    }
  }

  return Array.from(fieldsToUse.entries()).map(([fieldName, fieldInfo]) => {
    const item = new vscode.CompletionItem(
      fieldName,
      vscode.CompletionItemKind.Field
    );

    // Use only the properties that exist on FieldInfo
    item.detail = fieldInfo.type || "Field";
    item.documentation = `Field of type ${fieldInfo.type || "unknown"}`;
    item.sortText = `1_${fieldName}`;
    item.insertText = new vscode.SnippetString(`${fieldName}' => $0`);
    item.range = makeReplaceRange(doc, pos, already.length);

    return item;
  });
}

function getRelatedModelFields(
  fieldInfo: FieldInfo,
  modelMap: Map<string, any>
): Map<string, FieldInfo> | null {
  if (!fieldInfo.type) {
    return null;
  }

  // Extract the related model name from the field type
  // This might be something like "User" or "User[]" depending on your schema
  const relatedModelName = fieldInfo.type.replace(/\[\]$/, ""); // Remove array notation if present
  const relatedModel = modelMap.get(relatedModelName);

  if (!relatedModel || !relatedModel.fields) {
    return null;
  }

  return relatedModel.fields;
}

function filterFieldsByOperation(
  allFields: [string, FieldInfo][],
  operation: string,
  modelMap: ModelMap
): [string, FieldInfo][] {
  if (operation === "include") {
    // For include: only show relations (fields whose type is another model)
    return allFields.filter(([, info]) =>
      Array.from(modelMap.keys()).includes(info.type.toLowerCase())
    );
  }

  if (operation === "select") {
    // For select: show ALL fields (scalars + relations)
    return allFields;
  }

  // For other operations (where, data, etc.): show all fields
  return allFields;
}

function getTargetModelFromChain(
  relationChain: RelationChainItem[],
  modelMap: ModelMap
): Map<string, FieldInfo> | null {
  if (relationChain.length === 0) {
    return null;
  }

  // Get the last relation in the chain - that's our target model
  const lastRelation = relationChain[relationChain.length - 1];
  return modelMap.get(lastRelation.modelType.toLowerCase()) || null;
}

function createWhereFieldCompletions(
  context: CompletionContext,
  suggestions: [string, FieldInfo][]
): vscode.CompletionItem[] {
  const { pos, already, doc } = context;

  return suggestions.map(([name, info]) => {
    const typeStr = `${info.type}${info.isList ? "[]" : ""}`;
    const optional = info.nullable;

    const label: vscode.CompletionItemLabel = {
      label: optional ? `${name}?` : name,
      detail: `: ${typeStr}`,
    };

    const item = new vscode.CompletionItem(
      label,
      vscode.CompletionItemKind.Field
    );

    item.sortText = `0_${name}`;
    item.insertText = new vscode.SnippetString(`${name}' => $0`);
    item.documentation = new vscode.MarkdownString(
      `**Type**: \`${typeStr}\`\n\n- **Required**: ${!info.nullable}\n- **Nullable**: ${
        info.nullable
      }`
    );
    item.range = makeReplaceRange(doc, pos, already.length);
    return item;
  });
}

function createStandardFieldCompletions(
  context: CompletionContext,
  suggestions: [string, FieldInfo][]
): vscode.CompletionItem[] {
  const { pos, already, doc } = context;

  return suggestions.map(([name, info]) => {
    const typeStr = `${info.type}${info.isList ? "[]" : ""}`;
    const optional = info.nullable;

    const label: vscode.CompletionItemLabel = {
      label: optional ? `${name}?` : name,
      detail: `: ${typeStr}`,
    };

    const item = new vscode.CompletionItem(
      label,
      vscode.CompletionItemKind.Field
    );

    item.insertText = new vscode.SnippetString(`${name}' => $0`);
    item.documentation = new vscode.MarkdownString(
      `**Type**: \`${typeStr}\`\n\n- **Required**: ${!info.nullable}\n- **Nullable**: ${
        info.nullable
      }`
    );
    item.range = makeReplaceRange(doc, pos, already.length);
    return item;
  });
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
  diags: vscode.Diagnostic[],
  modelMap: ModelMap
): void {
  /* ——————————————————————— 0. sólo si es array literal ——————————————————— */
  if (!isArray(includeEntry.value) || !includeEntry.value.loc) {
    return;
  }
  const arrNode = includeEntry.value as PhpArray;

  /* ——————————————————————— 1. recorrer cada clave del bloque ————————————————— */
  for (const item of arrNode.items as Entry[]) {
    if (item.key?.kind !== "string" || !item.value) {
      continue;
    }

    const relName = (item.key as any).value as string;
    const keyRange = rangeOf(doc, item.key.loc!);

    /* ——— 1-A. relación inexistente ———————————————————————————————— */
    const relInfo = fields.get(relName);
    if (!relInfo && relName !== "_count") {
      diags.push(
        new vscode.Diagnostic(
          keyRange,
          `The relation "${relName}" does not exist on ${modelName}.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }

    /* ——— 1-B. _count: boolean 𝘰 select-bools ——————————————————————— */
    if (relName === "_count") {
      // i) valor booleano simple
      if (item.value.kind !== "array") {
        const raw = doc.getText(rangeOf(doc, item.value.loc!)).trim();
        if (!/^(true|false)$/i.test(raw)) {
          diags.push(
            new vscode.Diagnostic(
              keyRange,
              "`include._count` expects a boolean or a nested [ 'select' => [...] ] block, " +
                `but got ${JSON.stringify(raw)}.`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
        continue;
      }

      // ii) array literal → debe contener select => [ cols => bool ]
      const countArr = item.value as PhpArray;
      const selEntry = (countArr.items as Entry[]).find(
        (e) => e.key?.kind === "string" && (e.key as any).value === "select"
      );
      if (!selEntry || !isArray(selEntry.value) || !selEntry.value.loc) {
        diags.push(
          new vscode.Diagnostic(
            keyRange,
            "`include._count` array must contain a `select` entry with boolean values.",
            vscode.DiagnosticSeverity.Error
          )
        );
        continue;
      }

      const innerArr = selEntry.value as PhpArray;
      if (!innerArr.loc) {
        continue;
      }
      const start = innerArr.loc.start.offset;
      const end = innerArr.loc.end.offset;
      const literal = doc.getText(
        new vscode.Range(doc.positionAt(start), doc.positionAt(end))
      );

      validateSelectBlock(doc, literal, start, fields, modelName, diags);
      continue;
    }

    /* ——— 1-C. valor booleano normal ———————————————————————————————— */
    if (item.value.kind !== "array") {
      const raw = doc.getText(rangeOf(doc, item.value.loc!)).trim();
      if (!/^(true|false)$/i.test(raw)) {
        diags.push(
          new vscode.Diagnostic(
            keyRange,
            `\`include\` for "${relName}" expects a boolean or a nested array, but got ${JSON.stringify(
              raw
            )}.`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
      continue;
    }

    /* ——— 1-D. array nested ⇒ validar recursivamente ———————————————— */
    const nestedArr = item.value as PhpArray;
    const nestedModel = relInfo!.type.toLowerCase();
    const nestedFlds =
      modelMap.get(nestedModel) ?? new Map<string, FieldInfo>();

    // i) validar select/include/omit/where dentro del bloque anidado
    validateSelectIncludeEntries(
      doc,
      nestedArr,
      nestedFlds,
      relInfo!.type,
      diags,
      modelMap
    );

    // ii) buscar include anidados aún más profundos
    for (const sub of nestedArr.items as Entry[]) {
      if (
        sub.key?.kind === "string" &&
        sub.value?.kind === "array" &&
        nestedFlds.has((sub.key as any).value as string)
      ) {
        validateIncludeBlock(
          doc,
          sub,
          nestedFlds,
          relInfo!.type,
          diags,
          modelMap
        );
      }
    }
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
    validateIncludeBlock(doc, includeEntry, fields, modelName, diags, modelMap);
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
  /**
   * For Boolean fields we allow any number of leading “!” operators,
   * because `!$foo`, `!!$foo`, `!true`, etc. are still valid booleans.
   * For every other Prisma type we keep the original string intact.
   */
  const raw =
    info.type === "Boolean" ? expr.replace(/^!+\s*/, "").trim() : expr.trim();

  const allowed = phpDataTypes[info.type] ?? [];

  /* ── quick classifiers (all run on the *cleaned* raw string) ── */
  const isString = /^['"]/.test(raw);
  const isNumber = /^-?\d+(\.\d+)?$/.test(raw);
  const isBool = /^(true|false)$/i.test(raw);
  const isArray = /^\[.*\]$/.test(raw);
  const isVar = /^\$[A-Za-z_]\w*/.test(raw);
  const isFnCall = /^\s*(?:new\s+[A-Za-z_]\w*|\w+)\s*\(.*\)\s*$/.test(raw);
  const isNull = /^null$/i.test(raw);

  /* variables are always accepted (type checked at runtime) */
  if (isVar) {
    return true;
  }

  /* explicit null only if the column is nullable */
  if (isNull) {
    return info.nullable === true;
  }

  /* final decision against the Prisma field type */
  return allowed.some((t) => {
    switch (t) {
      case "string":
        return isString || isVar;
      case "int":
        return isNumber && !raw.includes(".");
      case "float":
        return isNumber;
      case "bool":
        return isBool || isVar; // ← allows cleaned booleans
      case "array":
        return isArray;
      case "DateTime":
        return /^new\s+DateTime/.test(raw) || isFnCall || isString || isVar;
      case "BigInteger":
      case "BigDecimal":
        return isFnCall;
      case "enum":
        return isString;
      default: /* custom scalar, class, etc. */
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

function isDynamicKey(key?: Node | null): boolean {
  return (
    !!key &&
    (key.kind === "variable" || //  $column
      key.kind === "propertylookup" || //  $obj->field
      key.kind === "identifier") //  CONST_CASE  ó  Foo::BAR
  );
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
      diags,
      modelMap
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
  out: vscode.Diagnostic[],
  modelMap?: ModelMap
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
        validateWhereArray(doc, item.value, fields, model, out, modelMap);
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

    // 3) handle nested filter object
    if (isArray(item.value)) {
      // **NEW: Check if this is a relation field with relation operators**
      if (modelMap && isRelationField(info, modelMap)) {
        validateRelationWhereArray(doc, item.value, info, key, out, modelMap);
      } else {
        // Regular scalar field validation
        validateScalarWhereArray(doc, item.value, info, key, out);
      }
      continue;
    }

    // 4) simple equals case (existing logic)
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

function validateRelationWhereArray(
  doc: vscode.TextDocument,
  arrayNode: Node,
  relationInfo: FieldInfo,
  relationName: string,
  out: vscode.Diagnostic[],
  modelMap: ModelMap
) {
  if (!isArray(arrayNode)) {
    return;
  }

  const relationModelName = relationInfo.type.toLowerCase();
  const relationFields = modelMap.get(relationModelName);

  if (!relationFields) {
    return; // Can't validate if we don't have the related model schema
  }

  for (const entry of (arrayNode as PhpArray).items as Entry[]) {
    if (!entry.key || entry.key.kind !== "string") {
      continue;
    }

    const operator = (entry.key as any).value as string;
    const opRange = locToRange(doc, entry.key.loc!);

    // Check if it's a valid relation operator
    if (RELATION_OPERATORS.includes(operator as any)) {
      // Validate the nested where conditions
      if (isArray(entry.value)) {
        validateWhereArray(
          doc,
          entry.value,
          relationFields,
          relationInfo.type,
          out,
          modelMap
        );
      } else {
        out.push(
          new vscode.Diagnostic(
            opRange,
            `Relation operator "${operator}" requires a nested where condition array.`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    } else if (
      FILTER_OPERATORS.includes(operator as any) &&
      !RELATION_OPERATORS.includes(operator as any)
    ) {
      // Regular scalar operators on relation fields are not allowed
      out.push(
        new vscode.Diagnostic(
          opRange,
          `Cannot use scalar operator "${operator}" on relation field "${relationName}". Use "every", "none", or "some" instead.`,
          vscode.DiagnosticSeverity.Error
        )
      );
    } else {
      out.push(
        new vscode.Diagnostic(
          opRange,
          `Invalid operator "${operator}" for relation field "${relationName}".`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }
}

function validateScalarWhereArray(
  doc: vscode.TextDocument,
  arrayNode: Node,
  fieldInfo: FieldInfo,
  fieldName: string,
  out: vscode.Diagnostic[]
) {
  if (!isArray(arrayNode)) {
    return;
  }

  for (const opEntry of (arrayNode as PhpArray).items as Entry[]) {
    if (!opEntry.key || opEntry.key.kind !== "string") {
      continue;
    }
    const op = (opEntry.key as any).value as string;
    const opRange = locToRange(doc, opEntry.key.loc!);

    // Don't allow relation operators on scalar fields
    if (RELATION_OPERATORS.includes(op as any)) {
      out.push(
        new vscode.Diagnostic(
          opRange,
          `Cannot use relation operator "${op}" on scalar field "${fieldName}". Relation operators are only for relation fields.`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }

    if (!PRISMA_OPERATORS.has(op)) {
      out.push(
        new vscode.Diagnostic(
          opRange,
          `Invalid filter operator "${op}" for "${fieldName}".`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }

    // Existing validation logic for scalar operators...
    const valRange = locToRange(doc, opEntry.value.loc!);
    const raw = doc.getText(valRange).trim();

    if ((op === "in" || op === "notIn") && !/^\[.*\]$/.test(raw)) {
      out.push(
        new vscode.Diagnostic(
          opRange,
          `Filter "${op}" for "${fieldName}" expects an array, but got "${raw}".`,
          vscode.DiagnosticSeverity.Error
        )
      );
      continue;
    }

    if (!isValidPhpType(raw, fieldInfo)) {
      out.push(
        new vscode.Diagnostic(
          opRange,
          `Filter "${op}" for "${fieldName}" expects type ${fieldInfo.type}, but received "${raw}".`,
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
      validateWhereArray(
        doc,
        whereEntry.value,
        fields,
        modelName,
        diagnostics,
        modelMap
      );
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
      const realUpdates = entries.filter((e) => {
        if (!e.key) {
          return false;
        }

        /* ① Claves literales ─ se aceptan salvo que sean operadores */
        if (e.key.kind === "string") {
          return !PRISMA_OPERATORS.has((e.key as any).value);
        }

        /* ② Claves dinámicas ($var, $obj->prop, CONST) */
        return isDynamicKey(e.key);
      });

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
    validateWhereArray(
      doc,
      whereEntry.value,
      fields,
      modelName,
      diagnostics,
      modelMap
    );
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
    validateWhereArray(
      doc,
      whereEntry.value,
      fields,
      modelName,
      diagnostics,
      modelMap
    );

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
      validateWhereArray(
        doc,
        whereEntry.value,
        fields,
        modelName,
        diagnostics,
        modelMap
      );
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
          diagnostics,
          modelMap
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
