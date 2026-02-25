import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerProvenance } from "./types.js";
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
  private descSearchActive = false;
  private descQuery = "";
  private dirty = false;
  private confirmingDiscard = false;
  private discardSelected = 1;
  private importNotice: string | null = null;

  // OAuth setup view (for servers with auth: "oauth")
  private view: "main" | "auth" = "main";
  private authServerIndex: number | null = null;
  private authEnteringToken = false;
  private authTokenInput = "";
  private authMessage: { kind: "info" | "error"; text: string } | null = null;
  private reconnectAllInProgress = false;

  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private visibleItems: VisibleItem[] = [];
  private tui: { requestRender(): void };
  private t = DEFAULT_THEME;

  private static readonly MAX_VISIBLE = 12;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    private config: McpConfig,
    cache: MetadataCache | null,
    provenance: Map<string, ServerProvenance>,
    private callbacks: McpPanelCallbacks,
    tui: { requestRender(): void },
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
      this.done({ cancelled: true, changes: new Map() });
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
    this.dirty = this.servers.some((s) => s.tools.some((t) => t.isDirect !== t.wasDirect));
  }

  private buildResult(): McpPanelResult {
    const changes = new Map<string, true | string[] | false>();
    for (const server of this.servers) {
      const changed = server.tools.some((t) => t.isDirect !== t.wasDirect);
      if (!changed) continue;
      const directTools = server.tools.filter((t) => t.isDirect);
      if (directTools.length === server.tools.length && server.tools.length > 0) {
        changes.set(server.name, true);
      } else if (directTools.length === 0) {
        changes.set(server.name, false);
      } else {
        changes.set(server.name, directTools.map((t) => t.name));
      }
    }
    return { changes, cancelled: false };
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();
    this.importNotice = null;

    if (this.confirmingDiscard) {
      this.handleDiscardInput(data);
      return;
    }

    // Global shortcuts — always work, even during auth/token entry
    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }

    if (matchesKey(data, "ctrl+s")) {
      this.cleanup();
      this.done(this.buildResult());
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

    // Reconnect all servers
    if (matchesKey(data, "shift+ctrl+r")) {
      this.reconnectAll();
      return;
    }

    // OAuth setup view for selected server
    if (matchesKey(data, "ctrl+a")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item?.type === "server") {
        const server = this.servers[item.serverIndex];
        if (this.isOAuthServer(server.name)) {
          this.openAuthView(item.serverIndex);
          return;
        }
      }
    }

    if (matchesKey(data, "escape")) {
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
      this.done({ cancelled: true, changes: new Map() });
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

    // Backspace removes from name query
    if (matchesKey(data, "backspace")) {
      if (this.nameQuery.length > 0) {
        this.nameQuery = this.nameQuery.slice(0, -1);
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      }
      return;
    }

    // All other printable chars → always-on name search
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.nameQuery += data;
      this.rebuildVisibleItems();
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
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

    server.connectionStatus = "connecting";
    this.tui.requestRender();

    try {
      await this.callbacks.reconnect(server.name);
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);

      if (server.connectionStatus === "connected") {
        const entry = this.callbacks.refreshCacheAfterReconnect(server.name);
        if (entry) {
          this.rebuildServerTools(server, entry);
        }
        server.hasCachedData = true;
      }
    } catch {
      server.connectionStatus = "failed";
    } finally {
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      this.tui.requestRender();
    }
  }

  private reconnectAll(): void {
    if (this.reconnectAllInProgress) return;

    this.reconnectAllInProgress = true;
    this.tui.requestRender();

    (async () => {
      for (const server of this.servers) {
        await this.reconnectServer(server);
      }
    })().finally(() => {
      this.reconnectAllInProgress = false;
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
      this.done({ cancelled: true, changes: new Map() });
      return;
    }
    if (matchesKey(data, "escape") || data === "n" || data === "N") {
      this.confirmingDiscard = false;
      return;
    }
    if (matchesKey(data, "return")) {
      if (this.discardSelected === 0) {
        this.cleanup();
        this.done({ cancelled: true, changes: new Map() });
      } else {
        this.confirmingDiscard = false;
      }
      return;
    }
    if (data === "y" || data === "Y") {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
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

    if (this.view === "auth") {
      const serverIndex = this.authServerIndex;
      const server = typeof serverIndex === "number" ? this.servers[serverIndex] : undefined;
      const serverName = server?.name ?? "(unknown)";
      const definition = server ? this.config.mcpServers[serverName] : undefined;

      const titleText = " OAuth Setup ";
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
        lines.push(row(fg(t.cancel, `Server "${serverName}" does not use OAuth (auth=${definition.auth ?? "none"}).`)));
      } else if (!definition.url) {
        lines.push(row(fg(t.cancel, `Server "${serverName}" has no URL configured (OAuth requires HTTP transport).`)));
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
        : [
            italic("t") + " set token",
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
    } else if (this.nameQuery) {
      lines.push(row(`${searchIcon}  ${this.nameQuery}${cursor}`));
    } else {
      lines.push(row(`${searchIcon}  ${fg(t.placeholder, italic("search..."))}`));
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
    }

    lines.push(divider());
    lines.push(emptyRow());

    if (this.confirmingDiscard) {
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
      const stats =
        directCount > 0 ? `${directCount} direct  ~${totalTokens.toLocaleString()} tokens` : "no direct tools";
      lines.push(row(fg(t.description, stats + (this.dirty ? fg(t.needsAuth, "  (unsaved)") : ""))));
    }

    lines.push(emptyRow());
    const hints = [
      italic("↑↓") + " navigate",
      italic("space") + " toggle",
      italic("⏎") + " expand",
      italic("ctrl+r") + " reconnect",
      italic("shift+ctrl+r") + " reconnect all",
      italic("ctrl+a") + " oauth",
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
  tui: { requestRender(): void },
  done: (result: McpPanelResult) => void,
): McpPanel & { dispose(): void } {
  return new McpPanel(config, cache, provenance, callbacks, tui, done);
}
