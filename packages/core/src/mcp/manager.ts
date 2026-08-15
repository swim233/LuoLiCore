import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import type { Role } from '@luoli/shared';
import type { ToolRegistry } from '../tools/registry.js';
import type { Config, LogSink } from '../index.js';
import type { Sqlite } from '@luoli/db';

interface ServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  minRole?: string;
  enabled?: boolean;
  toolAllow?: string[];
  toolDeny?: string[];
  timeoutMs?: number;
}

export class McpManager {
  readonly #clients = new Map<string, Client>();
  readonly #tools = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; minRole: Role; call: (input: unknown) => Promise<unknown> }>();
  constructor(private readonly db: Sqlite, private readonly config: Readonly<Config['mcp']>, private readonly log: LogSink, private registry?: ToolRegistry) {}
  bindRegistry(registry: ToolRegistry): void { this.registry = registry; }

  async connect(server: ServerConfig): Promise<Client> {
    const existing = this.#clients.get(server.name);
    if (existing) return existing;
    const client = new Client({ name: 'luolicore', version: '0.1.0' });
    const transport = server.transport === 'stdio'
      ? new StdioClientTransport({ command: server.command!, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) })
      : new StreamableHTTPClientTransport(new URL(server.url!), server.headers ? { requestInit: { headers: server.headers } } : undefined);
    await client.connect(transport as Parameters<Client['connect']>[0]);
    this.#clients.set(server.name, client);
    const tools = await client.listTools();
    this.db.prepare(`INSERT INTO mcp_servers(name,transport,command,args_json,env_json,url,headers_json,min_role,enabled,tool_allow_json,tool_deny_json,timeout_ms,state,tools_json,connected_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET state='up',tools_json=excluded.tools_json,connected_at=excluded.connected_at,updated_at=excluded.updated_at,last_error=NULL`)
      .run(server.name, server.transport, server.command ?? null, JSON.stringify(server.args ?? []), JSON.stringify(server.env ?? {}), server.url ?? null, JSON.stringify(server.headers ?? {}), server.minRole ?? this.config.defaultMinRole,
        server.enabled === false ? 0 : 1, JSON.stringify(server.toolAllow ?? []), JSON.stringify(server.toolDeny ?? []), server.timeoutMs ?? 30_000, 'up', JSON.stringify(tools.tools), Date.now(), Date.now());
    return client;
  }

  async discover(server: ServerConfig): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown>; minRole: Role; call: (input: unknown) => Promise<unknown> }>> {
    const client = await this.connect(server);
    const tools = (await client.listTools()).tools.filter((tool) => !(server.toolAllow?.length) || server.toolAllow.some((pattern) => minimatch(tool.name, pattern)))
      .filter((tool) => !server.toolDeny?.some((pattern) => minimatch(tool.name, pattern)));
    return tools.map((entry) => ({ name: `mcp__${server.name}__${entry.name}`, description: entry.description ?? `MCP ${server.name}/${entry.name}`, inputSchema: entry.inputSchema as Record<string, unknown>, minRole: (server.minRole as Role | undefined) ?? this.config.defaultMinRole,
      call: async (input) => {
        const started = performance.now();
        try { return await client.callTool({ name: entry.name, arguments: input as Record<string, unknown> }); }
        finally { this.log.event({ level: 'info', kind: 'tool.mcp', summary: `${server.name}/${entry.name}`, durationMs: Math.round(performance.now() - started) }); }
      } }));
  }

  async reconcile(): Promise<void> {
    this.registry?.unregisterBySource('mcp');
    this.#tools.clear();
    if (!this.config.enabled) return;
    for (const raw of this.config.servers) {
      const server = raw as unknown as ServerConfig;
      if (server.enabled === false) continue;
      try {
        for (const entry of await this.discover(server)) this.#tools.set(entry.name, entry);
        this.log.event({ level: 'info', kind: 'mcp.connect', summary: `${server.name} connected`, data: { server: server.name, transport: server.transport } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.prepare(`INSERT INTO mcp_servers(name,transport,min_role,enabled,timeout_ms,state,last_error,updated_at) VALUES (?,?,?,?,?,'down',?,?) ON CONFLICT(name) DO UPDATE SET state='down',last_error=excluded.last_error,updated_at=excluded.updated_at`).run(server.name, server.transport, server.minRole ?? this.config.defaultMinRole, 1, server.timeoutMs ?? 30_000, message, Date.now());
        this.log.event({ level: 'warn', kind: 'mcp.error', summary: message, data: { server: server.name } });
      }
    }
    if (this.registry) for (const entry of this.#tools.values()) this.registry.registerExternal({ name: entry.name, description: entry.description, inputSchema: z.record(z.unknown()), minRole: entry.minRole, source: 'mcp', execute: entry.call });
  }

  toolEntries(): Array<{ name: string; description: string; inputSchema: Record<string, unknown>; minRole: Role; call: (input: unknown) => Promise<unknown> }> {
    return [...this.#tools.values()];
  }

  async close(): Promise<void> {
    await Promise.all([...this.#clients.values()].map((client) => client.close()));
    this.#clients.clear();
  }
}
