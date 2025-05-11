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

interface PropMeta {
  name: string;
  type: string; //  string|int|null …
  default?: string; //  already‑formatted literal
  doc?: string; //  first line of PHP‑Doc
}

/* helper ──────────────────────────────────────────── */
/* helper ──────────────────────────────────────────── */
function typeToString(t: any | undefined): string {
  if (!t) {
    return "mixed";
  }

  switch (t.kind) {
    /* plain Foo */
    case "identifier":
      return t.name;

    /* string, int, DateTime, …   (php‑parser’s own node) */
    case "typereference":
      return t.raw ?? t.name;

    /* ?Foo */
    case "nullabletype":
    case "nullabletypereference": // ← new
      return `${typeToString(t.what ?? t.type)}|null`;

    /* Foo|Bar */
    case "uniontype":
      return t.types.map(typeToString).join("|");

    /* Foo&Bar */
    case "intersectiontype":
      return t.types.map(typeToString).join("&");

    default:
      return "mixed";
  }
}

type Cached = { mtime: number; props: PropMeta[] };

/* ------------------------------------------------------------- *
 *  ComponentPropsProvider – extracts public props from PHPX classes
 * ------------------------------------------------------------- */
export class ComponentPropsProvider {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly tagMap: TagMap,
    private readonly fqcnToFile: FqcnToFile
  ) {}

  /** Public properties for <Tag>.  Empty array if not found. */
  /** Return the public props (name + type + doc) declared on a component */
  /** Return the public props (name + type + default + doc) declared on a component */
  public getProps(
    tag: string
  ): PropMeta[]; /** Grab the public props (name + type + default + doc) for <Tag>. */
  public getProps(tag: string): PropMeta[] {
    /* 1️⃣  where is the PHP file for this tag? */
    const fqcn = this.tagMap.get(tag);
    const file = fqcn && this.fqcnToFile(fqcn);
    if (!file || !fs.existsSync(file)) {
      return [];
    }

    /* 2️⃣  up‑to‑date cache hit?  -------------------------------- */
    const mtime = fs.statSync(file).mtimeMs; // current disk stamp
    const hit = this.cache.get(tag); // {mtime, props}
    if (hit && hit.mtime === mtime) {
      return hit.props;
    } // still fresh

    /* 3️⃣  parse + extract  -------------------------------------- */
    const ast = php.parseCode(fs.readFileSync(file, "utf8"), file);
    const props: PropMeta[] = [];

    this.walk(ast, (node) => {
      if (
        node.kind !== "propertystatement" &&
        node.kind !== "promotedproperty"
      ) {
        return;
      }

      const stmt: any = node;
      const isPublic =
        ((stmt.flags ?? 0) & FLAG_PUBLIC) !== 0 || stmt.visibility === "public";
      if (!isPublic) {
        return;
      }

      /* PHP‑Doc (optional) that precedes the statement */
      const docRaw: string | undefined = (stmt.leadingComments ?? [])
        .filter(
          (c: any) => c.kind === "commentblock" && c.value.startsWith("*")
        )
        .map((c: any) => c.value.replace(/^\*\s*/gm, "").trim())
        .pop();

      for (const p of stmt.properties ?? []) {
        const name =
          typeof p.name === "string"
            ? p.name
            : (p.name?.name as string | undefined);
        if (!name) {
          continue;
        }

        /* ← type resolution */
        let finalType = typeToString(p.type ?? stmt.type);
        if (docRaw) {
          const m = /@var\s+([^\s]+)/.exec(docRaw);
          if (m) {
            finalType = m[1];
          }
        }

        /* ← default scalar value, if any */
        let def: string | string[] | undefined;

        if (p.value) {
          switch (p.value.kind) {
            case "string":
              // pipe‑string  → keep as text
              def = p.value.value; // "default|outline"
              break;

            case "array":
              // literal [ 'default', 'outline' ]
              def = (p.value.items as any[])
                .filter((it) => it.value?.kind === "string")
                .map((it) => it.value.value as string);
              break;

            /* basic scalars for completeness */
            case "number":
              def = String(p.value.value);
              break;
            case "boolean":
              def = p.value.value ? "true" : "false";
              break;
            case "nullkeyword":
              def = "null";
              break;
          }
        }

        const doc = docRaw?.split(/\r?\n/)[0]; // first line of PHP‑Doc
        props.push({
          name,
          type: finalType,
          default: Array.isArray(def) ? def.join("|") : def,
          doc,
        });
      }
    });

    /* 4️⃣  cache + return  -------------------------------------- */
    this.cache.set(tag, { mtime, props });
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
      if (!child) {
        continue;
      }
      if (Array.isArray(child)) {
        child.forEach((c) => c && this.walk(c, visit));
      } else if (typeof child === "object" && child.kind) {
        this.walk(child as Node, visit);
      }
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
  return provider
    .getProps(tag)
    .filter(({ name }) => !written.has(name) && name.startsWith(partial))
    .map(({ name, type, default: def, doc }) => {
      const item = new vscode.CompletionItem(
        name,
        vscode.CompletionItemKind.Field
      );

      /* insert   variant="$0"   as before */
      item.insertText = new vscode.SnippetString(`${name}="$0"`);

      /* list label  →  ": string = \"default\""  */
      item.detail = def ? `: ${type} = ${def}` : `: ${type}`;

      /* docs / hover */
      const md = new vscode.MarkdownString();
      md.appendCodeblock(
        def ? `${name}: ${type} = ${def}` : `${name}: ${type}`,
        "php"
      );
      if (doc) {
        md.appendMarkdown("\n\n" + doc);
      }
      item.documentation = md;

      return item;
    });
}
