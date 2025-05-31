import * as vscode from "vscode";
import ts from "typescript";
import { parseGlobalsWithTS } from "../extension";

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

// ─────────────────────────────────────────────────────────────────────────────
//  Regex Definitions (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────

// ① Mustache expressions: {{ foo?.bar?.baz }}
//    Capture group allows both “.” and “?.” between identifiers.
const MUSTACHE_RE =
  /{{\s*([A-Za-z_$][\w$]*(?:(?:\?\.)|\.)[A-Za-z_$][\w$]*)[\s\S]*?}}/g;

// ② Generic state scan: state('key', …)
const GENERIC_STATE_RE =
  /(?:pphp\.)?state(?:<[^>]*>)?\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*,/g;

// ③ Object‐literal state scan: state('key', { … })
const OBJ_LITERAL_RE =
  /(?:pphp\.)?state(?:<[^>]*>)?\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*,\s*({[\s\S]*?})\s*\)/g;

// ④ Destructuring state via literal: const [key, …] = pphp.state({...})
const DESTRUCTURED_RE =
  /\b(?:const|let|var)\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*(?:pphp\.)?state(?:<[^>]*>)?\(\s*(\{[\s\S]*?\}|\[[\s\S]*?\]|['"][\s\S]*?['"]|true|false|null|\d+(?:\.\d+)?)\s*\)/g;

// ─────────────────────────────────────────────────────────────────────────────
//  PropNode (nested) Structure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A PropNode represents a node in the nested property tree.
 * `children` maps each property name → a nested PropNode.
 */
interface PropNode {
  children: Map<string, PropNode>;
}

/**
 * Create a fresh PropNode (with no children).
 */
function createPropNode(): PropNode {
  return { children: new Map() };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main “orchestrator”
// ─────────────────────────────────────────────────────────────────────────────

let lastStubText = ""; // to avoid rewriting if nothing changed

export async function rebuildMustacheStub(document: vscode.TextDocument) {
  const text = document.getText();

  // Use Map<rootKey, PropNode> to build nested chains
  const propMap = new Map<string, PropNode>();

  // 1) Mustache “roots” + “props”
  collectMustacheRootsAndProps(text, propMap);

  // 2) Any state('key', …) → ensure the key exists
  collectGenericStateKeys(text, propMap);

  // 3) state('key', { … }) → parse that object for its nested keys
  await collectObjectLiteralProps(text, propMap);

  // 4) Destructured state via literal → parse objects for nested keys
  await collectDestructuredLiteralProps(text, propMap);

  // 5) Build the .d.ts lines out of the nested propMap
  const newText = buildStubLines(propMap);

  // 6) If nothing changed, skip writing; otherwise, write & notify TS
  if (newText !== lastStubText) {
    lastStubText = newText;
    await writeStubFile(newText);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  1) collectMustacheRootsAndProps
//     Splits on both “.” and “?.” so that “foo?.bar?.baz” yields
//     ["foo","bar","baz"], building a nested PropNode tree.
// ─────────────────────────────────────────────────────────────────────────────

function collectMustacheRootsAndProps(
  text: string,
  map: Map<string, PropNode>
) {
  let m: RegExpExecArray | null;

  while ((m = MUSTACHE_RE.exec(text))) {
    // m[1] might be "myVarNested", "myVarNested.foo.bar", or "myVarNested?.foo?.bar"
    const expr = m[1];

    // Split on either “.” or “?.”. e.g. "myVarNested?.foo?.bar" → ["myVarNested", "foo", "bar"]
    const parts = expr.split(/\?\.\s*|\.\s*/);
    const root = parts[0];
    if (reservedWords.has(root) || isBuiltIn(root)) {
      continue;
    }

    // Ensure a PropNode exists for this root
    if (!map.has(root)) {
      map.set(root, createPropNode());
    }
    let node = map.get(root)!;

    // Walk (or create) nested children for each subsequent segment
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i];
      if (!seg) {
        continue;
      }
      // Skip reserved or built-in at any level
      if (reservedWords.has(seg) || isBuiltIn(seg)) {
        break;
      }
      if (!node.children.has(seg)) {
        node.children.set(seg, createPropNode());
      }
      node = node.children.get(seg)!;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  2) collectGenericStateKeys
//     Finds any pphp.state('key', …) usage and ensures a PropNode for “key”
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
//  3) collectObjectLiteralProps
//     For each state('key', { … }), parse the object literal with TS AST
//     and pull out its nested property names into children of the root.
// ─────────────────────────────────────────────────────────────────────────────

async function collectObjectLiteralProps(
  text: string,
  map: Map<string, PropNode>
) {
  let m: RegExpExecArray | null;
  while ((m = OBJ_LITERAL_RE.exec(text))) {
    const key = m[1];
    const objLiteral = m[2];

    if (reservedWords.has(key) || isBuiltIn(key)) {
      continue;
    }

    if (!map.has(key)) {
      map.set(key, createPropNode());
    }
    const rootNode = map.get(key)!;

    // Build a fake TS source file: “const __o = { … };”
    const fake = `const __o = ${objLiteral};`;
    const sf = ts.createSourceFile(
      "stub.ts",
      fake,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    // Walk the AST and recurse into nested object literals
    sf.forEachChild((stmt) => {
      if (
        ts.isVariableStatement(stmt) &&
        stmt.declarationList.declarations.length > 0
      ) {
        for (const decl of stmt.declarationList.declarations) {
          const init = decl.initializer;
          if (init && ts.isObjectLiteralExpression(init)) {
            // Recursively process each property
            processObjectLiteral(init, rootNode);
          }
        }
      }
    });
  }
}

/**
 * Recursively process an ObjectLiteralExpression and populate the given PropNode.
 *
 * @param expr    TS ObjectLiteralExpression (e.g. "{ foo: { bar: '…' } }")
 * @param node    PropNode under which to add child nodes
 */
function processObjectLiteral(
  expr: ts.ObjectLiteralExpression,
  node: PropNode
) {
  for (const propNode of expr.properties) {
    if (ts.isPropertyAssignment(propNode) && ts.isIdentifier(propNode.name)) {
      const name = propNode.name.text;
      if (reservedWords.has(name)) {
        continue;
      }

      // Ensure a child PropNode exists for this property
      if (!node.children.has(name)) {
        node.children.set(name, createPropNode());
      }
      const childNode = node.children.get(name)!;

      // If the initializer is another object literal, recurse
      if (
        propNode.initializer &&
        ts.isObjectLiteralExpression(propNode.initializer)
      ) {
        processObjectLiteral(propNode.initializer, childNode);
      }
    } else if (
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
      // Shorthand assignment has no nested object, so no recursion needed
    }
    // (Skip other kinds: SpreadAssignment, MethodDeclaration, etc.)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  4) collectDestructuredLiteralProps
//     For each “const [key, …] = pphp.state({ … })” scenario, parse the object
//     literal similarly and pull out nested keys.
// ─────────────────────────────────────────────────────────────────────────────

async function collectDestructuredLiteralProps(
  text: string,
  map: Map<string, PropNode>
) {
  let m: RegExpExecArray | null;
  while ((m = DESTRUCTURED_RE.exec(text))) {
    const key = m[1];
    const literal = m[2];

    if (reservedWords.has(key) || isBuiltIn(key)) {
      continue;
    }

    if (!map.has(key)) {
      map.set(key, createPropNode());
    }
    const rootNode = map.get(key)!;

    // Only if it’s an object literal (startswith “{”)
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

// ─────────────────────────────────────────────────────────────────────────────
//  5) buildStubLines
//     Given a Map<root, PropNode>, produce the final text of the stub.
// ─────────────────────────────────────────────────────────────────────────────

function buildStubLines(map: Map<string, PropNode>): string {
  const lines: string[] = [];

  for (const [root, node] of map) {
    if (node.children.size === 0) {
      // No children → just “any”
      lines.push(`declare var ${root}: any;`);
    } else {
      // Build a nested object‐literal via recursion
      const typeLiteral = printNode(node, 1);
      lines.push(`declare var ${root}: ${typeLiteral};`);
    }
  }

  return lines.join("\n\n") + "\n";
}

/**
 * Recursively prints a PropNode as a TypeScript object‐literal string.
 *
 * @param node         The PropNode whose children we should serialize
 * @param indentLevel  How many indent levels deep we are
 * @returns             Something like:
 *   "{\n    foo: { bar: any; [key:string]: any; };\n    baz: any;\n    [key:string]: any;\n  }"
 */
function printNode(node: PropNode, indentLevel: number): string {
  const indent = "  ".repeat(indentLevel);
  const parts: string[] = [];

  // 1) Print each child property
  for (const [propKey, childNode] of node.children) {
    if (childNode.children.size === 0) {
      // Leaf node: “propKey: any;”
      parts.push(`${indent}${propKey}: any;`);
    } else {
      // Nested children → recurse
      const nestedLiteral = printNode(childNode, indentLevel + 1);
      parts.push(`${indent}${propKey}: ${nestedLiteral};`);
    }
  }

  // 2) Add index signature at this level
  parts.push(`${indent}[key: string]: any;`);

  // 3) Wrap with braces
  return `{\n${parts.join("\n")}\n${"  ".repeat(indentLevel - 1)}}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  6) writeStubFile
//     Writes “.pphp/phpx-mustache.d.ts” and then re-parse with TS.
// ─────────────────────────────────────────────────────────────────────────────

async function writeStubFile(newText: string) {
  const stubUri = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders![0].uri,
    ".pphp",
    "phpx-mustache.d.ts"
  );
  await vscode.workspace.fs.writeFile(stubUri, Buffer.from(newText, "utf8"));
  parseGlobalsWithTS(newText);
}
