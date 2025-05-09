// settings/pphp-attributes.ts
import * as vscode from "vscode";

interface AttrDoc {
  label: string;          // the attribute name
  blurb: string;          // one‑liner shown in the docs pane
  snippet?: string;       // custom snippet (defaults to attr="$0")
  mdExtra?: string;       // optional extra Markdown (images, tips, links…)
}

const ATTRS: readonly AttrDoc[] = [
  {
    label: "pp-visibility",
    blurb: "Toggle **visibility** (display:none) when the bound value is false.",
    mdExtra: "```html\n<button pp-visibility=\"isOpen\">…</button>\n```"
  },
  {
    label: "pp-display",
    blurb: "Like *v-show* in Vue – keeps the node in the DOM but hides it.",
  },
  {
    label: "pp-debounce",
    blurb:
      "Debounce an event or expression; value is the delay in **ms** (default = 300).",
    mdExtra: "> **Tip:** combine with `pp-before-request` to avoid extra calls."
  },
  {
    label: "pp-before-request",
    blurb: "Executes the expression **right before** a network request starts.",
  },
  {
    label: "pp-suspense",
    blurb: "Shows a fallback while the inner async block is pending.",
  },
  {
    label: "pp-autofocus",
    blurb: "Gives the element focus when it is rendered.",
  },
  {
    label: "pp-append-params",
    blurb: "Appends its value to the current query‑string automatically.",
  },
  {
    label: "pp-ref",
    blurb: "Creates a component **ref** that you can access in JS/TS code.",
    mdExtra: "```ts\nconst btn = pphp.ref('myButton');\nbtn.click();\n```"
  },
  {
    label: "pp-bind",
    blurb: "One‑way bind *any* attribute or property to an expression.",
    mdExtra: "```html\n<input pp-bind-value=\"username\" />\n```"
  },
  {
    label: "pp-bind-spread",
    blurb: "Spread an object of props / attrs onto the element.",
  }
] as const;

/*───────────────────────────────────────────────────────────*
 *          2)  COMPLETION‑ITEMS WITH NICE DOCS              *
 *───────────────────────────────────────────────────────────*/

export function buildAttrCompletions(): vscode.CompletionItem[] {
  return ATTRS.map((attr) => {
    const item = new vscode.CompletionItem(
      attr.label,
      vscode.CompletionItemKind.Property
    );

    /* snippet: defaults to  attr="$0"  unless overridden */
    item.insertText = new vscode.SnippetString(
      attr.snippet ?? `${attr.label}="$0"`
    );

    /* main blurb shown under the label in the docs pane */
    item.documentation = new vscode.MarkdownString(
      `**${attr.label}** – ${attr.blurb}\n\n${attr.mdExtra ?? ""}`
    );

    /* make sure our custom attrs sort before the native ones */
    item.sortText = `0_${attr.label}`;

    /* an extra small one‑liner shown *in the list* (optional) */
    item.detail = attr.blurb;

    return item;
  });
}