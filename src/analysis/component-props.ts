import { Engine, Node } from "php-parser";
import * as fs from "fs";
import * as vscode from "vscode";

/**
 * Single shared php‑parser instance (cheap to reuse).
 */
const php = new Engine({ parser: { php8: true, suppressErrors: true } });

/**
 * php‑parser uses bit‑flags for visibility.  Public = 4.
 * (src/const.js in the library)
 */
const FLAG_PUBLIC = 4;

/* ------------------------------------------------------------- *
 *  Types helpers
 * ------------------------------------------------------------- */
export type FqcnToFile = (fqcn: string) => string | undefined;
export type TagMap = Map<string, string>; // «<TagName>» -> FQCN

/* ------------------------------------------------------------- *
 *  ComponentPropsProvider – extracts public props from PHPX classes
 * ------------------------------------------------------------- */
export class ComponentPropsProvider {
  private readonly cache = new Map<string, string[]>(); // tag -> props[]

  constructor(
    private readonly tagMap: TagMap,
    private readonly fqcnToFile: FqcnToFile
  ) {}

  /** Public properties for <Tag>.  Empty array if not found. */
  public getProps(tag: string): string[] {
    console.log("🚀 ~ ComponentPropsProvider ~ getProps ~ tag:", tag);
    if (this.cache.has(tag)) return this.cache.get(tag)!;

    const fqcn = this.tagMap.get(tag);
    console.log("🚀 ~ ComponentPropsProvider ~ getProps ~ fqcn:", fqcn);
    if (!fqcn) return [];

    const file = this.fqcnToFile(fqcn);
    console.log("🚀 ~ ComponentPropsProvider ~ getProps ~ file:", file);
    if (!file || !fs.existsSync(file)) return [];

    const code = fs.readFileSync(file, "utf8");
    const ast = php.parseCode(code, file);
    console.log("🚀 ~ ComponentPropsProvider ~ getProps ~ ast:", ast);

    const props: string[] = [];

    this.walk(ast, (n) => {
      /* we only care about propertystatement (or promotedproperty in ≥3.3) */
      if (n.kind !== "propertystatement" && n.kind !== "promotedproperty")
        return;

      const stmt: any = n;

      /* ── visibility ─────────────────────────────────────────────── */
      const isPublic =
        (stmt.flags !== undefined ? (stmt.flags & FLAG_PUBLIC) !== 0 : false) ||
        stmt.visibility === "public";
      if (!isPublic) return;

      /* ── iterate over every declared variable on this line ───────── */
      for (const prop of stmt.properties ?? []) {
        const nm = typeof prop.name === "string" ? prop.name : prop.name?.name;
        if (nm) props.push(nm);
      }
    });

    this.cache.set(tag, props);
    console.log("🚀 ~ ComponentPropsProvider ~ getProps ~ props:", props);
    return props;
  }

  /** Clear cache – call when class files change. */
  public clear(): void {
    this.cache.clear();
  }

  /* --- tiny recursive walker -------------------------------- */
  private walk(node: Node, visit: (n: Node) => void): void {
    visit(node);
    for (const key of Object.keys(node)) {
      const child = (node as any)[key];
      if (!child) continue;
      if (Array.isArray(child)) child.forEach((c) => c && this.walk(c, visit));
      else if (typeof child === "object" && child.kind)
        this.walk(child as Node, visit);
    }
  }
}

/* ------------------------------------------------------------- *
 *  Build VS Code completion items for these props
 * ------------------------------------------------------------- */
export function buildDynamicAttrItems(
  tag: string,
  written: Set<string>,
  partial: string,
  provider: ComponentPropsProvider
): vscode.CompletionItem[] {
  console.log("🚀 ~ tag:", tag);
  console.log("🚀 ~ written:", written);
  console.log("🚀 ~ partial:", partial);
  console.log("🚀 ~ provider:", provider);
  return provider
    .getProps(tag)
    .filter((p) => !written.has(p) && p.startsWith(partial))
    .map((p) => {
      const it = new vscode.CompletionItem(p, vscode.CompletionItemKind.Field);
      it.insertText = new vscode.SnippetString(`${p}="$0"`);
      it.documentation = new vscode.MarkdownString(
        `Public **property** \`${p}\` of the component \`${tag}\``
      );
      return it;
    });
}
