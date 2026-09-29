// npx-resolver.ts - Resolve npx/npm exec binaries to avoid npm parent processes
import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync, readFileSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { basename, delimiter, dirname, join, extname, resolve } from "node:path";

export interface NpxResolution {
  binPath: string;
  extraArgs: string[];
  isJs: boolean;
}

interface ParsedInvocation {
  packageSpec: string;
  binName?: string;
  extraArgs: string[];
}

export async function resolveNpxBinary(
  command: string,
  args: string[],
  options: Pick<ExecFileOptions, "cwd" | "env"> = {},
): Promise<NpxResolution | null> {
  const parsed = command === "npx"
    ? parseNpxArgs(args)
    : command === "npm"
      ? parseNpmExecArgs(args)
      : null;

  if (!parsed) return null;

  const packageName = extractPackageName(parsed.packageSpec);
  if (!packageName || !/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(packageName)) return null;

  try {
    // Let npm resolve tags/ranges/pins and put the selected package first on PATH.
    // Scanning _npx by package name (or caching @latest ourselves) can launch an old version.
    const stdout = await new Promise<string>((resolveOutput, reject) => {
      execFile("npm", [
        "exec", "--yes", "--package", parsed.packageSpec,
        "--", "node", "-p", "JSON.stringify(process.env.PATH)",
      ], { ...options, encoding: "utf-8", timeout: 30_000 }, (error, output) => {
        if (error) reject(error);
        else resolveOutput(output);
      });
    });
    const npmPath: unknown = JSON.parse(stdout);
    if (typeof npmPath !== "string") return null;

    for (const binDir of npmPath.split(delimiter)) {
      if (basename(binDir) !== ".bin" || basename(dirname(binDir)) !== "node_modules") continue;
      const packageDir = join(dirname(binDir), packageName);
      if (!existsSync(join(packageDir, "package.json"))) continue;
      const resolved = resolvePackageBin(packageDir, packageName, parsed.binName);
      return resolved ? { ...resolved, extraArgs: parsed.extraArgs } : null;
    }
  } catch {
    // On npm/manifest failures, run the original command rather than a stale binary.
  }

  return null;
}

function parseNpxArgs(args: string[]): ParsedInvocation | null {
  const separatorIndex = args.indexOf("--");
  const before = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const after = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

  const positionals: string[] = [];
  let packageSpec: string | undefined;
  let sawPackageFlag = false;
  let foundFirstPositional = false;

  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (foundFirstPositional) {
      positionals.push(arg);
      continue;
    }
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "-p" || arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-") || packageSpec) return null;
      packageSpec = value;
      sawPackageFlag = true;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value || packageSpec) return null;
      packageSpec = value;
      sawPackageFlag = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
    positionals.push(arg);
    foundFirstPositional = true;
  }

  if (sawPackageFlag) {
    const binName = positionals[0];
    if (!packageSpec || !binName) return null;
    const extraArgs = positionals.slice(1).concat(after);
    return { packageSpec, binName, extraArgs };
  }

  const packagePositional = positionals[0];
  if (!packagePositional) return null;
  const extraArgs = positionals.slice(1).concat(after);
  return { packageSpec: packagePositional, extraArgs };
}

function parseNpmExecArgs(args: string[]): ParsedInvocation | null {
  if (args[0] !== "exec") return null;
  const execArgs = args.slice(1);
  const separatorIndex = execArgs.indexOf("--");
  if (separatorIndex < 0) return null;

  const before = execArgs.slice(0, separatorIndex);
  const after = execArgs.slice(separatorIndex + 1);

  let packageSpec: string | undefined;
  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-") || packageSpec) return null;
      packageSpec = value;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value || packageSpec) return null;
      packageSpec = value;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
  }

  const binName = after[0];
  if (!packageSpec || !binName) return null;
  const extraArgs = after.slice(1);
  return { packageSpec, binName, extraArgs };
}

function resolvePackageBin(packageDir: string, packageName: string, binName?: string) {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as {
    name?: string;
    bin?: string | Record<string, string>;
  };
  const defaultName = defaultBinName(pkg.name ?? packageName);
  const bins = typeof pkg.bin === "string" ? { [defaultName]: pkg.bin } : pkg.bin;
  if (!bins) return null;

  // Match npm's bin inference, and never substitute a different explicitly requested bin.
  const chosenBinName = binName ?? (new Set(Object.values(bins)).size === 1
    ? Object.keys(bins)[0]
    : defaultName);
  const binRel = bins[chosenBinName];
  if (typeof binRel !== "string") return null;

  const binPath = realpathSync(resolve(packageDir, binRel));
  return { binPath, isJs: detectJsBinary(binPath) };
}

function extractPackageName(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("@")) {
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex < 0) return null;
    const atIndex = trimmed.lastIndexOf("@");
    if (atIndex > slashIndex) {
      return trimmed.slice(0, atIndex);
    }
    return trimmed;
  }
  const atIndex = trimmed.indexOf("@");
  return atIndex >= 0 ? trimmed.slice(0, atIndex) : trimmed;
}

function defaultBinName(packageName: string): string {
  if (packageName.startsWith("@")) {
    const parts = packageName.split("/");
    return parts[1] ?? packageName.replace("@", "").replace("/", "-");
  }
  return packageName;
}

function detectJsBinary(binPath: string): boolean {
  const ext = extname(binPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return true;
  try {
    const fd = openSync(binPath, "r");
    try {
      const buf = Buffer.alloc(256);
      readSync(fd, buf, 0, 256, 0);
      const firstLine = buf.toString("utf-8").split("\n")[0] ?? "";
      return firstLine.startsWith("#!") && firstLine.includes("node");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
