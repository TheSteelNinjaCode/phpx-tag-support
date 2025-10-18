import * as acorn from "acorn";
import * as walk from "acorn-walk";
import type { Node } from "acorn";

export interface MustacheExpression {
  /** Full text including braces: `{user.name}` */
  full: string;
  /** Inner expression: `user.name` */
  inner: string;
  /** Start offset in document */
  startOffset: number;
  /** End offset in document */
  endOffset: number;
  /** Parsed AST (null if invalid) */
  ast: Node | null;
  /** Parse error if any */
  error?: string;
}

export interface IdentifierInfo {
  name: string;
  startOffset: number;
  endOffset: number;
  type: "variable" | "property" | "method";
}

/**
 * Extract mustache expressions while respecting:
 * - Nested braces
 * - String literals
 * - Exclusion zones (PHP blocks, script tags, etc.)
 */
export function extractMustacheExpressions(
  text: string,
  exclusionRanges: Array<[number, number]> = []
): MustacheExpression[] {
  const expressions: MustacheExpression[] = [];

  for (let i = 0; i < text.length; i++) {
    // Skip if in exclusion zone
    if (isInExclusionRange(i, exclusionRanges)) {
      continue;
    }

    // Look for single `{` (not legacy `{{`)
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

        i = result.end - 1; // Skip past this expression
      }
    }
  }

  return expressions;
}

/**
 * Extract a balanced expression respecting strings and nesting
 */
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

    // Handle string boundaries
    if ((ch === '"' || ch === "'" || ch === "`") && !inString) {
      inString = ch;
    } else if (ch === inString) {
      inString = null;
    }

    // Count braces outside strings
    if (!inString) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }

    i++;
  }

  return depth === 0 ? { start, end: i } : null;
}

/**
 * Parse JavaScript expression with acorn
 */
/**
 * Parse JavaScript expression with acorn and add parent references
 */
function parseExpression(expr: string): Node | null {
  try {
    // Wrap in parentheses to ensure it's parsed as an expression
    const wrapped = `(${expr})`;
    const program = acorn.parse(wrapped, {
      ecmaVersion: "latest",
      sourceType: "module",
    });

    // Add parent references
    addParentReferences(program as any);

    // Extract the actual expression from: Program -> ExpressionStatement -> ParenthesizedExpression -> Expression
    const body = (program as any).body;
    if (body && body.length > 0 && body[0].type === "ExpressionStatement") {
      const exprStmt = body[0];
      // The expression is wrapped in parentheses, so unwrap it
      return exprStmt.expression.expression || exprStmt.expression;
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Add parent references to AST nodes
 */
function addParentReferences(node: any, parent: any = null): void {
  node.parent = parent;

  for (const key in node) {
    if (key === "parent") continue;

    const child = node[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        child.forEach((item) => {
          if (item && typeof item === "object") {
            addParentReferences(item, node);
          }
        });
      } else if (child.type) {
        addParentReferences(child, node);
      }
    }
  }
}

/**
 * Check if offset is in any exclusion range
 */
function isInExclusionRange(
  offset: number,
  ranges: Array<[number, number]>
): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Extract all identifiers from a mustache expression
 */
export function extractIdentifiers(
  expr: MustacheExpression,
  text: string
): IdentifierInfo[] {
  if (!expr.ast) return [];

  const identifiers: IdentifierInfo[] = [];
  const baseOffset = expr.startOffset + 1; // +1 for opening brace

  walk.simple(expr.ast, {
    Identifier(node: any) {
      // Determine type based on context
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

/**
 * Check if expression contains assignment operators
 */
export function containsAssignment(expr: MustacheExpression): boolean {
  if (!expr.ast) return false;

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

/**
 * Extract member expression chains like `user.profile.name`
 */
export function extractMemberChains(expr: MustacheExpression): string[][] {
  if (!expr.ast) return [];

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

/**
 * Build exclusion ranges for PHP, script, style tags
 */
export function buildExclusionRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // PHP blocks
  const phpRegex = /<\?(?:php|=)?([\s\S]*?)(?:\?>|$)/g;
  for (const match of text.matchAll(phpRegex)) {
    ranges.push([match.index!, match.index! + match[0].length]);
  }

  // Script tags
  const scriptRegex = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
  for (const match of text.matchAll(scriptRegex)) {
    ranges.push([match.index!, match.index! + match[0].length]);
  }

  // Style tags
  const styleRegex = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
  for (const match of text.matchAll(styleRegex)) {
    ranges.push([match.index!, match.index! + match[0].length]);
  }

  // HTML attribute values (onclick, etc.)
  const attrRegex = /\bon\w+\s*=\s*["']([^"']*?)["']/gi;
  for (const match of text.matchAll(attrRegex)) {
    const valueStart = match.index! + match[0].indexOf(match[1]);
    ranges.push([valueStart, valueStart + match[1].length]);
  }

  return ranges;
}
