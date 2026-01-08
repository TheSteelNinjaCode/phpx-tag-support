import * as vscode from "vscode";
import {
  parseScriptForState,
  extractFunctionsFromScript,
  PulseStateVar,
  ParsedFunction,
} from "../utils/html-parser";

export class MustacheHoverProvider implements vscode.HoverProvider {
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const range = document.getWordRangeAtPosition(position);
    if (!range) return undefined;

    const word = document.getText(range);
    const offset = document.offsetAt(position);
    const text = document.getText();

    // 1. Verify we are inside a PulsePoint mustache { ... }
    // We ignore PHP tags (<?php ... ?>) and target { ... }
    if (!this.isInsidePulsePointMustache(text, offset)) {
      return undefined;
    }

    // 2. Parse the script to get definitions
    const stateVars = parseScriptForState(text);
    const functions = extractFunctionsFromScript(text);

    // 3. Check for State Match
    const stateVar = stateVars.find((v) => v.name === word);
    if (stateVar) {
      return this.createStateHover(stateVar);
    }

    // 4. Check for Function Match
    const func = functions.find((f) => f.name === word);
    if (func) {
      return this.createFunctionHover(func);
    }

    // 5. Check for Standard Globals
    if (["Date", "Math", "JSON", "console"].includes(word)) {
      return new vscode.Hover(
        new vscode.MarkdownString(`**JS Core Object**: \`${word}\``)
      );
    }

    return undefined;
  }

  /**
   * Checks if the specific offset is inside { ... } but NOT inside PHP tags
   */
  private isInsidePulsePointMustache(text: string, offset: number): boolean {
    /**
     * REGEX STRATEGY (Matches Validator Logic):
     * [1] PHP Tag:       <? ... ?> (Ignore these)
     * [2] PulsePoint:    { ... }   (Target these)
     */
    const regex = /(<\?(?:php|=)[\s\S]*?\?>)|(\{([^{}]+)\})/gi;

    let match;
    while ((match = regex.exec(text)) !== null) {
      // 1. If match[1] exists, it is a PHP tag.
      if (match[1]) {
        const start = match.index;
        const end = start + match[0].length;
        // If cursor is inside PHP, explicitly return false
        if (offset >= start && offset <= end) {
          return false;
        }
        continue;
      }

      // 2. Otherwise, it's a PulsePoint match (match[2])
      if (match[2]) {
        const start = match.index;
        const end = start + match[0].length;

        // Check if our cursor is inside this PulsePoint block
        if (offset >= start && offset <= end) {
          return true;
        }
      }
    }
    return false;
  }

  private createStateHover(stateVar: PulseStateVar): vscode.Hover {
    const md = new vscode.MarkdownString();
    // TypeScript-like signature
    md.appendCodeblock(
      `(state) ${stateVar.name}: ${stateVar.type}`,
      "typescript"
    );

    md.appendMarkdown(`**PulsePoint Reactive State**`);

    if (
      stateVar.type === "Object" &&
      stateVar.keys &&
      stateVar.keys.length > 0
    ) {
      md.appendMarkdown(`\n\n**Properties:**\n`);
      stateVar.keys.forEach((k) => md.appendMarkdown(`- \`${k}\`\n`));
    }

    return new vscode.Hover(md);
  }

  private createFunctionHover(func: ParsedFunction): vscode.Hover {
    const md = new vscode.MarkdownString();

    if (func.isStateSetter) {
      md.appendCodeblock(
        `(setter) ${func.name}(value: any): void`,
        "typescript"
      );
      md.appendMarkdown(
        `**State Setter**\n\nUpdates the reactive state variable.`
      );
    } else {
      md.appendCodeblock(`(function) ${func.name}(...args): any`, "typescript");
      md.appendMarkdown(`**Component Function**\n\nDefined in script scope.`);
    }

    return new vscode.Hover(md);
  }
}
