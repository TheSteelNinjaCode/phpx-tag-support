// src/analysis/reactive-state-validator.ts

import * as vscode from "vscode";

interface StateDeclaration {
  variableName: string;
  isPrimitive: boolean;
  initialValue: any;
  position: vscode.Position;
  type: "state" | "share";
}

interface StateUsage {
  variableName: string;
  usageText: string;
  position: vscode.Position;
  hasValueAccess: boolean;
  lineText: string;
  isSpreadUsage: boolean;
}

export class ReactiveStateValidator {
  private diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("pphp-state");
  }

  public validateDocument(document: vscode.TextDocument): void {
    if (!document.fileName.endsWith(".php")) {
      return;
    }

    console.log(`[PPHP Validator] Validating document: ${document.fileName}`);

    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const scriptBlocks = this.extractScriptBlocks(text, document);

    console.log(`[PPHP Validator] Found ${scriptBlocks.length} script blocks`);

    for (const scriptBlock of scriptBlocks) {
      const states = this.extractStateDeclarations(
        scriptBlock.content,
        scriptBlock.startLine,
        document
      );
      console.log(
        `[PPHP Validator] Found ${states.length} state declarations:`,
        states.map((s) => `${s.variableName} (primitive: ${s.isPrimitive})`)
      );

      const usages = this.extractStateUsages(
        scriptBlock.content,
        scriptBlock.startLine,
        states,
        document
      );
      console.log(
        `[PPHP Validator] Found ${usages.length} state usages:`,
        usages.map(
          (u) =>
            `${u.variableName} at line ${u.position.line + 1} (.value: ${
              u.hasValueAccess
            }) (spread: ${u.isSpreadUsage})`
        )
      );

      // Validate primitive state usages
      for (const usage of usages) {
        const state = states.find((s) => s.variableName === usage.variableName);
        if (state && !usage.hasValueAccess) {
          // For primitives: always need .value
          // For non-primitives: only need .value in spread syntax or when used as primitive
          const shouldWarn = state.isPrimitive || usage.isSpreadUsage;

          if (shouldWarn) {
            const message = usage.isSpreadUsage
              ? `State '${usage.variableName}' in spread syntax should use '.value' to access the current value. Use '...${usage.variableName}.value' instead of '...${usage.variableName}'.`
              : `Primitive state '${usage.variableName}' should use '.value' to access the current value. Without '.value', this will return a Proxy object.`;

            console.log(
              `[PPHP Validator] Creating diagnostic for: ${
                usage.variableName
              } at line ${usage.position.line + 1}, char ${
                usage.position.character
              }`
            );

            // Calculate the exact range of the variable name
            const startPos = usage.position;
            const endPos = new vscode.Position(
              startPos.line,
              startPos.character + usage.variableName.length
            );

            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(startPos, endPos),
              message,
              vscode.DiagnosticSeverity.Warning
            );
            diagnostic.code = usage.isSpreadUsage
              ? "pphp-spread-state-access"
              : "pphp-primitive-state-access";
            diagnostic.source = "PPHP State Validator";
            diagnostics.push(diagnostic);
          }
        }
      }
    }

    console.log(`[PPHP Validator] Setting ${diagnostics.length} diagnostics`);
    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  private extractScriptBlocks(
    text: string,
    document: vscode.TextDocument
  ): Array<{ content: string; startLine: number }> {
    const scriptBlocks: Array<{ content: string; startLine: number }> = [];
    const lines = text.split("\n");
    let inScript = false;
    let scriptContent = "";
    let scriptStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.includes("<script>")) {
        inScript = true;
        // The actual script content starts on the NEXT line after <script>
        scriptStartLine = i + 1;
        scriptContent = "";

        // Handle same-line script content after <script>
        const scriptIndex = line.indexOf("<script>");
        const afterScript = line.substring(scriptIndex + 8);

        if (afterScript.trim() && !afterScript.includes("</script>")) {
          // If there's content on the same line as <script>, start from current line
          scriptStartLine = i;
          scriptContent += afterScript + "\n";
        } else if (afterScript.includes("</script>")) {
          // Handle single-line script
          scriptStartLine = i;
          const endIndex = afterScript.indexOf("</script>");
          scriptContent += afterScript.substring(0, endIndex);
          scriptBlocks.push({
            content: scriptContent,
            startLine: scriptStartLine,
          });
          inScript = false;
        }
      } else if (line.includes("</script>") && inScript) {
        // Handle content before closing tag
        const beforeScript = line.substring(0, line.indexOf("</script>"));
        if (beforeScript.trim()) {
          scriptContent += beforeScript;
        }

        scriptBlocks.push({
          content: scriptContent,
          startLine: scriptStartLine,
        });
        inScript = false;
      } else if (inScript) {
        scriptContent += lines[i] + "\n";
      }
    }

    return scriptBlocks;
  }

  private extractStateDeclarations(
    scriptContent: string,
    startLine: number,
    document: vscode.TextDocument
  ): StateDeclaration[] {
    const states: StateDeclaration[] = [];

    // Handle multiline state declarations by removing line breaks within the pphp.state() call
    const normalizedContent = this.normalizeStateDeclarations(scriptContent);
    const lines = normalizedContent.split("\n");

    // More flexible regex pattern that handles multiline content
    const stateRegex =
      /const\s*\[\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*\]\s*=\s*pphp\.(state|share)\s*\([^}]*\}?\s*\)/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match;
      stateRegex.lastIndex = 0; // Reset regex

      while ((match = stateRegex.exec(line)) !== null) {
        const variableName = match[1];
        const type = match[2] as "state" | "share";
        const fullMatch = match[0];

        // Extract the initial value from the full match
        const parenStart = fullMatch.indexOf("(") + 1;
        const parenEnd = fullMatch.lastIndexOf(")");
        const initialValueStr = fullMatch
          .substring(parenStart, parenEnd)
          .trim();

        const isPrimitive = this.isPrimitiveValue(initialValueStr);

        states.push({
          variableName,
          isPrimitive,
          initialValue: initialValueStr,
          position: new vscode.Position(startLine + i, match.index!),
          type,
        });
      }
    }

    // Fallback: Try to find declarations that span multiple lines in original content
    const multilineStates = this.extractMultilineStateDeclarations(
      scriptContent,
      startLine
    );

    // Merge results, avoiding duplicates
    for (const multilineState of multilineStates) {
      if (!states.find((s) => s.variableName === multilineState.variableName)) {
        states.push(multilineState);
      }
    }

    return states;
  }

  private normalizeStateDeclarations(content: string): string {
    // Replace multiline state declarations with single line equivalents
    return content.replace(
      /const\s*\[\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*\]\s*=\s*pphp\.(state|share)\s*\(\s*(\[[\s\S]*?\]|\{[\s\S]*?\}|[^)]*)\s*\);?/g,
      (match, varName, type, value) => {
        // Compress multiline content to single line
        const compressedValue = value.replace(/\s+/g, " ").trim();
        return `const [${varName}, set${
          varName.charAt(0).toUpperCase() + varName.slice(1)
        }] = pphp.${type}(${compressedValue});`;
      }
    );
  }

  private extractMultilineStateDeclarations(
    scriptContent: string,
    startLine: number
  ): StateDeclaration[] {
    const states: StateDeclaration[] = [];
    const lines = scriptContent.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Look for the start of a const declaration
      const constMatch = line.match(
        /const\s*\[\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*\]\s*=\s*pphp\.(state|share)\s*\(/
      );
      if (constMatch) {
        const variableName = constMatch[1];
        const type = constMatch[2] as "state" | "share";

        // Find the complete declaration by looking for the closing parenthesis and semicolon
        let declarationContent = line;
        let j = i + 1;
        let parenCount =
          (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;

        while (
          j < lines.length &&
          (parenCount > 0 || !declarationContent.includes(");"))
        ) {
          declarationContent += " " + lines[j].trim();
          parenCount +=
            (lines[j].match(/\(/g) || []).length -
            (lines[j].match(/\)/g) || []).length;
          j++;
        }

        // Extract the initial value
        const valueMatch = declarationContent.match(
          /pphp\.(state|share)\s*\((.+)\)\s*;?$/
        );
        if (valueMatch) {
          const initialValueStr = valueMatch[2].trim();
          const isPrimitive = this.isPrimitiveValue(initialValueStr);

          states.push({
            variableName,
            isPrimitive,
            initialValue: initialValueStr,
            position: new vscode.Position(startLine + i, constMatch.index!),
            type,
          });
        }
      }
    }

    return states;
  }

  private extractStateUsages(
    scriptContent: string,
    startLine: number,
    states: StateDeclaration[],
    document: vscode.TextDocument
  ): StateUsage[] {
    const usages: StateUsage[] = [];
    const lines = scriptContent.split("\n");

    const stateNames = states.map((s) => s.variableName);
    if (stateNames.length === 0) {
      return usages;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const actualLineNumber = startLine + i;

      // Skip lines that contain console.log since they already support .value
      if (this.isConsoleLogLine(line)) {
        continue;
      }

      // Look for spread usage first: ...variableName
      for (const stateName of stateNames) {
        const spreadPattern = new RegExp(
          `\\.\\.\\.(${stateName})(?!\\.value)\\b`,
          "g"
        );
        let spreadMatch;

        while ((spreadMatch = spreadPattern.exec(line)) !== null) {
          const matchStart = spreadMatch.index! + 3; // Skip the '...' part

          // Skip if it's part of a declaration
          if (this.isPartOfDeclaration(line, matchStart)) {
            continue;
          }

          // Skip if it's inside console.log, alert, or other logging functions
          if (this.isInsideLoggingFunction(line, matchStart)) {
            continue;
          }

          // Skip if it's inside a string literal
          if (this.isInsideStringLiteral(line, matchStart)) {
            continue;
          }

          console.log(
            `[PPHP Validator] Found spread usage: ...${stateName} at line ${
              actualLineNumber + 1
            }`
          );

          usages.push({
            variableName: stateName,
            usageText: `...${spreadMatch[1]}`,
            position: new vscode.Position(actualLineNumber, matchStart),
            hasValueAccess: false, // Spread without .value is always incorrect
            lineText: line,
            isSpreadUsage: true,
          });
        }

        // Look for spread with .value: ...variableName.value
        const spreadValuePattern = new RegExp(
          `\\.\\.\\.(${stateName})\\.value\\b`,
          "g"
        );
        let spreadValueMatch;

        while ((spreadValueMatch = spreadValuePattern.exec(line)) !== null) {
          const matchStart = spreadValueMatch.index! + 3; // Skip the '...' part

          // Skip if it's part of a declaration
          if (this.isPartOfDeclaration(line, matchStart)) {
            continue;
          }

          // Skip if it's inside console.log, alert, or other logging functions
          if (this.isInsideLoggingFunction(line, matchStart)) {
            continue;
          }

          // Skip if it's inside a string literal
          if (this.isInsideStringLiteral(line, matchStart)) {
            continue;
          }

          console.log(
            `[PPHP Validator] Found correct spread usage: ...${stateName}.value at line ${
              actualLineNumber + 1
            }`
          );

          usages.push({
            variableName: stateName,
            usageText: `...${spreadValueMatch[1]}.value`,
            position: new vscode.Position(actualLineNumber, matchStart),
            hasValueAccess: true, // This is correct usage
            lineText: line,
            isSpreadUsage: true,
          });
        }
      }

      // Look for regular state variable usage (non-spread)
      for (const stateName of stateNames) {
        const pattern = `\\b(${stateName})\\b(?!\\.value)(?!\\s*\\.value)`;
        const regex = new RegExp(pattern, "g");
        let match;

        while ((match = regex.exec(line)) !== null) {
          const matchStart = match.index!;
          const matchEnd = matchStart + stateName.length;

          // Skip if it's part of a declaration
          if (this.isPartOfDeclaration(line, matchStart)) {
            continue;
          }

          // Skip if it's inside console.log, alert, or other logging functions
          if (this.isInsideLoggingFunction(line, matchStart)) {
            continue;
          }

          // Skip if it's inside a string literal
          if (this.isInsideStringLiteral(line, matchStart)) {
            continue;
          }

          // Skip if it's already part of a spread usage
          const beforeMatch = line.substring(
            Math.max(0, matchStart - 3),
            matchStart
          );
          if (beforeMatch === "...") {
            continue; // This will be handled by spread detection
          }

          // Check what comes after the variable name
          const afterVariable = line.substring(matchEnd);
          const hasValueAccess = this.checkValueAccess(
            afterVariable,
            line,
            matchStart
          );

          usages.push({
            variableName: stateName,
            usageText: match[0],
            position: new vscode.Position(actualLineNumber, matchStart),
            hasValueAccess,
            lineText: line,
            isSpreadUsage: false,
          });
        }
      }
    }

    return usages;
  }

  private isConsoleLogLine(line: string): boolean {
    const trimmed = line.trim();
    return (
      trimmed.includes("console.log") ||
      trimmed.includes("console.warn") ||
      trimmed.includes("console.error") ||
      trimmed.includes("console.info") ||
      trimmed.includes("alert(") ||
      trimmed.includes("print(")
    );
  }

  private isInsideLoggingFunction(line: string, position: number): boolean {
    const beforeMatch = line.substring(0, position);
    const afterMatch = line.substring(position);

    // Check if we're inside console.log(), alert(), etc.
    const logFunctions = [
      "console.log",
      "console.warn",
      "console.error",
      "console.info",
      "alert",
      "print",
    ];

    for (const func of logFunctions) {
      const funcIndex = beforeMatch.lastIndexOf(func + "(");
      if (funcIndex !== -1) {
        // Check if there's a closing parenthesis after our position
        const closingParen = line.indexOf(")", position);
        if (closingParen !== -1) {
          return true;
        }
      }
    }

    return false;
  }

  private isInsideStringLiteral(line: string, position: number): boolean {
    const beforeMatch = line.substring(0, position);

    // Count quotes before the position
    const singleQuotes = (beforeMatch.match(/'/g) || []).length;
    const doubleQuotes = (beforeMatch.match(/"/g) || []).length;

    // If odd number of quotes, we're inside a string
    return singleQuotes % 2 === 1 || doubleQuotes % 2 === 1;
  }

  private checkValueAccess(
    afterVariable: string,
    fullLine: string,
    variableIndex: number
  ): boolean {
    const trimmed = afterVariable.trim();

    // Direct .value access
    if (trimmed.startsWith(".value")) {
      return true;
    }

    // Property access (like user.name) - but not .value
    if (trimmed.startsWith(".") && !trimmed.startsWith(".value")) {
      return true;
    }

    // Array access (like items[0])
    if (trimmed.startsWith("[")) {
      return true;
    }

    // Method call with dot notation (like items.push())
    const dotIndex = trimmed.indexOf(".");
    const parenIndex = trimmed.indexOf("(");
    if (dotIndex !== -1 && parenIndex !== -1 && dotIndex < parenIndex) {
      return true;
    }

    // Check if it's followed by a method call directly (like scores.includes())
    if (trimmed.match(/^\.[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/)) {
      return true;
    }

    return false;
  }

  private isPrimitiveValue(valueStr: string): boolean {
    if (!valueStr) {
      return true;
    }

    const trimmed = valueStr.trim();

    // Boolean values
    if (trimmed === "true" || trimmed === "false") {
      return true;
    }

    // Numeric values
    if (/^-?\d*\.?\d+$/.test(trimmed)) {
      return true;
    }

    // String values (quoted)
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return true;
    }

    // Null and undefined
    if (trimmed === "null" || trimmed === "undefined") {
      return true;
    }

    // Empty string for no parameters
    if (trimmed === "") {
      return true;
    }

    return false;
  }

  private isPartOfDeclaration(line: string, position: number): boolean {
    const beforeMatch = line.substring(0, position);
    return (
      beforeMatch.includes("const [") ||
      beforeMatch.includes("let [") ||
      beforeMatch.includes("var [") ||
      beforeMatch.includes("= pphp.state") ||
      beforeMatch.includes("= pphp.share")
    );
  }

  public dispose(): void {
    this.diagnosticCollection.dispose();
  }
}

export function createReactiveStateValidator(): ReactiveStateValidator {
  const validator = new ReactiveStateValidator();

  // Register document change listener with debounce
  let timeout: NodeJS.Timeout;
  const changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      validator.validateDocument(event.document);
    }, 300); // 300ms debounce
  });

  // Register document open listener
  const openDisposable = vscode.workspace.onDidOpenTextDocument((document) => {
    validator.validateDocument(document);
  });

  // Register document save listener
  const saveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
    validator.validateDocument(document);
  });

  // Validate all currently open documents
  vscode.workspace.textDocuments.forEach((document) => {
    validator.validateDocument(document);
  });

  // Return a disposable that cleans up everything
  return validator;
}
