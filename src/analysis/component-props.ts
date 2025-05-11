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

type Cached = { mtime: number; props: PropMeta[] };

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

/** Si no hay tipo declarado, dedúcelo a partir del literal. */
function inferTypeFromValue(v: any | undefined): string {
  console.log("🚀 ~ inferTypeFromValue ~ v:", v);
  if (!v) {
    return "mixed";
  }

  switch (v.kind) {
    case "string":
      return "string";
    case "number":
      return Number.isInteger(v.value) ? "int" : "float";
    case "boolean":
      return "bool";
    case "array": {
      // ¿array homogéneo de strings?  →  string[]
      const allStrings = (v.items as any[]).every(
        (it) => (it.value ?? it).kind === "string"
      );
      return allStrings ? "string[]" : "array";
    }
    case "nullkeyword":
      return "null";
    default:
      return "mixed";
  }
}

/* ------------------------------------------------------------- *
 *  ComponentPropsProvider – extracts public props from PHPX classes
 * ------------------------------------------------------------- */
export class ComponentPropsProvider {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly tagMap: TagMap,
    private readonly fqcnToFile: FqcnToFile
  ) {}

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
    console.log("🚀 ~ ComponentPropsProvider ~ getProps ~ ast:", ast);
    const props: PropMeta[] = [];

    this.walk(ast, (node) => {
      if (
        node.kind !== "propertystatement" &&
        node.kind !== "promotedproperty" &&
        node.kind !== "classconstant"
      ) {
        return;
      }

      const stmt: any = node;
      const isPublic =
        ((stmt.flags ?? 0) & FLAG_PUBLIC) !== 0 || stmt.visibility === "public";
      if (!isPublic) {
        return;
      }

      /* PHP‑Doc (optional) */
      const docRaw = (stmt.leadingComments ?? [])
        .filter(
          (c: any) => c.kind === "commentblock" && c.value.startsWith("*")
        )
        .map((c: any) => c.value.replace(/^\*\s*/gm, "").trim())
        .pop();

      /* ───────────────────────────────────────────────────────────── */
      /* A) ‑‑‑ properties & promoted‑properties ‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑ */
      if (node.kind !== "classconstant") {
        for (const p of stmt.properties ?? []) {
          handleMember(p.name, p.value);
        }
      } else {
        /* B) ‑‑‑ class constants ‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑‑ */
        for (const c of stmt.constants ?? []) {
          handleMember(c.name, c.value);
        }
      }
      /* ───────────────────────────────────────────────────────────── */

      function handleMember(nameNode: any, valueNode: any | undefined): void {
        console.log(
          "🚀 ~ ComponentPropsProvider ~ handleMember ~ valueNode:",
          valueNode
        );
        const name =
          typeof nameNode === "string" ? nameNode : (nameNode?.name as string);
        if (!name) {
          return;
        }

        // 1) @var PHP‑Doc siempre manda
        let finalType: string | undefined;
        if (docRaw) {
          const m = /@var\s+([^\s]+)/.exec(docRaw);
          if (m) {
            finalType = m[1];
          }
        }

        // 2) declaración de tipo en código (propiedad/promoted property)
        if (!finalType && stmt.type) {
          finalType = typeToString(stmt.type);
        }

        // 3) nada aún → intenta deducir del valor literal
        if (!finalType || finalType === "mixed") {
          finalType = inferTypeFromValue(valueNode);
        }

        /* ← default value (usa la lógica nueva array‑keys) */
        let def: string | string[] | undefined;
        if (valueNode) {
          switch (valueNode.kind) {
            case "string":
              def = valueNode.value;
              break;
            case "array": {
              const keys: string[] = [];
              for (const item of valueNode.items as any[]) {
                if (item.key && item.key.kind === "string") {
                  keys.push(item.key.value as string);
                } else if (!item.key && item.value?.kind === "string") {
                  keys.push(item.value.value as string);
                }
              }
              def = keys;
              break;
            }
            case "number":
              def = String(valueNode.value);
              break;
            case "boolean":
              def = valueNode.value ? "true" : "false";
              break;
            case "nullkeyword":
              def = "null";
              break;
          }
        }

        props.push({
          name,
          type: finalType,
          default: Array.isArray(def) ? def.join("|") : def,
          doc: docRaw?.split(/\r?\n/)[0],
        });
      }
    });

    /* 4️⃣  cache + return */
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
