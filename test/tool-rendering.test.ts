import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

test("MCP results stay hidden until expanded, without hiding errors or progress", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "pi-mcp-render-test-"));
  const originalArgv = [...process.argv];
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  t.after(async () => {
    process.argv.splice(0, process.argv.length, ...originalArgv);
    if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });

  t.mock.method(os, "homedir", () => root);
  syncBuiltinESMExports();
  delete process.env.MCP_DIRECT_TOOLS;
  const { computeServerHash } = await import("../src/metadata-cache.js");
  const { default: mcpAdapter } = await import("../src/index.js");
  const agentDir = join(root, ".pi", "agent");
  const configPath = join(agentDir, "mcp.json");
  const definition = { command: "unused-test-server", directTools: true as const };
  await mkdir(agentDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    mcpServers: { example: definition }, settings: { toolPrefix: "none" },
  }));
  await writeFile(join(agentDir, "mcp-cache.json"), JSON.stringify({
    version: 1,
    servers: {
      example: {
        configHash: computeServerHash(definition), cachedAt: Date.now(),
        tools: [{ name: "example_tool" }, { name: "sequentialthinking" }], resources: [],
      },
    },
  }));
  process.argv.push("--mcp-config", configPath);

  const tools = new Map<string, ToolDefinition<any, any>>();
  mcpAdapter({
    getAllTools: () => [], on: () => {}, registerFlag: () => {}, registerCommand: () => {},
    registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const output = Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join("\n");

  for (const name of ["mcp", "example_tool", "sequentialthinking"]) {
    const tool = tools.get(name);
    assert.ok(tool?.renderResult, `${name} must have a result renderer`);
    function render(result: any, expanded = false, isPartial = false, isError = false) {
      return tool.renderResult(result, { expanded, isPartial }, theme as any, { isError } as any)
        .render(120).join("\n").trim();
    }
    const result = {
      content: [{ type: "text", text: output }],
      details: {
        ...(name === "mcp" ? { mode: "call" } : {}),
        server: "example", tool: name === "mcp" ? "example_tool" : name,
        mcpRequest: { name, arguments: { thought: "Detailed thought", thoughtNumber: 1, totalThoughts: 2 } },
      },
    };
    const originalResult = structuredClone(result);
    assert.equal(render({ ...result, content: [{ type: "text", text: "Successful output" }] }), "", `${name} should hide short output too`);
    assert.equal(render(result), "", `${name} should hide successful output`);
    assert.match(render(result, true), /output line 20/);
    assert.equal(render(result), "", `${name} should collapse again after expansion`);
    if (name === "sequentialthinking") assert.match(render(result, true), /Thought 1\/2/);
    assert.deepEqual(result, originalResult, "rendering must not alter model-visible results");

    const error = { content: [{ type: "text", text: "Connection failed\nDetailed error" }], details: {} };
    assert.match(render(error, false, false, true), /Connection failed/);
    assert.match(render({ ...error, details: { error: "call_failed" } }), /Connection failed/);
    assert.match(render({ ...error, isError: true }), /Connection failed/);
    assert.match(render({ content: [], details: { error: "call_failed" } }), /call_failed/);
    assert.match(render(error, true, false, true), /Detailed error/);
    assert.match(render(result, false, true), /working|Processing/i);

    const image = { content: [{ type: "image", data: "test", mimeType: "image/png" }], details: result.details };
    assert.equal(render(image), "");
    assert.match(render(image, true), /image\/png/);
    assert.equal(render({ content: [], details: {} }), "");
    assert.match(render({ content: [], details: {} }, true), /empty result/);
  }

  const gateway = tools.get("mcp");
  assert.ok(gateway?.renderCall);
  assert.equal(gateway.renderCall({ tool: "example_tool" }, theme as any, {} as any).render(120).join("\n").trimEnd(), "mcp call example_tool");
  assert.equal(gateway.renderResult({ content: [{ type: "text", text: "Server status" }], details: { mode: "status" } },
    { expanded: false, isPartial: false }, theme as any, { isError: false } as any).render(120).join("\n"), "");
});
