import * as vscode from "vscode";

/**
 * Completions for the main `pp` object (PPHPUtilities).
 * Includes methods inherited from PP (Reactive Core) and PPHPUtilities specifics.
 */
export const getPulsePointCompletions = (): vscode.CompletionItem[] => {
  const methods = [
    // -----------------------------------------------------------------
    // Reactive Core (Inherited from PP)
    // -----------------------------------------------------------------
    {
      label: "hydrationStarted",
      kind: vscode.CompletionItemKind.Field,
      detail: "(property) hydrationStarted: boolean",
      documentation: "Flag indicating if the hydration process has started.",
    },
    {
      label: "hydrationDone",
      kind: vscode.CompletionItemKind.Field,
      detail: "(property) hydrationDone: boolean",
      documentation:
        "Flag indicating if the hydration process is fully complete.",
    },
    {
      label: "isHydrated",
      kind: vscode.CompletionItemKind.Property,
      detail: "(getter) isHydrated: boolean",
      documentation: "Returns true if the hydration process is complete.",
    },
    {
      label: "isHydrating",
      kind: vscode.CompletionItemKind.Property,
      detail: "(getter) isHydrating: boolean",
      documentation:
        "Returns true if the hydration process is currently active.",
    },
    {
      label: "initialize",
      kind: vscode.CompletionItemKind.Method,
      detail: "initialize(): Promise<void>",
      documentation:
        "Manually triggers the initialization and hydration process.",
      insertText: "initialize()",
    },
    {
      label: "state",
      kind: vscode.CompletionItemKind.Method,
      detail: "state<T>(keyOrInitial: string | T, initialValue?: T)",
      documentation: "Create a reactive state variable with an optional key.",
      insertText: new vscode.SnippetString("state(${1:initialValue})"),
    },
    {
      label: "effect",
      kind: vscode.CompletionItemKind.Method,
      detail: "effect(cb: () => void, deps?: [])",
      documentation:
        "Register a side effect that runs when dependencies change.",
      insertText: new vscode.SnippetString(
        "effect(() => {\n\t$0\n}, [${1:deps}])",
      ),
    },
    {
      label: "ref",
      kind: vscode.CompletionItemKind.Method,
      detail: "ref<T>(initial?: T): Ref<T>",
      documentation: "Creates a mutable reference object.",
      insertText: new vscode.SnippetString("ref(${1:null})"),
    },

    // -----------------------------------------------------------------
    // Lifecycle & Hydration Hooks
    // -----------------------------------------------------------------
    {
      label: "onPhase",
      kind: vscode.CompletionItemKind.Method,
      detail: "onPhase(phase: HydrationPhase, cb: () => void)",
      documentation: "Register a callback for a specific hydration phase.",
      insertText: new vscode.SnippetString(
        "onPhase(${1:phase}, () => {\n\t$0\n})",
      ),
    },
    {
      label: "waitForPhase",
      kind: vscode.CompletionItemKind.Method,
      detail: "waitForPhase(phase: HydrationPhase): Promise<void>",
      documentation:
        "Returns a promise that resolves when a specific phase is reached.",
      insertText: new vscode.SnippetString("waitForPhase(${1:phase})"),
    },
    {
      label: "hydrated",
      kind: vscode.CompletionItemKind.Method,
      detail: "hydrated(): Promise<void>",
      documentation:
        "Returns a promise that resolves when hydration is complete.",
      insertText: "hydrated()",
    },
    {
      label: "onHydrated",
      kind: vscode.CompletionItemKind.Method,
      detail: "onHydrated(cb: () => void)",
      documentation: "Register a callback to run once hydration is finished.",
      insertText: new vscode.SnippetString("onHydrated(() => {\n\t$0\n})"),
    },
    {
      label: "registerLifecycleHooks",
      kind: vscode.CompletionItemKind.Method,
      detail: "registerLifecycleHooks(hooks: LifecycleHooks)",
      documentation: "Registers global lifecycle hooks for the application.",
      insertText: new vscode.SnippetString(
        "registerLifecycleHooks({\n\t$1\n})",
      ),
    },
    {
      label: "destroy",
      kind: vscode.CompletionItemKind.Method,
      detail: "destroy(): void",
      documentation: "Cleans up all observers, state, and listeners.",
      insertText: "destroy()",
    },

    // -----------------------------------------------------------------
    // Portal Management
    // -----------------------------------------------------------------
    {
      label: "createPortal",
      kind: vscode.CompletionItemKind.Method,
      detail: "createPortal(content, container, options?)",
      documentation: "Renders content into a different part of the DOM.",
      insertText: new vscode.SnippetString(
        "createPortal(${1:content}, ${2:container})",
      ),
    },
    {
      label: "removePortal",
      kind: vscode.CompletionItemKind.Method,
      detail: "removePortal(portalId: string): boolean",
      documentation: "Removes a portal by its ID.",
      insertText: new vscode.SnippetString("removePortal(${1:portalId})"),
    },
    {
      label: "hasPortal",
      kind: vscode.CompletionItemKind.Method,
      detail: "hasPortal(portalId: string): boolean",
      documentation: "Checks if a portal with the given ID exists.",
      insertText: new vscode.SnippetString("hasPortal(${1:portalId})"),
    },
    {
      label: "getPortal",
      kind: vscode.CompletionItemKind.Method,
      detail: "getPortal(portalId: string): Portal | undefined",
      documentation: "Retrieves the portal instance by ID.",
      insertText: new vscode.SnippetString("getPortal(${1:portalId})"),
    },
    {
      label: "markPortalHydrated",
      kind: vscode.CompletionItemKind.Method,
      detail: "markPortalHydrated(portalId: string)",
      documentation: "Manually marks a portal as hydrated.",
      insertText: new vscode.SnippetString("markPortalHydrated(${1:portalId})"),
    },
    {
      label: "updatePortal",
      kind: vscode.CompletionItemKind.Method,
      detail: "updatePortal(portalId, content, options?)",
      documentation: "Updates the content or options of an existing portal.",
      insertText: new vscode.SnippetString(
        "updatePortal(${1:portalId}, ${2:content})",
      ),
    },

    // -----------------------------------------------------------------
    // PPHPUtilities: Navigation & SPA
    // -----------------------------------------------------------------
    {
      label: "redirect",
      kind: vscode.CompletionItemKind.Method,
      detail: "redirect(url: string): Promise<void>",
      documentation:
        "Smart redirect. Uses SPA navigation for internal links and standard window location for external links.",
      insertText: new vscode.SnippetString("redirect('${1:url}')"),
    },
    {
      label: "navigateTo",
      kind: vscode.CompletionItemKind.Method,
      detail: "navigateTo(url: string, pushState?: boolean): Promise<void>",
      documentation:
        "Performs an internal SPA navigation to the specified URL.",
      insertText: new vscode.SnippetString("navigateTo('${1:url}')"),
    },
    {
      label: "enableSPANavigation",
      kind: vscode.CompletionItemKind.Method,
      detail: "enableSPANavigation(): void",
      documentation:
        "Enables interception of link clicks and popstate events for Single Page Application behavior.",
      insertText: "enableSPANavigation()",
    },
    {
      label: "disableSPANavigation",
      kind: vscode.CompletionItemKind.Method,
      detail: "disableSPANavigation(): void",
      documentation:
        "Disables the SPA router interception. Links will trigger standard browser navigation.",
      insertText: "disableSPANavigation()",
    },

    // -----------------------------------------------------------------
    // PPHPUtilities: Networking
    // -----------------------------------------------------------------
    {
      label: "fetchFunction",
      kind: vscode.CompletionItemKind.Method,
      detail:
        "fetchFunction<T>(functionName: string, data?: object, options?: boolean | RpcOptions): Promise<T | void>",
      documentation: `### RPC Features
- **File Uploads**: Pass \`File\` or \`FileList\` in the data object.
- **Streaming**: Handle Server-Sent Events with \`onStream\`.
- **Abort**: Cancel requests using \`abortPrevious: true\`.

**Full RpcOptions Interface:**
\`\`\`typescript
type RpcOptions = {
  abortPrevious?: boolean;
  onStream?: (chunk: any) => void;
  onStreamError?: (error: any) => void;
  onStreamComplete?: () => void;
  onUploadProgress?: (info: {
    loaded: number;
    total: number | null;
    percent: number | null;
  }) => void;
  onUploadComplete?: () => void;
};
\`\`\``,
      insertText: new vscode.SnippetString(
        "fetchFunction('${1:functionName}', { ${2:key}: ${3:value} })",
      ),
    },
  ];

  return methods.map((m) => {
    const item = new vscode.CompletionItem(m.label, m.kind);
    item.detail = m.detail;
    item.documentation = new vscode.MarkdownString(m.documentation || "");
    if (m.insertText) {
      item.insertText = m.insertText;
    }
    return item;
  });
};

/**
 * Completions for the global `searchParams` object (SearchParamsManager).
 */
export const getSearchParamsCompletions = (): vscode.CompletionItem[] => {
  const methods = [
    {
      label: "get",
      kind: vscode.CompletionItemKind.Method,
      detail: "get(key: string): string | null",
      documentation:
        "Returns the first value associated with the given search parameter.",
      insertText: new vscode.SnippetString("get('${1:key}')"),
    },
    {
      label: "set",
      kind: vscode.CompletionItemKind.Method,
      detail: "set(key: string, value: string): void",
      documentation:
        "Sets the value associated with a given search parameter and updates the URL.",
      insertText: new vscode.SnippetString("set('${1:key}', '${2:value}')"),
    },
    {
      label: "delete",
      kind: vscode.CompletionItemKind.Method,
      detail: "delete(key: string): void",
      documentation: "Deletes the given search parameter and updates the URL.",
      insertText: new vscode.SnippetString("delete('${1:key}')"),
    },
    {
      label: "replace",
      kind: vscode.CompletionItemKind.Method,
      detail: "replace(params: Record<string, string | null>): void",
      documentation:
        "Replaces the current search parameters with a new set. Pass null to remove a key.",
      insertText: new vscode.SnippetString(
        "replace({\n\t${1:key}: ${2:value}\n})",
      ),
    },
    {
      label: "params",
      kind: vscode.CompletionItemKind.Property,
      detail: "(getter) params: URLSearchParams",
      documentation: "Get the underlying URLSearchParams object.",
    },
    {
      label: "listen",
      kind: vscode.CompletionItemKind.Method,
      detail: "listen(callback: SearchParamsListener): void",
      documentation:
        "Registers a callback to be called when search parameters change.",
      insertText: new vscode.SnippetString("listen((params) => {\n\t$0\n})"),
    },
    {
      label: "enablePopStateListener",
      kind: vscode.CompletionItemKind.Method,
      detail: "enablePopStateListener(): void",
      documentation:
        "Enables listening to the window's popstate event to update parameters.",
      insertText: "enablePopStateListener()",
    },
  ];

  return methods.map((m) => {
    const item = new vscode.CompletionItem(m.label, m.kind);
    item.detail = m.detail;
    item.documentation = new vscode.MarkdownString(m.documentation || "");
    if (m.insertText) {
      item.insertText = m.insertText;
    }
    return item;
  });
};

/**
 * Completions for the global `store` object (PPHPLocalStore).
 */
export const getStoreCompletions = (): vscode.CompletionItem[] => {
  const methods = [
    {
      label: "state",
      kind: vscode.CompletionItemKind.Field,
      detail: "state: Record<string, any>",
      documentation: "The current state object stored in local storage.",
    },
    {
      label: "setState",
      kind: vscode.CompletionItemKind.Method,
      detail:
        "setState(update: Partial<State>, syncWithBackend?: boolean): void",
      documentation:
        "Updates the local store state. Optionally syncs with the backend.",
      insertText: new vscode.SnippetString(
        "setState({ ${1:key}: ${2:value} })",
      ),
    },
    {
      label: "resetState",
      kind: vscode.CompletionItemKind.Method,
      detail: "resetState(id?: string, syncWithBackend?: boolean): void",
      documentation:
        "Resets the entire state or a specific key if ID is provided.",
      insertText: new vscode.SnippetString("resetState()"),
    },
  ];

  return methods.map((m) => {
    const item = new vscode.CompletionItem(m.label, m.kind);
    item.detail = m.detail;
    item.documentation = new vscode.MarkdownString(m.documentation || "");
    (item.documentation as vscode.MarkdownString).isTrusted = true;
    if (m.insertText) {
      item.insertText = m.insertText;
    }
    return item;
  });
};

/**
 * Completions for the global variables themselves (pp, searchParams, store).
 */
export const getPulsePointGlobals = (): vscode.CompletionItem[] => {
  return [
    {
      label: "pp",
      kind: vscode.CompletionItemKind.Class,
      detail: "Global PulsePoint Utilities",
      documentation:
        "The main entry point for PulsePoint reactive utilities (PPHPUtilities).",
      insertText: "pp",
    },
    {
      label: "searchParams",
      kind: vscode.CompletionItemKind.Variable,
      detail: "Global SearchParams Manager",
      documentation: "Reactive wrapper for URL search parameters.",
      insertText: "searchParams",
    },
    {
      label: "store",
      kind: vscode.CompletionItemKind.Variable,
      detail: "Global Local Store",
      documentation: "Persistent local state manager (PPHPLocalStore).",
      insertText: "store",
    },
  ];
};
