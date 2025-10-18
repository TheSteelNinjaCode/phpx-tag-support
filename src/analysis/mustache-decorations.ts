import * as vscode from "vscode";

import {
  extractMustacheExpressions,
  buildExclusionRanges,
} from "./mustache-ast";

export interface DecorationRanges {
  braces: vscode.Range[];
  variables: vscode.Range[];
  properties: vscode.Range[];
  methods: vscode.Range[];
  strings: vscode.Range[];
  numbers: vscode.Range[];
}

/**
 * Extract decoration ranges from mustache expressions
 */
export function getMustacheDecorations(
  document: vscode.TextDocument
): DecorationRanges {
  const text = document.getText();
  const exclusions = buildExclusionRanges(text);
  const expressions = extractMustacheExpressions(text, exclusions);

  const result: DecorationRanges = {
    braces: [],
    variables: [],
    properties: [],
    methods: [],
    strings: [],
    numbers: [],
  };

  for (const expr of expressions) {
    // Decorate braces
    result.braces.push(
      new vscode.Range(
        document.positionAt(expr.startOffset),
        document.positionAt(expr.startOffset + 1)
      ),
      new vscode.Range(
        document.positionAt(expr.endOffset - 1),
        document.positionAt(expr.endOffset)
      )
    );

    if (!expr.ast) continue;

    // Base offset: after opening brace, minus 1 for wrapping parenthesis
    const baseOffset = expr.startOffset + 1;

    // Manually walk the tree to ensure we visit all nodes
    walkWithParents(expr.ast, (node: any) => {
      if (node.type === "Identifier") {
        handleIdentifier(node, document, baseOffset, result);
      } else if (node.type === "Literal") {
        handleLiteral(node, document, baseOffset, result);
      } else if (node.type === "TemplateLiteral") {
        handleTemplateLiteral(node, document, baseOffset, result);
      }
    });
  }

  return result;
}

/**
 * Custom tree walker that preserves parent references
 */
function walkWithParents(node: any, callback: (node: any) => void): void {
  if (!node || typeof node !== "object") return;

  callback(node);

  for (const key in node) {
    if (key === "parent" || key === "loc" || key === "range") continue;

    const child = node[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        child.forEach((item) => {
          if (item && typeof item === "object" && item.type) {
            walkWithParents(item, callback);
          }
        });
      } else if (child.type) {
        walkWithParents(child, callback);
      }
    }
  }
}

/**
 * Handle identifier node decoration
 */
function handleIdentifier(
  node: any,
  document: vscode.TextDocument,
  baseOffset: number,
  result: DecorationRanges
): void {
  // Calculate position (subtract 1 for wrapping parenthesis)
  const start = document.positionAt(baseOffset + node.start - 1);
  const end = document.positionAt(baseOffset + node.end - 1);
  const range = new vscode.Range(start, end);

  const parent = node.parent;

  if (!parent) {
    result.variables.push(range);
    return;
  }

  // Check if it's a method call: foo() or obj.foo()
  if (parent.type === "CallExpression" && parent.callee === node) {
    result.methods.push(range);
    return;
  }

  // Check if it's a method in a member expression: obj.method()
  if (
    parent.type === "MemberExpression" &&
    parent.property === node &&
    !parent.computed
  ) {
    // Check if the parent MemberExpression is being called
    const grandparent = parent.parent;
    if (
      grandparent?.type === "CallExpression" &&
      grandparent.callee === parent
    ) {
      result.methods.push(range);
      return;
    }

    // Otherwise it's a property
    result.properties.push(range);
    return;
  }

  // Check if it's the object in a member expression: obj in obj.prop
  if (parent.type === "MemberExpression" && parent.object === node) {
    result.variables.push(range);
    return;
  }

  // Default: it's a variable
  result.variables.push(range);
}

/**
 * Handle literal node decoration
 */
function handleLiteral(
  node: any,
  document: vscode.TextDocument,
  baseOffset: number,
  result: DecorationRanges
): void {
  const start = document.positionAt(baseOffset + node.start - 1);
  const end = document.positionAt(baseOffset + node.end - 1);
  const range = new vscode.Range(start, end);

  if (typeof node.value === "string") {
    result.strings.push(range);
  } else if (typeof node.value === "number") {
    result.numbers.push(range);
  }
}

/**
 * Handle template literal node decoration
 */
function handleTemplateLiteral(
  node: any,
  document: vscode.TextDocument,
  baseOffset: number,
  result: DecorationRanges
): void {
  const start = document.positionAt(baseOffset + node.start - 1);
  const end = document.positionAt(baseOffset + node.end - 1);
  result.strings.push(new vscode.Range(start, end));
}
