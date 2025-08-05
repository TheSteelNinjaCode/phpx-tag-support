import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

interface RouteInfo {
  path: string;
  url: string;
  filePath: string;
  isDynamic: boolean;
  dynamicSegments: string[];
  pattern: RegExp;
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

    // Sort static routes first, then dynamic
    return routes.sort((a, b) => {
      if (a.isDynamic && !b.isDynamic) {
        return 1;
      }
      if (!a.isDynamic && b.isDynamic) {
        return -1;
      }
      return a.url.localeCompare(b.url);
    });
  }

  private convertFilePathToRoute(filePath: string): RouteInfo | null {
    // Handle root case: ./src/app/index.php
    if (filePath.endsWith("/app/index.php")) {
      return {
        path: "/",
        url: "/",
        filePath: filePath,
        isDynamic: false,
        dynamicSegments: [],
        pattern: /^\/$/,
      };
    }

    // Extract the part after /app/ and before /index.php
    const appMatch = filePath.match(/\/app\/(.*)\/index\.php$/);
    if (!appMatch) {
      return null;
    }

    const routePath = appMatch[1];
    const segments = routePath.split("/");

    const dynamicSegments: string[] = [];
    let isDynamic = false;
    let urlPattern = "";
    let displayUrl = "";

    segments.forEach((segment, index) => {
      if (segment.startsWith("[") && segment.endsWith("]")) {
        isDynamic = true;
        const paramName = segment.slice(1, -1);

        if (paramName.startsWith("...")) {
          // Catch-all route: [...slug]
          const cleanParam = paramName.substring(3);
          dynamicSegments.push(cleanParam);
          urlPattern += "/(.+)"; // Matches one or more segments
          displayUrl += `/{...${cleanParam}}`;
        } else {
          // Single dynamic segment: [slug]
          dynamicSegments.push(paramName);
          urlPattern += "/([^/]+)"; // Matches single segment
          displayUrl += `/{${paramName}}`;
        }
      } else {
        // Static segment
        urlPattern += `/${segment}`;
        displayUrl += `/${segment}`;
      }
    });

    const pattern = new RegExp(`^${urlPattern}$`);
    const url = isDynamic ? displayUrl : `/${routePath}`;

    return {
      path: routePath,
      url: url,
      filePath: filePath,
      isDynamic: isDynamic,
      dynamicSegments: dynamicSegments,
      pattern: pattern,
    };
  }

  public getRoutes(): RouteInfo[] {
    return this.routes;
  }

  public getRouteUrls(): string[] {
    return this.routes.map((route) => route.url);
  }

  public isValidRoute(url: string): boolean {
    // Check static routes first
    const staticRoute = this.routes.find(
      (route) => !route.isDynamic && route.url === url
    );
    if (staticRoute) {
      return true;
    }

    // Check dynamic routes
    return this.routes.some((route) => {
      if (!route.isDynamic) {
        return false;
      }
      return route.pattern.test(url);
    });
  }

  public getRouteByUrl(url: string): RouteInfo | undefined {
    // Check static routes first
    const staticRoute = this.routes.find(
      (route) => !route.isDynamic && route.url === url
    );
    if (staticRoute) {
      return staticRoute;
    }

    // Check dynamic routes
    return this.routes.find((route) => {
      if (!route.isDynamic) {
        return false;
      }
      return route.pattern.test(url);
    });
  }

  public getMatchingRoute(
    url: string
  ): { route: RouteInfo; params: Record<string, string | string[]> } | null {
    // Check static routes first
    const staticRoute = this.routes.find(
      (route) => !route.isDynamic && route.url === url
    );
    if (staticRoute) {
      return { route: staticRoute, params: {} };
    }

    // Check dynamic routes
    for (const route of this.routes) {
      if (!route.isDynamic) {
        continue;
      }

      const match = route.pattern.exec(url);
      if (match) {
        const params: Record<string, string | string[]> = {};

        route.dynamicSegments.forEach((paramName, index) => {
          const value = match[index + 1];

          // Handle catch-all parameters (they capture everything as segments)
          if (route.path.includes(`[...${paramName}]`)) {
            params[paramName] = value.split("/").filter(Boolean);
          } else {
            params[paramName] = value;
          }
        });

        return { route, params };
      }
    }

    return null;
  }

  public refresh(): void {
    this.loadRoutes();
  }

  public createHrefCompletionItems(): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    this.routes.forEach((route) => {
      const item = new vscode.CompletionItem(
        route.url,
        route.isDynamic
          ? vscode.CompletionItemKind.Snippet
          : vscode.CompletionItemKind.Reference
      );

      if (route.isDynamic) {
        item.detail = `Dynamic Route: ${route.url}`;
        item.documentation = new vscode.MarkdownString(
          `**Dynamic Route:** \`${route.url}\`\n\n` +
            `**Parameters:** ${route.dynamicSegments
              .map((s) => `\`${s}\``)
              .join(", ")}\n\n` +
            `**File:** \`${route.filePath}\`\n\n` +
            `**Examples:**\n` +
            `${this.generateExamples(route)
              .map((ex) => `- \`${ex}\``)
              .join("\n")}`
        );
        item.insertText = this.createSnippetText(route);
      } else {
        item.detail = `Static Route: ${route.url}`;
        item.documentation = new vscode.MarkdownString(
          `**Route:** \`${route.url}\`\n\n**File:** \`${route.filePath}\``
        );
        item.insertText = route.url;
      }

      // Sorting: static routes first, then dynamic
      item.sortText = route.isDynamic
        ? `2_${route.url}`
        : route.url === "/"
        ? "0_/"
        : `1_${route.url}`;

      items.push(item);
    });

    return items;
  }

  private createSnippetText(route: RouteInfo): vscode.SnippetString {
    let snippet = route.url;
    let tabIndex = 1;

    route.dynamicSegments.forEach((param) => {
      if (route.path.includes(`[...${param}]`)) {
        snippet = snippet.replace(
          `{...${param}}`,
          `\${${tabIndex}:${param}/more}`
        );
      } else {
        snippet = snippet.replace(`{${param}}`, `\${${tabIndex}:${param}}`);
      }
      tabIndex++;
    });

    return new vscode.SnippetString(snippet);
  }

  private generateExamples(route: RouteInfo): string[] {
    const examples: string[] = [];
    const baseUrl = route.url.replace(/\{[^}]+\}/g, "");

    if (route.path.includes("[id]")) {
      examples.push(baseUrl.replace("{id}", "123"));
      examples.push(baseUrl.replace("{id}", "abc"));
    }

    if (route.path.includes("[slug]")) {
      examples.push(baseUrl.replace("{slug}", "my-post"));
      examples.push(baseUrl.replace("{slug}", "another-article"));
    }

    if (route.path.includes("[...")) {
      const basePath = baseUrl.replace("{...", "").replace("}", "");
      examples.push(`${basePath}category`);
      examples.push(`${basePath}category/subcategory`);
      examples.push(`${basePath}category/subcategory/item`);
    }

    return examples.length ? examples : [route.url];
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

// Updated diagnostic provider
export class HrefDiagnosticProvider {
  constructor(private routeProvider: RouteProvider) {}

  validateDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();

    const hrefRegex = /href\s*=\s*"([^"]*)"/g;
    let match;

    while ((match = hrefRegex.exec(text)) !== null) {
      const hrefValue = match[1];

      if (this.isExternalOrSpecialUrl(hrefValue)) {
        continue;
      }

      if (!this.routeProvider.isValidRoute(hrefValue)) {
        const start = document.positionAt(
          match.index + match[0].indexOf(hrefValue)
        );
        const end = document.positionAt(
          match.index + match[0].indexOf(hrefValue) + hrefValue.length
        );

        const suggestions = this.getSuggestions(hrefValue);
        const message = suggestions.length
          ? `Route "${hrefValue}" not found. Did you mean: ${suggestions.join(
              ", "
            )}?`
          : `Route "${hrefValue}" not found. Available routes: ${this.routeProvider
              .getRouteUrls()
              .slice(0, 5)
              .join(", ")}${
              this.routeProvider.getRoutes().length > 5 ? "..." : ""
            }`;

        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(start, end),
            message,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }

    return diagnostics;
  }

  private getSuggestions(invalidUrl: string): string[] {
    const routes = this.routeProvider.getRoutes();
    const suggestions: string[] = [];

    // Find similar static routes
    routes
      .filter((route) => !route.isDynamic)
      .forEach((route) => {
        if (this.isSimilar(invalidUrl, route.url)) {
          suggestions.push(route.url);
        }
      });

    // Add dynamic route patterns that might match
    routes
      .filter((route) => route.isDynamic)
      .forEach((route) => {
        const basePath = route.url.split("{")[0];
        if (invalidUrl.startsWith(basePath)) {
          suggestions.push(route.url);
        }
      });

    return suggestions.slice(0, 3);
  }

  private isSimilar(str1: string, str2: string): boolean {
    const distance = this.levenshteinDistance(str1, str2);
    return distance <= Math.max(str1.length, str2.length) * 0.4;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1)
      .fill(null)
      .map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) {
      matrix[0][i] = i;
    }
    for (let j = 0; j <= str2.length; j++) {
      matrix[j][0] = j;
    }

    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + indicator
        );
      }
    }

    return matrix[str2.length][str1.length];
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

// Updated hover provider
export class HrefHoverProvider implements vscode.HoverProvider {
  constructor(private routeProvider: RouteProvider) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const line = document.lineAt(position.line).text;
    const cursorOffset = position.character;

    const hrefValue = this.getHrefValue(line, cursorOffset);
    if (!hrefValue) {
      return;
    }

    const matchResult = this.routeProvider.getMatchingRoute(hrefValue);
    if (!matchResult) {
      return;
    }

    const { route, params } = matchResult;
    const md = new vscode.MarkdownString();

    md.appendCodeblock(`href="${hrefValue}"`, "html");
    md.appendMarkdown(`\n\n**Route:** \`${route.url}\``);

    if (route.isDynamic && Object.keys(params).length > 0) {
      md.appendMarkdown(`\n\n**Parameters:**`);
      Object.entries(params).forEach(([key, value]) => {
        const displayValue = Array.isArray(value) ? value.join("/") : value;
        md.appendMarkdown(`\n- \`${key}\`: ${displayValue}`);
      });
    }

    md.appendMarkdown(`\n\n**File:** \`${route.filePath}\``);

    return new vscode.Hover(md);
  }

  private getHrefValue(line: string, cursorOffset: number): string | null {
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
