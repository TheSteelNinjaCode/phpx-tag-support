import * as vscode from "vscode";
import { XMLValidator } from "fast-xml-parser";

// fast-xml-parser doesn't export the error type, so define minimal shape we use.
interface XmlValidationError {
  err?: {
    code: string;
    msg: string;
    line: number;
    col: number;
  };
}

export function registerXmlValidator(context: vscode.ExtensionContext) {
  const collection =
    vscode.languages.createDiagnosticCollection("pp-xml-validation");

  const validate = (doc: vscode.TextDocument) => {
    if (doc.languageId !== "php") return;

    const diagnostics: vscode.Diagnostic[] = [];
    const text = doc.getText();

    // 1) Validate XML-like markup outside of PHP blocks
    diagnostics.push(...validateMixedContent(text, doc));

    // 2) Validate heredocs (<<<XML / <<<HTML) inside PHP blocks
    diagnostics.push(...validateHeredocs(text, doc));

    collection.set(doc.uri, diagnostics);
  };

  if (vscode.window.activeTextEditor) {
    validate(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidSaveTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((e) => validate(e.document))
  );
}

/**
 * Validate "XML-like" markup that is outside PHP blocks.
 * We mask PHP blocks so pure PHP files do not trip XML validation.
 */
function validateMixedContent(
  text: string,
  doc: vscode.TextDocument
): vscode.Diagnostic[] {
  // Mask <?php ... ?> and <?= ... ?> blocks (including missing closing ?> at EOF)
  const masked = text.replace(/<\?(?:php|=)[\s\S]*?(?:\?>|$)/gi, (m) =>
    " ".repeat(m.length)
  );

  if (!masked.trim() || !masked.includes("<")) {
    return [];
  }

  return runXmlValidation(masked, 0, doc, "XML (Mixed)");
}

/**
 * Validate heredocs labeled XML or HTML:
 *
 * return <<<HTML
 * <div>...</div>
 * HTML;
 */
function validateHeredocs(
  text: string,
  doc: vscode.TextDocument
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  const heredocRegex = /<<<(['"]?)(XML|HTML)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2;?/g;

  let match: RegExpExecArray | null;
  while ((match = heredocRegex.exec(text)) !== null) {
    const identifier = match[2]; // XML | HTML
    const content = match[3];

    const fullMatch = match[0];
    const header = fullMatch.split(content)[0];
    const startOffset = match.index + header.length;

    // Mask PHP templating conventions valid in heredocs (e.g. {$attributes}, <?= ... ?>, <?php ... ?>)
    // while preserving length so offsets still line up.
    const sanitized = maskPhpTemplateSyntaxPreserveLength(content);

    if (sanitized.trim().includes("<")) {
      diagnostics.push(
        ...runXmlValidation(sanitized, startOffset, doc, `PHP ${identifier}`)
      );
    }
  }

  return diagnostics;
}

function maskBareAmpersandsPreserveLength(input: string): string {
  // Replace '&' that is NOT starting a valid XML entity:
  //   &name;  or  &#123;  or  &#x1A;
  return input.replace(
    /&(?![A-Za-z][A-Za-z0-9._:-]*;|#\d+;|#x[0-9A-Fa-f]+;)/g,
    "＆" // Fullwidth ampersand, length-preserving
  );
}

function runXmlValidation(
  xmlContent: string,
  offsetAdjustment: number,
  doc: vscode.TextDocument,
  source: string
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  // Ignore contents of <script> and <style> (JS/CSS can contain "<" which is not XML-safe)
  const safeContent = maskScriptAndStyleBodiesPreserveLength(xmlContent);
  const contentForValidation = maskBareAmpersandsPreserveLength(safeContent);

  const options = {
    allowBooleanAttributes: true,
  };

  let result = XMLValidator.validate(contentForValidation, options);

  // If XML complains about multiple roots, treat it as an HTML fragment: wrap and re-validate.
  if (result !== true) {
    const err = (result as XmlValidationError)?.err;
    const msg = err?.msg || "";

    if (msg.includes("Multiple possible root nodes found")) {
      const looksLikeDocument =
        /^\s*<\?xml\b/i.test(safeContent) ||
        /^\s*<!doctype\b/i.test(safeContent);

      if (!looksLikeDocument) {
        const prefix = "<__pp_fragment__>";
        const suffix = "</__pp_fragment__>";
        const wrapped = prefix + safeContent + suffix;

        const wrappedResult = XMLValidator.validate(wrapped, options);

        // If wrapped is valid => fragment is valid => no XML error (only lint warnings/errors).
        if (wrappedResult === true) {
          diagnostics.push(
            ...lintAttributesWithoutValues(
              safeContent,
              offsetAdjustment,
              doc,
              source
            )
          );
          return diagnostics;
        }

        // If wrapped still errors, map it back into the original fragment coordinates if possible.
        const wErr = (wrappedResult as XmlValidationError)?.err;
        if (wErr) {
          const wrappedOffset = offsetFromLineCol(wrapped, wErr.line, wErr.col);
          const originalOffset = wrappedOffset - prefix.length;

          if (originalOffset >= 0 && originalOffset <= safeContent.length) {
            diagnostics.push(
              makeDiagnosticAtOffset(
                offsetAdjustment + originalOffset,
                doc,
                `Invalid XML: ${wErr.msg}`,
                vscode.DiagnosticSeverity.Error,
                source
              )
            );
            diagnostics.push(
              ...lintAttributesWithoutValues(
                safeContent,
                offsetAdjustment,
                doc,
                source
              )
            );
            return diagnostics;
          }
        }
        // Fall through if we can't map safely.
      }
    }

    // Normal XML error mapping
    if (err) {
      const absoluteOffset =
        offsetAdjustment + offsetFromLineCol(safeContent, err.line, err.col);

      diagnostics.push(
        makeDiagnosticAtOffset(
          absoluteOffset,
          doc,
          `Invalid XML: ${err.msg}`,
          vscode.DiagnosticSeverity.Error,
          source
        )
      );
    }
  }

  // Always run lint to provide guidance like disabled="true" and catch missing values for non-boolean attrs.
  diagnostics.push(
    ...lintAttributesWithoutValues(safeContent, offsetAdjustment, doc, source)
  );

  return diagnostics;
}

function parseAttrsRespectingQuotes(
  attrsPart: string
): Array<{ name: string; hasValue: boolean; nameIndex: number }> {
  const out: Array<{ name: string; hasValue: boolean; nameIndex: number }> = [];
  const s = attrsPart;
  const n = s.length;

  let i = 0;

  const isSpace = (c: string) =>
    c === " " || c === "\t" || c === "\n" || c === "\r";
  const isNameStart = (c: string) => /[A-Za-z_:]/.test(c);
  const isNameChar = (c: string) => /[\w:.-]/.test(c);

  while (i < n) {
    // skip whitespace
    while (i < n && isSpace(s[i])) i++;
    if (i >= n) break;

    // stop if we hit a stray slash (self-close) or angle bracket (shouldn't be here, but safe)
    if (s[i] === "/" || s[i] === ">") break;

    // attribute name
    if (!isNameStart(s[i])) {
      i++;
      continue;
    }

    const nameStart = i;
    i++;
    while (i < n && isNameChar(s[i])) i++;
    const name = s.slice(nameStart, i);

    // skip whitespace
    while (i < n && isSpace(s[i])) i++;

    // check for '='
    let hasValue = false;
    if (i < n && s[i] === "=") {
      hasValue = true;
      i++; // skip '='
      while (i < n && isSpace(s[i])) i++;

      // parse value (quoted or unquoted)
      if (i < n && (s[i] === '"' || s[i] === "'")) {
        const q = s[i];
        i++; // skip opening quote
        while (i < n && s[i] !== q) i++;
        if (i < n && s[i] === q) i++; // skip closing quote
      } else {
        // unquoted value: read until whitespace or end
        while (i < n && !isSpace(s[i]) && s[i] !== ">") i++;
      }
    }

    out.push({ name, hasValue, nameIndex: nameStart });
  }

  return out;
}

function lintAttributesWithoutValues(
  xmlContent: string,
  offsetAdjustment: number,
  doc: vscode.TextDocument,
  source: string
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  const booleanAttrs = new Set([
    "disabled",
    "checked",
    "selected",
    "readonly",
    "multiple",
    "required",
    "autofocus",
    "autoplay",
    "controls",
    "loop",
    "muted",
    "open",
    "hidden",
    "async",
    "defer",
    "novalidate",
    "formnovalidate",
    "reversed",
    "ismap",
    "itemscope",
    "scoped",
  ]);

  // Match start tags only (not closing tags or comments)
  const tagRegex = /<([A-Za-z][\w:-]*)(\s[^<>]*?)?(\s*\/?)>/g;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagRegex.exec(xmlContent)) !== null) {
    const tagName = tagMatch[1];
    const attrsPart = tagMatch[2] || "";
    if (!attrsPart) continue;

    // Parse attributes safely (respect quotes)
    const attrs = parseAttrsRespectingQuotes(attrsPart);

    for (const a of attrs) {
      if (a.hasValue) continue;

      const attrLower = a.name.toLowerCase();

      // Compute absolute offset for attribute name within original document
      // "<" + tagName is length (1 + tagName.length), attrsPart begins immediately after that
      const attrsStartInTag = 1 + tagName.length;
      const absoluteOffset =
        offsetAdjustment + tagMatch.index + attrsStartInTag + a.nameIndex;

      if (booleanAttrs.has(attrLower)) {
        diagnostics.push(
          makeDiagnosticAtOffset(
            absoluteOffset,
            doc,
            `Boolean attribute '${a.name}' is allowed, but prefer ${a.name}="true" for strict XML compatibility.`,
            vscode.DiagnosticSeverity.Warning,
            `${source}:boolean-attr`,
            a.name.length
          )
        );
      } else {
        diagnostics.push(
          makeDiagnosticAtOffset(
            absoluteOffset,
            doc,
            `Invalid XML: attribute '${a.name}' must have a value (e.g., ${a.name}="...").`,
            vscode.DiagnosticSeverity.Error,
            `${source}:missing-attr-value`,
            a.name.length
          )
        );
      }
    }
  }

  return diagnostics;
}

/**
 * Mask PHP templating syntax inside heredocs while preserving length:
 * - <?= ... ?>, <?php ... ?>
 * - {$var}, {$this->children}, { $attributes }, etc.
 */
function maskPhpTemplateSyntaxPreserveLength(input: string): string {
  let out = input;

  // Mask PHP tags inside heredoc content
  out = out.replace(/<\?(?:php|=)[\s\S]*?\?>/gi, (m) => " ".repeat(m.length));

  // Mask PHP interpolation blocks (common heredoc templating)
  out = out.replace(/\{\s*\$[^}]*\}/g, (m) => " ".repeat(m.length));

  return out;
}

/**
 * Mask the body content of <script> and <style> tags (keep tags, blank inner body),
 * preserving exact length for accurate diagnostics.
 */
function maskScriptAndStyleBodiesPreserveLength(input: string): string {
  let out = maskTagBodyPreserveLength(input, "script");
  out = maskTagBodyPreserveLength(out, "style");
  return out;
}

function maskTagBodyPreserveLength(
  input: string,
  tagName: "script" | "style"
): string {
  const re = new RegExp(
    `<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`,
    "gi"
  );

  return input.replace(re, (m) => {
    const openEnd = m.indexOf(">") + 1;
    const lower = m.toLowerCase();
    const closeStart = lower.lastIndexOf(`</${tagName}`);

    if (openEnd <= 0 || closeStart < openEnd) return " ".repeat(m.length);

    // Keep <script ...> and </script>, replace ONLY the inner body with spaces
    return (
      m.slice(0, openEnd) +
      " ".repeat(closeStart - openEnd) +
      m.slice(closeStart)
    );
  });
}

/**
 * Convert 1-based (line, col) into 0-based string offset.
 */
function offsetFromLineCol(text: string, line: number, col: number): number {
  const lines = text.split("\n");
  let off = 0;

  const safeLine = Math.max(1, Math.min(line, lines.length));
  for (let i = 0; i < safeLine - 1; i++) off += lines[i].length + 1; // newline

  const lineText = lines[safeLine - 1] ?? "";
  const safeCol = Math.max(1, Math.min(col, lineText.length + 1));
  off += safeCol - 1;

  return off;
}

/**
 * Create a diagnostic at a document offset, highlighting `highlightLen` chars (default 5).
 */
function makeDiagnosticAtOffset(
  absoluteOffset: number,
  doc: vscode.TextDocument,
  message: string,
  severity: vscode.DiagnosticSeverity,
  code: string,
  highlightLen: number = 5
): vscode.Diagnostic {
  const startPos = doc.positionAt(Math.max(0, absoluteOffset));
  const line = doc.lineAt(startPos.line);

  let endPos = startPos.translate(0, highlightLen);
  if (endPos.character > line.range.end.character) {
    endPos = line.range.end;
  }

  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(startPos, endPos),
    message,
    severity
  );
  diagnostic.source = "Prisma PHP XML";
  diagnostic.code = code;

  return diagnostic;
}
