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

function extractClassBodies(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const classRe = /class\s+([A-Za-z_]\w*)[^{]*\{/g;
  let m: RegExpExecArray | null;

  while ((m = classRe.exec(src))) {
    const name = m[1];
    let depth = 1,
      i = classRe.lastIndex;
    while (depth && i < src.length) {
      if (src[i] === "{") {
        depth++;
      } else if (src[i] === "}") {
        depth--;
      }
      i++;
    }
    out[name] = src.slice(classRe.lastIndex, i - 1); // cuerpo limpio
    classRe.lastIndex = i; // seguimos tras la llave
  }
  return out;
}

function parsePublicProps(body: string): PropMeta[] {
  const props: PropMeta[] = [];
  const propRe =
    /public\s+\??([\w\\|]+)\s+\$([A-Za-z_]\w*)(?:\s*=\s*([^;]+))?;/g;
  let m: RegExpExecArray | null;

  while ((m = propRe.exec(body))) {
    const [, rawType, name, def] = m;

    props.push({
      name,
      type: rawType, // dejamos todos los “|” para el tooltip
      default: def?.trim(),
      optional: /\bnull\b/i.test(rawType), // ← lo que pide tu interfaz
      // doc y allowed los puedes añadir más tarde si lo necesitas
    });
  }
  return props;
}

export function buildPropsFromPhpFile(fqcn: string, src: string): PropMeta[] {
  const classes = extractClassBodies(src);
  const short = fqcn.split("\\").pop()!;
  const body = classes[short];
  return body ? parsePublicProps(body) : [];
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
    /* 1️⃣ localizar el archivo --------------------------------------- */
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

    /* 3️⃣ parsear el AST completo ------------------------------------ */
    const src = fs.readFileSync(file, "utf8");
    const ast = phpEngine.parseCode(src, file);
    const comments = ast.comments ?? [];

    // 🔧 FIX: Extract the correct target class name from the FQCN
    const targetClass = fqcn!.split("\\").pop()!;
    const props: PropMeta[] = [];

    /* ——— helpers locales ——————————————————————————————— */
    const pushProp = (
      stmt: any,
      propNode: any,
      nameNode: any,
      valueNode: any | undefined
    ) => {
      const name =
        typeof nameNode === "string" ? nameNode : (nameNode?.name as string);
      if (!name) {
        return;
      }

      /* A) doc-comment ------------------------------------------------ */
      const docRaw =
        extractDocForProp(propNode, comments, name) ??
        extractDocForProp(stmt, comments, name);

      /* B) tipo declarado ------------------------------------------- */
      const rawTypeNode = propNode.type ?? stmt.type;
      let finalType: string | undefined =
        rawTypeNode && typeToString(rawTypeNode);

      let allowedLiterals: string | undefined;
      let optional = false;

      if (docRaw) {
        const rx = new RegExp(
          `@property\\s+([^\\s]+)\\s+\\$${name}\\s*(.*)`,
          "i"
        );
        const mProp = rx.exec(docRaw);
        if (mProp) {
          const rawType = mProp[1];
          const full = mProp[2]?.trim();
          optional = rawType.startsWith("?");
          finalType = rawType.replace(/^\?/, "");

          if (full) {
            const cm = /^\s*=\s*([^\s]+)(?:\s+.*)?$/.exec(full);
            if (cm && cm[1].includes("|")) {
              allowedLiterals = cm[1];
            }
          }
        } else {
          const mVar = /@var\s+([^\s]+)/i.exec(docRaw);
          if (mVar) {
            finalType = mVar[1];
          }
        }
      }

      /* C) fallback a declaración/inferencia ------------------------- */
      if (!finalType && stmt.type) {
        finalType = typeToString(stmt.type);
      }
      if (!finalType || finalType === "mixed") {
        finalType = inferTypeFromValue(valueNode);
      }

      /* D) optional por nullable o default null ---------------------- */
      const defaultIsNull = valueNode?.kind === "nullkeyword";
      optional =
        optional ||
        defaultIsNull ||
        propNode.nullable === true ||
        /\bnull\b/.test(finalType);

      /* E) default --------------------------------------------------- */
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
            def = (valueNode.items as any[])
              .map((it: any) => it.value?.value ?? it.key?.value)
              .filter(Boolean);
            break;
        }
      }

      const finalProp = {
        name,
        type: finalType ?? "mixed",
        default: Array.isArray(def) ? def.join("|") : def,
        doc: docRaw?.split(/\r?\n/)[0],
        optional,
        allowed: allowedLiterals,
      };

      props.push(finalProp);
    };

    /* ——— 🔧 FIX: Find and process the specific target class ——— */
    const walkClass = (classNode: any) => {
      const className = classNode.name?.name ?? classNode.name;

      if (className !== targetClass) {
        return; // Skip classes that don't match
      }

      // Only process the direct body of the target class
      for (const stmt of classNode.body ?? []) {
        if (
          stmt.kind === "propertystatement" ||
          stmt.kind === "promotedproperty" ||
          stmt.kind === "classconstant"
        ) {
          const pub =
            ((stmt.flags ?? 0) & FLAG_PUBLIC) !== 0 ||
            stmt.visibility === "public";

          if (!pub) {
            continue;
          }

          const members =
            stmt.kind !== "classconstant"
              ? stmt.properties ?? []
              : stmt.constants ?? [];

          for (const member of members) {
            pushProp(stmt, member, member.name, member.value);
          }
        }

        /* promoted‑properties en __construct() ----------------------- */
        if (stmt.kind === "method" && stmt.name?.name === "__construct") {
          for (const param of stmt.arguments ?? []) {
            if (
              param.kind === "parameter" &&
              ((param.flags ?? 0) & FLAG_PUBLIC) !== 0
            ) {
              pushProp(param, param, param.name, param.value);
            }
          }
        }
      }
    };

    /* ——— 🔧 FIX: Find all classes in the file ——— */
    const findClasses = (node: any) => {
      if (node.kind === "class") {
        walkClass(node);
        return; // Don't recurse into class body, we handle it above
      }

      // Only recurse into container nodes
      if (node.kind === "namespace" || node.kind === "program") {
        for (const child of node.children ?? []) {
          if (child && typeof child === "object" && child.kind) {
            findClasses(child);
          }
        }
      }
    };

    findClasses(ast);

    /* 4️⃣ cache y return -------------------------------------------- */
    this.cache.set(tag, { mtime, props });
    return props;
  }

  /** Clear cache – call when class files change. */
  public clear(): void {
    this.cache.clear();
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

  const tagRe = /<\s*([A-Z][A-Za-z0-9_]*)\b([^>]*?)\/?>/g;
  const attrRe = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g;

  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(text))) {
    const [, tag, attrPart] = tagMatch;

    attrRe.lastIndex = 0;

    const props = propsProvider.getProps(tag);

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
        // ✅ FIX: Double-check that this prop actually belongs to this component
        const componentsMap = getComponentsFromClassLog();
        const fqcn = componentsMap.get(tag);

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
