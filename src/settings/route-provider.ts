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
  routeGroups: string[];
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
        routeGroups: [], // No route groups for root
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
    const routeGroups: string[] = []; // Track route groups
    let isDynamic = false;
    let urlPattern = "";
    let displayUrl = "";

    segments.forEach((segment, index) => {
      // Skip route groups (segments wrapped in parentheses)
      if (segment.startsWith("(") && segment.endsWith(")")) {
        // Extract and store the route group name
        const groupName = segment.slice(1, -1);
        routeGroups.push(groupName);
        return; // Skip this segment for URL generation
      }

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
    const url = isDynamic ? displayUrl : displayUrl || "/";

    return {
      path: routePath,
      url: url,
      filePath: filePath,
      isDynamic: isDynamic,
      dynamicSegments: dynamicSegments,
      pattern: pattern,
      routeGroups: routeGroups, // Include route groups
    };
  }

  public getRoutes(): RouteInfo[] {
    return this.routes;
  }

  public getRouteUrls(): string[] {
    return this.routes.map((route) => route.url);
  }

  public isValidRoute(url: string): boolean {
    // Parse URL to separate path from query parameters
    const { pathname, searchParams } = this.parseUrl(url);

    // Check static routes first
    const staticRoute = this.routes.find(
      (route) => !route.isDynamic && route.url === pathname
    );
    if (staticRoute) {
      return true;
    }

    // Check dynamic routes against the pathname
    const pathMatches = this.routes.some((route) => {
      if (!route.isDynamic) {
        return false;
      }
      return route.pattern.test(pathname);
    });

    if (pathMatches) {
      return true;
    }

    // NEW: Check if query parameters can satisfy dynamic route parameters
    // For example: /blog?id=123 should match /blog/{id} route
    return this.routes.some((route) => {
      if (!route.isDynamic) {
        return false;
      }

      // Check if this is a base path match with query parameters
      const basePath = this.getBasePath(route.url);
      if (pathname === basePath) {
        // Check if all required dynamic segments can be satisfied by query parameters
        return route.dynamicSegments.every((paramName) => {
          return searchParams.has(paramName);
        });
      }

      return false;
    });
  }

  /**
   * Get the base path of a dynamic route (without the dynamic segments)
   * Example: /blog/{id} -> /blog
   */
  private getBasePath(routeUrl: string): string {
    return routeUrl.split("{")[0].replace(/\/$/, "") || "/";
  }

  /**
   * Parse URL to separate pathname, search params, and hash
   */
  private parseUrl(url: string): {
    pathname: string;
    search: string;
    hash: string;
    searchParams: URLSearchParams;
  } {
    try {
      // Handle relative URLs by adding a dummy base
      const fullUrl = url.startsWith("/") ? `http://dummy${url}` : url;
      const parsed = new URL(fullUrl);

      return {
        pathname: parsed.pathname,
        search: parsed.search,
        hash: parsed.hash,
        searchParams: parsed.searchParams,
      };
    } catch {
      // Fallback parsing for malformed URLs
      const [pathname, rest] = url.split("?", 2);
      const [search, hash] = rest ? rest.split("#", 2) : ["", ""];

      return {
        pathname: pathname || "/",
        search: search ? `?${search}` : "",
        hash: hash ? `#${hash}` : "",
        searchParams: new URLSearchParams(search || ""),
      };
    }
  }

  public getRouteByUrl(url: string): RouteInfo | undefined {
    // Parse URL to separate path from query parameters
    const { pathname, searchParams } = this.parseUrl(url);

    // Check static routes first
    const staticRoute = this.routes.find(
      (route) => !route.isDynamic && route.url === pathname
    );
    if (staticRoute) {
      return staticRoute;
    }

    // Check dynamic routes against pathname
    const pathMatchRoute = this.routes.find((route) => {
      if (!route.isDynamic) {
        return false;
      }
      return route.pattern.test(pathname);
    });

    if (pathMatchRoute) {
      return pathMatchRoute;
    }

    // NEW: Check if query parameters can match dynamic route
    return this.routes.find((route) => {
      if (!route.isDynamic) {
        return false;
      }

      const basePath = this.getBasePath(route.url);
      if (pathname === basePath) {
        // Check if all required dynamic segments can be satisfied by query parameters
        return route.dynamicSegments.every((paramName) => {
          return searchParams.has(paramName);
        });
      }

      return false;
    });
  }

  public getMatchingRoute(url: string): {
    route: RouteInfo;
    params: Record<string, string | string[]>;
    queryParams: URLSearchParams;
  } | null {
    // Parse URL to separate path from query parameters
    const { pathname, searchParams } = this.parseUrl(url);

    // Check static routes first
    const staticRoute = this.routes.find(
      (route) => !route.isDynamic && route.url === pathname
    );
    if (staticRoute) {
      return { route: staticRoute, params: {}, queryParams: searchParams };
    }

    // Check dynamic routes with path parameters
    for (const route of this.routes) {
      if (!route.isDynamic) {
        continue;
      }

      const match = route.pattern.exec(pathname);
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

        return { route, params, queryParams: searchParams };
      }
    }

    // NEW: Check dynamic routes with query parameters
    // For example: /blog?id=123 should match /blog/{id} route
    for (const route of this.routes) {
      if (!route.isDynamic) {
        continue;
      }

      const basePath = this.getBasePath(route.url);
      if (pathname === basePath) {
        // Check if all required dynamic segments can be satisfied by query parameters
        const canSatisfyAllParams = route.dynamicSegments.every((paramName) => {
          return searchParams.has(paramName);
        });

        if (canSatisfyAllParams) {
          const params: Record<string, string | string[]> = {};

          // Extract parameters from query string
          route.dynamicSegments.forEach((paramName) => {
            const value = searchParams.get(paramName);
            if (value !== null) {
              // For catch-all parameters, split by comma or slash
              if (route.path.includes(`[...${paramName}]`)) {
                params[paramName] = value.split(/[,\/]/).filter(Boolean);
              } else {
                params[paramName] = value;
              }
            }
          });

          return { route, params, queryParams: searchParams };
        }
      }
    }

    return null;
  }

  public refresh(): void {
    this.loadRoutes();
  }

  createHrefCompletionItems(): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    this.routes.forEach((route) => {
      const item = new vscode.CompletionItem(
        route.url,
        route.isDynamic
          ? vscode.CompletionItemKind.Snippet
          : vscode.CompletionItemKind.Reference
      );

      // Create route groups display text
      const groupsText =
        route.routeGroups.length > 0
          ? ` ${route.routeGroups.map((g) => `(${g})`).join(" ")}`
          : "";

      if (route.isDynamic) {
        item.detail = `Dynamic Route: ${route.url}${groupsText}`;
        item.documentation = new vscode.MarkdownString(
          `**Dynamic Route:** \`${route.url}\`${
            groupsText ? ` ${groupsText}` : ""
          }\n\n` +
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
        item.detail = `Static Route: ${route.url}${groupsText}`;
        item.documentation = new vscode.MarkdownString(
          `**Route:** \`${route.url}\`${
            groupsText ? ` ${groupsText}` : ""
          }\n\n**File:** \`${route.filePath}\``
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

    // Generate examples by replacing each dynamic segment
    route.dynamicSegments.forEach((paramName) => {
      if (route.path.includes(`[...${paramName}]`)) {
        // Catch-all route examples
        const basePath = route.url.replace(`{...${paramName}}`, "");
        examples.push(`${basePath}category`);
        examples.push(`${basePath}category/subcategory`);
        examples.push(`${basePath}category/subcategory/item`);
      } else {
        // Single dynamic segment examples
        const basePath = route.url.replace(`{${paramName}}`, "");

        if (paramName === "id") {
          examples.push(`${basePath}123`);
          examples.push(`${basePath}456`);
          examples.push(`${basePath}abc`);
        } else if (paramName === "slug") {
          examples.push(`${basePath}my-post`);
          examples.push(`${basePath}another-article`);
          examples.push(`${basePath}sample-page`);
        } else {
          // Generic examples for other parameter names
          examples.push(`${basePath}a`);
          examples.push(`${basePath}b`);
          examples.push(`${basePath}c`);
        }
      }
    });

    // If no specific examples were generated, create generic ones
    if (examples.length === 0) {
      let genericExample = route.url;
      route.dynamicSegments.forEach((paramName) => {
        if (route.path.includes(`[...${paramName}]`)) {
          genericExample = genericExample.replace(
            `{...${paramName}}`,
            "example"
          );
        } else {
          genericExample = genericExample.replace(`{${paramName}}`, "example");
        }
      });
      examples.push(genericExample);
    }

    return examples.slice(0, 3); // Limit to 3 examples
  }
}

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

      // NEW: Skip validation if href contains PHP tags
      if (this.containsPhpTags(hrefValue)) {
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

  /**
   * Check if string contains PHP tags
   */
  private containsPhpTags(value: string): boolean {
    // Check for various PHP tag patterns
    const phpTagPatterns = [
      /<\?php/i, // <?php
      /<\?=/i, // <?=
      /<\?(?!\s*xml)/i, // <? (but not <?xml)
      /<\%/i, // <% (alternative PHP tags)
      /<script[^>]*language\s*=\s*["']?php["']?[^>]*>/i, // <script language="php">
    ];

    return phpTagPatterns.some((pattern) => pattern.test(value));
  }

  private getSuggestions(invalidUrl: string): string[] {
    const routes = this.routeProvider.getRoutes();
    const suggestions: string[] = [];

    routes
      .filter((route) => !route.isDynamic)
      .forEach((route) => {
        if (this.isSimilar(invalidUrl, route.url)) {
          suggestions.push(route.url);
        }
      });

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

    const { route, params, queryParams } = matchResult;
    const md = new vscode.MarkdownString();

    md.appendCodeblock(`href="${hrefValue}"`, "html");

    // Show route groups if they exist
    if (route.routeGroups.length > 0) {
      const routeType = route.isDynamic ? "Dynamic" : "Static";
      const groupsText = route.routeGroups.map((g) => `(${g})`).join(" ");
      md.appendMarkdown(
        `\n\n**${routeType} Route:** \`${route.url}\` ${groupsText}`
      );
    } else {
      const routeType = route.isDynamic ? "Dynamic Route" : "Route";
      md.appendMarkdown(`\n\n**${routeType}:** \`${route.url}\``);
    }

    if (route.isDynamic && Object.keys(params).length > 0) {
      md.appendMarkdown(`\n\n**Parameters:**`);
      Object.entries(params).forEach(([key, value]) => {
        const displayValue = Array.isArray(value) ? value.join("/") : value;
        md.appendMarkdown(`\n- \`${key}\`: ${displayValue}`);
      });
    }

    // Show query parameters if they exist
    if (queryParams.size > 0) {
      md.appendMarkdown(`\n\n**Query Parameters:**`);
      queryParams.forEach((value, key) => {
        md.appendMarkdown(`\n- \`${key}\`: ${value}`);
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

export class PhpRedirectDiagnosticProvider {
  constructor(private routeProvider: RouteProvider) {}

  validateDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();

    const redirectRegex = /Request::redirect\s*\(\s*['"]([^'"]*)['"]\s*\)/g;
    let match;

    while ((match = redirectRegex.exec(text)) !== null) {
      const redirectValue = match[1];

      if (this.isExternalOrSpecialUrl(redirectValue)) {
        continue;
      }

      // NEW: Skip validation if redirect value contains PHP tags
      if (this.containsPhpTags(redirectValue)) {
        continue;
      }

      if (!this.routeProvider.isValidRoute(redirectValue)) {
        const start = document.positionAt(
          match.index + match[0].indexOf(redirectValue)
        );
        const end = document.positionAt(
          match.index + match[0].indexOf(redirectValue) + redirectValue.length
        );

        const suggestions = this.getSuggestions(redirectValue);
        const message = suggestions.length
          ? `Route "${redirectValue}" not found. Did you mean: ${suggestions.join(
              ", "
            )}?`
          : `Route "${redirectValue}" not found. Available routes: ${this.routeProvider
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

  /**
   * Check if string contains PHP tags
   */
  private containsPhpTags(value: string): boolean {
    const phpTagPatterns = [
      /<\?php/i,
      /<\?=/i,
      /<\?(?!\s*xml)/i,
      /<\%/i,
      /<script[^>]*language\s*=\s*["']?php["']?[^>]*>/i,
    ];

    return phpTagPatterns.some((pattern) => pattern.test(value));
  }

  private getSuggestions(invalidUrl: string): string[] {
    const routes = this.routeProvider.getRoutes();
    const suggestions: string[] = [];

    routes
      .filter((route) => !route.isDynamic)
      .forEach((route) => {
        if (this.isSimilar(invalidUrl, route.url)) {
          suggestions.push(route.url);
        }
      });

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

export class PhpRedirectHoverProvider implements vscode.HoverProvider {
  constructor(private routeProvider: RouteProvider) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const line = document.lineAt(position.line).text;
    const cursorOffset = position.character;

    const redirectValue = this.getRedirectValue(line, cursorOffset);
    if (!redirectValue) {
      return;
    }

    const matchResult = this.routeProvider.getMatchingRoute(redirectValue);
    if (!matchResult) {
      return;
    }

    const { route, params, queryParams } = matchResult;
    const md = new vscode.MarkdownString();

    md.appendCodeblock(`Request::redirect('${redirectValue}')`, "php");

    // Show route groups if they exist
    if (route.routeGroups.length > 0) {
      const routeType = route.isDynamic ? "Dynamic" : "Static";
      const groupsText = route.routeGroups.map((g) => `(${g})`).join(" ");
      md.appendMarkdown(
        `\n\n**${routeType} Route:** \`${route.url}\` ${groupsText}`
      );
    } else {
      const routeType = route.isDynamic ? "Dynamic Route" : "Route";
      md.appendMarkdown(`\n\n**${routeType}:** \`${route.url}\``);
    }

    if (route.isDynamic && Object.keys(params).length > 0) {
      md.appendMarkdown(`\n\n**Parameters:**`);
      Object.entries(params).forEach(([key, value]) => {
        const displayValue = Array.isArray(value) ? value.join("/") : value;
        md.appendMarkdown(`\n- \`${key}\`: ${displayValue}`);
      });
    }

    // Show query parameters if they exist
    if (queryParams.size > 0) {
      md.appendMarkdown(`\n\n**Query Parameters:**`);
      queryParams.forEach((value, key) => {
        md.appendMarkdown(`\n- \`${key}\`: ${value}`);
      });
    }

    md.appendMarkdown(`\n\n**File:** \`${route.filePath}\``);

    return new vscode.Hover(md);
  }

  private getRedirectValue(line: string, cursorOffset: number): string | null {
    const redirectRegex = /Request::redirect\s*\(\s*['"]([^'"]*)['"]\s*\)/g;
    let match;

    while ((match = redirectRegex.exec(line)) !== null) {
      const start = match.index + match[0].indexOf(match[1]);
      const end = start + match[1].length;

      if (cursorOffset >= start && cursorOffset <= end) {
        return match[1];
      }
    }

    return null;
  }
}

export class PhpRedirectCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private routeProvider: RouteProvider) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position.line).text;
    const cursorOffset = position.character;

    // Check if we're inside a Request::redirect() call
    const redirectContext = this.getRedirectContext(line, cursorOffset);
    if (!redirectContext) {
      return [];
    }

    // Return route completions with PHP-specific formatting
    return this.createPhpRedirectCompletionItems();
  }

  /**
   * Check if cursor is inside Request::redirect('...') call
   */
  private getRedirectContext(line: string, cursorOffset: number): boolean {
    const beforeCursor = line.substring(0, cursorOffset);
    const afterCursor = line.substring(cursorOffset);

    // Look for Request::redirect(' or Request::redirect(" before cursor
    const redirectMatch = /Request::redirect\s*\(\s*['"]([^'"]*)$/.exec(
      beforeCursor
    );
    if (!redirectMatch) {
      return false;
    }

    // Make sure there's a closing quote after cursor
    const nextQuoteIndex = afterCursor.search(/['"]/);
    return nextQuoteIndex !== -1;
  }

  private createPhpRedirectCompletionItems(): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    this.routeProvider.getRoutes().forEach((route) => {
      const item = new vscode.CompletionItem(
        route.url,
        route.isDynamic
          ? vscode.CompletionItemKind.Snippet
          : vscode.CompletionItemKind.Reference
      );

      // Create route groups display text
      const groupsText =
        route.routeGroups.length > 0
          ? ` ${route.routeGroups.map((g) => `(${g})`).join(" ")}`
          : "";

      if (route.isDynamic) {
        item.detail = `Dynamic Route: ${route.url}${groupsText}`;
        item.documentation = new vscode.MarkdownString(
          `**Dynamic Route:** \`${route.url}\`${
            groupsText ? ` ${groupsText}` : ""
          }\n\n` +
            `**Parameters:** ${route.dynamicSegments
              .map((s) => `\`${s}\``)
              .join(", ")}\n\n` +
            `**File:** \`${route.filePath}\`\n\n` +
            `**PHP Usage:**\n` +
            `\`\`\`php\n` +
            `Request::redirect('${route.url}');\n` +
            `\`\`\`\n\n` +
            `**Examples:**\n` +
            `${this.generatePhpExamples(route)
              .map((ex) => `- \`Request::redirect('${ex}');\``)
              .join("\n")}`
        );
        item.insertText = this.createSnippetText(route);
      } else {
        item.detail = `Static Route: ${route.url}${groupsText}`;
        item.documentation = new vscode.MarkdownString(
          `**Route:** \`${route.url}\`${
            groupsText ? ` ${groupsText}` : ""
          }\n\n**File:** \`${route.filePath}\`\n\n` +
            `**PHP Usage:**\n` +
            `\`\`\`php\n` +
            `Request::redirect('${route.url}');\n` +
            `\`\`\``
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

  private generatePhpExamples(route: RouteInfo): string[] {
    const examples: string[] = [];

    // Generate examples by replacing each dynamic segment
    route.dynamicSegments.forEach((paramName) => {
      if (route.path.includes(`[...${paramName}]`)) {
        // Catch-all route examples
        const basePath = route.url.replace(`{...${paramName}}`, "");
        examples.push(`${basePath}category`);
        examples.push(`${basePath}category/subcategory`);
      } else {
        // Single dynamic segment examples
        const basePath = route.url.replace(`{${paramName}}`, "");

        if (paramName === "id") {
          examples.push(`${basePath}123`);
          examples.push(`${basePath}456`);
        } else if (paramName === "slug") {
          examples.push(`${basePath}my-post`);
          examples.push(`${basePath}another-article`);
        } else {
          // Generic examples for other parameter names
          examples.push(`${basePath}example`);
          examples.push(`${basePath}sample`);
        }
      }
    });

    // If no specific examples were generated, create generic ones
    if (examples.length === 0) {
      let genericExample = route.url;
      route.dynamicSegments.forEach((paramName) => {
        if (route.path.includes(`[...${paramName}]`)) {
          genericExample = genericExample.replace(
            `{...${paramName}}`,
            "example"
          );
        } else {
          genericExample = genericExample.replace(`{${paramName}}`, "example");
        }
      });
      examples.push(genericExample);
    }

    return examples.slice(0, 2); // Limit to 2 examples for PHP
  }
}

export class PhpRedirectDefinitionProvider
  implements vscode.DefinitionProvider
{
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

    // Check if we're clicking on a redirect value
    const redirectValue = this.getRedirectValue(line, cursorOffset);
    if (!redirectValue) {
      return;
    }

    const route = this.routeProvider.getRouteByUrl(redirectValue);
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
   * Extract redirect value at cursor position
   */
  private getRedirectValue(line: string, cursorOffset: number): string | null {
    // Find Request::redirect() calls in the line
    const redirectRegex = /Request::redirect\s*\(\s*['"]([^'"]*)['"]\s*\)/g;
    let match;

    while ((match = redirectRegex.exec(line)) !== null) {
      const start = match.index + match[0].indexOf(match[1]);
      const end = start + match[1].length;

      if (cursorOffset >= start && cursorOffset <= end) {
        return match[1];
      }
    }

    return null;
  }
}

export class PphpScriptRedirectDiagnosticProvider {
  constructor(private routeProvider: RouteProvider) {}

  validateDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();

    // Match pphp.redirect('...') and pphp.redirect("...")
    const redirectRegex = /pphp\.redirect\s*\(\s*['"]([^'"]*)['"]\s*\)/g;
    let match;

    while ((match = redirectRegex.exec(text)) !== null) {
      const redirectValue = match[1];

      if (this.isExternalOrSpecialUrl(redirectValue)) {
        continue;
      }

      if (!this.routeProvider.isValidRoute(redirectValue)) {
        const start = document.positionAt(
          match.index + match[0].indexOf(redirectValue)
        );
        const end = document.positionAt(
          match.index + match[0].indexOf(redirectValue) + redirectValue.length
        );

        const suggestions = this.getSuggestions(redirectValue);
        const message = suggestions.length
          ? `Route "${redirectValue}" not found. Did you mean: ${suggestions.join(
              ", "
            )}?`
          : `Route "${redirectValue}" not found. Available routes: ${this.routeProvider
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

export class PphpScriptRedirectHoverProvider implements vscode.HoverProvider {
  constructor(private routeProvider: RouteProvider) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const line = document.lineAt(position.line).text;
    const cursorOffset = position.character;

    const redirectValue = this.getRedirectValue(line, cursorOffset);
    if (!redirectValue) {
      return;
    }

    const matchResult = this.routeProvider.getMatchingRoute(redirectValue);
    if (!matchResult) {
      return;
    }

    const { route, params, queryParams } = matchResult;
    const md = new vscode.MarkdownString();

    md.appendCodeblock(`pphp.redirect('${redirectValue}')`, "javascript");

    // Show route groups if they exist
    if (route.routeGroups.length > 0) {
      const routeType = route.isDynamic ? "Dynamic" : "Static";
      const groupsText = route.routeGroups.map((g) => `(${g})`).join(" ");
      md.appendMarkdown(
        `\n\n**${routeType} Route:** \`${route.url}\` ${groupsText}`
      );
    } else {
      const routeType = route.isDynamic ? "Dynamic Route" : "Route";
      md.appendMarkdown(`\n\n**${routeType}:** \`${route.url}\``);
    }

    if (route.isDynamic && Object.keys(params).length > 0) {
      md.appendMarkdown(`\n\n**Parameters:**`);
      Object.entries(params).forEach(([key, value]) => {
        const displayValue = Array.isArray(value) ? value.join("/") : value;
        md.appendMarkdown(`\n- \`${key}\`: ${displayValue}`);
      });
    }

    // Show query parameters if they exist
    if (queryParams.size > 0) {
      md.appendMarkdown(`\n\n**Query Parameters:**`);
      queryParams.forEach((value, key) => {
        md.appendMarkdown(`\n- \`${key}\`: ${value}`);
      });
    }

    md.appendMarkdown(`\n\n**File:** \`${route.filePath}\``);

    return new vscode.Hover(md);
  }

  private getRedirectValue(line: string, cursorOffset: number): string | null {
    const redirectRegex = /pphp\.redirect\s*\(\s*['"]([^'"]*)['"]\s*\)/g;
    let match;

    while ((match = redirectRegex.exec(line)) !== null) {
      const start = match.index + match[0].indexOf(match[1]);
      const end = start + match[1].length;

      if (cursorOffset >= start && cursorOffset <= end) {
        return match[1];
      }
    }

    return null;
  }
}

export class PphpScriptRedirectCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private routeProvider: RouteProvider) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position.line).text;
    const cursorOffset = position.character;

    // Check if we're inside a pphp.redirect() call
    const redirectContext = this.getRedirectContext(line, cursorOffset);
    if (!redirectContext) {
      return [];
    }

    // Return route completions with JavaScript-specific formatting
    return this.createPphpScriptRedirectCompletionItems();
  }

  /**
   * Check if cursor is inside pphp.redirect('...') call
   */
  private getRedirectContext(line: string, cursorOffset: number): boolean {
    const beforeCursor = line.substring(0, cursorOffset);
    const afterCursor = line.substring(cursorOffset);

    // Look for pphp.redirect(' or pphp.redirect(" before cursor
    const redirectMatch = /pphp\.redirect\s*\(\s*['"]([^'"]*)$/.exec(
      beforeCursor
    );
    if (!redirectMatch) {
      return false;
    }

    // Make sure there's a closing quote after cursor
    const nextQuoteIndex = afterCursor.search(/['"]/);
    return nextQuoteIndex !== -1;
  }

  private createPphpScriptRedirectCompletionItems(): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    this.routeProvider.getRoutes().forEach((route) => {
      const item = new vscode.CompletionItem(
        route.url,
        route.isDynamic
          ? vscode.CompletionItemKind.Snippet
          : vscode.CompletionItemKind.Reference
      );

      // Create route groups display text
      const groupsText =
        route.routeGroups.length > 0
          ? ` ${route.routeGroups.map((g) => `(${g})`).join(" ")}`
          : "";

      if (route.isDynamic) {
        item.detail = `Dynamic Route: ${route.url}${groupsText}`;
        item.documentation = new vscode.MarkdownString(
          `**Dynamic Route:** \`${route.url}\`${
            groupsText ? ` ${groupsText}` : ""
          }\n\n` +
            `**Parameters:** ${route.dynamicSegments
              .map((s) => `\`${s}\``)
              .join(", ")}\n\n` +
            `**File:** \`${route.filePath}\`\n\n` +
            `**JavaScript Usage:**\n` +
            `\`\`\`javascript\n` +
            `pphp.redirect('${route.url}');\n` +
            `\`\`\`\n\n` +
            `**Examples:**\n` +
            `${this.generateJavaScriptExamples(route)
              .map((ex) => `- \`pphp.redirect('${ex}');\``)
              .join("\n")}`
        );
        item.insertText = this.createSnippetText(route);
      } else {
        item.detail = `Static Route: ${route.url}${groupsText}`;
        item.documentation = new vscode.MarkdownString(
          `**Route:** \`${route.url}\`${
            groupsText ? ` ${groupsText}` : ""
          }\n\n**File:** \`${route.filePath}\`\n\n` +
            `**JavaScript Usage:**\n` +
            `\`\`\`javascript\n` +
            `pphp.redirect('${route.url}');\n` +
            `\`\`\``
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

  private generateJavaScriptExamples(route: RouteInfo): string[] {
    const examples: string[] = [];

    // Generate examples by replacing each dynamic segment
    route.dynamicSegments.forEach((paramName) => {
      if (route.path.includes(`[...${paramName}]`)) {
        // Catch-all route examples
        const basePath = route.url.replace(`{...${paramName}}`, "");
        examples.push(`${basePath}category`);
        examples.push(`${basePath}category/subcategory`);
      } else {
        // Single dynamic segment examples
        const basePath = route.url.replace(`{${paramName}}`, "");

        if (paramName === "id") {
          examples.push(`${basePath}123`);
          examples.push(`${basePath}456`);
        } else if (paramName === "slug") {
          examples.push(`${basePath}my-post`);
          examples.push(`${basePath}another-article`);
        } else {
          // Generic examples for other parameter names
          examples.push(`${basePath}example`);
          examples.push(`${basePath}sample`);
        }
      }
    });

    // If no specific examples were generated, create generic ones
    if (examples.length === 0) {
      let genericExample = route.url;
      route.dynamicSegments.forEach((paramName) => {
        if (route.path.includes(`[...${paramName}]`)) {
          genericExample = genericExample.replace(
            `{...${paramName}}`,
            "example"
          );
        } else {
          genericExample = genericExample.replace(`{${paramName}}`, "example");
        }
      });
      examples.push(genericExample);
    }

    return examples.slice(0, 2); // Limit to 2 examples for JavaScript
  }
}

export class PphpScriptRedirectDefinitionProvider
  implements vscode.DefinitionProvider
{
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

    // Check if we're clicking on a pphp.redirect value
    const redirectValue = this.getRedirectValue(line, cursorOffset);
    if (!redirectValue) {
      return;
    }

    const route = this.routeProvider.getRouteByUrl(redirectValue);
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
   * Extract redirect value at cursor position
   */
  private getRedirectValue(line: string, cursorOffset: number): string | null {
    // Find pphp.redirect() calls in the line
    const redirectRegex = /pphp\.redirect\s*\(\s*['"]([^'"]*)['"]\s*\)/g;
    let match;

    while ((match = redirectRegex.exec(line)) !== null) {
      const start = match.index + match[0].indexOf(match[1]);
      const end = start + match[1].length;

      if (cursorOffset >= start && cursorOffset <= end) {
        return match[1];
      }
    }

    return null;
  }
}
