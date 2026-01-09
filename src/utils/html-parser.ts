import { parse as parseHTML, HTMLElement } from "node-html-parser";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";

// ============ TYPES ============

export interface HTMLRegion {
  type: "script" | "style" | "template" | "element";
  start: number;
  end: number;
  content: string;
  attributes?: Record<string, string>;
  tagName?: string;
}

export interface PulseStateVar {
  name: string;
  type: "Boolean" | "Number" | "String" | "Object" | "Array" | "Unknown";
  keys?: string[];
  start: number;
  end: number;
}

export interface ParsedFunction {
  name: string;
  isStateSetter: boolean;
}

export interface LoopScope {
  alias: string;
  list: string;
  region: HTMLRegion;
}

export interface ParsedHTMLDocument {
  scripts: HTMLRegion[];
  styles: HTMLRegion[];
  templates: HTMLRegion[];
  ignored: HTMLRegion[];
  getRegionAtOffset(offset: number): HTMLRegion | null;
  getLoopScopeAtOffset(offset: number): LoopScope | null;
  isInsideScript(offset: number): boolean;
  isInsideStyle(offset: number): boolean;
  isInsidePpForTemplate(offset: number): boolean;
  isInsideIgnoredElement(offset: number): boolean;
  isInsideExcludedRegion(offset: number): boolean;
  getScriptContent(): string | null;
}

// ============ MAIN PARSER ============

export function parseHTMLDocument(text: string): ParsedHTMLDocument {
  const root = parseHTML(text, {
    comment: true,
    lowerCaseTagName: true,
    range: true,
  } as any);

  const scripts: HTMLRegion[] = [];
  const styles: HTMLRegion[] = [];
  const templates: HTMLRegion[] = [];
  const ignored: HTMLRegion[] = [];

  root.querySelectorAll("script").forEach((el) => {
    const region = createRegion(el, "script", text);
    if (region) scripts.push(region);
  });

  root.querySelectorAll("style").forEach((el) => {
    const region = createRegion(el, "style", text);
    if (region) styles.push(region);
  });

  root.querySelectorAll("template").forEach((el) => {
    if (el.getAttribute("pp-for")) {
      const region = createRegion(el, "template", text);
      if (region) templates.push(region);
    }
  });

  root.querySelectorAll("[pp-ignore]").forEach((el) => {
    const region = createRegion(el, "element", text);
    if (region) ignored.push(region);
  });

  return {
    scripts,
    styles,
    templates,
    ignored,

    getRegionAtOffset(offset: number): HTMLRegion | null {
      return (
        [...scripts, ...styles, ...templates, ...ignored].find(
          (r) => offset >= r.start && offset < r.end
        ) || null
      );
    },

    getLoopScopeAtOffset(offset: number): LoopScope | null {
      const matching = templates.filter(
        (t) => offset >= t.start && offset < t.end
      );

      if (matching.length === 0) return null;

      matching.sort((a, b) => a.end - a.start - (b.end - b.start));
      const target = matching[0];

      const ppFor = target.attributes?.["pp-for"];
      if (!ppFor) return null;

      // Parse "u in users"
      const parts = ppFor.split(" in ");
      if (parts.length !== 2) return null;

      return {
        alias: parts[0].trim(),
        list: parts[1].trim(),
        region: target,
      };
    },

    isInsideScript(offset: number): boolean {
      return scripts.some((r) => offset >= r.start && offset < r.end);
    },

    isInsideStyle(offset: number): boolean {
      return styles.some((r) => offset >= r.start && offset < r.end);
    },

    isInsidePpForTemplate(offset: number): boolean {
      return templates.some((r) => offset >= r.start && offset < r.end);
    },

    isInsideIgnoredElement(offset: number): boolean {
      return ignored.some((r) => offset >= r.start && offset < r.end);
    },

    isInsideExcludedRegion(offset: number): boolean {
      return (
        scripts.some((r) => offset >= r.start && offset < r.end) ||
        styles.some((r) => offset >= r.start && offset < r.end) ||
        ignored.some((r) => offset >= r.start && offset < r.end)
      );
    },

    getScriptContent(): string | null {
      if (scripts.length === 0) return null;
      return scripts[0].content;
    },
  };
}

function createRegion(
  el: HTMLElement,
  type: HTMLRegion["type"],
  fullText: string
): HTMLRegion | null {
  const range = (el as any).range;

  if (range && Array.isArray(range)) {
    return {
      type,
      start: range[0],
      end: range[1],
      content: el.innerHTML || "",
      attributes: el.attributes,
      tagName: el.tagName?.toLowerCase(),
    };
  }
  return null;
}

// ============ AST PARSING FOR STATE ============

export function parseScriptForState(fullText: string): PulseStateVar[] {
  const results: PulseStateVar[] = [];
  const htmlDoc = parseHTMLDocument(fullText);
  const jsCode = htmlDoc.getScriptContent();

  if (!jsCode) return [];

  let ast;
  try {
    ast = parser.parse(jsCode, {
      sourceType: "module",
      plugins: ["typescript"],
    });
  } catch (e) {
    return [];
  }

  traverse(ast, {
    VariableDeclarator(path: any) {
      if (!path.node.init || path.node.init.type !== "CallExpression") return;

      const callee = path.node.init.callee;
      if (
        callee.type === "MemberExpression" &&
        callee.object.name === "pp" &&
        callee.property.name === "state"
      ) {
        const id = path.node.id;
        if (id.type !== "ArrayPattern" || id.elements.length === 0) return;

        const firstElement = id.elements[0];
        const varName = firstElement.name;

        const start =
          typeof firstElement.start === "number" ? firstElement.start : 0;
        const end = typeof firstElement.end === "number" ? firstElement.end : 0;

        const args = path.node.init.arguments;
        let varType: PulseStateVar["type"] = "Unknown";
        let varKeys: string[] = [];

        if (args.length > 0) {
          const arg = args[0];
          if (arg.type === "BooleanLiteral") varType = "Boolean";
          else if (arg.type === "NumericLiteral") varType = "Number";
          else if (arg.type === "StringLiteral") varType = "String";
          else if (arg.type === "ObjectExpression") {
            varType = "Object";
            arg.properties.forEach((prop: any) => {
              if (prop.key && prop.key.name) {
                varKeys.push(prop.key.name);
              }
            });
          }
          else if (arg.type === "ArrayExpression") {
            varType = "Array";
            if (
              arg.elements.length > 0 &&
              arg.elements[0].type === "ObjectExpression"
            ) {
              arg.elements[0].properties.forEach((prop: any) => {
                if (prop.key && prop.key.name) {
                  varKeys.push(prop.key.name);
                }
              });
            }
          }
        }

        results.push({
          name: varName,
          type: varType,
          keys: varKeys,
          start,
          end,
        });
      }
    },
  });

  return results;
}

export function extractFunctionsFromScript(fullText: string): ParsedFunction[] {
  const functions: ParsedFunction[] = [];
  const htmlDoc = parseHTMLDocument(fullText);
  const script = htmlDoc.getScriptContent();

  if (!script) return functions;

  const seen = new Set<string>();

  const stateRegex = /const\s+\[(\w+),\s*(\w+)\]\s*=\s*pp\.state/g;
  let m;
  while ((m = stateRegex.exec(script)) !== null) {
    if (!seen.has(m[2])) {
      functions.push({ name: m[2], isStateSetter: true });
      seen.add(m[2]);
    }
  }

  const funcRegex =
    /(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|const\s+(\w+)\s*=\s*(?:async\s*)?[a-zA-Z_]\w*\s*=>)/g;
  while ((m = funcRegex.exec(script)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name && !seen.has(name)) {
      functions.push({ name, isStateSetter: false });
      seen.add(name);
    }
  }

  return functions;
}

export function getOffsetFromPosition(
  text: string,
  line: number,
  character: number
): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset + character;
}

export function isInsideTag(textBefore: string): boolean {
  const lastOpen = textBefore.lastIndexOf("<");
  const lastClose = textBefore.lastIndexOf(">");
  return lastOpen > lastClose;
}

export function getTagName(textBefore: string): string | null {
  const tagMatch = /<(\w+)[^>]*$/.exec(textBefore);
  return tagMatch?.[1]?.toLowerCase() || null;
}

export function getUsedTagNames(text: string): Set<string> {
  const root = parseHTML(text, {
    comment: true,
    lowerCaseTagName: false, // Must be false to match "Lock" import
    range: true,
  } as any);

  const usedTags = new Set<string>();

  function traverse(node: any) {
    if (node.tagName) {
      usedTags.add(node.tagName);
    }
    if (node.childNodes) {
      node.childNodes.forEach((child: any) => traverse(child));
    }
  }

  traverse(root);
  return usedTags;
}
