import * as vscode from "vscode";

interface AttrDoc {
  label: string; // attribute name
  blurb: string; // short, 1‑line description
  snippet?: string; // custom snippet (defaults to attr="$0")
  mdExtra?: string; // extra Markdown: examples, tips, links
}

/* ──────────────────────────────────────────────────────────── *
 *            Attribute palette with improved docs              *
 * ──────────────────────────────────────────────────────────── */
export const ATTRS: readonly AttrDoc[] = [
  /* ── Visibility & display ─────────────────────────────── */
  {
    label: "pp-visibility",
    blurb:
      "Toggles **visibility:hidden** (keeps layout space) while the bound expression is *falsy* or until a timer elapses.",
    mdExtra: `### Example  
\`\`\`html
<!-- keep in flow; hide when \`open\` is false -->
<button pp-visibility="duration">Save</button>

<!-- auto‑reveal after 800 ms -->
<div pp-visibility="{ 'start': '800ms' }">✅ Done!</div>
\`\`\`

[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-visibility)`,
  },
  {
    label: "pp-display",
    blurb:
      "Like Vue’s **v-show** but uses **display:none** – the node disappears from the layout entirely.",
    mdExtra: `Accepts a boolean or a timing object  
(\`'2s'\`, \`500ms\`, \`{ start:'1s', end:'5s' }\`, …).  
[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-display) :contentReference[oaicite:0]{index=0}`,
  },
  {
    label: "pp-loading-content=\"true\"",
    blurb:
      "A loading screen is a user interface displayed while a route is loading. This file, loading.php, defines the content shown during the loading process.",
    mdExtra: `[Full docs](https://prismaphp.tsnc.tech/docs?doc=fc-loading)`,
  },

  /* ── Network lifecycle helpers ─────────────────────────── */
  {
    label: "pp-before-request",
    blurb:
      "Runs **right before** any Prisma PHPX network request fires – perfect for disabling UI or showing spinners.",
    mdExtra: `\`\`\`html
<button pp-before-request="functionName">
  Submit
</button>
\`\`\`
[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-before-request)`,
  },
  {
    label: "pp-after-request",
    blurb:
      "Companion to `pp-before-request`; fires **once the request settles** (success *or* error).",
    mdExtra: `[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-after-request)`,
  },

  /* ── Async UX ──────────────────────────────────────────── */
  {
    label: "pp-suspense",
    blurb:
      "Shows a fallback template or element while an inner async block is pending.",
    mdExtra: `Wrap long‑running sections:  
\`\`\`html
<form onsubmit="update" pp-suspense="{'disabled': true}"></form>
\`\`\`
[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-suspense)`,
  },

  /* ── Misc UX helpers ───────────────────────────────────── */
  {
    label: "pp-append-params",
    blurb:
      "Synchronises the element’s value with the current URL’s **query‑string** (great for filters & pagination).",
    mdExtra: `[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-append-params)`,
  },
  {
    label: "pp-init-state",
    blurb:
      "The pp-init-state directive is used to initialize reactive state variables directly in your DOM elements. It provides a declarative way to set up initial values, especially useful when creating standalone components without needing an explicit <script> block.",
    mdExtra: `[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-init-state)`,
  },

  /* ── Reactivity & refs ─────────────────────────────────── */
  {
    label: "pp-ref",
    blurb:
      "Registers a **ref** so you can grab the element in JS/TS: `const btn = pphp.ref('myBtn')`.",
    mdExtra: `\`\`\`ts
const modal = pphp.ref('modal');
modal.open();
\`\`\``,
  },
  {
    label: "pp-bind",
    blurb:
      "One‑way bind *any* attribute or property to a reactive expression (e.g. `value`, `class`, custom props…).",
    mdExtra: `\`\`\`html
<input pp-bind-value="username">
<img pp-bind-src="avatarUrl">
  \`\`\`
  [Full docs](https://prismaphp.tsnc.tech/docs?doc=js-reactivity#pp-bind-ref)`,
  },
  {
    label: "pp-bind-spread",
    blurb:
      "Spreads an **object** of props / attributes onto the element in a single go.",
    mdExtra: `\`\`\`html
<div pp-bind-spread="extraAttrs">
  \`\`\`
  
  [Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-bind-spread)`,
  },

  /* ── Utility ───────────────────────────────────────────── */
  {
    label: "pp-debounce",
    blurb:
      "Debounces a bound event/expression. Value is the wait period (default **300 ms**).",
    mdExtra: `Combine with \`pp-before-request\` to avoid multiple API calls.  
[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-debounce)`,
  },

  /* ── Conditional rendering ───────────────────────────────── */
  {
    label: "pp-if",
    blurb: "Conditionally renders the element based on a reactive expression",
    mdExtra: `\`\`\`html
<div pp-if="isVisible">
  <p>Shown when isVisible is truthy.</p>
</div>
  \`\`\`
  [Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-if)`,
  },

  /* ── List rendering ───────────────────────────────────── */
  {
    label: "pp-for",
    blurb:
      "Renders a list by repeating the element for each item in an array or object.",
    mdExtra: `\`\`\`html
<ul>
  <template pp-for="(item) in items">
    <li>{{ item.name }}</li>
  </template>
</ul>
\`\`\`

[Full docs](https://prismaphp.tsnc.tech/docs?doc=pp-for)`,
  },

  /* ── State synchronization ─────────────────────────────── */
  {
    label: "pp-sync",
    blurb:
      "Automatically calls a sync function when the element’s value changes, keeping server and UI in sync.",
    mdExtra: `\`\`\`html
<table pp-sync="user-table"></table>
\`\`\`

[Full docs](https://prismaphp.tsnc.tech/docs?doc=js-functions#pphpSync-function)`,
  },
];

/*───────────────────────────────────────────────────────────*
 *         Completion items factory (unchanged)              *
 *───────────────────────────────────────────────────────────*/
export function buildAttrCompletions(): vscode.CompletionItem[] {
  return ATTRS.map((attr) => {
    const item = new vscode.CompletionItem(
      attr.label,
      vscode.CompletionItemKind.Property
    );

    // insert attr="…" (or the custom snippet)
    item.insertText = new vscode.SnippetString(
      attr.snippet ?? `${attr.label}="$0"`
    );

    // rich hover markdown
    item.documentation = new vscode.MarkdownString(
      `**${attr.label}** – ${attr.blurb}\n\n${attr.mdExtra ?? ""}`,
      true // support command links
    );

    item.detail = attr.blurb; // short info in the picker
    item.sortText = `0_${attr.label}`; // keep ours above native attrs
    return item;
  });
}
