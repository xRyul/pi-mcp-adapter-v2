// logger.ts - Safe logging for pi-mcp-adapter (avoids breaking Pi's TUI)
//
// IMPORTANT: Do not use console.log/console.error inside Pi TUI overlays.
// Any stdout/stderr output can corrupt rendering. This logger writes to a file.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_PATH = join(homedir(), ".pi", "agent", "logs", "pi-mcp-adapter.log");

let listener: ((level: LogLevel, message: string) => void) | null = null;

export function setLogListener(fn: ((level: LogLevel, message: string) => void) | null): void {
  listener = fn;
}

function writeLine(line: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line + "\n", "utf-8");
  } catch {
    // Never throw from logging.
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}

export function log(level: LogLevel, message: string, err?: unknown): void {
  const ts = new Date().toISOString();
  const suffix = err !== undefined ? `\n${formatError(err)}` : "";
  const line = `[${ts}] [${level}] ${message}${suffix}`;

  listener?.(level, message);
  writeLine(line);

  // Optional console passthrough for debugging outside the TUI.
  // Keep this OFF by default.
  if (process.env.PI_MCP_ADAPTER_CONSOLE === "1") {
    // eslint-disable-next-line no-console
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(message, err ?? "");
  }
}

export const logDebug = (message: string, err?: unknown) => log("debug", message, err);
export const logInfo = (message: string, err?: unknown) => log("info", message, err);
export const logWarn = (message: string, err?: unknown) => log("warn", message, err);
export const logError = (message: string, err?: unknown) => log("error", message, err);
