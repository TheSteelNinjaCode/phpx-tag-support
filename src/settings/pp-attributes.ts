import * as vscode from "vscode";

interface AttrDoc {
  label: string;
  blurb: string;
  snippet?: string;
  mdExtra?: string;
}

export const ATTRS: readonly AttrDoc[] = [
  {
    label: 'pp-loading-content="true"',
    blurb:
      "A loading screen is a user interface displayed while a route is loading. This file, loading.php, defines the content shown during the loading process.",
    mdExtra: `[Full docs](https://prismaphp.tsnc.tech/docs?doc=fc-loading)`,
  },
  {
    label: "pp-ref",
    blurb:
      "Registers a **ref** so you can grab the element in JS/TS: `const btn = pp.ref('myBtn')`.",
    mdExtra: `\`\`\`ts
const modal = pp.ref('modal');
modal.open();
\`\`\``,
  },
  {
    label: "pp-spread",
    blurb:
      "Spreads an **object** of props / attributes onto the element in a single go.",
    mdExtra: `\`\`\`html
<div pp-spread="{extraAttrs}"></div>
  \`\`\`
  
  [Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-spread)`,
  },
  {
    label: "pp-for",
    blurb:
      "Renders a list by repeating the element for each item in an array or object.",
    mdExtra: `\`\`\`html
<ul>
  <template pp-for="(item) in items">
    <li>{item.name}</li>
  </template>
</ul>
\`\`\`

[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-for)`,
  },
];

export function buildAttrCompletions(): vscode.CompletionItem[] {
  return ATTRS.map((attr) => {
    const item = new vscode.CompletionItem(
      attr.label,
      vscode.CompletionItemKind.Property
    );

    item.insertText = new vscode.SnippetString(
      attr.snippet ?? `${attr.label}="$0"`
    );

    item.documentation = new vscode.MarkdownString(
      `**${attr.label}** – ${attr.blurb}\n\n${attr.mdExtra ?? ""}`,
      true
    );

    item.detail = attr.blurb;
    item.sortText = `0_${attr.label}`;
    return item;
  });
}
