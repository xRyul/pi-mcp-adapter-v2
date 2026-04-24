// server-manager.ts - MCP connection management (stdio + HTTP)
import type { McpContent, McpTool, McpResource, ServerDefinition } from "./types.js";
import { getStoredTokens } from "./oauth-handler.js";
import { resolveNpxBinary } from "./npx-resolver.js";
import { logDebug } from "./logger.js";

type RuntimeTransport = {
  close(): Promise<void>;
};

type RuntimeReadResourceContent = Record<string, unknown> & {
  text?: string;
  blob?: string;
  mimeType?: string;
};

type RuntimeCallToolResult = {
  content?: McpContent[];
  isError?: boolean;
};

type RuntimeClient = {
  connect(transport: RuntimeTransport): Promise<void>;
  close(): Promise<void>;
  listTools(args?: { cursor?: string }): Promise<{ tools?: McpTool[]; nextCursor?: string }>;
  listResources(args?: { cursor?: string }): Promise<{ resources?: McpResource[]; nextCursor?: string }>;
  readResource(params: { uri: string }): Promise<{ contents?: RuntimeReadResourceContent[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<RuntimeCallToolResult>;
};

type RuntimeSdk = {
  Client: new (info: { name: string; version: string }) => RuntimeClient;
  StdioClientTransport: new (options: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    stderr?: "inherit" | "ignore";
  }) => RuntimeTransport;
  StreamableHTTPClientTransport: new (
    url: URL,
    options?: { requestInit?: { headers?: Record<string, string> } },
  ) => RuntimeTransport;
  SSEClientTransport: new (
    url: URL,
    options?: { requestInit?: { headers?: Record<string, string> } },
  ) => RuntimeTransport;
};

let runtimeSdkPromise: Promise<RuntimeSdk | null> | undefined;

export function getMcpSdkMissingMessage(): string {
  return 'pi-mcp-adapter-v2 is running in disabled mode because "@modelcontextprotocol/sdk" is not installed locally.';
}

async function loadRuntimeSdk(): Promise<RuntimeSdk | null> {
  if (!runtimeSdkPromise) {
    runtimeSdkPromise = Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      import("@modelcontextprotocol/sdk/client/sse.js"),
    ])
      .then(([clientMod, stdioMod, streamableMod, sseMod]) => ({
        Client: clientMod.Client,
        StdioClientTransport: stdioMod.StdioClientTransport,
        StreamableHTTPClientTransport: streamableMod.StreamableHTTPClientTransport,
        SSEClientTransport: sseMod.SSEClientTransport,
      }))
      .catch(() => null);
  }

  return runtimeSdkPromise;
}

export async function hasMcpSdk(): Promise<boolean> {
  return (await loadRuntimeSdk()) !== null;
}

async function requireRuntimeSdk(): Promise<RuntimeSdk> {
  const sdk = await loadRuntimeSdk();
  if (!sdk) {
    throw new Error(getMcpSdkMissingMessage());
  }
  return sdk;
}

interface ServerConnection {
  client: RuntimeClient;
  transport: RuntimeTransport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed";
}

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  
  async connect(name: string, definition: ServerDefinition): Promise<ServerConnection> {
    // Dedupe concurrent connection attempts
    if (this.connectPromises.has(name)) {
      return this.connectPromises.get(name)!;
    }
    
    // Reuse existing connection if healthy
    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    
    const promise = this.createConnection(name, definition);
    this.connectPromises.set(name, promise);
    
    try {
      const connection = await promise;
      this.connections.set(name, connection);
      return connection;
    } finally {
      this.connectPromises.delete(name);
    }
  }
  
  private async createConnection(
    name: string,
    definition: ServerDefinition
  ): Promise<ServerConnection> {
    const sdk = await requireRuntimeSdk();
    const client = new sdk.Client({ name: `pi-mcp-${name}`, version: "1.0.0" });
    
    let transport: RuntimeTransport;
    
    if (definition.command) {
      let command = definition.command;
      let args = definition.args ?? [];

      if (command === "npx" || command === "npm") {
        const resolved = await resolveNpxBinary(command, args);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          logDebug(`MCP: ${name} resolved to ${resolved.binPath} (skipping npm parent)`);
        }
      }

      transport = new sdk.StdioClientTransport({
        command,
        args,
        env: resolveEnv(definition.env),
        cwd: definition.cwd,
        stderr: definition.debug ? "inherit" : "ignore",
      });
    } else if (definition.url) {
      // HTTP transport with fallback
      transport = await this.createHttpTransport(definition, name);
    } else {
      throw new Error(`Server ${name} has no command or url`);
    }
    
    try {
      await client.connect(transport);
      
      // Discover tools and resources
      const [tools, resources] = await Promise.all([
        this.fetchAllTools(client),
        this.fetchAllResources(client),
      ]);
      
      return {
        client,
        transport,
        definition,
        tools,
        resources,
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      };
    } catch (error) {
      // Clean up both client and transport on any error
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }
  
  private async createHttpTransport(definition: ServerDefinition, serverName?: string): Promise<RuntimeTransport> {
    const sdk = await requireRuntimeSdk();
    const url = new URL(definition.url!);
    const headers = resolveHeaders(definition.headers) ?? {};
    
    // Add bearer token if configured
    if (definition.auth === "bearer") {
      const token = definition.bearerToken 
        ?? (definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }
    
    // Handle OAuth auth - use stored tokens
    if (definition.auth === "oauth") {
      if (!serverName) {
        throw new Error("Server name required for OAuth authentication");
      }
      const tokens = getStoredTokens(serverName);
      if (!tokens) {
        throw new Error(
          `No OAuth tokens found for "${serverName}". Open /mcp, select the server and press ctrl+a to set a token.`
        );
      }
      headers["Authorization"] = `Bearer ${tokens.access_token}`;
    }
    
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    
    // Try StreamableHTTP first (modern MCP servers)
    const streamableTransport = new sdk.StreamableHTTPClientTransport(url, { requestInit });
    
    try {
      // Create a test client to verify the transport works
      const testClient = new sdk.Client({ name: "pi-mcp-probe", version: "1.0.0" });
      await testClient.connect(streamableTransport);
      await testClient.close().catch(() => {});
      // Close probe transport before creating fresh one
      await streamableTransport.close().catch(() => {});
      
      // StreamableHTTP works - create fresh transport for actual use
      return new sdk.StreamableHTTPClientTransport(url, { requestInit });
    } catch {
      // StreamableHTTP failed, close and try SSE fallback
      await streamableTransport.close().catch(() => {});
      
      // SSE is the legacy transport
      return new sdk.SSEClientTransport(url, { requestInit });
    }
  }
  
  private async fetchAllTools(client: RuntimeClient): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;
    
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    
    return allTools;
  }
  
  private async fetchAllResources(client: RuntimeClient): Promise<McpResource[]> {
    try {
      const allResources: McpResource[] = [];
      let cursor: string | undefined;
      
      do {
        const result = await client.listResources(cursor ? { cursor } : undefined);
        allResources.push(...(result.resources ?? []));
        cursor = result.nextCursor;
      } while (cursor);
      
      return allResources;
    } catch {
      // Server may not support resources
      return [];
    }
  }
  
  async close(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    
    // Delete from map BEFORE async cleanup to prevent a race where a
    // concurrent connect() creates a new connection that our deferred
    // delete() would then remove, orphaning the new server process.
    connection.status = "closed";
    this.connections.delete(name);
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(() => {});
  }
  
  async closeAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map(name => this.close(name)));
  }
  
  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }
  
  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.lastUsedAt = Date.now();
    }
  }

  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.inFlight = (connection.inFlight ?? 0) + 1;
    }
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) {
      connection.inFlight--;
    }
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return false;
    if (connection.inFlight && connection.inFlight > 0) return false;
    return (Date.now() - connection.lastUsedAt) > timeoutMs;
  }
}

/**
 * Resolve environment variables with interpolation.
 */
function resolveEnv(env?: Record<string, string>): Record<string, string> {
  // Copy process.env, filtering out undefined values
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      resolved[key] = value;
    }
  }
  
  if (!env) return resolved;
  
  for (const [key, value] of Object.entries(env)) {
    // Support ${VAR} and $env:VAR interpolation
    resolved[key] = value
      .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
      .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
  }
  
  return resolved;
}

/**
 * Resolve headers with environment variable interpolation.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value
      .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
      .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
  }
  return resolved;
}
