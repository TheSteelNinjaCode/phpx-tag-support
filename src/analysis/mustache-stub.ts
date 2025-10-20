import * as vscode from "vscode";
import ts from "typescript";
import { parseGlobalsWithTS } from "../extension";
import { updateTypeCache } from "./type-chache";

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
  inferredType?: "string" | "number" | "boolean" | "object" | "array";
  element?: PropNode;
}

function createPropNode(): PropNode {
  return { children: new Map() };
}

let lastStubText = "";

const explicitTypes = new Map<string, string>();

export async function rebuildMustacheStub(document: vscode.TextDocument) {
  const text = document.getText();
  const propMap = new Map<string, PropNode>();

  collectMustacheRootsAndProps(text, propMap);
  collectGenericStateKeys(text, propMap);
  await collectObjectLiteralProps(text, propMap);
  await collectDestructuredLiteralProps(text, propMap);

  collectExplicitTypes(text);
  mergeExplicitTypesIntoPropMap(propMap);

  const newText = buildStubLines(propMap);

  if (newText !== lastStubText) {
    lastStubText = newText;
    await writeStubFile(newText);
  }

  updateTypeCache(propMap);
}

function mergeExplicitTypesIntoPropMap(map: Map<string, PropNode>): void {
  for (const [varName, typeStr] of explicitTypes) {
    if (!map.has(varName)) {
      map.set(varName, createPropNode());
    }

    const node = map.get(varName)!;

    if (typeStr === "string") {
      node.inferredType = "string";
    } else if (typeStr === "number") {
      node.inferredType = "number";
    } else if (typeStr === "boolean") {
      node.inferredType = "boolean";
    } else if (typeStr.includes("{")) {
      node.inferredType = "object";
    } else if (typeStr.includes("[]")) {
      node.inferredType = "array";
    }
  }
}

function collectExplicitTypes(text: string): void {
  explicitTypes.clear();

  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;

  while ((scriptMatch = scriptRegex.exec(text)) !== null) {
    const scriptContent = scriptMatch[1];

    const sf = ts.createSourceFile(
      "temp.ts",
      scriptContent,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    sf.forEachChild((node) => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.type) {
            const varName = decl.name.text;
            const typeStr = decl.type.getText(sf);
            explicitTypes.set(varName, typeStr);
          } else if (ts.isArrayBindingPattern(decl.name) && decl.initializer) {
            const pattern = decl.name;
            if (pattern.elements.length > 0) {
              const firstElement = pattern.elements[0];
              if (
                ts.isBindingElement(firstElement) &&
                ts.isIdentifier(firstElement.name)
              ) {
                const varName = firstElement.name.text;

                if (ts.isCallExpression(decl.initializer)) {
                  const callExpr = decl.initializer;

                  let isStateCall = false;
                  if (ts.isPropertyAccessExpression(callExpr.expression)) {
                    if (
                      ts.isIdentifier(callExpr.expression.expression) &&
                      callExpr.expression.expression.text === "pp" &&
                      ts.isIdentifier(callExpr.expression.name) &&
                      callExpr.expression.name.text === "state"
                    ) {
                      isStateCall = true;
                    }
                  } else if (ts.isIdentifier(callExpr.expression)) {
                    if (callExpr.expression.text === "state") {
                      isStateCall = true;
                    }
                  }

                  if (isStateCall && callExpr.arguments.length > 0) {
                    const firstArg = callExpr.arguments[0];
                    const inferredType = inferTypeFromExpression(firstArg, sf);
                    explicitTypes.set(varName, inferredType);
                  }
                }
              }
            }
          } else if (
            ts.isIdentifier(decl.name) &&
            !decl.type &&
            decl.initializer
          ) {
            const varName = decl.name.text;
            const inferredType = inferTypeFromExpression(decl.initializer, sf);
            explicitTypes.set(varName, inferredType);
          }
        }
      }
    });
  }
}

function inferTypeFromExpression(
  expr: ts.Expression,
  sf: ts.SourceFile
): string {
  if (ts.isStringLiteral(expr)) return "string";
  if (ts.isNumericLiteral(expr)) return "number";
  if (
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword
  )
    return "boolean";
  if (ts.isObjectLiteralExpression(expr)) return buildObjectType(expr, sf);

  if (ts.isArrayLiteralExpression(expr)) {
    const first = expr.elements[0];
    if (first && ts.isObjectLiteralExpression(first)) {
      const el = buildObjectType(first, sf);
      return `${el}[]`;
    }
    return "any[]";
  }
  return "any";
}

function buildObjectType(
  expr: ts.ObjectLiteralExpression,
  sf: ts.SourceFile
): string {
  const props: string[] = [];

  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      const propName = prop.name.text;
      const propType = inferTypeFromExpression(prop.initializer, sf);
      props.push(`  ${propName}: ${propType};`);
    } else if (
      ts.isShorthandPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name)
    ) {
      const propName = prop.name.text;
      props.push(`  ${propName}: any;`);
    }
  }

  props.push("  [key: string]: any;");

  return `{\n${props.join("\n")}\n}`;
}

function collectMustacheRootsAndProps(
  text: string,
  map: Map<string, PropNode>
) {
  const scriptBlocks = extractScriptBlocks(text);
  const phpBlocks = extractPhpBlocks(text);
  const excludedBlocks = [...scriptBlocks, ...phpBlocks];

  let m: RegExpExecArray | null;

  while ((m = MUSTACHE_RE.exec(text))) {
    const matchIndex = m.index;

    if (isInExcludedBlock(matchIndex, excludedBlocks)) {
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

function extractScriptBlocks(text: string): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = [];
  const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return blocks;
}

function extractPhpBlocks(text: string): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = [];
  const regex = /<\?(?:php|=)?([\s\S]*?)(?:\?>|$)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return blocks;
}

function isInExcludedBlock(
  index: number,
  blocks: { start: number; end: number }[]
): boolean {
  return blocks.some((block) => index >= block.start && index < block.end);
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

          if (init && ts.isArrayLiteralExpression(init)) {
            rootNode.inferredType = "array";
            processArrayLiteral(init, rootNode);
          }
        }
      }
    });
  }
}

function inferTypeFromInitializer(
  init: ts.Expression
): "string" | "number" | "boolean" | "object" | "array" | "any" {
  if (ts.isStringLiteral(init)) {
    return "string";
  }
  if (ts.isNumericLiteral(init)) {
    return "number";
  }
  if (
    init.kind === ts.SyntaxKind.TrueKeyword ||
    init.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return "boolean";
  }
  if (ts.isObjectLiteralExpression(init)) {
    return "object";
  }
  if (ts.isArrayLiteralExpression(init)) {
    return "array";
  }
  return "any";
}

function processArrayLiteral(expr: ts.ArrayLiteralExpression, node: PropNode) {
  node.inferredType = "array";
  const first = expr.elements[0];
  if (first && ts.isObjectLiteralExpression(first)) {
    node.element = createPropNode();
    processObjectLiteral(first, node.element);
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

      if (propNode.initializer) {
        const inferredType = inferTypeFromInitializer(propNode.initializer);

        if (inferredType !== "any") {
          childNode.inferredType = inferredType;
        }

        if (ts.isObjectLiteralExpression(propNode.initializer)) {
          processObjectLiteral(propNode.initializer, childNode);
        }

        if (ts.isArrayLiteralExpression(propNode.initializer)) {
          const child = node.children.get(name)!;
          processArrayLiteral(propNode.initializer, child);
        }
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

            if (init && ts.isArrayLiteralExpression(init)) {
              rootNode.inferredType = "array";
              processArrayLiteral(init, rootNode);
            }
          }
        }
      });
    }

    if (literal.startsWith("[")) {
      const fake = `const __a = ${literal};`;
      const sf = ts.createSourceFile(
        "stub.ts",
        fake,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      sf.forEachChild((stmt) => {
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            const init = decl.initializer;
            if (init && ts.isArrayLiteralExpression(init)) {
              rootNode.inferredType = "array";
              processArrayLiteral(init, rootNode);
            }
          }
        }
      });
    }
  }
}

function buildStubLines(map: Map<string, PropNode>): string {
  const lines: string[] = [];
  const processedVars = new Set<string>();

  for (const [root, node] of map) {
    processedVars.add(root);

    const explicitType = explicitTypes.get(root);

    if (explicitType) {
      lines.push(`declare var ${root}: ${explicitType};`);
    } else if (node.children.size === 0) {
      lines.push(`declare var ${root}: any;`);
    } else {
      const typeLiteral = printNode(node, 1);
      lines.push(`declare var ${root}: ${typeLiteral};`);
    }
  }

  for (const [varName, typeStr] of explicitTypes) {
    if (!processedVars.has(varName)) {
      lines.push(`declare var ${varName}: ${typeStr};`);
    }
  }

  return lines.join("\n\n") + "\n";
}

function printNode(node: PropNode, indentLevel: number): string {
  if (node.inferredType === "array") {
    if (node.element) {
      const el = printNode(node.element, indentLevel);
      return `${el}[]`;
    }
    return `any[]`;
  }

  const indent = "  ".repeat(indentLevel);
  const parts: string[] = [];
  for (const [propKey, childNode] of node.children) {
    let typeAnnotation = "any";
    if (childNode.inferredType === "string") typeAnnotation = "string";
    else if (childNode.inferredType === "number") typeAnnotation = "number";
    else if (childNode.inferredType === "boolean") typeAnnotation = "boolean";
    else if (childNode.inferredType === "array")
      typeAnnotation = printNode(childNode, indentLevel + 1);
    else if (childNode.inferredType === "object")
      typeAnnotation = printNode(childNode, indentLevel + 1);
    parts.push(`${indent}${propKey}: ${typeAnnotation};`);
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
