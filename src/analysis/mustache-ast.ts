import * as acorn from "acorn";
import * as walk from "acorn-walk";
import type { Node } from "acorn";

export interface MustacheExpression {
  full: string;
  inner: string;
  startOffset: number;
  endOffset: number;
  ast: Node | null;
  error?: string;
}

export interface IdentifierInfo {
  name: string;
  startOffset: number;
  endOffset: number;
  type: "variable" | "property" | "method";
}

export function extractMustacheExpressions(
  text: string,
  exclusionRanges: Array<[number, number]> = []
): MustacheExpression[] {
  const expressions: MustacheExpression[] = [];

  for (let i = 0; i < text.length; i++) {
    if (isInExclusionRange(i, exclusionRanges)) {
      continue;
    }

    if (text[i] === "{" && text[i - 1] !== "{") {
      const result = extractBalancedExpression(text, i);

      if (result && text[result.end] !== "}") {
        const full = text.slice(result.start, result.end);
        const inner = text.slice(result.start + 1, result.end - 1);

        expressions.push({
          full,
          inner,
          startOffset: result.start,
          endOffset: result.end,
          ast: parseExpression(inner),
        });

        i = result.end - 1;
      }
    }
  }

  return expressions;
}

function extractBalancedExpression(
  text: string,
  start: number
): { start: number; end: number } | null {
  let depth = 1;
  let i = start + 1;
  let inString: string | null = null;
  let escaped = false;

  while (i < text.length && depth > 0) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      i++;
      continue;
    }

    if (ch === "\\" && inString) {
      escaped = true;
      i++;
      continue;
    }

    if ((ch === '"' || ch === "'" || ch === "`") && !inString) {
      inString = ch;
    } else if (ch === inString) {
      inString = null;
    }

    if (!inString) {
      if (ch === "{") {
        depth++;
      }
      if (ch === "}") {
        depth--;
      }
    }

    i++;
  }

  return depth === 0 ? { start, end: i } : null;
}

function parseExpression(expr: string): Node | null {
  try {
    const wrapped = `(${expr})`;
    const program = acorn.parse(wrapped, {
      ecmaVersion: "latest",
      sourceType: "module",
    }) as any;

    if (
      program.body &&
      program.body.length > 0 &&
      program.body[0].type === "ExpressionStatement"
    ) {
      const exprStmt = program.body[0];
      let actualExpr = exprStmt.expression;

      while (actualExpr && actualExpr.type === "ParenthesizedExpression") {
        actualExpr = actualExpr.expression;
      }

      addParentReferences(actualExpr);

      return actualExpr;
    }

    return null;
  } catch (error) {
    return null;
  }
}

function addParentReferences(node: any, parent: any = null): void {
  if (!node || typeof node !== "object") {
    return;
  }

  node.parent = parent;

  for (const key in node) {
    if (key === "parent" || key === "loc" || key === "range") {
      continue;
    }

    const child = node[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        child.forEach((item) => {
          if (item && typeof item === "object" && item.type) {
            addParentReferences(item, node);
          }
        });
      } else if (child.type) {
        addParentReferences(child, node);
      }
    }
  }
}

function isInExclusionRange(
  offset: number,
  ranges: Array<[number, number]>
): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

export function extractIdentifiers(
  expr: MustacheExpression,
  text: string
): IdentifierInfo[] {
  if (!expr.ast) {
    return [];
  }

  const identifiers: IdentifierInfo[] = [];
  const baseOffset = expr.startOffset + 1;

  walk.simple(expr.ast, {
    Identifier(node: any) {
      let type: "variable" | "property" | "method" = "variable";

      if (node.parent?.type === "MemberExpression") {
        type = node.parent.property === node ? "property" : "variable";
      }

      if (
        node.parent?.type === "CallExpression" &&
        node.parent.callee === node
      ) {
        type = "method";
      }

      identifiers.push({
        name: node.name,
        startOffset: baseOffset + node.start,
        endOffset: baseOffset + node.end,
        type,
      });
    },
  });

  return identifiers;
}

export function containsAssignment(expr: MustacheExpression): boolean {
  if (!expr.ast) {
    return false;
  }

  let hasAssignment = false;

  walk.simple(expr.ast, {
    AssignmentExpression() {
      hasAssignment = true;
    },
    UpdateExpression() {
      hasAssignment = true;
    },
  });

  return hasAssignment;
}

export function extractMemberChains(expr: MustacheExpression): string[][] {
  if (!expr.ast) {
    return [];
  }

  const chains: string[][] = [];

  walk.simple(expr.ast, {
    MemberExpression(node: any) {
      const chain: string[] = [];

      let current = node;
      while (current.type === "MemberExpression") {
        if (current.property.type === "Identifier") {
          chain.unshift(current.property.name);
        }
        current = current.object;
      }

      if (current.type === "Identifier") {
        chain.unshift(current.name);
      }

      if (chain.length > 0) {
        chains.push(chain);
      }
    },
  });

  return chains;
}

export function buildExclusionRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  const startsWithPhp = /^<\?php\b/.test(text.trim());

  if (startsWithPhp) {
    const firstClose = text.indexOf("?>");
    if (firstClose === -1) {
      return [[0, text.length]];
    }
  }

  let pos = 0;
  while (pos < text.length) {
    const openMatch = text.slice(pos).match(/<\?(?:php\b|=)?/);
    if (!openMatch || openMatch.index === undefined) break;

    const openPos = pos + openMatch.index;
    const openTag = openMatch[0];

    const closePos = text.indexOf("?>", openPos + openTag.length);

    if (closePos === -1) {
      ranges.push([openPos, text.length]);
      break;
    }

    ranges.push([openPos, closePos + 2]);
    pos = closePos + 2;
  }

  const scriptRegex = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
  for (const match of text.matchAll(scriptRegex)) {
    ranges.push([match.index!, match.index! + match[0].length]);
  }

  const styleRegex = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
  for (const match of text.matchAll(styleRegex)) {
    ranges.push([match.index!, match.index! + match[0].length]);
  }

  const attrRegex = /\bon\w+\s*=\s*["']([^"']*?)["']/gi;
  for (const match of text.matchAll(attrRegex)) {
    const valueStart = match.index! + match[0].indexOf(match[1]);
    ranges.push([valueStart, valueStart + match[1].length]);
  }

  return ranges;
}
