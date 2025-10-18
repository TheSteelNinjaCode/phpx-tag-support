import * as vscode from "vscode";
import * as walk from "acorn-walk";
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

    const baseOffset = expr.startOffset + 1;

    // Walk AST and collect ranges
    walk.simple(expr.ast, {
      Identifier(node: any) {
        const start = document.positionAt(baseOffset + node.start);
        const end = document.positionAt(baseOffset + node.end);
        const range = new vscode.Range(start, end);

        // Determine category
        if (node.parent?.type === "MemberExpression") {
          if (node.parent.property === node) {
            result.properties.push(range);
          } else {
            result.variables.push(range);
          }
        } else if (
          node.parent?.type === "CallExpression" &&
          node.parent.callee === node
        ) {
          result.methods.push(range);
        } else {
          result.variables.push(range);
        }
      },

      Literal(node: any) {
        const start = document.positionAt(baseOffset + node.start);
        const end = document.positionAt(baseOffset + node.end);
        const range = new vscode.Range(start, end);

        if (typeof node.value === "string") {
          result.strings.push(range);
        } else if (typeof node.value === "number") {
          result.numbers.push(range);
        }
      },

      TemplateLiteral(node: any) {
        // Handle template strings
        const start = document.positionAt(baseOffset + node.start);
        const end = document.positionAt(baseOffset + node.end);
        result.strings.push(new vscode.Range(start, end));
      },
    });
  }

  return result;
}
