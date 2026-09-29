import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

test("npm selects the requested version instead of stale adapter or npm cache entries", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "pi-mcp-npx-test-"));
  const cacheDir = join(root, "npm-cache");
  const bins = new Map<string, string>();
  for (const version of ["0.21.0", "1.10.1", "1.11.0"]) {
    const packageDir = join(cacheDir, "_npx", version, "node_modules", "@test", "server");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "@test/server", version, bin: { server: "cli.js" },
    }));
    const bin = join(packageDir, "cli.js");
    await writeFile(bin, "// test executable\n");
    bins.set(version, bin);
  }

  const latestArgs = ["-y", "@test/server@latest", "--port", "9222"];
  const adapterCacheDir = join(root, ".pi", "agent");
  await mkdir(adapterCacheDir, { recursive: true });
  await writeFile(join(adapterCacheDir, "mcp-npx-cache.json"), JSON.stringify({
    version: 1,
    entries: {
      [JSON.stringify(["npx", ...latestArgs])]: {
        resolvedBin: bins.get("0.21.0"), resolvedAt: Date.now(),
        packageVersion: "0.21.0", isJs: true,
      },
    },
  }));

  const originalCache = process.env.NPM_CONFIG_CACHE;
  process.env.NPM_CONFIG_CACHE = cacheDir;
  t.after(async () => {
    if (originalCache === undefined) delete process.env.NPM_CONFIG_CACHE;
    else process.env.NPM_CONFIG_CACHE = originalCache;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(os, "homedir", () => root);
  // No registry access or real MCP processes in this regression check.
  t.mock.method(childProcess, "spawn", () => { throw new Error("Unexpected process spawn"); });
  let npmPath = join(cacheDir, "_npx", "1.10.1", "node_modules", ".bin");
  let stdout = () => JSON.stringify(npmPath);
  let npmError: Error | null = null;
  const npm = t.mock.method(childProcess, "execFile", (
    _command: string, _args: string[], _options: childProcess.ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    callback(npmError, stdout(), "");
    return {} as childProcess.ChildProcess;
  });
  syncBuiltinESMExports();
  const { resolveNpxBinary } = await import("../src/npx-resolver.js");

  assert.deepEqual(await resolveNpxBinary("npx", latestArgs), {
    binPath: bins.get("1.10.1"), extraArgs: ["--port", "9222"], isJs: true,
  });
  assert.equal(npm.mock.calls[0].arguments[0], "npm");
  assert.ok(npm.mock.calls[0].arguments[1].includes("@test/server@latest"));

  // A reconnect must resolve a moving tag again, without waiting for a TTL.
  npmPath = join(cacheDir, "_npx", "1.11.0", "node_modules", ".bin");
  assert.equal((await resolveNpxBinary("npx", latestArgs))?.binPath, bins.get("1.11.0"));

  npmPath = [
    join(cacheDir, "_npx", "1.10.1", "node_modules", ".bin"),
    join(cacheDir, "_npx", "1.11.0", "node_modules", ".bin"),
  ].join(delimiter);
  for (const spec of ["@test/server@1.10.1", "@test/server@^1.10.0", "@test/server"]) {
    const resolved = await resolveNpxBinary("npm", ["exec", "--yes", "--package", spec, "--", "server"]);
    assert.equal(resolved?.binPath, bins.get("1.10.1"));
    assert.ok(npm.mock.calls.at(-1)?.arguments[1].includes(spec));
  }

  assert.equal(await resolveNpxBinary("npm", [
    "exec", "--package", "@test/server@1.10.1", "--", "missing-bin",
  ]), null);

  // npm must use the same registry/cache environment and working directory as the server.
  const options = { cwd: root, env: { NPM_CONFIG_CACHE: cacheDir } };
  await resolveNpxBinary("npx", latestArgs, options);
  assert.equal(npm.mock.calls.at(-1)?.arguments[2].cwd, root);
  assert.deepEqual(npm.mock.calls.at(-1)?.arguments[2].env, options.env);

  // Never fall back to an arbitrary cached version when resolution fails.
  npmError = new Error("npm failed");
  assert.equal(await resolveNpxBinary("npx", latestArgs), null);
  npmError = null;
  for (const invalid of ["not JSON", "null", "42"]) {
    stdout = () => invalid;
    assert.equal(await resolveNpxBinary("npx", latestArgs), null);
  }
  stdout = () => JSON.stringify(root);
  assert.equal(await resolveNpxBinary("npx", latestArgs), null);

  const calls = npm.mock.callCount();
  assert.equal(await resolveNpxBinary("npx", ["--offline", "@test/server"]), null);
  assert.equal(await resolveNpxBinary("npm", ["install", "@test/server"]), null);
  assert.equal(await resolveNpxBinary("npx", [
    "--package", "@test/server", "--package", "other-package", "server",
  ]), null);
  assert.equal(await resolveNpxBinary("npm", [
    "exec", "--package=@test/server", "--package=other-package", "--", "server",
  ]), null);
  assert.equal(npm.mock.callCount(), calls);
});
