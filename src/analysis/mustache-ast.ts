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

function extractHeredocBlocks(
  text: string
): Array<{ start: number; end: number; content: string }> {
  const blocks: Array<{ start: number; end: number; content: string }> = [];
  const heredocRegex =
    /<<<(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2\s*;?/gm;

  let match: RegExpExecArray | null;
  while ((match = heredocRegex.exec(text)) !== null) {
    const contentStart = match.index + match[0].indexOf(match[3]);
    blocks.push({
      start: contentStart,
      end: contentStart + match[3].length,
      content: match[3],
    });
  }

  return blocks;
}

function findPhpVariableInterpolations(text: string): Array<[number, number]> {
  const phpVarRanges: Array<[number, number]> = [];
  // Pattern matches {$var}, {$this->prop}, {$obj->method()}, etc.
  const phpVarRegex = /\{\$[^}]+\}/g;

  let match: RegExpExecArray | null;
  while ((match = phpVarRegex.exec(text)) !== null) {
    phpVarRanges.push([match.index, match.index + match[0].length]);
  }

  return phpVarRanges;
}

export function buildExclusionRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  const scriptPatterns = [
    /<script\b[^>]*>([\s\S]*?)<\/script>/gi,
    /&lt;script\b[^&>]*&gt;([\s\S]*?)&lt;\/script&gt;/gi,
  ];

  for (const pattern of scriptPatterns) {
    for (const match of text.matchAll(pattern)) {
      ranges.push([match.index!, match.index! + match[0].length]);
    }
  }

  const stylePatterns = [
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
    /&lt;style\b[^&>]*&gt;([\s\S]*?)&lt;\/style&gt;/gi,
  ];

  for (const pattern of stylePatterns) {
    for (const match of text.matchAll(pattern)) {
      ranges.push([match.index!, match.index! + match[0].length]);
    }
  }

  let pos = 0;
  while (pos < text.length) {
    const scriptMatch = text.slice(pos).match(/<script\b[^>]*>/i);
    if (!scriptMatch || scriptMatch.index === undefined) break;

    const scriptStart = pos + scriptMatch.index;
    const scriptEnd = text.indexOf("</script>", scriptStart);

    if (scriptEnd === -1) {
      ranges.push([scriptStart, text.length]);
      break;
    }

    pos = scriptStart + scriptMatch[0].length;
  }

  pos = 0;
  while (pos < text.length) {
    const scriptMatch = text.slice(pos).match(/&lt;script\b[^&>]*&gt;/i);
    if (!scriptMatch || scriptMatch.index === undefined) break;

    const scriptStart = pos + scriptMatch.index;
    const scriptEnd = text.indexOf("&lt;/script&gt;", scriptStart);

    if (scriptEnd === -1) {
      ranges.push([scriptStart, text.length]);
      break;
    }

    pos = scriptStart + scriptMatch[0].length;
  }

  pos = 0;
  while (pos < text.length) {
    const styleMatch = text.slice(pos).match(/<style\b[^>]*>/i);
    if (!styleMatch || styleMatch.index === undefined) break;

    const styleStart = pos + styleMatch.index;
    const styleEnd = text.indexOf("</style>", styleStart);

    if (styleEnd === -1) {
      ranges.push([styleStart, text.length]);
      break;
    }

    pos = styleStart + styleMatch[0].length;
  }

  pos = 0;
  while (pos < text.length) {
    const styleMatch = text.slice(pos).match(/&lt;style\b[^&>]*&gt;/i);
    if (!styleMatch || styleMatch.index === undefined) break;

    const styleStart = pos + styleMatch.index;
    const styleEnd = text.indexOf("&lt;/style&gt;", styleStart);

    if (styleEnd === -1) {
      ranges.push([styleStart, text.length]);
      break;
    }

    pos = styleStart + styleMatch[0].length;
  }

  const heredocBlocks = extractHeredocBlocks(text);

  pos = 0;
  while (pos < text.length) {
    const openMatch = text.slice(pos).match(/<\?(?:php\b|=)?/);
    if (!openMatch || openMatch.index === undefined) break;

    const openPos = pos + openMatch.index;
    const openTag = openMatch[0];
    const afterOpen = openPos + openTag.length;

    const closePos = text.indexOf("?>", afterOpen);

    if (closePos === -1) {
      if (heredocBlocks.length === 0) {
        ranges.push([openPos, text.length]);
        break;
      }

      const relevantHeredocs = heredocBlocks.filter(
        (h) => h.start >= afterOpen
      );

      if (relevantHeredocs.length === 0) {
        ranges.push([openPos, text.length]);
        break;
      }

      let currentPos = openPos;
      for (const heredoc of relevantHeredocs) {
        if (currentPos < heredoc.start) {
          ranges.push([currentPos, heredoc.start]);
        }
        currentPos = heredoc.end;
      }

      if (currentPos < text.length) {
        ranges.push([currentPos, text.length]);
      }

      break;
    }

    const blockStart = openPos;
    const blockEnd = closePos + 2;

    const blockHeredocs = heredocBlocks.filter(
      (h) => h.start >= blockStart && h.end <= blockEnd
    );

    if (blockHeredocs.length === 0) {
      ranges.push([blockStart, blockEnd]);
    } else {
      let currentPos = blockStart;
      for (const heredoc of blockHeredocs) {
        if (currentPos < heredoc.start) {
          ranges.push([currentPos, heredoc.start]);
        }
        currentPos = heredoc.end;
      }
      if (currentPos < blockEnd) {
        ranges.push([currentPos, blockEnd]);
      }
    }

    pos = blockEnd;
  }

  const phpVars = findPhpVariableInterpolations(text);
  ranges.push(...phpVars);

  return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];

  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current[0] <= last[1]) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }

  return merged;
}
