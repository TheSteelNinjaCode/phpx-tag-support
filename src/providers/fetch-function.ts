import * as vscode from "vscode";

/**
 * Extracts public PHP functions from the document (excluding those starting with _)
 * Only analyzes PHP code blocks, not JavaScript inside <script> tags
 */
function extractPhpFunctions(document: vscode.TextDocument): {
  name: string;
  position: vscode.Position;
}[] {
  const text = document.getText();
  const functions: { name: string; position: vscode.Position }[] = [];

  // First, identify all PHP code blocks and script tag ranges
  const phpBlocks = extractPhpCodeBlocks(text);

  // Match PHP function definitions within PHP blocks only
  const functionRegex = /function\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = functionRegex.exec(text)) !== null) {
    const functionName = match[1];
    const matchIndex = match.index;

    // Skip functions starting with underscore (private functions)
    if (functionName.startsWith("_")) {
      continue;
    }

    // Check if this function is inside a PHP block (not inside <script> tags)
    if (isInPhpBlock(matchIndex, phpBlocks)) {
      const position = document.positionAt(matchIndex);
      functions.push({
        name: functionName,
        position,
      });
    }
  }

  return functions;
}

/**
 * Extracts PHP code block ranges from the document
 */
function extractPhpCodeBlocks(text: string): { start: number; end: number }[] {
  const phpBlocks: { start: number; end: number }[] = [];

  // Find PHP opening and closing tags
  const phpTagRegex = /<\?(?:php|=)?([\s\S]*?)(?:\?>|$)/g;
  let match: RegExpExecArray | null;

  while ((match = phpTagRegex.exec(text)) !== null) {
    phpBlocks.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // Also find content outside of <script> tags (assuming it's PHP by default in .php files)
  const scriptBlocks = extractScriptBlocks(text);

  // If there are no explicit PHP tags, treat everything outside script tags as PHP
  if (phpBlocks.length === 0) {
    let lastEnd = 0;

    for (const scriptBlock of scriptBlocks) {
      if (lastEnd < scriptBlock.start) {
        phpBlocks.push({
          start: lastEnd,
          end: scriptBlock.start,
        });
      }
      lastEnd = scriptBlock.end;
    }

    // Add remaining content after last script tag
    if (lastEnd < text.length) {
      phpBlocks.push({
        start: lastEnd,
        end: text.length,
      });
    }
  }

  return phpBlocks;
}

/**
 * Extracts <script> tag ranges to exclude them from PHP analysis
 */
function extractScriptBlocks(text: string): { start: number; end: number }[] {
  const scriptBlocks: { start: number; end: number }[] = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(text)) !== null) {
    scriptBlocks.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return scriptBlocks;
}

/**
 * Checks if a given index is within any PHP block
 */
function isInPhpBlock(
  index: number,
  phpBlocks: { start: number; end: number }[]
): boolean {
  return phpBlocks.some((block) => index >= block.start && index < block.end);
}

/**
 * Checks if the cursor is inside a pp.fetchFunction call
 */
function isInsideFetchFunctionCall(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  const line = document.lineAt(position.line).text;
  const beforeCursor = line.substring(0, position.character);

  // Check if we're inside pp.fetchFunction('...' or pp.fetchFunction("..."
  const fetchFunctionPattern = /pp\.fetchFunction\s*\(\s*['"][^'"]*$/;
  return fetchFunctionPattern.test(beforeCursor);
}

/**
 * Gets the function name from fetchFunction call at cursor position
 */
function getFunctionNameFromCall(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const line = document.lineAt(position.line).text;
  const beforeCursor = line.substring(0, position.character);
  const afterCursor = line.substring(position.character);

  // Match: pp.fetchFunction('functionName' with cursor potentially in the middle
  const match = /pp\.fetchFunction\s*\(\s*['"]([^'"]*?)$/.exec(beforeCursor);
  if (!match) {
    return null;
  }

  const partial = match[1];
  const nextQuoteIndex = afterCursor.indexOf(
    match[0].includes('"') ? '"' : "'"
  );
  if (nextQuoteIndex === -1) {
    return null;
  }

  const remaining = afterCursor.substring(0, nextQuoteIndex);
  return partial + remaining;
}

/**
 * Completion provider for pp.fetchFunction
 */
export class FetchFunctionCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    if (!isInsideFetchFunctionCall(document, position)) {
      return [];
    }

    const functions = extractPhpFunctions(document);

    return functions.map((func) => {
      const item = new vscode.CompletionItem(
        func.name,
        vscode.CompletionItemKind.Function
      );

      item.detail = `PHP Function`;
      item.documentation = new vscode.MarkdownString(
        `Call PHP function \`${func.name}()\` from JavaScript`
      );

      // Insert just the function name (quotes are already there)
      item.insertText = func.name;

      return item;
    });
  }
}

/**
 * Definition provider for pp.fetchFunction
 */
export class FetchFunctionDefinitionProvider
  implements vscode.DefinitionProvider
{
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Definition> {
    const functionName = getFunctionNameFromCall(document, position);
    if (!functionName) {
      return;
    }

    const functions = extractPhpFunctions(document);
    const targetFunction = functions.find((func) => func.name === functionName);

    if (!targetFunction) {
      return;
    }

    // Return location pointing to the function definition
    return new vscode.Location(document.uri, targetFunction.position);
  }
}

/**
 * Hover provider for pp.fetchFunction
 */
export class FetchFunctionHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const functionName = getFunctionNameFromCall(document, position);
    if (!functionName) {
      return;
    }

    const functions = extractPhpFunctions(document);
    const targetFunction = functions.find((func) => func.name === functionName);

    if (!targetFunction) {
      return new vscode.Hover(
        new vscode.MarkdownString(
          `⚠️ PHP Function \`${functionName}\` not found in current file`
        )
      );
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendCodeblock(`function ${functionName}()`, "php");
    markdown.appendMarkdown(
      `\n\n📍 PHP Function defined at line ${targetFunction.position.line + 1}`
    );

    return new vscode.Hover(markdown);
  }
}

/**
 * Diagnostic provider for pp.fetchFunction
 */
export class FetchFunctionDiagnosticProvider {
  validateDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();

    // 1. Get all available PHP functions in the document
    const functions = extractPhpFunctions(document);
    const validFunctionNames = new Set(functions.map((f) => f.name));

    // 2. Regex to find all pp.fetchFunction calls
    // Matches: pp.fetchFunction('name' or pp.fetchFunction("name"
    const callRegex = /pp\.fetchFunction\s*\(\s*(['"])([^'"]+)\1/g;
    let match: RegExpExecArray | null;

    while ((match = callRegex.exec(text)) !== null) {
      const functionName = match[2];

      // If the function doesn't exist in our PHP definitions
      if (!validFunctionNames.has(functionName)) {
        // Calculate the range of just the function name inside the quotes
        // match[0] is the whole string: pp.fetchFunction('foo'
        // We need to find where 'foo' starts inside that match
        const fullMatchStr = match[0];
        const nameStartIndexInMatch = fullMatchStr.lastIndexOf(functionName);

        const startOffset = match.index + nameStartIndexInMatch;
        const endOffset = startOffset + functionName.length;

        const range = new vscode.Range(
          document.positionAt(startOffset),
          document.positionAt(endOffset)
        );

        const diagnostic = new vscode.Diagnostic(
          range,
          `PHP Function '${functionName}' not found or is private (starts with _).`,
          vscode.DiagnosticSeverity.Error
        );

        diagnostic.source = "PulsePoint";
        diagnostics.push(diagnostic);
      }
    }

    return diagnostics;
  }
}
