import { matchesKey, truncateToWidth, visibleWidth, Editor, type EditorTheme, type TUI } from "@mariozechner/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerEntry, ServerProvenance } from "./types.js";
import { resourceNameToToolName } from "./resource-tools.js";
import type { MetadataCache, ServerCacheEntry, CachedTool } from "./metadata-cache.js";

interface PanelTheme {
  border: string;
  title: string;
  selected: string;
  direct: string;
  needsAuth: string;
  placeholder: string;
  description: string;
  hint: string;
  confirm: string;
  cancel: string;
}

const DEFAULT_THEME: PanelTheme = {
  border: "2",
  title: "2",
  selected: "36",
  direct: "32",
  needsAuth: "33",
  placeholder: "2;3",
  description: "2",
  hint: "2",
  confirm: "32",
  cancel: "31",
};

function fg(code: string, text: string): string {
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const RAINBOW_COLORS = [
  "38;2;178;129;214",
  "38;2;215;135;175",
  "38;2;254;188;56",
  "38;2;228;192;15",
  "38;2;137;210;129",
  "38;2;0;175;175",
  "38;2;23;143;185",
];

function rainbowProgress(filled: number, total: number): string {
  const dots: string[] = [];
  for (let i = 0; i < total; i++) {
    const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
    dots.push(fg(color, i < filled ? "●" : "○"));
  }
  return dots.join(" ");
}

function fuzzyScore(query: string, text: string): number {
  const lq = query.toLowerCase();
  const lt = text.toLowerCase();
  if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
  let score = 0;
  let qi = 0;
  let consecutive = 0;
  for (let i = 0; i < lt.length && qi < lq.length; i++) {
    if (lt[i] === lq[qi]) {
      score += 10 + consecutive;
      consecutive += 5;
      qi++;
    } else {
      consecutive = 0;
    }
  }
  return qi === lq.length ? score : 0;
}

function estimateTokens(tool: CachedTool): number {
  const schemaLen = JSON.stringify(tool.inputSchema ?? {}).length;
  const descLen = tool.description?.length ?? 0;
  return Math.ceil((tool.name.length + descLen + schemaLen) / 4) + 10;
}

type ConnectionStatus = "connected" | "idle" | "failed" | "needs-auth" | "connecting";

interface ToolState {
  name: string;
  description: string;
  isDirect: boolean;
  wasDirect: boolean;
  estimatedTokens: number;
}

interface ServerState {
  name: string;
  expanded: boolean;
  source: "user" | "project" | "import";
  importKind?: string;
  connectionStatus: ConnectionStatus;
  tools: ToolState[];
  hasCachedData: boolean;
}

interface VisibleItem {
  type: "server" | "tool";
  serverIndex: number;
  toolIndex?: number;
}

class McpPanel {
  private servers: ServerState[] = [];
  private cursorIndex = 0;
  private nameQuery = "";
  private nameSearchActive = false;
  private descSearchActive = false;
  private descQuery = "";
  private dirty = false;
  private confirmingDiscard = false;
  private discardSelected = 1;
  private importNotice: string | null = null;
  private panelMessage: { kind: "info" | "error"; text: string } | null = null;

  // Server CRUD (add/edit/delete) staged changes. Applied on ctrl+s save.
  private serverChanges = new Map<string, ServerEntry | null>();
  private confirmingDelete = false;
  private deleteSelected = 1;
  private deleteServerIndex: number | null = null;

  // Server JSON editor view (multiline)
  private serverEditor: Editor | null = null;
  private serverEditorMode: "add" | "edit" = "add";
  private serverEditorTarget: string | null = null;
  private serverEditorInitialText = "";
  private serverEditorMessage: { kind: "info" | "error"; text: string } | null = null;
  private serverEditorInPaste = false;
  private serverEditorPasteBuffer = "";
  private confirmingEditorDiscard = false;
  private editorDiscardSelected = 1;

  // OAuth setup view (for servers with auth: "oauth")
  private view: "main" | "auth" | "server-editor" = "main";
  private authServerIndex: number | null = null;
  private authEnteringToken = false;
  private authTokenInput = "";
  private authMessage: { kind: "info" | "error"; text: string } | null = null;
  private reconnectAllInProgress = false;

  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private visibleItems: VisibleItem[] = [];
  private tui: TUI;
  private t = DEFAULT_THEME;

  private static readonly MAX_VISIBLE = 12;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    private config: McpConfig,
    cache: MetadataCache | null,
    provenance: Map<string, ServerProvenance>,
    private callbacks: McpPanelCallbacks,
    tui: TUI,
    private done: (result: McpPanelResult) => void,
  ) {
    this.tui = tui;

    for (const [serverName, definition] of Object.entries(config.mcpServers)) {
      const prov = provenance.get(serverName);
      const serverCache = cache?.servers?.[serverName];

      const globalDirect = config.settings?.directTools;
      let toolFilter: true | string[] | false = false;
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }

      const tools: ToolState[] = [];
      if (serverCache) {
        for (const tool of serverCache.tools ?? []) {
          const isDirect = toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(tool.name));
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            isDirect,
            wasDirect: isDirect,
            estimatedTokens: estimateTokens(tool),
          });
        }
        if (definition.exposeResources !== false) {
          for (const resource of serverCache.resources ?? []) {
            const baseName = `get_${resourceNameToToolName(resource.name)}`;
            const isDirect = toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(baseName));
            const ct: CachedTool = { name: baseName, description: resource.description };
            tools.push({
              name: baseName,
              description: resource.description ?? `Read resource: ${resource.uri}`,
              isDirect,
              wasDirect: isDirect,
              estimatedTokens: estimateTokens(ct),
            });
          }
        }
      }

      const status = callbacks.getConnectionStatus(serverName);

      this.servers.push({
        name: serverName,
        expanded: false,
        source: prov?.kind ?? "user",
        importKind: prov?.importKind,
        connectionStatus: status,
        tools,
        hasCachedData: !!serverCache,
      });
    }

    this.rebuildVisibleItems();
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.done({ cancelled: true, directToolChanges: new Map(), serverChanges: new Map() });
    }, McpPanel.INACTIVITY_MS);
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  private rebuildVisibleItems(): void {
    const query = this.descSearchActive ? this.descQuery : this.nameQuery;
    const mode = this.descSearchActive ? "desc" : "name";

    this.visibleItems = [];
    for (let si = 0; si < this.servers.length; si++) {
      const server = this.servers[si];
      this.visibleItems.push({ type: "server", serverIndex: si });
      if (server.expanded || query) {
        for (let ti = 0; ti < server.tools.length; ti++) {
          const tool = server.tools[ti];
          if (query) {
            const score = mode === "name"
              ? Math.max(
                  fuzzyScore(query, tool.name),
                  fuzzyScore(query, server.name) * 0.6,
                )
              : fuzzyScore(query, tool.description);
            if (score === 0) continue;
          }
          this.visibleItems.push({ type: "tool", serverIndex: si, toolIndex: ti });
        }
      }
    }

    if (query) {
      this.visibleItems = this.visibleItems.filter((item) => {
        if (item.type === "server") {
          return this.visibleItems.some(
            (other) => other.type === "tool" && other.serverIndex === item.serverIndex,
          );
        }
        return true;
      });
    }
  }

  private updateDirty(): void {
    const directDirty = this.servers.some((s) => s.tools.some((t) => t.isDirect !== t.wasDirect));
    const serverDirty = this.serverChanges.size > 0;
    this.dirty = directDirty || serverDirty;
  }

  private buildResult(): McpPanelResult {
    const directToolChanges = new Map<string, true | string[] | false>();
    for (const server of this.servers) {
      const changed = server.tools.some((t) => t.isDirect !== t.wasDirect);
      if (!changed) continue;
      const directTools = server.tools.filter((t) => t.isDirect);
      if (directTools.length === server.tools.length && server.tools.length > 0) {
        directToolChanges.set(server.name, true);
      } else if (directTools.length === 0) {
        directToolChanges.set(server.name, false);
      } else {
        directToolChanges.set(server.name, directTools.map((t) => t.name));
      }
    }
    return {
      directToolChanges,
      serverChanges: new Map(this.serverChanges),
      cancelled: false,
    };
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();
    this.importNotice = null;

    if (this.confirmingDiscard) {
      this.handleDiscardInput(data);
      return;
    }

    if (this.confirmingDelete) {
      this.handleDeleteConfirmInput(data);
      return;
    }

    if (this.confirmingEditorDiscard) {
      this.handleEditorDiscardInput(data);
      return;
    }

    // Global shortcuts — always work, even during auth/token entry
    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, directToolChanges: new Map(), serverChanges: new Map() });
      return;
    }

    if (matchesKey(data, "ctrl+s")) {
      // If we're in the server JSON editor, try to apply changes first so they're included in the save.
      if (this.view === "server-editor") {
        const ok = this.applyServerEditorAndClose();
        if (!ok) return;
      }
      this.cleanup();
      this.done(this.buildResult());
      return;
    }

    // Server JSON editor view
    if (this.view === "server-editor") {
      this.handleServerEditorInput(data);
      return;
    }

    // OAuth setup view
    if (this.view === "auth") {
      this.handleAuthViewInput(data);
      return;
    }

    // If reconnect-all is running, ignore input (except ctrl+c/ctrl+s handled above)
    if (this.reconnectAllInProgress) {
      return;
    }

    // Modal description search mode
    if (this.descSearchActive) {
      if (matchesKey(data, "escape") || matchesKey(data, "return")) {
        this.descSearchActive = false;
        this.descQuery = "";
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      if (matchesKey(data, "backspace")) {
        if (this.descQuery.length > 0) {
          this.descQuery = this.descQuery.slice(0, -1);
          this.rebuildVisibleItems();
          this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        }
        return;
      }
      if (matchesKey(data, "up")) { this.moveCursor(-1); return; }
      if (matchesKey(data, "down")) { this.moveCursor(1); return; }
      if (matchesKey(data, "space")) {
        // Toggle even while in desc search
        const item = this.visibleItems[this.cursorIndex];
        if (item) this.toggleItem(item);
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.descQuery += data;
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      return;
    }

    // Name search mode (press / to enter)
    if (this.nameSearchActive) {
      if (matchesKey(data, "escape")) {
        this.nameSearchActive = false;
        this.nameQuery = "";
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      if (matchesKey(data, "return")) {
        // Lock query and return to normal navigation
        this.nameSearchActive = false;
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      if (matchesKey(data, "backspace")) {
        if (this.nameQuery.length > 0) {
          this.nameQuery = this.nameQuery.slice(0, -1);
          this.rebuildVisibleItems();
          this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        }
        return;
      }
      if (matchesKey(data, "up")) { this.moveCursor(-1); return; }
      if (matchesKey(data, "down")) { this.moveCursor(1); return; }
      if (matchesKey(data, "space")) {
        const item = this.visibleItems[this.cursorIndex];
        if (item) this.toggleItem(item);
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.nameQuery += data;
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      return;
    }

    // Enter name search
    if (data === "/") {
      this.nameSearchActive = true;
      this.tui.requestRender();
      return;
    }

    // Add / Edit / Delete server
    if (data === "n" || data === "N") {
      this.openServerEditorAdd();
      return;
    }
    if (data === "e" || data === "E") {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) {
        this.panelMessage = { kind: "error", text: "No server selected." };
        this.tui.requestRender();
        return;
      }
      this.openServerEditorEdit(item.serverIndex);
      return;
    }
    if (data === "d" || data === "D" || matchesKey(data, "delete")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) {
        this.panelMessage = { kind: "error", text: "No server selected." };
        this.tui.requestRender();
        return;
      }
      this.openDeleteConfirm(item.serverIndex);
      return;
    }

    // Reconnect all servers
    if (matchesKey(data, "ctrl+alt+r")) {
      this.reconnectAll();
      return;
    }

    // OAuth setup view for selected server
    if (matchesKey(data, "ctrl+a")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) {
        this.panelMessage = { kind: "error", text: "No server selected." };
        this.tui.requestRender();
        return;
      }
      // Open auth view even if the server is not OAuth-capable; the view will explain why.
      this.openAuthView(item.serverIndex);
      return;
    }

    if (matchesKey(data, "escape")) {
      // Clear locked name query first
      if (this.nameQuery) {
        this.nameQuery = "";
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      if (this.dirty) {
        this.confirmingDiscard = true;
        this.discardSelected = 1;
        return;
      }
      this.cleanup();
      this.done({ cancelled: true, directToolChanges: new Map(), serverChanges: new Map() });
      return;
    }

    if (matchesKey(data, "up")) { this.moveCursor(-1); return; }
    if (matchesKey(data, "down")) { this.moveCursor(1); return; }

    if (matchesKey(data, "space")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item) this.toggleItem(item);
      return;
    }

    if (matchesKey(data, "return")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      if (item.type === "server") {
        server.expanded = !server.expanded;
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      } else if (item.toolIndex !== undefined) {
        const tool = server.tools[item.toolIndex];
        tool.isDirect = !tool.isDirect;
        if (tool.isDirect && server.source === "import") {
          this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`;
        }
        this.updateDirty();
      }
      return;
    }

    if (matchesKey(data, "ctrl+r")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      void this.reconnectServer(server);
      return;
    }

    if (data === "?") {
      this.descSearchActive = true;
      this.descQuery = "";
      this.rebuildVisibleItems();
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      return;
    }

    // Backspace edits locked name query
    if (matchesKey(data, "backspace")) {
      if (this.nameQuery.length > 0) {
        this.nameQuery = this.nameQuery.slice(0, -1);
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      }
      return;
    }
  }

  private createServerEditorTheme(): EditorTheme {
    const t = this.t;
    return {
      borderColor: (s: string) => fg(t.border, s),
      selectList: {
        selectedPrefix: (s: string) => fg(t.selected, s),
        selectedText: (s: string) => fg(t.selected, s),
        description: (s: string) => fg(t.description, s),
        scrollInfo: (s: string) => fg(t.description, s),
        noMatch: (s: string) => fg(t.description, s),
      },
    };
  }

  private openServerEditorAdd(): void {
    this.serverEditorMode = "add";
    this.serverEditorTarget = null;
    this.serverEditorMessage = null;
    this.serverEditorInPaste = false;
    this.serverEditorPasteBuffer = "";
    this.confirmingEditorDiscard = false;
    this.editorDiscardSelected = 1;
    this.confirmingDelete = false;

    const template = JSON.stringify(
      {
        mcpServers: {
          "my-server": {
            command: "npx",
            args: ["-y", "some-mcp-server@latest"],
          },
        },
      },
      null,
      2,
    );

    const editor = new Editor(this.tui, this.createServerEditorTheme(), { paddingX: 0 });
    editor.disableSubmit = true;
    editor.setText(template);
    this.serverEditor = editor;
    this.serverEditorInitialText = template;
    this.view = "server-editor";
    this.tui.requestRender();
  }

  private openServerEditorEdit(serverIndex: number): void {
    const server = this.servers[serverIndex];
    if (!server) {
      this.panelMessage = { kind: "error", text: "No server selected." };
      this.tui.requestRender();
      return;
    }

    if (server.source === "project") {
      this.panelMessage = { kind: "error", text: "Editing project MCP servers is not supported yet (global-only)." };
      this.tui.requestRender();
      return;
    }

    const staged = this.serverChanges.get(server.name);
    const definition = staged === undefined ? this.config.mcpServers?.[server.name] : staged;
    if (!definition) {
      this.panelMessage = { kind: "error", text: `Server \"${server.name}\" not found in config.` };
      this.tui.requestRender();
      return;
    }

    this.serverEditorMode = "edit";
    this.serverEditorTarget = server.name;
    this.serverEditorInPaste = false;
    this.serverEditorPasteBuffer = "";
    this.confirmingEditorDiscard = false;
    this.editorDiscardSelected = 1;
    this.confirmingDelete = false;

    this.serverEditorMessage =
      server.source === "import"
        ? { kind: "info", text: `Imported from ${server.importKind ?? "external"} — will copy to user config on save.` }
        : null;

    const template = JSON.stringify(definition, null, 2);

    const editor = new Editor(this.tui, this.createServerEditorTheme(), { paddingX: 0 });
    editor.disableSubmit = true;
    editor.setText(template);
    this.serverEditor = editor;
    this.serverEditorInitialText = template;
    this.view = "server-editor";
    this.tui.requestRender();
  }

  private closeServerEditor(): void {
    this.view = "main";
    this.serverEditor = null;
    this.serverEditorTarget = null;
    this.serverEditorInitialText = "";
    this.serverEditorMessage = null;
    this.serverEditorInPaste = false;
    this.serverEditorPasteBuffer = "";
    this.confirmingEditorDiscard = false;
    this.editorDiscardSelected = 1;
    this.tui.requestRender();
  }

  private handleServerEditorInput(data: string): void {
    const editor = this.serverEditor;
    if (!editor) {
      // Shouldn't happen, but don't crash the panel
      if (matchesKey(data, "escape")) this.view = "main";
      return;
    }

    // Esc: go back (with confirm if dirty)
    if (matchesKey(data, "escape")) {
      const isDirty = editor.getText() !== this.serverEditorInitialText;
      if (isDirty) {
        this.confirmingEditorDiscard = true;
        this.editorDiscardSelected = 1;
      } else {
        this.closeServerEditor();
      }
      return;
    }

    // Enter: apply (we keep submit disabled so Editor doesn't clear the buffer)
    if (matchesKey(data, "return")) {
      this.applyServerEditorAndClose();
      return;
    }

    // Handle bracketed paste mode ourselves so large pastes don't get collapsed into [paste #...] markers
    if (data.includes("\x1b[200~")) {
      this.serverEditorInPaste = true;
      this.serverEditorPasteBuffer = "";
      data = data.replace("\x1b[200~", "");
    }
    if (this.serverEditorInPaste) {
      this.serverEditorPasteBuffer += data;
      const endIndex = this.serverEditorPasteBuffer.indexOf("\x1b[201~");
      if (endIndex !== -1) {
        const pasteContent = this.serverEditorPasteBuffer.substring(0, endIndex);
        if (pasteContent.length > 0) {
          editor.insertTextAtCursor(pasteContent);
        }
        this.serverEditorInPaste = false;
        const remaining = this.serverEditorPasteBuffer.substring(endIndex + 6);
        this.serverEditorPasteBuffer = "";
        if (remaining.length > 0) {
          this.handleServerEditorInput(remaining);
        }
      }
      this.tui.requestRender();
      return;
    }

    editor.handleInput(data);
  }

  private handleEditorDiscardInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, directToolChanges: new Map(), serverChanges: new Map() });
      return;
    }
    if (matchesKey(data, "escape") || data === "n" || data === "N") {
      this.confirmingEditorDiscard = false;
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.editorDiscardSelected = this.editorDiscardSelected === 0 ? 1 : 0;
      return;
    }
    if (matchesKey(data, "return")) {
      if (this.editorDiscardSelected === 0) {
        // Discard editor buffer and return to main view
        this.closeServerEditor();
      } else {
        // Keep editing
        this.confirmingEditorDiscard = false;
      }
      return;
    }
    if (data === "y" || data === "Y") {
      this.closeServerEditor();
      return;
    }
  }

  private parseServersJson(text: string): { servers: Record<string, ServerEntry> } | { error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Expected a JSON object." };
    }
    const root = parsed as Record<string, unknown>;

    const serversRaw = (root.mcpServers ?? root["mcp-servers"] ?? root) as unknown;
    if (!serversRaw || typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
      return { error: "Expected an object of servers (e.g. {\"mcpServers\": { \"name\": { ... } } })." };
    }

    // If the user pasted only a single ServerEntry object, prompt them to include the server name key.
    const maybeEntry = serversRaw as Record<string, unknown>;
    if (typeof maybeEntry.command === "string" || typeof maybeEntry.url === "string") {
      return { error: "Missing server name. Wrap it like {\"mcpServers\": { \"my-server\": { ... } } }." };
    }

    const servers: Record<string, ServerEntry> = {};
    for (const [name, def] of Object.entries(serversRaw as Record<string, unknown>)) {
      if (!name || typeof name !== "string") {
        return { error: "Server name must be a string." };
      }
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        return { error: `Server \"${name}\" must be an object.` };
      }
      const entry = def as ServerEntry;
      if (entry.command && entry.url) {
        return { error: `Server \"${name}\" must have either \"command\" or \"url\", not both.` };
      }
      if (!entry.command && !entry.url) {
        return { error: `Server \"${name}\" must have either \"command\" (stdio) or \"url\" (HTTP).` };
      }
      servers[name] = entry;
    }

    if (Object.keys(servers).length === 0) {
      return { error: "No servers found." };
    }
    return { servers };
  }

  private applyServerEditorAndClose(): boolean {
    const editor = this.serverEditor;
    if (!editor) return true;

    const text = editor.getText();

    // Edit mode supports two formats:
    // 1) Raw ServerEntry JSON (most convenient)
    // 2) Wrapper JSON containing mcpServers / mcp-servers
    if (this.serverEditorMode === "edit") {
      const target = this.serverEditorTarget;
      if (!target) {
        this.serverEditorMessage = { kind: "error", text: "No edit target server." };
        this.tui.requestRender();
        return false;
      }

      let root: unknown;
      try {
        root = JSON.parse(text);
      } catch (e) {
        this.serverEditorMessage = { kind: "error", text: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
        this.tui.requestRender();
        return false;
      }

      if (root && typeof root === "object" && !Array.isArray(root)) {
        const obj = root as Record<string, unknown>;
        const hasWrapper = typeof obj.mcpServers === "object" || typeof obj["mcp-servers"] === "object";
        const looksLikeEntry = typeof (obj as Record<string, unknown>).command === "string" || typeof (obj as Record<string, unknown>).url === "string";
        if (!hasWrapper && looksLikeEntry) {
          const entry = root as ServerEntry;
          if (entry.command && entry.url) {
            this.serverEditorMessage = { kind: "error", text: "Server entry must have either \"command\" or \"url\", not both." };
            this.tui.requestRender();
            return false;
          }
          if (!entry.command && !entry.url) {
            this.serverEditorMessage = { kind: "error", text: "Server entry must have either \"command\" (stdio) or \"url\" (HTTP)." };
            this.tui.requestRender();
            return false;
          }
          this.serverChanges.set(target, entry);
          this.updateDirty();
          this.panelMessage = { kind: "info", text: `Staged ${target}. Press ctrl+s to save.` };
          this.serverEditorMessage = null;
          this.closeServerEditor();
          return true;
        }
      }
      // Otherwise fall through to wrapper parsing below.
    }

    const parsed = this.parseServersJson(text);
    if ("error" in parsed) {
      this.serverEditorMessage = { kind: "error", text: parsed.error };
      this.tui.requestRender();
      return false;
    }

    const servers = parsed.servers;
    const names = Object.keys(servers);

    if (this.serverEditorMode === "edit") {
      const target = this.serverEditorTarget;
      if (!target) {
        this.serverEditorMessage = { kind: "error", text: "No edit target server." };
        this.tui.requestRender();
        return false;
      }
      if (names.length !== 1 || names[0] !== target) {
        this.serverEditorMessage = {
          kind: "error",
          text: `Edit mode expects exactly one server named \"${target}\".`,
        };
        this.tui.requestRender();
        return false;
      }
    }

    // Stage changes and update list UI
    for (const [name, def] of Object.entries(servers)) {
      const existing = this.servers.find((s) => s.name === name);
      if (!existing) {
        this.servers.push({
          name,
          expanded: false,
          source: "user",
          connectionStatus: "idle",
          tools: [],
          hasCachedData: false,
        });
      }
      this.serverChanges.set(name, def);
    }

    this.updateDirty();
    this.rebuildVisibleItems();
    this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));

    const suffix = names.length === 1 ? "server" : "servers";
    this.panelMessage = { kind: "info", text: `Staged ${names.length} ${suffix}. Press ctrl+s to save.` };
    this.serverEditorMessage = null;
    this.closeServerEditor();
    return true;
  }

  private openDeleteConfirm(serverIndex: number): void {
    const server = this.servers[serverIndex];
    if (!server) {
      this.panelMessage = { kind: "error", text: "No server selected." };
      this.tui.requestRender();
      return;
    }
    if (server.source !== "user") {
      this.panelMessage = { kind: "error", text: `Delete not supported for ${server.source} servers yet.` };
      this.tui.requestRender();
      return;
    }

    this.confirmingDelete = true;
    this.deleteServerIndex = serverIndex;
    this.deleteSelected = 1;
    this.tui.requestRender();
  }

  private handleDeleteConfirmInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, directToolChanges: new Map(), serverChanges: new Map() });
      return;
    }
    if (matchesKey(data, "escape") || data === "n" || data === "N") {
      this.confirmingDelete = false;
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.deleteSelected = this.deleteSelected === 0 ? 1 : 0;
      return;
    }
    if (matchesKey(data, "return")) {
      if (this.deleteSelected === 0) {
        const idx = this.deleteServerIndex;
        const server = typeof idx === "number" ? this.servers[idx] : undefined;
        if (server) {
          const name = server.name;
          // If it was newly added in this session, just drop it
          if (!this.config.mcpServers?.[name] && this.serverChanges.has(name)) {
            this.serverChanges.delete(name);
          } else {
            this.serverChanges.set(name, null);
          }
          this.servers = this.servers.filter((s) => s.name !== name);
          this.rebuildVisibleItems();
          this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
          this.updateDirty();
          this.panelMessage = { kind: "info", text: `Deleted ${name} (staged). Press ctrl+s to save.` };
        }
      }
      this.confirmingDelete = false;
      this.deleteServerIndex = null;
      return;
    }
    if (data === "y" || data === "Y") {
      // Confirm delete via single-key shortcut
      this.deleteSelected = 0;
      const idx = this.deleteServerIndex;
      const server = typeof idx === "number" ? this.servers[idx] : undefined;
      if (server) {
        const name = server.name;
        if (!this.config.mcpServers?.[name] && this.serverChanges.has(name)) {
          this.serverChanges.delete(name);
        } else {
          this.serverChanges.set(name, null);
        }
        this.servers = this.servers.filter((s) => s.name !== name);
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        this.updateDirty();
        this.panelMessage = { kind: "info", text: `Deleted ${name} (staged). Press ctrl+s to save.` };
      }
      this.confirmingDelete = false;
      this.deleteServerIndex = null;
      return;
    }
  }

  private isOAuthServer(serverName: string): boolean {
    return this.config.mcpServers?.[serverName]?.auth === "oauth";
  }

  private getAuthTokenDisplayPath(serverName: string): string {
    return `~/.pi/agent/mcp-oauth/${serverName}/tokens.json`;
  }

  private getAuthTokenFsPath(serverName: string): string {
    return join(homedir(), ".pi", "agent", "mcp-oauth", serverName, "tokens.json");
  }

  private writeAuthToken(serverName: string, accessToken: string): void {
    const tokensPath = this.getAuthTokenFsPath(serverName);
    mkdirSync(dirname(tokensPath), { recursive: true });
    const data = { access_token: accessToken, token_type: "bearer" };
    writeFileSync(tokensPath, JSON.stringify(data, null, 2), "utf-8");
  }

  private openAuthView(serverIndex: number): void {
    this.view = "auth";
    this.authServerIndex = serverIndex;
    this.authEnteringToken = false;
    this.authTokenInput = "";
    this.authMessage = null;
    this.tui.requestRender();
  }

  private closeAuthView(): void {
    this.view = "main";
    this.authServerIndex = null;
    this.authEnteringToken = false;
    this.authTokenInput = "";
    this.authMessage = null;
    this.tui.requestRender();
  }

  private handleAuthViewInput(data: string): void {
    const serverIndex = this.authServerIndex;
    const server = typeof serverIndex === "number" ? this.servers[serverIndex] : undefined;
    if (!server) {
      this.closeAuthView();
      return;
    }

    const definition = this.config.mcpServers?.[server.name];
    const oauthReady = definition?.auth === "oauth" && !!definition.url;

    // Close view
    if (!this.authEnteringToken && matchesKey(data, "escape")) {
      this.closeAuthView();
      return;
    }

    // Reconnect server
    if (!this.authEnteringToken && matchesKey(data, "ctrl+r")) {
      void this.reconnectServer(server);
      return;
    }

    // Start entering token
    if (!this.authEnteringToken && (data === "t" || data === "T")) {
      if (!definition) {
        this.authMessage = { kind: "error", text: `Server "${server.name}" not found in config.` };
        this.tui.requestRender();
        return;
      }
      if (definition.auth !== "oauth") {
        this.authMessage = { kind: "error", text: `Server "${server.name}" is not configured for OAuth (auth=${definition.auth ?? "none"}).` };
        this.tui.requestRender();
        return;
      }
      if (!oauthReady) {
        this.authMessage = { kind: "error", text: `Server "${server.name}" has no URL configured (OAuth requires HTTP transport).` };
        this.tui.requestRender();
        return;
      }
      this.authEnteringToken = true;
      this.authTokenInput = "";
      this.authMessage = null;
      this.tui.requestRender();
      return;
    }

    if (!this.authEnteringToken) {
      return;
    }

    // Token entry mode
    if (matchesKey(data, "escape")) {
      this.authEnteringToken = false;
      this.authTokenInput = "";
      this.authMessage = null;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.authTokenInput.length > 0) {
        this.authTokenInput = this.authTokenInput.slice(0, -1);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "return")) {
      const token = this.authTokenInput.trim();
      if (!token) {
        this.authMessage = { kind: "error", text: "Access token is empty." };
        this.tui.requestRender();
        return;
      }

      this.authEnteringToken = false;
      this.authTokenInput = "";
      this.authMessage = { kind: "info", text: "Token saved. Connecting..." };
      this.tui.requestRender();

      (async () => {
        try {
          this.writeAuthToken(server.name, token);
        } catch (e) {
          this.authMessage = {
            kind: "error",
            text: `Failed to write tokens.json: ${e instanceof Error ? e.message : String(e)}`,
          };
          this.tui.requestRender();
          return;
        }

        await this.reconnectServer(server);

        if (server.connectionStatus === "connected") {
          this.authMessage = { kind: "info", text: "Connected." };
        } else if (server.connectionStatus === "needs-auth") {
          this.authMessage = { kind: "error", text: "Still needs OAuth token." };
        } else if (server.connectionStatus === "failed") {
          this.authMessage = { kind: "error", text: "Connection failed. Check token and server configuration." };
        } else {
          this.authMessage = { kind: "info", text: "Done." };
        }
        this.tui.requestRender();
      })().catch(() => {});
      return;
    }

    // Ignore navigation keys while entering token
    if (
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right") ||
      matchesKey(data, "tab")
    ) {
      return;
    }

    // Accept pasted chunks (strip bracketed paste wrappers if present)
    let chunk = data;
    chunk = chunk.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
    for (const ch of chunk) {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code !== 127) {
        this.authTokenInput += ch;
      }
    }
    this.tui.requestRender();
  }

  private async reconnectServer(server: ServerState): Promise<void> {
    if (server.connectionStatus === "connecting") return;

    if (this.serverChanges.has(server.name)) {
      this.panelMessage = {
        kind: "error",
        text: `Server "${server.name}" has unsaved config changes. Press ctrl+s to save, then reconnect.`,
      };
      this.tui.requestRender();
      return;
    }

    server.connectionStatus = "connecting";
    this.panelMessage = { kind: "info", text: `Reconnecting ${server.name}...` };
    this.tui.requestRender();

    let ok = false;
    let crash: string | null = null;

    try {
      ok = await this.callbacks.reconnect(server.name);
    } catch (err) {
      crash = err instanceof Error ? err.message : String(err);
    }

    try {
      if (crash) {
        server.connectionStatus = "failed";
        this.panelMessage = { kind: "error", text: `Reconnect crashed for ${server.name}: ${crash}` };
        return;
      }

      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);

      if (server.connectionStatus === "connected") {
        const entry = this.callbacks.refreshCacheAfterReconnect(server.name);
        if (entry) {
          this.rebuildServerTools(server, entry);
        }
        server.hasCachedData = true;
        this.panelMessage = { kind: "info", text: `Reconnected ${server.name}.` };
      } else if (server.connectionStatus === "needs-auth") {
        this.panelMessage = { kind: "error", text: `Server "${server.name}" needs OAuth token (ctrl+a).` };
      } else if (!ok) {
        this.panelMessage = { kind: "error", text: `Failed to reconnect ${server.name}.` };
      } else {
        this.panelMessage = { kind: "error", text: `Reconnect finished but status is ${server.connectionStatus}.` };
      }
    } finally {
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      this.tui.requestRender();
    }
  }

  private reconnectAll(): void {
    if (this.reconnectAllInProgress) return;

    this.reconnectAllInProgress = true;
    this.panelMessage = { kind: "info", text: "Reconnecting all servers..." };
    this.tui.requestRender();

    (async () => {
      for (const server of this.servers) {
        await this.reconnectServer(server);
      }
    })().finally(() => {
      this.reconnectAllInProgress = false;
      this.panelMessage = { kind: "info", text: "Reconnect all finished." };
      this.tui.requestRender();
    });
  }


  private toggleItem(item: VisibleItem): void {
    const server = this.servers[item.serverIndex];
    if (item.type === "server") {
      const newState = !server.tools.every((t) => t.isDirect);
      if (server.source === "import" && newState) {
        this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`;
      }
      for (const t of server.tools) t.isDirect = newState;
    } else if (item.toolIndex !== undefined) {
      const tool = server.tools[item.toolIndex];
      tool.isDirect = !tool.isDirect;
      if (tool.isDirect && server.source === "import") {
        this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`;
      }
    }
    this.updateDirty();
  }

  private handleDiscardInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, directToolChanges: new Map(), serverChanges: new Map() });
      return;
    }
    if (matchesKey(data, "escape") || data === "n" || data === "N") {
      this.confirmingDiscard = false;
      return;
    }
    if (matchesKey(data, "return")) {
      if (this.discardSelected === 0) {
        this.cleanup();
        this.done({ cancelled: true, directToolChanges: new Map(), serverChanges: new Map() });
      } else {
        this.confirmingDiscard = false;
      }
      return;
    }
    if (data === "y" || data === "Y") {
      this.cleanup();
      this.done({ cancelled: true, directToolChanges: new Map(), serverChanges: new Map() });
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.discardSelected = this.discardSelected === 0 ? 1 : 0;
    }
  }

  private moveCursor(delta: number): void {
    if (this.visibleItems.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(this.visibleItems.length - 1, this.cursorIndex + delta));
  }

  private rebuildServerTools(server: ServerState, entry: ServerCacheEntry): void {
    const existingState = new Map<string, boolean>();
    for (const t of server.tools) existingState.set(t.name, t.isDirect);

    const newTools: ToolState[] = [];
    for (const tool of entry.tools ?? []) {
      const prev = existingState.get(tool.name);
      const isDirect = prev !== undefined ? prev : false;
      newTools.push({
        name: tool.name,
        description: tool.description ?? "",
        isDirect,
        wasDirect: prev !== undefined ? server.tools.find((t) => t.name === tool.name)?.wasDirect ?? false : false,
        estimatedTokens: estimateTokens(tool),
      });
    }

    for (const resource of entry.resources ?? []) {
      const baseName = `get_${resourceNameToToolName(resource.name)}`;
      const prev = existingState.get(baseName);
      const isDirect = prev !== undefined ? prev : false;
      const ct: CachedTool = { name: baseName, description: resource.description };
      newTools.push({
        name: baseName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        isDirect,
        wasDirect: prev !== undefined ? server.tools.find((t) => t.name === baseName)?.wasDirect ?? false : false,
        estimatedTokens: estimateTokens(ct),
      });
    }

    server.tools = newTools;
    this.rebuildVisibleItems();
    this.updateDirty();
  }

  render(width: number): string[] {
    const innerW = width - 2;
    const lines: string[] = [];
    const t = this.t;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
    const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

    const row = (content: string) =>
      fg(t.border, "│") + truncateToWidth(" " + content, innerW, "…", true) + fg(t.border, "│");
    const emptyRow = () => fg(t.border, "│") + " ".repeat(innerW) + fg(t.border, "│");
    const divider = () => fg(t.border, "├" + "─".repeat(innerW) + "┤");

    const rowRaw = (content: string) => {
      const pad = Math.max(0, innerW - visibleWidth(content));
      return fg(t.border, "│") + content + " ".repeat(pad) + fg(t.border, "│");
    };

    if (this.view === "server-editor") {
      const titleText = " MCP Server JSON ";
      const borderLen = innerW - visibleWidth(titleText);
      const leftB = Math.floor(borderLen / 2);
      const rightB = borderLen - leftB;
      lines.push(
        fg(t.border, "╭" + "─".repeat(leftB)) + fg(t.title, titleText) + fg(t.border, "─".repeat(rightB) + "╮"),
      );

      lines.push(emptyRow());

      const modeLabel = this.serverEditorMode === "add" ? "Add" : "Edit";
      lines.push(row(fg(t.description, "Mode: ") + fg(t.selected, modeLabel)));
      if (this.serverEditorMode === "edit" && this.serverEditorTarget) {
        lines.push(row(fg(t.description, "Server: ") + fg(t.selected, this.serverEditorTarget)));
      }
      lines.push(emptyRow());

      if (!this.serverEditor) {
        lines.push(row(fg(t.cancel, "Editor not initialized.")));
      } else {
        const editorLines = this.serverEditor.render(innerW);
        for (const l of editorLines) {
          lines.push(rowRaw(l));
        }
      }

      if (this.serverEditorMessage) {
        lines.push(emptyRow());
        const msgColor = this.serverEditorMessage.kind === "error" ? t.cancel : t.confirm;
        lines.push(row(fg(msgColor, this.serverEditorMessage.text)));
      }

      lines.push(divider());
      lines.push(emptyRow());

      if (this.confirmingEditorDiscard) {
        const discardBtn = this.editorDiscardSelected === 0
          ? inverse(bold(fg(t.cancel, "  Discard  ")))
          : fg(t.hint, "  Discard  ");
        const keepBtn = this.editorDiscardSelected === 1
          ? inverse(bold(fg(t.confirm, "  Keep  ")))
          : fg(t.hint, "  Keep  ");
        lines.push(row(`Discard editor changes?  ${discardBtn}   ${keepBtn}`));
      } else {
        lines.push(row(fg(t.description, "Press Enter to apply JSON and return. Use Shift+Enter for a newline.")));
      }

      lines.push(emptyRow());
      const hints = [
        italic("enter") + " apply",
        italic("shift+enter") + " newline",
        italic("esc") + " back",
        italic("ctrl+s") + " save",
        italic("ctrl+c") + " quit",
      ];
      const gap = "  ";
      const gapW = 2;
      const maxW = innerW - 2;
      let curLine = "";
      let curW = 0;
      for (const hint of hints) {
        const hw = visibleWidth(hint);
        const needed = curW === 0 ? hw : gapW + hw;
        if (curW > 0 && curW + needed > maxW) {
          lines.push(row(fg(t.hint, curLine)));
          curLine = hint;
          curW = hw;
        } else {
          curLine += (curW > 0 ? gap : "") + hint;
          curW += needed;
        }
      }
      if (curLine) lines.push(row(fg(t.hint, curLine)));

      lines.push(fg(t.border, "╰" + "─".repeat(innerW) + "╯"));
      return lines;
    }


    if (this.view === "auth") {
      const serverIndex = this.authServerIndex;
      const server = typeof serverIndex === "number" ? this.servers[serverIndex] : undefined;
      const serverName = server?.name ?? "(unknown)";
      const definition = server ? this.config.mcpServers[serverName] : undefined;
      const oauthReady = definition?.auth === "oauth" && !!definition.url;

      const titleText = " Auth Setup ";
      const borderLen = innerW - visibleWidth(titleText);
      const leftB = Math.floor(borderLen / 2);
      const rightB = borderLen - leftB;
      lines.push(fg(t.border, "╭" + "─".repeat(leftB)) + fg(t.title, titleText) + fg(t.border, "─".repeat(rightB) + "╮"));

      lines.push(emptyRow());
      lines.push(row(fg(t.description, "Server: ") + fg(t.selected, serverName)));
      if (definition?.url) {
        lines.push(row(fg(t.description, "URL: ") + fg(t.description, definition.url)));
      }
      if (server) {
        const statusColor =
          server.connectionStatus === "connected" ? t.direct :
          server.connectionStatus === "failed" ? t.cancel :
          server.connectionStatus === "needs-auth" ? t.needsAuth :
          server.connectionStatus === "connecting" ? t.needsAuth :
          t.description;
        lines.push(row(fg(t.description, "Status: ") + fg(statusColor, server.connectionStatus)));
      }
      lines.push(emptyRow());

      if (!server) {
        lines.push(row(fg(t.cancel, "No server selected.")));
      } else if (!definition) {
        lines.push(row(fg(t.cancel, `Server "${serverName}" not found in config.`)));
      } else if (definition.auth !== "oauth") {
        const authMode = definition.auth ?? "none";
        lines.push(row(fg(t.cancel, `OAuth not enabled for "${serverName}" (auth=${authMode}).`)));
        if (authMode === "bearer") {
          lines.push(row(fg(t.description, "Bearer tokens are configured in mcp.json (bearerToken/bearerTokenEnv).")));
        } else if (definition.command) {
          lines.push(row(fg(t.description, "This is a command/stdio server; no OAuth token is used.")));
        } else {
          lines.push(row(fg(t.description, "OAuth setup is only for HTTP servers configured with url + auth:\"oauth\".")));
        }
      } else if (!definition.url) {
        lines.push(row(fg(t.cancel, `Server "${serverName}" has no URL configured (OAuth requires HTTP transport).`)));
        lines.push(row(fg(t.description, `Add a \"url\" field for "${serverName}" in mcp.json.`)));
      } else {
        lines.push(row(fg(t.description, "Token file: ") + this.getAuthTokenDisplayPath(serverName)));
        lines.push(emptyRow());

        if (this.authEnteringToken) {
          lines.push(row(fg(t.needsAuth, "Paste access_token (hidden). Press ⏎ to save, Esc to cancel.")));
          lines.push(row(fg(t.description, `Token length: ${this.authTokenInput.length} chars`)));
        } else {
          lines.push(row(`Press ${fg(t.selected, "t")} to paste/set an access token (hidden).`));
          lines.push(row(`Or create the file manually, then press ${fg(t.selected, "ctrl+r")} to connect.`));
          lines.push(emptyRow());
          lines.push(row(fg(t.description, "{")));
          lines.push(row(fg(t.description, '  "access_token": "your-token-here",')));
          lines.push(row(fg(t.description, '  "token_type": "bearer"')));
          lines.push(row(fg(t.description, "}")));
        }
      }

      if (this.authMessage) {
        lines.push(emptyRow());
        const msgColor = this.authMessage.kind === "error" ? t.cancel : t.confirm;
        lines.push(row(fg(msgColor, this.authMessage.text)));
      }

      lines.push(emptyRow());
      lines.push(divider());
      lines.push(emptyRow());

      const hints = this.authEnteringToken
        ? [
            italic("⏎") + " save token",
            italic("backspace") + " delete",
            italic("esc") + " cancel",
            italic("ctrl+c") + " quit",
          ]
        : oauthReady
          ? [
              italic("t") + " set token",
              italic("ctrl+r") + " reconnect",
              italic("esc") + " back",
              italic("ctrl+c") + " quit",
            ]
          : [
              italic("ctrl+r") + " reconnect",
              italic("esc") + " back",
              italic("ctrl+c") + " quit",
            ];

      const gap = "  ";
      const gapW = 2;
      const maxW = innerW - 2;
      let curLine = "";
      let curW = 0;
      for (const hint of hints) {
        const hw = visibleWidth(hint);
        const needed = curW === 0 ? hw : gapW + hw;
        if (curW > 0 && curW + needed > maxW) {
          lines.push(row(fg(t.hint, curLine)));
          curLine = hint;
          curW = hw;
        } else {
          curLine += (curW > 0 ? gap : "") + hint;
          curW += needed;
        }
      }
      if (curLine) lines.push(row(fg(t.hint, curLine)));

      lines.push(fg(t.border, "╰" + "─".repeat(innerW) + "╯"));
      return lines;
    }


    const titleText = " MCP Servers ";
    const borderLen = innerW - visibleWidth(titleText);
    const leftB = Math.floor(borderLen / 2);
    const rightB = borderLen - leftB;
    lines.push(fg(t.border, "╭" + "─".repeat(leftB)) + fg(t.title, titleText) + fg(t.border, "─".repeat(rightB) + "╮"));

    lines.push(emptyRow());

    const cursor = fg(t.selected, "│");
    const searchIcon = fg(t.border, "◎");
    if (this.descSearchActive) {
      lines.push(row(`${searchIcon}  ${fg(t.needsAuth, "desc:")} ${this.descQuery}${cursor}`));
    } else if (this.nameSearchActive) {
      lines.push(row(`${searchIcon}  ${fg(t.needsAuth, "name:")} ${this.nameQuery}${cursor}`));
    } else if (this.nameQuery) {
      lines.push(row(`${searchIcon}  ${fg(t.needsAuth, "name:")} ${this.nameQuery}${fg(t.description, "  (/ to edit)")}`));
    } else {
      lines.push(row(`${searchIcon}  ${fg(t.placeholder, italic("press / to search..."))}`));
    }

    lines.push(emptyRow());
    lines.push(divider());

    if (this.servers.length === 0) {
      lines.push(emptyRow());
      lines.push(row(fg(t.hint, italic("No MCP servers configured."))));
      lines.push(emptyRow());
    } else {
      const maxVis = McpPanel.MAX_VISIBLE;
      const total = this.visibleItems.length;
      const startIdx = Math.max(0, Math.min(this.cursorIndex - Math.floor(maxVis / 2), total - maxVis));
      const endIdx = Math.min(startIdx + maxVis, total);

      lines.push(emptyRow());

      for (let i = startIdx; i < endIdx; i++) {
        const item = this.visibleItems[i];
        const isCursor = i === this.cursorIndex;
        const server = this.servers[item.serverIndex];

        if (item.type === "server") {
          lines.push(row(this.renderServerRow(server, isCursor)));
        } else if (item.toolIndex !== undefined) {
          lines.push(row(this.renderToolRow(server.tools[item.toolIndex], isCursor, innerW)));
        }
      }

      lines.push(emptyRow());

      if (total > maxVis) {
        const prog = Math.round(((this.cursorIndex + 1) / total) * 10);
        lines.push(row(`${rainbowProgress(prog, 10)}  ${fg(t.hint, `${this.cursorIndex + 1}/${total}`)}`));
        lines.push(emptyRow());
      }

      if (this.importNotice) {
        lines.push(row(fg(t.needsAuth, italic(this.importNotice))));
        lines.push(emptyRow());
      }

      if (this.panelMessage) {
        const msgColor = this.panelMessage.kind === "error" ? t.cancel : t.confirm;
        lines.push(row(fg(msgColor, this.panelMessage.text)));
        lines.push(emptyRow());
      }
    }

    lines.push(divider());
    lines.push(emptyRow());

    if (this.confirmingDelete) {
      const idx = this.deleteServerIndex;
      const serverName = typeof idx === "number" ? (this.servers[idx]?.name ?? "(unknown)") : "(unknown)";
      const deleteBtn = this.deleteSelected === 0
        ? inverse(bold(fg(t.cancel, "  Delete  ")))
        : fg(t.hint, "  Delete  ");
      const cancelBtn = this.deleteSelected === 1
        ? inverse(bold(fg(t.confirm, "  Cancel  ")))
        : fg(t.hint, "  Cancel  ");
      lines.push(row(`Delete server ${fg(t.selected, serverName)}?  ${deleteBtn}   ${cancelBtn}`));
    } else if (this.confirmingDiscard) {
      const discardBtn = this.discardSelected === 0
        ? inverse(bold(fg(t.cancel, "  Discard  ")))
        : fg(t.hint, "  Discard  ");
      const keepBtn = this.discardSelected === 1
        ? inverse(bold(fg(t.confirm, "  Keep  ")))
        : fg(t.hint, "  Keep  ");
      lines.push(row(`Discard unsaved changes?  ${discardBtn}   ${keepBtn}`));
    } else {
      const directCount = this.servers.reduce((sum, s) => sum + s.tools.filter((t) => t.isDirect).length, 0);
      const totalTokens = this.servers.reduce(
        (sum, s) => sum + s.tools.filter((t) => t.isDirect).reduce((ts, t) => ts + t.estimatedTokens, 0),
        0,
      );
      const serverOps = this.serverChanges.size;
      let stats = directCount > 0 ? `${directCount} direct  ~${totalTokens.toLocaleString()} tokens` : "no direct tools";
      if (serverOps > 0) {
        stats += fg(t.needsAuth, `  ${serverOps} server change${serverOps === 1 ? "" : "s"}`);
      }
      lines.push(row(fg(t.description, stats + (this.dirty ? fg(t.needsAuth, "  (unsaved)") : ""))));
    }

    lines.push(emptyRow());
    const hints = [
      italic("↑↓") + " navigate",
      italic("space") + " toggle",
      italic("⏎") + " expand",
      italic("n") + " new",
      italic("e") + " edit",
      italic("d") + " delete",
      italic("/") + " search",
      italic("ctrl+r") + " reconnect",
      italic("ctrl+alt+r") + " reconnect all",
      italic("ctrl+a") + " auth",
      italic("?") + " desc search",
      italic("ctrl+s") + " save",
      italic("esc") + " clear/close",
      italic("ctrl+c") + " quit",
    ];
    const gap = "  ";
    const gapW = 2;
    const maxW = innerW - 2;
    let curLine = "";
    let curW = 0;
    for (const hint of hints) {
      const hw = visibleWidth(hint);
      const needed = curW === 0 ? hw : gapW + hw;
      if (curW > 0 && curW + needed > maxW) {
        lines.push(row(fg(t.hint, curLine)));
        curLine = hint;
        curW = hw;
      } else {
        curLine += (curW > 0 ? gap : "") + hint;
        curW += needed;
      }
    }
    if (curLine) lines.push(row(fg(t.hint, curLine)));

    lines.push(fg(t.border, "╰" + "─".repeat(innerW) + "╯"));

    return lines;
  }

  private renderServerRow(server: ServerState, isCursor: boolean): string {
    const t = this.t;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

    const expandIcon = server.expanded ? "▾" : "▸";
    const prefix = isCursor ? fg(t.selected, expandIcon) : fg(t.border, server.expanded ? expandIcon : "·");

    const nameStr = isCursor ? bold(fg(t.selected, server.name)) : server.name;
    const importLabel = server.source === "import" ? fg(t.description, ` (${server.importKind ?? "import"})`) : "";

    let statusIcon = fg(t.description, "○");
    if (server.connectionStatus === "connected") statusIcon = fg(t.direct, "✓");
    else if (server.connectionStatus === "failed") statusIcon = fg(t.cancel, "✗");
    else if (server.connectionStatus === "needs-auth") statusIcon = fg(t.needsAuth, "⚠");
    else if (server.connectionStatus === "connecting") statusIcon = fg(t.needsAuth, "…");

    if (!server.hasCachedData) {
      return `${prefix} ${statusIcon}  ${nameStr}${importLabel}  ${fg(t.description, "(not cached)")}`;
    }

    const directCount = server.tools.filter((t) => t.isDirect).length;
    const totalCount = server.tools.length;
    let toggleIcon = fg(t.description, "○");
    if (directCount === totalCount && totalCount > 0) {
      toggleIcon = fg(t.direct, "●");
    } else if (directCount > 0) {
      toggleIcon = fg(t.needsAuth, "◐");
    }

    let toolInfo = "";
    if (totalCount > 0) {
      toolInfo = `${directCount}/${totalCount}`;
      if (directCount > 0) {
        const tokens = server.tools.filter((t) => t.isDirect).reduce((s, t) => s + t.estimatedTokens, 0);
        toolInfo += `  ~${tokens.toLocaleString()}`;
      }
      toolInfo = fg(t.description, toolInfo);
    }

    return `${prefix} ${statusIcon} ${toggleIcon} ${nameStr}${importLabel}  ${toolInfo}`;
  }

  private renderToolRow(tool: ToolState, isCursor: boolean, innerW: number): string {
    const t = this.t;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

    const toggleIcon = tool.isDirect ? fg(t.direct, "●") : fg(t.description, "○");
    const cursor = isCursor ? fg(t.selected, "▸") : " ";
    const nameStr = isCursor ? bold(fg(t.selected, tool.name)) : tool.name;

    const prefixLen = 7 + visibleWidth(tool.name);
    const maxDescLen = Math.max(0, innerW - prefixLen - 8);
    const descStr =
      maxDescLen > 5 && tool.description
        ? fg(t.description, "— " + truncateToWidth(tool.description, maxDescLen, "…"))
        : "";

    return `  ${cursor} ${toggleIcon} ${nameStr} ${descStr}`;
  }

  invalidate(): void {}

  dispose(): void {
    this.cleanup();
  }
}

export function createMcpPanel(
  config: McpConfig,
  cache: MetadataCache | null,
  provenance: Map<string, ServerProvenance>,
  callbacks: McpPanelCallbacks,
  tui: TUI,
  done: (result: McpPanelResult) => void,
): McpPanel & { dispose(): void } {
  return new McpPanel(config, cache, provenance, callbacks, tui, done);
}
