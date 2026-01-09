import * as vscode from "vscode";
import { XMLValidator } from "fast-xml-parser";

// 1. Define the interface manually since it is not exported
interface XmlValidationError {
  err: {
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

    // 1. Validate Mixed Content (XML outside of PHP)
    const mixedDiagnostics = validateMixedContent(text, doc);
    diagnostics.push(...mixedDiagnostics);

    // 2. Validate Heredocs (<<<XML inside PHP)
    const heredocDiagnostics = validateHeredocs(text, doc);
    diagnostics.push(...heredocDiagnostics);

    collection.set(doc.uri, diagnostics);
  };

  // Initial validation
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

function validateMixedContent(
  text: string,
  doc: vscode.TextDocument
): vscode.Diagnostic[] {
  // FIX 1: Updated Regex to match PHP blocks that end with ?> OR End-of-File ($)
  // This ensures pure PHP files (which validly omit ?>) are fully masked out.
  const pureXml = text.replace(/<\?(?:php|=)[\s\S]*?(?:\?>|$)/gi, (match) => {
    return " ".repeat(match.length);
  });

  // If the result is empty or doesn't look like XML, skip validation entirely.
  // This solves the "Start tag expected" error in pure PHP files.
  if (!pureXml.trim() || !pureXml.includes("<")) {
    return [];
  }

  return runXmlValidation(pureXml, 0, doc, "XML (Mixed)");
}

function maskPhpTemplateSyntaxPreserveLength(input: string): string {
  let out = input;

  // 1) Mask PHP tags that may appear inside the heredoc content
  //    <?= ... ?>, <?php ... ?> (and variants)
  out = out.replace(/<\?(?:php|=)[\s\S]*?\?>/gi, (m) => " ".repeat(m.length));

  // 2) Mask PHP variable interpolation blocks commonly used in heredocs:
  //    {$attributes}, { $attributes }, {$this->children}, etc.
  //    These are not XML attribute names, but are valid PHP templating.
  out = out.replace(/\{\s*\$[^}]*\}/g, (m) => " ".repeat(m.length));

  return out;
}

function validateHeredocs(
  text: string,
  doc: vscode.TextDocument
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const heredocRegex = /<<<(['"]?)(XML|HTML)\1\s*\r?\n([\s\S]*?)\r?\n\s*\2;?/g;

  let match;
  while ((match = heredocRegex.exec(text)) !== null) {
    const identifier = match[2];
    const content = match[3];
    const fullMatch = match[0];
    const header = fullMatch.split(content)[0];
    const startOffset = match.index + header.length;

    // Sanitize PHP templating fragments inside the heredoc, but keep exact length
    // so diagnostics still point to the correct positions in the original file.
    const sanitized = maskPhpTemplateSyntaxPreserveLength(content);

    if (sanitized.trim().startsWith("<")) {
      diagnostics.push(
        ...runXmlValidation(sanitized, startOffset, doc, `PHP ${identifier}`)
      );
    }
  }

  return diagnostics;
}

function runXmlValidation(
  xmlContent: string,
  offsetAdjustment: number,
  doc: vscode.TextDocument,
  source: string
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  // Allow HTML/JSX-style boolean attrs (<button disabled>) so it doesn't hard-error,
  // but we'll emit a Warning suggesting disabled="true".
  const result = XMLValidator.validate(xmlContent, {
    allowBooleanAttributes: true,
  });

  // Keep normal XML parser errors (malformed tags, etc.)
  if (result !== true) {
    const validationResult = result as unknown as XmlValidationError;
    const err = validationResult.err;

    if (err) {
      const errorLines = xmlContent.split("\n");
      const errorLineIndex = err.line - 1;

      if (errorLineIndex >= 0 && errorLineIndex < errorLines.length) {
        let absoluteOffset = offsetAdjustment;
        for (let i = 0; i < errorLineIndex; i++) {
          absoluteOffset += errorLines[i].length + 1; // newline
        }
        absoluteOffset += err.col - 1;

        const startPos = doc.positionAt(absoluteOffset);
        const rangeLine = doc.lineAt(startPos.line);

        let endPos = startPos.translate(0, 5);
        if (endPos.character > rangeLine.range.end.character) {
          endPos = rangeLine.range.end;
        }

        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(startPos, endPos),
          `Invalid XML: ${err.msg}`,
          vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = "Prisma PHP XML";
        diagnostic.code = source;

        diagnostics.push(diagnostic);
      }
    }
  }

  // Add guidance for boolean attrs + keep strictness for non-boolean attrs missing values.
  diagnostics.push(
    ...lintAttributesWithoutValues(xmlContent, offsetAdjustment, doc, source)
  );

  return diagnostics;
}

function lintAttributesWithoutValues(
  xmlContent: string,
  offsetAdjustment: number,
  doc: vscode.TextDocument,
  source: string
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  // Common HTML boolean attributes: allowed, but we recommend explicit XML form: attr="true"
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

  // Start tags only (not closing tags/comments)
  const tagRegex = /<([A-Za-z][\w:-]*)(\s[^<>]*?)?(\s*\/?)>/g;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagRegex.exec(xmlContent)) !== null) {
    const tagName = tagMatch[1];
    const attrsPart = tagMatch[2] || "";
    if (!attrsPart) continue;

    // Attributes without "=" (e.g., " disabled" before space or tag end)
    const attrRegex = /\s([A-Za-z_:][\w:.-]*)(?!\s*=)(?=(\s|$))/g;
    let attrMatch: RegExpExecArray | null;

    while ((attrMatch = attrRegex.exec(attrsPart)) !== null) {
      const attrName = attrMatch[1];
      const attrLower = attrName.toLowerCase();

      // Compute absolute offset for attribute name
      const attrsStartInTag = 1 + tagName.length;
      const attrNameStartInTag = attrsStartInTag + attrMatch.index + 1; // +1 skip leading space
      const absoluteOffset =
        offsetAdjustment + tagMatch.index + attrNameStartInTag;

      const startPos = doc.positionAt(absoluteOffset);
      const endPos = startPos.translate(0, attrName.length);

      const line = doc.lineAt(startPos.line);
      const safeEnd =
        endPos.character > line.range.end.character ? line.range.end : endPos;

      if (booleanAttrs.has(attrLower)) {
        const d = new vscode.Diagnostic(
          new vscode.Range(startPos, safeEnd),
          `Boolean attribute '${attrName}' is allowed, but prefer ${attrName}="true" for strict XML compatibility.`,
          vscode.DiagnosticSeverity.Warning
        );
        d.source = "Prisma PHP XML";
        d.code = `${source}:boolean-attr`;
        diagnostics.push(d);
      } else {
        // Re-introduce strictness: any other attr without a value is very likely a mistake
        const d = new vscode.Diagnostic(
          new vscode.Range(startPos, safeEnd),
          `Invalid XML: attribute '${attrName}' must have a value (e.g., ${attrName}="...").`,
          vscode.DiagnosticSeverity.Error
        );
        d.source = "Prisma PHP XML";
        d.code = `${source}:missing-attr-value`;
        diagnostics.push(d);
      }
    }
  }

  return diagnostics;
}
