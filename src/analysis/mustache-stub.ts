// analysis/mustache‐stub.ts
import * as vscode from "vscode";
import ts from "typescript";
import { parseGlobalsWithTS } from "../extension";

// ──────────────────────────────────────────────────────────────────────────────
//   0) Helpers: reservedWords + isBuiltIn
// ──────────────────────────────────────────────────────────────────────────────
//

const isBuiltIn: (name: string) => boolean = (() => {
  const cache = new Map<string, boolean>();
  const prototypes = [
    Object.prototype,
    Function.prototype,
    Array.prototype,
    String.prototype,
    Number.prototype,
    Boolean.prototype,
    Date.prototype,
    RegExp.prototype,
    Map.prototype,
    Set.prototype,
    WeakMap.prototype,
    WeakSet.prototype,
    Error.prototype,
    Promise.prototype,
  ];

  return (name: string): boolean => {
    const hit = cache.get(name);
    if (hit !== undefined) {
      return hit;
    }
    // Check if `name` is in globalThis, or in any of the built‐in prototypes:
    const found = name in globalThis || prototypes.some((p) => name in p);
    cache.set(name, found);
    return found;
  };
})();

const reservedWords = new Set([
  "null",
  "undefined",
  "true",
  "false",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "async",
  "await",
  "implements",
  "interface",
  "event",
  "NaN",
  "Infinity",
  "Number",
  "String",
  "Boolean",
  "Object",
  "Array",
  "Function",
  "Date",
  "RegExp",
  "Error",
  "JSON",
  "Math",
  "Map",
  "Set",
]);

/**
 * This regex now matches ANY of:
 *    {{ myVar }}
 *    {{ user.profile }}
 *    {{ user?.profile?.address.street }}
 *
 * Capture group #1 will be exactly the “chain” (e.g. “myVar”, “user.profile”,
 * or “user?.profile?.address.street”).
 */
const MUSTACHE_RE =
  /{{\s*([A-Za-z_$][\w$]*(?:(?:(?:\?\.)|(?:\.))[A-Za-z_$][\w$]*)*)\s*}}/g;

//
// ──────────────────────────────────────────────────────────────────────────────
//   2) GENERIC_STATE_RE: pick up any pphp.state('key', …) calls
// ──────────────────────────────────────────────────────────────────────────────
//

const GENERIC_STATE_RE =
  /(?:pphp\.)?state(?:<[^>]*>)?\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*,/g;

//
// ──────────────────────────────────────────────────────────────────────────────
//   3) OBJ_LITERAL_RE: pick up pphp.state('key', { … })
// ──────────────────────────────────────────────────────────────────────────────
//

const OBJ_LITERAL_RE =
  /(?:pphp\.)?state(?:<[^>]*>)?\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*,\s*({[\s\S]*?})\s*\)/g;

//
// ──────────────────────────────────────────────────────────────────────────────
//   4) DESTRUCTURED_RE: “const [key, …] = pphp.state({ … })”
// ──────────────────────────────────────────────────────────────────────────────
//

const DESTRUCTURED_RE =
  /\b(?:const|let|var)\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*(?:pphp\.)?state(?:<[^>]*>)?\(\s*(\{[\s\S]*?\}|\[[\s\S]*?\]|['"][\s\S]*?['"]|true|false|null|\d+(?:\.\d+)?)\s*\)/g;

//
// ──────────────────────────────────────────────────────────────────────────────
//   5) PropNode: holds a nested map of children
// ──────────────────────────────────────────────────────────────────────────────
//

interface PropNode {
  children: Map<string, PropNode>;
}

/** Create a fresh PropNode with no children. */
function createPropNode(): PropNode {
  return { children: new Map() };
}

//
// ──────────────────────────────────────────────────────────────────────────────
//   6) Main entry: rebuildMustacheStub(document)
// ──────────────────────────────────────────────────────────────────────────────
//

let lastStubText = ""; // to avoid rewriting if nothing changed

/**
 * Runs on every document‐change or save. It will:
 *   1) scan all {{…}} expressions,
 *   2) pick up any pphp.state('key', …) calls (to ensure those keys exist),
 *   3) parse object‐literal states for deeply nested props,
 *   4) parse destructured‐literal states ([k, …] = state({...})),
 *   5) build a new .d.ts string, and if it changed, write it into .pphp/phpx-mustache.d.ts.
 */
export async function rebuildMustacheStub(document: vscode.TextDocument) {
  const text = document.getText();
  const propMap = new Map<string, PropNode>();

  // 6.1) Gather every mustache‐root + nested props from {{ … }}:
  collectMustacheRootsAndProps(text, propMap);

  // 6.2) Ensure that any “state('key', …)” also creates a root:
  collectGenericStateKeys(text, propMap);

  // 6.3) If state('key', { … }) has an object literal, parse its nested keys:
  await collectObjectLiteralProps(text, propMap);

  // 6.4) If there’s “const [key, …] = state({ … })”, parse that object as well:
  await collectDestructuredLiteralProps(text, propMap);

  // 6.5) Build the new `.d.ts` content from our propMap:
  const newText = buildStubLines(propMap);

  // 6.6) If it’s changed from last time, write it and re‐parse:
  if (newText !== lastStubText) {
    lastStubText = newText;
    await writeStubFile(newText);
  }
}

//
// ──────────────────────────────────────────────────────────────────────────────
//   6.1) collectMustacheRootsAndProps: scan every {{…}} and build a PropNode tree
// ──────────────────────────────────────────────────────────────────────────────
//

function collectMustacheRootsAndProps(
  text: string,
  map: Map<string, PropNode>
) {
  let m: RegExpExecArray | null;

  while ((m = MUSTACHE_RE.exec(text))) {
    //
    //  m[1] might be any of:
    //    “myVar”
    //    “user.profile”
    //    “user?.profile?.address.street”
    //
    const expr = m[1];

    // Split on either “.” or “?.”. E.g. “user?.profile?.address” → ["user","profile","address"]
    const parts = expr.split(/\?\.\s*|\.\s*/);
    const root = parts[0];
    if (reservedWords.has(root) || isBuiltIn(root)) {
      continue;
    }

    // If we don’t yet have a PropNode for `root`, create one:
    if (!map.has(root)) {
      map.set(root, createPropNode());
    }
    let node = map.get(root)!;

    // Walk through each segment after the root (e.g. “profile”, then “address”, etc.)
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i];
      if (!seg) {
        continue;
      }
      if (reservedWords.has(seg)) {
        break;
      }
      if (!node.children.has(seg)) {
        node.children.set(seg, createPropNode());
      }
      node = node.children.get(seg)!;
    }
  }
}

//
// ──────────────────────────────────────────────────────────────────────────────
//   6.2) collectGenericStateKeys: pick up every pphp.state('key', …) so “key” becomes a root
// ──────────────────────────────────────────────────────────────────────────────
//

function collectGenericStateKeys(text: string, map: Map<string, PropNode>) {
  let m: RegExpExecArray | null;
  while ((m = GENERIC_STATE_RE.exec(text))) {
    const key = m[1];
    if (reservedWords.has(key) || isBuiltIn(key)) {
      continue;
    }
    if (!map.has(key)) {
      map.set(key, createPropNode());
    }
  }
}

//
// ──────────────────────────────────────────────────────────────────────────────
//   6.3) collectObjectLiteralProps: for state('key', { … }), parse nested keys
// ──────────────────────────────────────────────────────────────────────────────
//

async function collectObjectLiteralProps(
  text: string,
  map: Map<string, PropNode>
) {
  let m: RegExpExecArray | null;
  while ((m = OBJ_LITERAL_RE.exec(text))) {
    const key = m[1];
    const objLiteral = m[2]; // e.g. "{ foo: { bar: … }, baz: 123 }"

    if (reservedWords.has(key) || isBuiltIn(key)) {
      continue;
    }
    if (!map.has(key)) {
      map.set(key, createPropNode());
    }
    const rootNode = map.get(key)!;

    // Create a small TS “stub.ts” so we can walk its AST via TypeScript’s parser:
    const fake = `const __o = ${objLiteral};`;
    const sf = ts.createSourceFile(
      "stub.ts",
      fake,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    sf.forEachChild((stmt) => {
      if (
        ts.isVariableStatement(stmt) &&
        stmt.declarationList.declarations.length > 0
      ) {
        for (const decl of stmt.declarationList.declarations) {
          const init = decl.initializer;
          if (init && ts.isObjectLiteralExpression(init)) {
            processObjectLiteral(init, rootNode);
          }
        }
      }
    });
  }
}

/**
 * Recursively process an ObjectLiteralExpression, adding each property name
 * as a child PropNode. If that property’s value is itself another object
 * literal, recurse further.
 */
function processObjectLiteral(
  expr: ts.ObjectLiteralExpression,
  node: PropNode
) {
  for (const propNode of expr.properties) {
    // Only handle “foo: …” (PropertyAssignment) where the name is a plain identifier
    if (ts.isPropertyAssignment(propNode) && ts.isIdentifier(propNode.name)) {
      const name = propNode.name.text;
      if (reservedWords.has(name)) {
        continue;
      }

      if (!node.children.has(name)) {
        node.children.set(name, createPropNode());
      }
      const childNode = node.children.get(name)!;

      // If that property’s value is another object literal, recurse:
      if (
        propNode.initializer &&
        ts.isObjectLiteralExpression(propNode.initializer)
      ) {
        processObjectLiteral(propNode.initializer, childNode);
      }
    }
    // Also support shorthand “{ foo }” inside an object literal:
    else if (
      ts.isShorthandPropertyAssignment(propNode) &&
      ts.isIdentifier(propNode.name)
    ) {
      const name = propNode.name.text;
      if (reservedWords.has(name)) {
        continue;
      }
      if (!node.children.has(name)) {
        node.children.set(name, createPropNode());
      }
      // (No further recursion—shorthand means “foo: foo” but not nested.)
    }
    // Skip any spreads, methods, computed properties, etc.
  }
}

//
// ──────────────────────────────────────────────────────────────────────────────
//   6.4) collectDestructuredLiteralProps: “const [ key, … ] = pphp.state({ … })”
// ──────────────────────────────────────────────────────────────────────────────
//

async function collectDestructuredLiteralProps(
  text: string,
  map: Map<string, PropNode>
) {
  let m: RegExpExecArray | null;
  while ((m = DESTRUCTURED_RE.exec(text))) {
    const key = m[1];
    const literal = m[2]; // Could be “{…}” or “[…]” or a primitive, etc.

    if (reservedWords.has(key) || isBuiltIn(key)) {
      continue;
    }
    if (!map.has(key)) {
      map.set(key, createPropNode());
    }
    const rootNode = map.get(key)!;

    // Only parse further if it really is an object literal (“{…}”):
    if (literal.startsWith("{")) {
      const fake = `const __o = ${literal};`;
      const sf = ts.createSourceFile(
        "stub.ts",
        fake,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      sf.forEachChild((stmt) => {
        if (
          ts.isVariableStatement(stmt) &&
          stmt.declarationList.declarations.length > 0
        ) {
          for (const decl of stmt.declarationList.declarations) {
            const init = decl.initializer;
            if (init && ts.isObjectLiteralExpression(init)) {
              processObjectLiteral(init, rootNode);
            }
          }
        }
      });
    }
  }
}

//
// ──────────────────────────────────────────────────────────────────────────────
//   6.5) buildStubLines: serialize each PropNode into a TypeScript “declare var”
// ──────────────────────────────────────────────────────────────────────────────
//

function buildStubLines(map: Map<string, PropNode>): string {
  const lines: string[] = [];

  for (const [root, node] of map) {
    // If there are no children, just declare “any”
    if (node.children.size === 0) {
      lines.push(`declare var ${root}: any;`);
    } else {
      // Otherwise, build a nested object‐literal type
      const typeLiteral = printNode(node, /*indentLevel=*/ 1);
      lines.push(`declare var ${root}: ${typeLiteral};`);
    }
  }

  // Join with a blank line between each block, and one final newline:
  return lines.join("\n\n") + "\n";
}

/**
 * Recursively prints a PropNode as a TypeScript object‐literal type, for example:
 *
 *   {
 *     name: any;
 *     age: any;
 *     child: {
 *       foo: any;
 *       [key: string]: any;
 *     };
 *     [key: string]: any;
 *   }
 *
 * @param node         The PropNode you want to serialize
 * @param indentLevel  How many “  ” indent‐units to apply to this level
 */
function printNode(node: PropNode, indentLevel: number): string {
  const indent = "  ".repeat(indentLevel);
  const parts: string[] = [];

  // 1) Print each child property in sorted order (optional: you may sort if you want)
  for (const [propKey, childNode] of node.children) {
    if (childNode.children.size === 0) {
      // Leaf property → “propKey: any;”
      parts.push(`${indent}${propKey}: any;`);
    } else {
      // Nested children → recurse and indent
      const nestedLiteral = printNode(childNode, indentLevel + 1);
      parts.push(`${indent}${propKey}: ${nestedLiteral};`);
    }
  }

  // 2) Always add a “[key: string]: any;” index signature at this level
  parts.push(`${indent}[key: string]: any;`);

  // 3) Wrap with braces. For the closing “}”, back out one indent level:
  const closingIndent = "  ".repeat(indentLevel - 1);
  return `{\n${parts.join("\n")}\n${closingIndent}}`;
}

//
// ──────────────────────────────────────────────────────────────────────────────
//   6.6) writeStubFile: write out “.pphp/phpx-mustache.d.ts” and re‐parse
// ──────────────────────────────────────────────────────────────────────────────
//

async function writeStubFile(newText: string) {
  const stubUri = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders![0].uri,
    ".pphp",
    "phpx-mustache.d.ts"
  );
  await vscode.workspace.fs.writeFile(stubUri, Buffer.from(newText, "utf8"));

  // Once it’s saved, also update our in‐memory TS stub so that globalStubs + globalStubTypes stay fresh
  parseGlobalsWithTS(newText);
}
