import * as vscode from "vscode";

interface AttrDoc {
  label: string;
  blurb: string;
  snippet?: string;
  mdExtra?: string;
}

export const ATTRS: readonly AttrDoc[] = [
  {
    label: "pp-loading-content",
    blurb:
      "Specifies the loading screen content shown while a route is loading (file: loading.php).",
    mdExtra: `[Full docs](https://prismaphp.tsnc.tech/docs?doc=fc-loading)`,
    snippet: 'pp-loading-content="true"',
  },
  {
    label: "pp-reset-scroll",
    blurb:
      "Resets the scroll position to the top of the page when navigating to a new route.",
    mdExtra: `[Full docs](https://prismaphp.tsnc.tech/docs?doc=fc-reset-scroll)`,
    snippet: 'pp-reset-scroll="true"',
  },
  {
    label: "key",
    blurb:
      "Unique key for an element, used for list rendering and DOM diffing optimizations.",
    mdExtra: `\`\`\`html
<template pp-for="item in items">
  <div key="{item.id}">{item.name}</div>
</template>
\`\`\``,
    snippet: 'key="{${1:item}.id}"',
  },
  {
    label: "pp-spa",
    blurb:
      "Enables SPA navigation for the element (prevents full page reloads). Placing this on the <body> enables site‑wide SPA behavior; add to individual links to enable per-link navigation.",
    mdExtra: "",
    snippet: 'pp-spa="true"',
  },
  {
    label: "pp-ignore",
    blurb:
      "Prevents the framework from processing the element's content — useful for <pre>, <code>, or other tags whose content you want to keep intact.",
    mdExtra: "",
    snippet: 'pp-ignore="true"',
  },
  {
    label: "pp-ref",
    blurb: "Registers a reference that can be retrieved via `pp.ref('name')`.",
    mdExtra: `\`\`\`ts
const modal = pp.ref('modal');
modal.open();
\`\`\``,
    snippet: 'pp-ref="${1:refName}"',
  },
  {
    label: "pp-spread",
    blurb:
      "Spreads an object of props/attributes onto the element in one operation.",
    mdExtra: `\`\`\`html
<div pp-spread="{extraAttrs}"></div>
\`\`\`

[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-spread)`,
    snippet: 'pp-spread="{${1:object}}"',
  },
  {
    label: "pp-for",
    blurb:
      "Renders a list by repeating the element for each item in an array or object.",
    mdExtra: `\`\`\`html
<ul>
  <template pp-for="item in items">
    <li>{item.name}</li>
  </template>
</ul>
\`\`\`

[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-for)`,
    snippet: 'pp-for="item in ${1:items}"',
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
