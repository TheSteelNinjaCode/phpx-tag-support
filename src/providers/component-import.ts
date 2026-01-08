import * as vscode from "vscode";

export const COMMAND_ADD_IMPORT = "phpx.addImport";
const PHP_LANGUAGE = "php";

/**
 * 1. CODE ACTION PROVIDER
 * Provides the "Quick Fix" lightbulb when a missing import diagnostic is found.
 */
export class ComponentImportCodeActionProvider
  implements vscode.CodeActionProvider
{
  constructor(private getComponentMap: () => Map<string, string>) {}

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const fixes: vscode.CodeAction[] = [];
    const missingImportRe =
      /Missing import for component\s+<([A-Za-z0-9_]+)\s*\/?>/;

    for (const diag of context.diagnostics) {
      const m = diag.message.match(missingImportRe);
      if (!m) {
        continue;
      }

      const tagName = m[1];
      const componentsMap = this.getComponentMap();
      const fullComponent = componentsMap.get(tagName);

      if (!fullComponent) {
        continue;
      }

      const action = new vscode.CodeAction(
        `Import <${tagName}/> from ${fullComponent}`,
        vscode.CodeActionKind.QuickFix
      );

      action.command = {
        title: "Import component",
        command: COMMAND_ADD_IMPORT,
        arguments: [document, fullComponent],
      };

      action.diagnostics = [diag];
      fixes.push(action);
    }

    return fixes;
  }
}

/**
 * 2. COMMAND HANDLER
 * Inserts the 'use' statement into the document.
 */
export const importComponentCommand = async (
  document: vscode.TextDocument,
  fullComponent: string
) => {
  const text = document.getText();

  if (text.includes(`use ${fullComponent};`)) {
    return;
  }

  const lastSlash = fullComponent.lastIndexOf("\\");
  const groupPrefix = fullComponent.substring(0, lastSlash);
  const componentName = fullComponent.substring(lastSlash + 1);

  const edit = new vscode.WorkspaceEdit();

  // Try to find an existing group import: use Namespace\{A, B};
  const groupImportRegex = new RegExp(
    `use\\s+${escapeRegex(groupPrefix)}\\\\\\{([^}]+)\\};`,
    "m"
  );
  const groupMatch = groupImportRegex.exec(text);

  if (groupMatch) {
    let existingComponents = groupMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (!existingComponents.includes(componentName)) {
      existingComponents.push(componentName);
      existingComponents.sort();
      const newGroupImport = `use ${groupPrefix}\\{${existingComponents.join(
        ", "
      )}\\};`;

      const startPos = document.positionAt(groupMatch.index);
      const endPos = document.positionAt(
        groupMatch.index + groupMatch[0].length
      );
      const groupRange = new vscode.Range(startPos, endPos);

      edit.replace(document.uri, groupRange, newGroupImport);
    }
  } else {
    // Look for single imports to group them or find insertion point
    const sepRegex = new RegExp(
      `use\\s+${escapeRegex(groupPrefix)}\\\\([A-Za-z0-9_]+);`,
      "gm"
    );

    const matchArray: { component: string; index: number; length: number }[] =
      [];
    let m;
    while ((m = sepRegex.exec(text)) !== null) {
      matchArray.push({
        component: m[1].trim(),
        index: m.index,
        length: m[0].length,
      });
    }

    if (matchArray.length > 0) {
      // Convert single imports to a group import
      let existingComponents = matchArray.map((x) => x.component);
      if (!existingComponents.includes(componentName)) {
        existingComponents.push(componentName);
      }
      existingComponents = Array.from(new Set(existingComponents)).sort();

      const newGroupImport = `use ${groupPrefix}\\{${existingComponents.join(
        ", "
      )}\\};`;

      const firstMatch = matchArray[0];
      const lastMatch = matchArray[matchArray.length - 1];
      const startPos = document.positionAt(firstMatch.index);
      const endPos = document.positionAt(lastMatch.index + lastMatch.length);
      const groupRange = new vscode.Range(startPos, endPos);

      edit.replace(document.uri, groupRange, newGroupImport);
    } else {
      // Insert new single import
      let insertPosition: vscode.Position;

      if (/^\s*<\?php/.test(text)) {
        const namespaceRegex = /^namespace\s+.+?;/m;
        const nsMatch = namespaceRegex.exec(text);

        if (nsMatch) {
          const nsPosition = document.positionAt(nsMatch.index);
          insertPosition = new vscode.Position(nsPosition.line + 1, 0);
        } else {
          const firstLine = document.lineAt(0);
          insertPosition = new vscode.Position(firstLine.lineNumber + 1, 0);
        }
        edit.insert(document.uri, insertPosition, `use ${fullComponent};\n`);
      } else {
        insertPosition = new vscode.Position(0, 0);
        const newPhpBlock = `<?php\nuse ${fullComponent};\n?>\n\n`;
        edit.insert(document.uri, insertPosition, newPhpBlock);
      }
    }
  }

  await vscode.workspace.applyEdit(edit);
};

/**
 * 3. DIAGNOSTIC LOGIC
 * Scans the file for <Tags> that are missing a 'use' statement.
 */
export const validateMissingImports = (
  document: vscode.TextDocument,
  shouldAnalyze: boolean,
  diagnosticCollection: vscode.DiagnosticCollection
): void => {
  if (document.languageId !== PHP_LANGUAGE || !shouldAnalyze) {
    diagnosticCollection.delete(document.uri);
    return;
  }

  const originalText = document.getText();
  const useMap = parsePhpUseStatements(originalText);

  // Sanitize text to avoid false positives in comments/strings
  let cleanText = removePhpComments(originalText);
  cleanText = blankOutHeredocOpeners(cleanText); // 👈 FIXED: Remove <<<HTML to prevent mismatch
  cleanText = cleanText.replace(/<\?(?:php|=)?[\s\S]*?\?>/g, (m) =>
    " ".repeat(m.length)
  );
  cleanText = removePhpStringLiterals(cleanText);

  const BUILTIN_COMPONENTS = new Set(["Fragment", "slot", "template"]);
  const diagnostics: vscode.Diagnostic[] = [];

  // Find all component tags: <ComponentName
  const tagMatches = [...cleanText.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)];

  tagMatches.forEach((match) => {
    const tag = match[1];
    if (!useMap.has(tag) && !BUILTIN_COMPONENTS.has(tag)) {
      const start = document.positionAt((match.index ?? 0) + 1);
      const range = new vscode.Range(start, start.translate(0, tag.length));

      diagnostics.push(
        new vscode.Diagnostic(
          range,
          `Missing import for component <${tag} />`,
          vscode.DiagnosticSeverity.Warning
        )
      );
    }
  });

  diagnosticCollection.set(document.uri, diagnostics);
};

// --- Helpers ---

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePhpUseStatements(text: string): Map<string, string> {
  const shortNameMap = new Map<string, string>();
  const useRegex = /use\s+([^;]+);/g;
  let match: RegExpExecArray | null;

  while ((match = useRegex.exec(text)) !== null) {
    const importBody = match[1].trim();
    if (!importBody) continue;

    const braceOpenIndex = importBody.indexOf("{");
    const braceCloseIndex = importBody.lastIndexOf("}");

    if (braceOpenIndex !== -1 && braceCloseIndex !== -1) {
      // Group import: use Prefix\{A, B};
      const prefix = importBody.substring(0, braceOpenIndex).trim();
      const insideBraces = importBody
        .substring(braceOpenIndex + 1, braceCloseIndex)
        .trim();

      insideBraces.split(",").forEach((rawItem) => {
        const item = rawItem.trim();
        if (item) processSingleImport(prefix, item, shortNameMap);
      });
    } else {
      // Single import
      processSingleImport("", importBody, shortNameMap);
    }
  }
  return shortNameMap;
}

function processSingleImport(
  prefix: string,
  item: string,
  map: Map<string, string>
) {
  const asMatch = /\bas\b\s+([\w]+)/i.exec(item);
  if (asMatch) {
    const aliasName = asMatch[1];
    const originalPart = item.substring(0, asMatch.index).trim();
    const fullClass = prefix
      ? prefix.endsWith("\\")
        ? prefix + originalPart
        : prefix + "\\" + originalPart
      : originalPart;
    map.set(aliasName, fullClass);
  } else {
    const fullClass = prefix
      ? prefix.endsWith("\\")
        ? prefix + item
        : prefix + "\\" + item
      : item;
    const shortName = fullClass.split("\\").pop() || "";
    map.set(shortName, fullClass);
  }
}

function removePhpComments(text: string): string {
  return text
    .replace(
      /(^|[^:])\/\/[^\r\n]*/g,
      (m, p) => p + " ".repeat(m.length - p.length)
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

function removePhpStringLiterals(text: string): string {
  return text
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length));
}

// 👈 NEW: Helper to mask heredoc openers
function blankOutHeredocOpeners(text: string): string {
  // Matches <<<HTML, <<<"HTML", or <<<'HTML'
  return text.replace(/<<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g, (match) =>
    " ".repeat(match.length)
  );
}
