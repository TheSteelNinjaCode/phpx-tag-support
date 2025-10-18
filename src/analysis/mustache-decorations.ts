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

    // Base offset is after the opening brace
    // We subtract 1 later because AST positions include the wrapping `(`
    const baseOffset = expr.startOffset + 1;

    // Walk AST and collect ranges
    walk.simple(expr.ast, {
      Identifier(node: any) {
        // Subtract 1 to account for the `(` we added when parsing
        const start = document.positionAt(baseOffset + node.start - 1);
        const end = document.positionAt(baseOffset + node.end - 1);
        const range = new vscode.Range(start, end);

        // Determine the type of identifier
        const parent = node.parent;

        if (!parent) {
          result.variables.push(range);
          return;
        }

        // Check if it's a method call
        if (parent.type === "CallExpression" && parent.callee === node) {
          result.methods.push(range);
          return;
        }

        // Check if it's a method in a member expression chain
        if (
          parent.type === "MemberExpression" &&
          parent.property === node &&
          parent.parent?.type === "CallExpression" &&
          parent.parent.callee === parent
        ) {
          result.methods.push(range);
          return;
        }

        // Check if it's a property access
        if (parent.type === "MemberExpression" && parent.property === node) {
          result.properties.push(range);
          return;
        }

        // Otherwise, it's a variable
        result.variables.push(range);
      },

      Literal(node: any) {
        // Subtract 1 to account for the `(` we added when parsing
        const start = document.positionAt(baseOffset + node.start - 1);
        const end = document.positionAt(baseOffset + node.end - 1);
        const range = new vscode.Range(start, end);

        if (typeof node.value === "string") {
          result.strings.push(range);
        } else if (typeof node.value === "number") {
          result.numbers.push(range);
        }
      },

      TemplateLiteral(node: any) {
        // Handle template strings (backticks)
        // Subtract 1 to account for the `(` we added when parsing
        const start = document.positionAt(baseOffset + node.start - 1);
        const end = document.positionAt(baseOffset + node.end - 1);
        result.strings.push(new vscode.Range(start, end));
      },
    });
  }

  return result;
}
