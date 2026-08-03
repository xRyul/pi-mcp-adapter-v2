import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CURSOR_MARKER, type Focusable, type TUI } from "@earendil-works/pi-tui";

import mcpAdapter from "../src/index.js";
import { createMcpPanel } from "../src/mcp-panel.js";
import type { McpPanelCallbacks } from "../src/types.js";

test("/mcp returns without opening custom UI outside TUI mode", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-mcp-adapter-test-"));
  const configPath = join(tempDir, "mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }));

  const originalArgv = [...process.argv];
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  process.argv.push("--mcp-config", configPath);
  process.env.MCP_DIRECT_TOOLS = "__none__";

  const eventHandlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
  const notifications: string[] = [];
  let customCalls = 0;

  const pi = {
    getAllTools: () => [],
    getFlag: (name: string) => name === "mcp-config" ? configPath : undefined,
    on: (event: string, handler: (...args: any[]) => unknown) => {
      eventHandlers.set(event, handler);
    },
    registerCommand: (name: string, command: { handler: (...args: any[]) => Promise<void> }) => {
      commands.set(name, command);
    },
    registerFlag: () => {},
    registerTool: () => {},
  };

  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      custom: () => {
        customCalls += 1;
        return undefined;
      },
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      theme: { fg: (_color: string, text: string) => text },
    },
  };

  try {
    mcpAdapter(pi as any);
    await eventHandlers.get("session_start")?.({}, ctx);

    const outcome = await Promise.race([
      commands.get("mcp")!.handler("", ctx as any).then(() => "resolved" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 200)),
    ]);

    assert.equal(outcome, "resolved");
    assert.equal(customCalls, 0);
    assert.ok(notifications.some((message) => message.includes("TUI mode")));
  } finally {
    await eventHandlers.get("session_shutdown")?.();
    process.argv.splice(0, process.argv.length, ...originalArgv);
    if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MCP panel exposes cursor markers for search and its embedded editor", () => {
  const callbacks: McpPanelCallbacks = {
    reconnect: async () => true,
    getConnectionStatus: () => "idle",
    refreshCacheAfterReconnect: () => null,
  };
  const panel = createMcpPanel(
    { mcpServers: {} },
    null,
    new Map(),
    callbacks,
    { terminal: { rows: 40 }, requestRender: () => {} } as TUI,
    () => {},
  );
  const focusablePanel = panel as typeof panel & Focusable;

  try {
    focusablePanel.focused = true;
    panel.handleInput("/");
    assert.ok(panel.render(100).join("\n").includes(CURSOR_MARKER));
    panel.handleInput("\x1b");

    panel.handleInput("n");
    assert.ok(panel.render(100).join("\n").includes(CURSOR_MARKER));

    focusablePanel.focused = false;
    assert.ok(!panel.render(100).join("\n").includes(CURSOR_MARKER));
  } finally {
    panel.dispose();
  }
});
