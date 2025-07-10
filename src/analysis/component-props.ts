import { Node } from "php-parser";
import * as fs from "fs";
import * as vscode from "vscode";
import { phpEngine } from "../util/php-engine";
import { getComponentsFromClassLog } from "../extension";

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

function isAllowed(meta: any, value: string): boolean {
  // If no allowed values specified, only check if value matches the type
  if (!meta.allowed) {
    return isValidType(meta.type, value);
  }

  // If allowed values are specified, check against them
  const allowedValues = meta.allowed.split("|").map((v: string) => v.trim());
  return allowedValues.includes(value);
}

function isValidType(type: string, value: string): boolean {
  if (!value.trim()) {
    return false; // Empty values are not valid
  }

  switch (type.toLowerCase()) {
    case "int":
    case "integer":
      return /^\d+$/.test(value);
    case "float":
    case "double":
      return /^\d+\.?\d*$/.test(value);
    case "bool":
    case "boolean":
      return ["true", "false", "1", "0"].includes(value.toLowerCase());
    case "string":
      return true; // Any non-empty string is valid
    default:
      return true; // Unknown types are allowed
  }
}

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
          /* @property ↓ - IMPROVED REGEX TO CAPTURE FULL COMMENT */
          const rx = new RegExp(
            `@property\\s+([^\\s]+)\\s+\\$${name}\\s*(.*)`,
            "i"
          );
          const mProp = rx.exec(docRaw);
          if (mProp) {
            const rawType = mProp[1]; // ?int
            const fullComment = mProp[2]?.trim(); // = 1|2|3|4|5|6 Your Idea

            optional = rawType.startsWith("?");
            finalType = rawType.replace(/^\?/, ""); // Remove the "?"

            // Parse the comment part after the type
            if (fullComment) {
              // Look for pattern: = value(s) [optional description]
              const commentMatch = /^\s*=\s*([^\s]+)(?:\s+(.*))?/.exec(
                fullComment
              );
              if (commentMatch) {
                const valuesPart = commentMatch[1]; // 1|2|3|4|5|6
                const description = commentMatch[2]; // Your Idea

                // Check if it contains multiple values (pipe-separated)
                if (valuesPart.includes("|")) {
                  allowedLiterals = valuesPart;
                } else {
                  // Single value - could be default, don't restrict
                  // Only set default if it's not a description
                  if (!description && !isNaN(Number(valuesPart))) {
                    // It's a numeric default, don't restrict
                  }
                }
              }
            }
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

/* ────────────────────────────────────────────────────────────── *
 *        1️⃣  A tiny validator for component‑prop *values*        *
 * ────────────────────────────────────────────────────────────── */

const ATTR_VALUE_DIAG =
  vscode.languages.createDiagnosticCollection("phpx-attr-values");

export function validateComponentPropValues(
  doc: vscode.TextDocument,
  propsProvider: ComponentPropsProvider
) {
  if (doc.languageId !== "php") {
    return;
  }

  const text = doc.getText();
  const diags: vscode.Diagnostic[] = [];

  /*           <Tag  foo="bar"  other="…">                            */
  const tagRe = /<\s*([A-Z][A-Za-z0-9_]*)\b([^>]*?)\/?>/g; // entire opening tag
  const attrRe = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g; // every attr="val"

  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(text))) {
    const [, tag, attrPart] = tagMatch;

    // ✅ FIX: Reset regex state and get props for THIS specific component
    attrRe.lastIndex = 0;

    const props = propsProvider.getProps(tag);
    if (!props.length) {
      continue;
    }

    // ✅ FIX: Add logging to debug which component we're validating
    console.log(
      `Validating component: ${tag}, Props:`,
      props.map((p) => `${p.name}${p.optional ? "?" : ""}`)
    );

    /* record which attrs we actually saw in this tag */
    const present = new Set<string>();

    /* ── 1️⃣  validate values that ARE present ─────────────────── */
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(attrPart))) {
      const [, attrName, value] = attrMatch;
      present.add(attrName);

      const meta = props.find((p) => p.name === attrName);
      if (!meta) {
        continue; // we don't know this prop
      }

      if (!isAllowed(meta, value)) {
        const tagStart = tagMatch.index;
        const attrRelOffset = tagMatch[0].indexOf(attrMatch[0]);
        const absStart = tagStart + attrRelOffset + attrMatch[0].indexOf(value);
        const absEnd = absStart + value.length;

        const allowedInfo = meta.allowed
          ? `Allowed values: ${meta.allowed.replace(/\|/g, ", ")}`
          : `Expected type: ${meta.type}`;

        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(doc.positionAt(absStart), doc.positionAt(absEnd)),
            `Invalid value "${value}". ${allowedInfo}`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }

    /* ── 2️⃣  flag *missing* required props ─────────────────────── */
    for (const p of props) {
      if (!p.optional && !present.has(p.name)) {
        // ✅ FIX: Add detailed logging to track the issue
        console.log(`Component ${tag} is missing required prop: ${p.name}`);
        console.log(`Present attributes:`, Array.from(present));

        // ✅ FIX: Double-check that this prop actually belongs to this component
        const componentsMap = getComponentsFromClassLog();
        const fqcn = componentsMap.get(tag);
        console.log(`FQCN for ${tag}:`, fqcn);

        // ✅ FIX: Only add diagnostic if we're sure this is the right component
        if (
          fqcn &&
          propsProvider
            .getProps(tag)
            .some((prop) => prop.name === p.name && !prop.optional)
        ) {
          // highlight the tag name itself for visibility
          const tagNameStart = tagMatch.index + 1; // skip '<'
          const tagNameEnd = tagNameStart + tag.length;

          diags.push(
            new vscode.Diagnostic(
              new vscode.Range(
                doc.positionAt(tagNameStart),
                doc.positionAt(tagNameEnd)
              ),
              `Missing required attribute "${p.name}" for component <${tag}>.`,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }

    // ✅ FIX: Reset regex state after each tag
    attrRe.lastIndex = 0;
  }

  ATTR_VALUE_DIAG.set(doc.uri, diags);
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
    .map(
      ({
        name,
        type,
        default: def,
        doc,
        optional,
        allowed,
      }): vscode.CompletionItem => {
        /* ──────────────────────────────────────────────────────────────
         * 1. Combine property value with documentation values (IMPROVED)
         * ─────────────────────────────────────────────────────────── */
        const combinedValues = new Set<string>();

        // Add documentation values first
        if (allowed) {
          if (allowed.includes("|")) {
            allowed.split("|").forEach((val) => {
              const trimmedVal = val.trim();
              if (trimmedVal) {
                // Only add non-empty values
                combinedValues.add(trimmedVal);
              }
            });
          } else {
            const trimmedVal = allowed.trim();
            if (trimmedVal) {
              combinedValues.add(trimmedVal);
            }
          }
        }

        // Add property default value (ensure no duplicates)
        if (def && def !== "null" && def.trim()) {
          combinedValues.add(def.trim());
        }

        // Create final allowed values string - maintain original order with default first if present
        let finalAllowed: string | undefined;
        if (combinedValues.size > 0) {
          const valuesArray = Array.from(combinedValues);

          // If default exists and is in the allowed values, put it first
          if (def && def !== "null" && combinedValues.has(def.trim())) {
            const defaultVal = def.trim();
            const otherValues = valuesArray.filter((v) => v !== defaultVal);
            finalAllowed = [defaultVal, ...otherValues].join("|");
          } else {
            finalAllowed = valuesArray.sort().join("|");
          }
        }

        /* ──────────────────────────────────────────────────────────────
         * 2. Basic completion item setup
         * ─────────────────────────────────────────────────────────── */
        const item = new vscode.CompletionItem(
          name,
          vscode.CompletionItemKind.Field
        );

        // Simplified insertion - always use placeholder, let value completion provider handle values
        item.insertText = new vscode.SnippetString(`${name}="$0"`);

        // Set cursor position after insertion to trigger value completion
        item.command = {
          command: "editor.action.triggerSuggest",
          title: "Trigger Suggest",
        };

        /* ──────────────────────────────────────────────────────────────
         * 3. Detail text (shown in completion dropdown)
         * ─────────────────────────────────────────────────────────── */
        const reqFlag = optional ? "(optional)" : "(required)";
        const allowedInfo = finalAllowed ? ` ∈ {${finalAllowed}}` : "";

        item.detail = def
          ? `${reqFlag} : ${type}${allowedInfo} = ${def}`
          : `${reqFlag} : ${type}${allowedInfo}`;

        /* ──────────────────────────────────────────────────────────────
         * 4. Documentation markdown (shown in hover/documentation panel)
         * ─────────────────────────────────────────────────────────── */
        const md = new vscode.MarkdownString(undefined, true);

        // Property signature
        const signature = def
          ? `${name}: ${type}${
              finalAllowed ? ` /* ${finalAllowed} */` : ""
            } = ${def}`
          : `${name}: ${type}${finalAllowed ? ` /* ${finalAllowed} */` : ""}`;

        md.appendCodeblock(signature, "php");

        // Required/Optional status with better styling
        md.appendMarkdown(
          `\n\n${
            optional
              ? "🔸 _This property is **optional** (nullable)_"
              : "🔹 _This property is **required**_"
          }`
        );

        // Allowed values section with enhanced formatting
        if (finalAllowed) {
          const allowedValues = finalAllowed.includes("|")
            ? finalAllowed
                .split("|")
                .map((val) => val.trim())
                .filter((val) => val) // Remove empty values
                .map((val) => `\`${val}\``)
                .join(" • ")
            : `\`${finalAllowed}\``;

          md.appendMarkdown(`\n\n**🎯 Allowed values:** ${allowedValues}`);

          // Add helpful hint for multiple values
          if (finalAllowed.includes("|")) {
            md.appendMarkdown(
              `\n\n💡 _Press **Ctrl+Space** inside the quotes to see all available options_`
            );
          }
        }

        // Default value information with better styling
        if (def) {
          md.appendMarkdown(`\n\n**📌 Default value:** \`${def}\``);
        }

        // Type information
        md.appendMarkdown(`\n\n**🏷️ Type:** \`${type}\``);

        // Original documentation from PHP docblock
        if (doc) {
          md.appendMarkdown(`\n\n---\n\n📝 **Documentation:**\n\n${doc}`);
        }

        // Usage example
        if (finalAllowed && finalAllowed.includes("|")) {
          const exampleValue = finalAllowed.split("|")[0].trim();
          md.appendMarkdown(
            `\n\n---\n\n**📋 Example:**\n\`\`\`php\n<${tag} ${name}="${exampleValue}" />\n\`\`\``
          );
        } else if (def) {
          md.appendMarkdown(
            `\n\n---\n\n**📋 Example:**\n\`\`\`php\n<${tag} ${name}="${def}" />\n\`\`\``
          );
        }

        item.documentation = md;

        /* ──────────────────────────────────────────────────────────────
         * 5. Additional completion item properties
         * ─────────────────────────────────────────────────────────── */

        // Sort priority (required props first, then by name)
        item.sortText = optional ? `z_${name}` : `a_${name}`;

        // Filter text for better matching
        item.filterText = name;

        // Preselect logic improvements
        if (!optional) {
          // Always preselect required properties
          item.preselect = true;
        } else if (finalAllowed && finalAllowed.includes("|")) {
          // Preselect optional properties with restricted values
          item.preselect = true;
        }

        // Enhanced kind based on property characteristics
        if (finalAllowed && finalAllowed.includes("|")) {
          item.kind = vscode.CompletionItemKind.Enum;
        } else if (!optional) {
          item.kind = vscode.CompletionItemKind.Property;
        } else {
          item.kind = vscode.CompletionItemKind.Field;
        }

        // Add visual indicators through tags
        const tags: vscode.CompletionItemTag[] = [];
        if (optional && !def) {
          // Optional without default - less important
          tags.push(vscode.CompletionItemTag.Deprecated);
        }
        if (tags.length > 0) {
          item.tags = tags;
        }

        // Store the final allowed values for the attribute value completion provider
        // IMPORTANT: This is where value completion gets its data - ensure no duplicates here
        (item as any).allowedValues = finalAllowed;
        (item as any).defaultValue = def?.trim();

        return item;
      }
    );
}
