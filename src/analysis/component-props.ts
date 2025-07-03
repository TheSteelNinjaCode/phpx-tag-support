import { Node } from "php-parser";
import * as fs from "fs";
import * as vscode from "vscode";
import { phpEngine } from "../util/php-engine";

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
  optional: boolean; // true ↔ nullable (…|null)
  allowed?: string; //  allowed literals, e.g. "1|2|3|4|5|6"
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
    case "uniontype": {
      const uniq: string[] = [];
      for (const part of t.types.map(typeToString)) {
        if (!uniq.includes(part)) {
          uniq.push(part);
        }
      }
      return uniq.join("|");
    }

    /* Foo&Bar */
    case "intersectiontype":
      return t.types.map(typeToString).join("&");

    default:
      return "mixed";
  }
}

/** Si no hay tipo declarado, dedúcelo a partir del literal. */
function inferTypeFromValue(v: any | undefined): string {
  if (!v) {
    return "mixed";
  }

  switch (v.kind) {
    case "string":
      return "string";

    case "number": {
      // ① parsear el literal
      const num = Number(v.value);
      // ② si no es un número válido → mixed
      if (Number.isNaN(num)) {
        return "mixed";
      }
      // ③ comprobar si es entero o no
      return Number.isInteger(num) ? "int" : "float";
    }

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
 * 1.  helper: extrae la primera doc-comment relevante
 * ------------------------------------------------------------- */
/**
 * Devuelve la línea @property o @var que hace referencia a la
 * propiedad dada; si no existe, devuelve undefined.
 */
function extractDocForProp(
  node: any,
  allComments: any[],
  propName: string
): string | undefined {
  /* 1) node.doc generado por extractDoc:true */
  if (node.doc) {
    const body = (node.doc.value ?? node.doc).replace(/^\*\s*/gm, "").trim();
    if (new RegExp(`\\$${propName}\\b`).test(body)) {
      return body;
    }
  }

  /* 2) comentarios adjuntos al nodo */
  for (const c of node.leadingComments ?? []) {
    if (c.kind !== "commentblock") {
      continue;
    }
    const body = (c.value ?? c)
      .replace(/^\s*\/\*\*?/, "")
      .replace(/\*\/\s*$/, "")
      .replace(/^\s*\*\s?/gm, "")
      .trim();
    if (new RegExp(`\\$${propName}\\b`).test(body) || /@var\s+/.test(body)) {
      return body;
    }
  }

  /* 3) último bloque antes del nodo que haga match */
  const nodeStart = node.loc?.start.offset ?? 0;
  for (let i = allComments.length - 1; i >= 0; i--) {
    const c = allComments[i];
    if (c.kind !== "commentblock" || c.offset >= nodeStart) {
      continue;
    }
    const body = (c.value ?? c)
      .replace(/^\s*\/\*\*?/, "")
      .replace(/\*\/\s*$/, "")
      .replace(/^\s*\*\s?/gm, "")
      .trim();
    if (new RegExp(`\\$${propName}\\b`).test(body) || /@var\s+/.test(body)) {
      return body;
    }
    break; // el primero que no hace match corta la búsqueda
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
    /* 1️⃣ locate file ------------------------------------------------- */
    const fqcn = this.tagMap.get(tag);
    const file = fqcn && this.fqcnToFile(fqcn);
    if (!file || !fs.existsSync(file)) {
      return [];
    }

    /* 2️⃣ cache ------------------------------------------------------- */
    const mtime = fs.statSync(file).mtimeMs;
    const hit = this.cache.get(tag);
    if (hit && hit.mtime === mtime) {
      return hit.props;
    }

    /* 3️⃣ parse ------------------------------------------------------- */
    const ast = phpEngine.parseCode(fs.readFileSync(file, "utf8"), file);
    const comments = ast.comments ?? [];
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
      if (
        !(
          ((stmt.flags ?? 0) & FLAG_PUBLIC) !== 0 ||
          stmt.visibility === "public"
        )
      ) {
        return;
      }

      const members =
        node.kind !== "classconstant"
          ? stmt.properties ?? []
          : stmt.constants ?? [];

      for (const m of members) {
        handleMember(m, m.name, m.value);
      }

      /* ─────────────────────────────────────────────────────────────── */
      function handleMember(
        propNode: any,
        nameNode: any,
        valueNode: any | undefined
      ): void {
        const name =
          typeof nameNode === "string" ? nameNode : (nameNode?.name as string);
        if (!name) {
          return;
        }

        /* A) doc-comment (@property / @var) --------------------------- */
        const docRaw =
          extractDocForProp(propNode, comments, name) ??
          extractDocForProp(stmt, comments, name);

        /* B) declared type ------------------------------------------- */
        const rawTypeNode = propNode.type ?? stmt.type;
        let finalType: string | undefined =
          rawTypeNode && typeToString(rawTypeNode);

        let allowedLiterals: string | undefined;
        let optional = false;

        if (docRaw) {
          /* @property ↓ */
          const rx = new RegExp(
            `@property\\s+([^\\s]+)\\s+\\$${name}\\s*(?:=\\s*([^\\s]+))?`,
            "i"
          );
          const mProp = rx.exec(docRaw);
          if (mProp) {
            const raw = mProp[1]; // ?int  ó  string[]
            optional = raw.startsWith("?");
            finalType = raw.replace(/^\?/, ""); // quita el "?"
            allowedLiterals = mProp[2]; // 1|2|3|4|5|6
          } else {
            /* @var fallback ↓ */
            const mVar = /@var\s+([^\s]+)/i.exec(docRaw);
            if (mVar) {
              finalType = mVar[1];
            }
          }
        }

        /* C) fallback to declaration / inference --------------------- */
        if (!finalType && stmt.type) {
          finalType = typeToString(stmt.type);
        }
        if (!finalType || finalType === "mixed") {
          finalType = inferTypeFromValue(valueNode);
        }

        /* D) optional via nullable/default null ---------------------- */
        const defaultIsNull = valueNode?.kind === "nullkeyword";
        optional =
          optional ||
          defaultIsNull ||
          propNode.nullable === true ||
          /\bnull\b/.test(finalType);

        /* E) default value ------------------------------------------ */
        let def: string | string[] | undefined;
        if (valueNode) {
          switch (valueNode.kind) {
            case "string":
              def = valueNode.value;
              break;
            case "number":
              def = String(valueNode.value);
              break;
            case "boolean":
              def = valueNode.value ? "true" : "false";
              break;
            case "nullkeyword":
              def = "null";
              break;
            case "array":
              {
                const keys: string[] = [];
                for (const it of valueNode.items as any[]) {
                  if (it.key?.kind === "string") {
                    keys.push(it.key.value);
                  } else if (!it.key && it.value?.kind === "string") {
                    keys.push(it.value.value);
                  }
                }
                def = keys;
              }
              break;
          }
        }

        /* F) push metadata ------------------------------------------ */
        props.push({
          name,
          type: finalType ?? "mixed",
          default: Array.isArray(def) ? def.join("|") : def,
          doc: docRaw?.split(/\r?\n/)[0],
          optional,
          allowed: allowedLiterals,
        });
      }
    });

    /* 4️⃣ cache + return -------------------------------------------- */
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
    .filter(
      ({ name }) => !written.has(name) && name.startsWith(partial) // solo props no escritas + coincide con lo tecleado
    )
    .map(
      ({
        name,
        type,
        default: def,
        doc,
        optional,
        allowed, // ← NUEVO
      }): vscode.CompletionItem => {
        /* ──────────────────────────────────────────────────────────────
         * 1.  item básico
         * ─────────────────────────────────────────────────────────── */
        const item = new vscode.CompletionItem(
          name,
          vscode.CompletionItemKind.Field
        );

        // inserta  foo="$0"
        item.insertText = new vscode.SnippetString(`${name}="$0"`);

        /* ──────────────────────────────────────────────────────────────
         * 2.  detail (lista desplegable)
         * ─────────────────────────────────────────────────────────── */
        const reqFlag = optional ? "(optional)" : "(required)";
        const allowedInfo = allowed ? ` ∈ {${allowed}}` : "";

        item.detail = def
          ? `${reqFlag}  : ${type}${allowedInfo} = ${def}`
          : `${reqFlag}  : ${type}${allowedInfo}`;

        /* ──────────────────────────────────────────────────────────────
         * 3.  documentación / hover
         * ─────────────────────────────────────────────────────────── */
        const md = new vscode.MarkdownString(undefined, true);

        // firma
        md.appendCodeblock(
          def
            ? `${name}: ${type}${allowed ? `  /* ${allowed} */` : ""} = ${def}`
            : `${name}: ${type}${allowed ? `  /* ${allowed} */` : ""}`,
          "php"
        );

        // opcional vs requerido
        md.appendMarkdown(
          `\n\n${
            optional
              ? "_This prop can be omitted (nullable)_"
              : "_This prop is required_"
          }`
        );

        // literales permitidos
        if (allowed) {
          md.appendMarkdown(
            `\n\n_Accepts only:_ **${allowed.replace(/\|/g, " · ")}**`
          );
        }

        // docstring original
        if (doc) {
          md.appendMarkdown("\n\n" + doc);
        }

        item.documentation = md;

        /* ────────────────────────────────────────────────────────────── */
        return item;
      }
    );
}
