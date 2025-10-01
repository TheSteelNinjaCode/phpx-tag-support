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

const MUSTACHE_RE =
  /\{\s*([A-Za-z_$][\w$]*(?:(?:(?:\?\.)|(?:\.))[A-Za-z_$][\w$]*)*)\s*\}/g;
const GENERIC_STATE_RE =
  /(?:(?:pp\.)?state)(?:<[^>]*>)?\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*,/g;
const OBJ_LITERAL_RE =
  /(?:(?:pp\.)?state)(?:<[^>]*>)?\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*,\s*({[\s\S]*?})\s*\)/g;
const DESTRUCTURED_RE =
  /\b(?:const|let|var)\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*(?:(?:pp\.)?state)(?:<[^>]*>)?\(\s*(\{[\s\S]*?\}|\[[\s\S]*?\]|['"][\s\S]*?['"]|true|false|null|\d+(?:\.\d+)?)\s*\)/g;

interface PropNode {
  children: Map<string, PropNode>;
}

function createPropNode(): PropNode {
  return { children: new Map() };
}

let lastStubText = "";

export async function rebuildMustacheStub(document: vscode.TextDocument) {
  const text = document.getText();
  const propMap = new Map<string, PropNode>();

  collectMustacheRootsAndProps(text, propMap);
  collectGenericStateKeys(text, propMap);
  await collectObjectLiteralProps(text, propMap);
  await collectDestructuredLiteralProps(text, propMap);

  const newText = buildStubLines(propMap);

  if (newText !== lastStubText) {
    lastStubText = newText;
    await writeStubFile(newText);
  }
}

function collectMustacheRootsAndProps(
  text: string,
  map: Map<string, PropNode>
) {
  let m: RegExpExecArray | null;

  while ((m = MUSTACHE_RE.exec(text))) {
    const start = m.index;
    const end = MUSTACHE_RE.lastIndex;
    if (text[start - 1] === "{" || text[end] === "}") {
      continue;
    }

    const expr = m[1];
    const parts = expr.split(/\?\.\s*|\.\s*/);
    const root = parts[0];
    if (reservedWords.has(root) || isBuiltIn(root)) {
      continue;
    }

    if (!map.has(root)) {
      map.set(root, createPropNode());
    }
    let node = map.get(root)!;

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

      if (!node.children.has(name)) {
        node.children.set(name, createPropNode());
      }
      const childNode = node.children.get(name)!;

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
    }
  }
}

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

function buildStubLines(map: Map<string, PropNode>): string {
  const lines: string[] = [];

  for (const [root, node] of map) {
    if (node.children.size === 0) {
      lines.push(`declare var ${root}: any;`);
    } else {
      const typeLiteral = printNode(node, 1);
      lines.push(`declare var ${root}: ${typeLiteral};`);
    }
  }

  return lines.join("\n\n") + "\n";
}

function printNode(node: PropNode, indentLevel: number): string {
  const indent = "  ".repeat(indentLevel);
  const parts: string[] = [];

  for (const [propKey, childNode] of node.children) {
    if (childNode.children.size === 0) {
      parts.push(`${indent}${propKey}: any;`);
    } else {
      const nestedLiteral = printNode(childNode, indentLevel + 1);
      parts.push(`${indent}${propKey}: ${nestedLiteral};`);
    }
  }

  parts.push(`${indent}[key: string]: any;`);
  const closingIndent = "  ".repeat(indentLevel - 1);
  return `{\n${parts.join("\n")}\n${closingIndent}}`;
}

async function writeStubFile(newText: string) {
  const stubUri = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders![0].uri,
    ".pp",
    "phpx-mustache.d.ts"
  );
  await vscode.workspace.fs.writeFile(stubUri, Buffer.from(newText, "utf8"));
  parseGlobalsWithTS(newText);
}
