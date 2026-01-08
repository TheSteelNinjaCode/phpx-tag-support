import * as vscode from "vscode";
import { parseHTMLDocument, parseScriptForState } from "../utils/html-parser";

export class PulseDefinitionProvider implements vscode.DefinitionProvider {
  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | undefined> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);

    // =========================================================
    // SCENARIO C: State Variables (Legacy Support)
    // =========================================================
    const htmlDoc = parseHTMLDocument(document.getText());
    const stateVars = parseScriptForState(document.getText());
    const targetVar = stateVars.find((v) => v.name === word);

    if (targetVar && htmlDoc.scripts.length > 0) {
      const scriptStart = htmlDoc.scripts[0].start;
      const fullText = document.getText();
      const scriptTagText = fullText.slice(scriptStart, htmlDoc.scripts[0].end);
      const contentMatch = scriptTagText.match(/^<script[^>]*>/i);
      const openTagLength = contentMatch ? contentMatch[0].length : 8;

      const scriptContentStart = scriptStart + openTagLength;
      const absoluteStart = scriptContentStart + targetVar.start;
      const absoluteEnd = scriptContentStart + targetVar.end;

      if (!isNaN(absoluteStart) && !isNaN(absoluteEnd)) {
        const startPos = document.positionAt(absoluteStart);
        const endPos = document.positionAt(absoluteEnd);
        return new vscode.Location(
          document.uri,
          new vscode.Range(startPos, endPos)
        );
      }
    }

    return undefined;
  }
}
