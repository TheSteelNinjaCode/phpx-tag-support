import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export class PpSyncProvider {
  private syncValues = new Set<string>();
  private workspaceFolder: vscode.WorkspaceFolder;

  constructor(workspaceFolder: vscode.WorkspaceFolder) {
    this.workspaceFolder = workspaceFolder;
    this.refresh();
  }

  async refresh(): Promise<void> {
    console.log("🔍 PP-Sync: Starting refresh...");
    this.syncValues.clear();
    await this.scanForSyncAttributes();
    console.log(
      `✅ PP-Sync: Found ${this.syncValues.size} sync tables:`,
      Array.from(this.syncValues)
    );
    await this.generateTypescriptFile();
  }

  private async scanForSyncAttributes(): Promise<void> {
    const srcAppPath = path.join(this.workspaceFolder.uri.fsPath, "src", "app");

    if (!fs.existsSync(srcAppPath)) {
      console.warn("⚠️ PP-Sync: src/app directory not found at:", srcAppPath);
      return;
    }

    console.log("🔍 PP-Sync: Scanning directory:", srcAppPath);
    await this.scanDirectory(srcAppPath);
  }

  private async scanDirectory(dirPath: string): Promise<void> {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const file of files) {
      const fullPath = path.join(dirPath, file.name);

      if (file.isDirectory()) {
        await this.scanDirectory(fullPath);
      } else if (file.isFile() && file.name.endsWith(".php")) {
        await this.scanPhpFile(fullPath);
      }
    }
  }

  private async scanPhpFile(filePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const syncAttributeRegex = /pp-sync\s*=\s*["']([^"']+)["']/g;

      let match;
      let foundInThisFile = 0;
      while ((match = syncAttributeRegex.exec(content)) !== null) {
        const syncValue = match[1].trim();
        if (syncValue) {
          this.syncValues.add(syncValue);
          foundInThisFile++;
        }
      }

      if (foundInThisFile > 0) {
        console.log(
          `📄 PP-Sync: Found ${foundInThisFile} sync attribute(s) in:`,
          path.relative(this.workspaceFolder.uri.fsPath, filePath)
        );
      }
    } catch (error) {
      console.error(`❌ PP-Sync: Error reading file ${filePath}:`, error);
    }
  }

  private async generateTypescriptFile(): Promise<void> {
    const syncValuesArray = Array.from(this.syncValues).sort();

    const tsContent = `// Auto-generated PP-Sync definitions
// This file is generated automatically by scanning pp-sync attributes in PHP files

export type PpSyncTable = ${
      syncValuesArray.length > 0
        ? syncValuesArray.map((v) => `"${v}"`).join(" | ")
        : "string"
    };

export const PP_SYNC_TABLES = [
${syncValuesArray.map((v) => `  "${v}"`).join(",\n")}
] as const;

// Usage: pphp.sync(sourceTable, targetTable)
export interface PpSyncMethods {
${syncValuesArray
  .map(
    (table) =>
      `  sync(sourceTable: "${table}", targetTable: PpSyncTable): void;`
  )
  .join("\n")}
  sync(sourceTable: PpSyncTable, targetTable: PpSyncTable): void;
}
`;

    // 🔧 FIX: Create the file in .pphp directory instead of root
    const pphpDir = path.join(this.workspaceFolder.uri.fsPath, ".pphp");
    const outputPath = path.join(pphpDir, "pp-sync.ts");

    try {
      // Ensure .pphp directory exists
      if (!fs.existsSync(pphpDir)) {
        fs.mkdirSync(pphpDir, { recursive: true });
      }

      fs.writeFileSync(outputPath, tsContent, "utf8");
      console.log(
        `✅ Generated .pphp/pp-sync.ts with ${syncValuesArray.length} sync tables`
      );
    } catch (error) {
      console.error("Error writing pp-sync.ts:", error);
    }
  }

  getSyncValues(): string[] {
    return Array.from(this.syncValues).sort();
  }

  hasSyncValue(value: string): boolean {
    return this.syncValues.has(value);
  }
}

export class PpSyncCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private syncProvider: PpSyncProvider) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position.line).text;
    const upToCursor = line.slice(0, position.character);

    // Check if we're inside a pphp.sync() call - handle both first and second parameter
    const syncCallPatterns = [
      // First parameter: pphp.sync("partial
      { pattern: /pphp\.sync\s*\(\s*["']?([^"',)]*)$/, paramIndex: 0 },
      // Second parameter: pphp.sync("first", "partial
      {
        pattern: /pphp\.sync\s*\(\s*["']([^"']*)["']\s*,\s*["']?([^"',)]*)$/,
        paramIndex: 1,
      },
    ];

    let match = null;
    let matchedPattern = -1;
    let isSecondParameter = false;
    let firstParameterValue = null;

    for (let i = 0; i < syncCallPatterns.length; i++) {
      match = syncCallPatterns[i].pattern.exec(upToCursor);
      if (match) {
        matchedPattern = i;
        isSecondParameter = syncCallPatterns[i].paramIndex === 1;

        // If we're in the second parameter, extract the first parameter value
        if (isSecondParameter) {
          firstParameterValue = match[1]; // The first captured group is the first parameter
        }
        break;
      }
    }

    if (!match) {
      return [];
    }

    // Get the partial text (last captured group is always the current partial)
    const partial = match[match.length - 1];
    let syncValues = this.syncProvider.getSyncValues();

    // Filter out the first parameter value if we're completing the second parameter
    if (isSecondParameter && firstParameterValue) {
      syncValues = syncValues.filter((value) => value !== firstParameterValue);
    }

    // Determine if we're already inside quotes
    const beforePartial = upToCursor.slice(
      0,
      upToCursor.length - partial.length
    );
    const alreadyInQuotes = /["']$/.test(beforePartial);

    // Check what comes after the cursor to see if there's already a closing quote
    const afterCursor = line.slice(position.character);
    const hasClosingQuote = /^["']/.test(afterCursor);

    return syncValues
      .filter((value) => value.startsWith(partial))
      .map((value) => {
        const item = new vscode.CompletionItem(
          value,
          vscode.CompletionItemKind.Value
        );
        item.detail = `PP-Sync Table${
          isSecondParameter ? " (Target)" : " (Source)"
        }`;

        const md = new vscode.MarkdownString();
        md.appendCodeblock(`pp-sync="${value}"`, "html");
        md.appendMarkdown(
          `\n\nSync table: \`${value}\`\n\nFound in pp-sync attributes across PHP files.`
        );

        // Add context-specific documentation
        if (isSecondParameter) {
          md.appendMarkdown(
            `\n\n**Target table** - Data will be synced TO this table.`
          );
          if (firstParameterValue) {
            md.appendMarkdown(
              `\n\n**Usage:** \`pphp.sync("${firstParameterValue}", "${value}")\``
            );
          }
        } else {
          md.appendMarkdown(
            `\n\n**Source table** - Data will be synced FROM this table.`
          );
        }

        item.documentation = md;

        // Smart quote handling
        if (alreadyInQuotes) {
          // We're already inside quotes, just insert the value
          item.insertText = value;
          // If there's no closing quote, add one
          if (!hasClosingQuote) {
            item.insertText += beforePartial.endsWith('"') ? '"' : "'";
          }
        } else {
          // We're not inside quotes, wrap with quotes
          item.insertText = `"${value}"`;
        }

        // Replace the partial text that was already typed
        const wordRange = document.getWordRangeAtPosition(
          position,
          /[a-zA-Z0-9_-]+/
        );
        if (wordRange) {
          item.range = wordRange;
        }

        // Set sort text to maintain alphabetical order
        item.sortText = `0_${value}`;

        return item;
      });
  }
}

export class PpSyncHoverProvider implements vscode.HoverProvider {
  constructor(private syncProvider: PpSyncProvider) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const range = document.getWordRangeAtPosition(position, /["']([^"']+)["']/);
    if (!range) {
      return;
    }

    const text = document.getText(range);
    const value = text.replace(/["']/g, "");

    // Check if we're in a pphp.sync() context
    const line = document.lineAt(position.line).text;
    if (!line.includes("pphp.sync")) {
      return;
    }

    if (this.syncProvider.hasSyncValue(value)) {
      const md = new vscode.MarkdownString();
      md.appendCodeblock(`pp-sync="${value}"`, "html");
      md.appendMarkdown(
        `\n\n✅ **Valid sync table**\n\nThis table is defined in PP-Sync attributes across your PHP files.`
      );
      return new vscode.Hover(md, range);
    }

    return;
  }
}

export class PpSyncDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private syncProvider: PpSyncProvider,
    private workspaceFolder: vscode.WorkspaceFolder
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[]> {
    const range = document.getWordRangeAtPosition(position, /["']([^"']+)["']/);
    if (!range) {
      return [];
    }

    const text = document.getText(range);
    const value = text.replace(/["']/g, "");

    // Check if we're in a pphp.sync() context
    const line = document.lineAt(position.line).text;
    if (!line.includes("pphp.sync")) {
      return [];
    }

    if (!this.syncProvider.hasSyncValue(value)) {
      return [];
    }

    // Find all PHP files that contain this pp-sync attribute
    const locations: vscode.Location[] = [];
    const srcAppPath = path.join(this.workspaceFolder.uri.fsPath, "src", "app");

    await this.findSyncAttributeLocations(srcAppPath, value, locations);

    return locations;
  }

  private async findSyncAttributeLocations(
    dirPath: string,
    syncValue: string,
    locations: vscode.Location[]
  ): Promise<void> {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    const files = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const file of files) {
      const fullPath = path.join(dirPath, file.name);

      if (file.isDirectory()) {
        await this.findSyncAttributeLocations(fullPath, syncValue, locations);
      } else if (file.isFile() && file.name.endsWith(".php")) {
        await this.searchInPhpFile(fullPath, syncValue, locations);
      }
    }
  }

  private async searchInPhpFile(
    filePath: string,
    syncValue: string,
    locations: vscode.Location[]
  ): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const regex = new RegExp(`pp-sync\\s*=\\s*["']${syncValue}["']`, "g");

      let match;
      while ((match = regex.exec(content)) !== null) {
        const document = await vscode.workspace.openTextDocument(filePath);
        const position = document.positionAt(
          match.index + match[0].indexOf(syncValue)
        );
        const range = new vscode.Range(
          position,
          position.translate(0, syncValue.length)
        );
        locations.push(new vscode.Location(document.uri, range));
      }
    } catch (error) {
      console.error(`Error searching in file ${filePath}:`, error);
    }
  }
}

export class PpSyncDiagnosticProvider {
  constructor(private syncProvider: PpSyncProvider) {}

  validateDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    if (document.languageId !== "php") {
      return [];
    }

    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();

    // More robust regex that handles mixed quotes properly
    const syncCallRegex =
      /pphp\.sync\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*?)\1\s*,\s*(['"])((?:\\.|(?!\3)[^\\])*?)\3\s*\)/g;

    let match;
    while ((match = syncCallRegex.exec(text)) !== null) {
      const [fullMatch, sourceQuote, sourceTable, targetQuote, targetTable] =
        match;
      const matchStart = match.index;

      // Debug logging (remove in production)
      console.log(`Found pphp.sync call: "${sourceTable}" -> "${targetTable}"`);
      console.log(`Available tables:`, this.syncProvider.getSyncValues());

      // Check for duplicate values (same source and target)
      if (sourceTable === targetTable) {
        const fullRange = new vscode.Range(
          document.positionAt(matchStart),
          document.positionAt(matchStart + fullMatch.length)
        );

        diagnostics.push(
          new vscode.Diagnostic(
            fullRange,
            `⚠️ Source and target tables are the same ("${sourceTable}"). Sync operations should use different tables.`,
            vscode.DiagnosticSeverity.Warning
          )
        );
        continue; // Skip individual validation if they're the same
      }

      // Validate source table
      if (!this.syncProvider.hasSyncValue(sourceTable)) {
        const sourceStart = this.findParameterPosition(
          fullMatch,
          sourceTable,
          sourceQuote,
          true
        );
        if (sourceStart !== -1) {
          const absoluteStart = matchStart + sourceStart;
          const sourceRange = new vscode.Range(
            document.positionAt(absoluteStart),
            document.positionAt(absoluteStart + sourceTable.length)
          );

          const availableTables = this.syncProvider.getSyncValues();
          const suggestion = this.findClosestMatch(
            sourceTable,
            availableTables
          );

          let message = `❌ Unknown sync table "${sourceTable}". Add pp-sync="${sourceTable}" to an HTML tag.`;
          if (suggestion) {
            message += ` Did you mean "${suggestion}"?`;
          }

          diagnostics.push(
            new vscode.Diagnostic(
              sourceRange,
              message,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }

      // Validate target table
      if (!this.syncProvider.hasSyncValue(targetTable)) {
        const targetStart = this.findParameterPosition(
          fullMatch,
          targetTable,
          targetQuote,
          false
        );
        if (targetStart !== -1) {
          const absoluteStart = matchStart + targetStart;
          const targetRange = new vscode.Range(
            document.positionAt(absoluteStart),
            document.positionAt(absoluteStart + targetTable.length)
          );

          const availableTables = this.syncProvider.getSyncValues();
          const suggestion = this.findClosestMatch(
            targetTable,
            availableTables
          );

          let message = `❌ Unknown sync table "${targetTable}". Add pp-sync="${targetTable}" to an HTML tag.`;
          if (suggestion) {
            message += ` Did you mean "${suggestion}"?`;
          }

          diagnostics.push(
            new vscode.Diagnostic(
              targetRange,
              message,
              vscode.DiagnosticSeverity.Error
            )
          );
        }
      }
    }

    return diagnostics;
  }

  private findParameterPosition(
    fullMatch: string,
    paramValue: string,
    quote: string,
    isFirst: boolean
  ): number {
    const pattern = `${quote}${this.escapeRegExp(paramValue)}${quote}`;

    if (isFirst) {
      const index = fullMatch.indexOf(pattern);
      return index !== -1 ? index + 1 : -1; // +1 to skip the opening quote
    } else {
      const index = fullMatch.lastIndexOf(pattern);
      return index !== -1 ? index + 1 : -1; // +1 to skip the opening quote
    }
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private findClosestMatch(input: string, candidates: string[]): string | null {
    if (candidates.length === 0) {
      return null;
    }

    let bestMatch = null;
    let bestDistance = Infinity;

    for (const candidate of candidates) {
      const distance = this.levenshteinDistance(
        input.toLowerCase(),
        candidate.toLowerCase()
      );
      if (distance < bestDistance && distance <= 3) {
        bestDistance = distance;
        bestMatch = candidate;
      }
    }

    return bestMatch;
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }
}
