import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

interface RouteInfo {
  path: string;
  url: string;
  filePath: string;
}

export class RouteProvider {
  private routes: RouteInfo[] = [];
  private filesListPath: string;

  constructor(workspaceFolder: vscode.WorkspaceFolder) {
    this.filesListPath = path.join(
      workspaceFolder.uri.fsPath,
      "settings",
      "files-list.json"
    );
    this.loadRoutes();
  }

  /**
   * Load routes from files-list.json
   */
  private loadRoutes(): void {
    try {
      if (!fs.existsSync(this.filesListPath)) {
        console.warn(`files-list.json not found at ${this.filesListPath}`);
        return;
      }

      const fileContent = fs.readFileSync(this.filesListPath, "utf8");
      const files: string[] = JSON.parse(fileContent);

      this.routes = this.extractRoutesFromFiles(files);
      console.log(`Loaded ${this.routes.length} routes:`, this.routes);
    } catch (error) {
      console.error("Error loading routes from files-list.json:", error);
    }
  }

  /**
   * Extract routes from file paths - only index.php files inside app directory
   */
  private extractRoutesFromFiles(files: string[]): RouteInfo[] {
    const routes: RouteInfo[] = [];

    files.forEach((filePath) => {
      // Only process index.php files inside the app directory
      if (!filePath.includes("/app/") || !filePath.endsWith("index.php")) {
        return;
      }

      const route = this.convertFilePathToRoute(filePath);
      if (route) {
        routes.push(route);
      }
    });

    // Sort routes by URL for better organization
    return routes.sort((a, b) => a.url.localeCompare(b.url));
  }

  /**
   * Convert file path to route information
   * Example: "./src/app/dashboard/index.php" → { path: "/dashboard", url: "/dashboard", filePath: "..." }
   */
  private convertFilePathToRoute(filePath: string): RouteInfo | null {
    // Extract the part after /app/ and before /index.php
    const appMatch = filePath.match(/\/app\/(.*)\/index\.php$/);

    if (!appMatch) {
      // Handle root case: ./src/app/index.php
      if (filePath.endsWith("/app/index.php")) {
        return {
          path: "/",
          url: "/",
          filePath: filePath,
        };
      }
      return null;
    }

    const routePath = appMatch[1];
    const url = `/${routePath}`;

    return {
      path: routePath,
      url: url,
      filePath: filePath,
    };
  }

  /**
   * Get all available routes
   */
  public getRoutes(): RouteInfo[] {
    return this.routes;
  }

  /**
   * Get route URLs for completion
   */
  public getRouteUrls(): string[] {
    return this.routes.map((route) => route.url);
  }

  /**
   * Validate if a URL exists as a route
   */
  public isValidRoute(url: string): boolean {
    return this.routes.some((route) => route.url === url);
  }

  /**
   * Get route info by URL
   */
  public getRouteByUrl(url: string): RouteInfo | undefined {
    return this.routes.find((route) => route.url === url);
  }

  /**
   * Refresh routes from files-list.json
   */
  public refresh(): void {
    this.loadRoutes();
  }

  /**
   * Create completion items for href attributes
   */
  public createHrefCompletionItems(): vscode.CompletionItem[] {
    return this.routes.map((route) => {
      const item = new vscode.CompletionItem(
        route.url,
        vscode.CompletionItemKind.Reference
      );

      item.detail = `Route: ${route.url}`;
      item.documentation = new vscode.MarkdownString(
        `**Route:** \`${route.url}\`\n\n**File:** \`${route.filePath}\``
      );

      // Insert just the URL
      item.insertText = route.url;

      // Add sorting priority - home route first
      item.sortText = route.url === "/" ? "0_/" : `1_${route.url}`;

      return item;
    });
  }
}

/**
 * Completion provider for href attributes in anchor tags
 */
export class HrefCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private routeProvider: RouteProvider) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position.line).text;
    const cursorOffset = position.character;

    // Check if we're inside an href attribute
    const hrefContext = this.getHrefContext(line, cursorOffset);
    if (!hrefContext) {
      return [];
    }

    // Return route completions
    return this.routeProvider.createHrefCompletionItems();
  }

  /**
   * Check if cursor is inside href="..." attribute
   */
  private getHrefContext(line: string, cursorOffset: number): boolean {
    const beforeCursor = line.substring(0, cursorOffset);
    const afterCursor = line.substring(cursorOffset);

    // Look for href=" before cursor
    const hrefMatch = /href\s*=\s*"([^"]*)$/.exec(beforeCursor);
    if (!hrefMatch) {
      return false;
    }

    // Make sure there's a closing quote after cursor
    const nextQuoteIndex = afterCursor.indexOf('"');
    return nextQuoteIndex !== -1;
  }
}

/**
 * Hover provider for href attributes
 */
export class HrefHoverProvider implements vscode.HoverProvider {
  constructor(private routeProvider: RouteProvider) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const line = document.lineAt(position.line).text;
    const cursorOffset = position.character;

    // Check if we're hovering over an href value
    const hrefValue = this.getHrefValue(line, cursorOffset);
    if (!hrefValue) {
      return;
    }

    const route = this.routeProvider.getRouteByUrl(hrefValue);
    if (!route) {
      return;
    }

    const md = new vscode.MarkdownString();
    md.appendCodeblock(`href="${route.url}"`, "html");
    md.appendMarkdown(`\n\n**Route:** \`${route.url}\``);
    md.appendMarkdown(`\n\n**File:** \`${route.filePath}\``);

    return new vscode.Hover(md);
  }

  /**
   * Extract href value at cursor position
   */
  private getHrefValue(line: string, cursorOffset: number): string | null {
    // Find href attributes in the line
    const hrefRegex = /href\s*=\s*"([^"]*)"/g;
    let match;

    while ((match = hrefRegex.exec(line)) !== null) {
      const start = match.index + match[0].indexOf(match[1]);
      const end = start + match[1].length;

      if (cursorOffset >= start && cursorOffset <= end) {
        return match[1];
      }
    }

    return null;
  }
}

/**
 * Diagnostic provider for invalid href routes
 */
export class HrefDiagnosticProvider {
  constructor(private routeProvider: RouteProvider) {}

  validateDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();

    // Find all href attributes
    const hrefRegex = /href\s*=\s*"([^"]*)"/g;
    let match;

    while ((match = hrefRegex.exec(text)) !== null) {
      const hrefValue = match[1];

      // Skip external URLs, mailto, tel, etc.
      if (this.isExternalOrSpecialUrl(hrefValue)) {
        continue;
      }

      // Check if it's a valid internal route
      if (!this.routeProvider.isValidRoute(hrefValue)) {
        const start = document.positionAt(
          match.index + match[0].indexOf(hrefValue)
        );
        const end = document.positionAt(
          match.index + match[0].indexOf(hrefValue) + hrefValue.length
        );

        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(start, end),
            `Route "${hrefValue}" not found. Available routes: ${this.routeProvider
              .getRouteUrls()
              .join(", ")}`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }

    return diagnostics;
  }

  private isExternalOrSpecialUrl(url: string): boolean {
    return (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("mailto:") ||
      url.startsWith("tel:") ||
      url.startsWith("#") ||
      url === ""
    );
  }
}

/**
 * Definition provider for href attributes - enables Ctrl+Click navigation
 */
export class HrefDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private routeProvider: RouteProvider,
    private workspaceFolder: vscode.WorkspaceFolder
  ) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Definition> {
    const line = document.lineAt(position.line).text;
    const cursorOffset = position.character;

    // Check if we're clicking on an href value
    const hrefValue = this.getHrefValue(line, cursorOffset);
    if (!hrefValue) {
      return;
    }

    const route = this.routeProvider.getRouteByUrl(hrefValue);
    if (!route) {
      return;
    }

    // Convert relative file path to absolute path
    const absoluteFilePath = path.resolve(
      this.workspaceFolder.uri.fsPath,
      route.filePath
    );

    // Check if file exists
    if (!fs.existsSync(absoluteFilePath)) {
      console.warn(`Route file not found: ${absoluteFilePath}`);
      return;
    }

    // Create VS Code URI and Location
    const fileUri = vscode.Uri.file(absoluteFilePath);
    const location = new vscode.Location(fileUri, new vscode.Position(0, 0));

    return location;
  }

  /**
   * Extract href value at cursor position
   */
  private getHrefValue(line: string, cursorOffset: number): string | null {
    // Find href attributes in the line
    const hrefRegex = /href\s*=\s*"([^"]*)"/g;
    let match;

    while ((match = hrefRegex.exec(line)) !== null) {
      const start = match.index + match[0].indexOf(match[1]);
      const end = start + match[1].length;

      if (cursorOffset >= start && cursorOffset <= end) {
        return match[1];
      }
    }

    return null;
  }
}
