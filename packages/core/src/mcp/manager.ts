import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { minimatch } from 'minimatch';
import { jsonSchemaToZod } from './schema.js';
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

/** 连接标识：url / command / args / env / headers 任何一项变了，缓存的 client 就不再是这台服务器。 */
function fingerprint(server: ServerConfig): string {
  return JSON.stringify([server.transport, server.command ?? null, server.args ?? [], server.env ?? {}, server.url ?? null, server.headers ?? {}]);
}

export class McpManager {
  readonly #clients = new Map<string, { client: Client; fingerprint: string }>();
  readonly #tools = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; minRole: Role; call: (input: unknown) => Promise<unknown> }>();
  readonly #config: () => Readonly<Config['mcp']>;
  /** config 传 getter 时每次 reconcile 都取最新值：吃启动快照的话，新增 MCP server 必须重启，
   *  `/api/mcp/:name/reconnect` 重连的也永远是启动时那份列表（docs/20 · W-CFG-02）。 */
  constructor(private readonly db: Sqlite, config: Readonly<Config['mcp']> | (() => Readonly<Config['mcp']>), private readonly log: LogSink, private registry?: ToolRegistry) {
    this.#config = typeof config === 'function' ? config : () => config;
  }
  bindRegistry(registry: ToolRegistry): void { this.registry = registry; }

  async connect(server: ServerConfig): Promise<Client> {
    const print = fingerprint(server);
    const existing = this.#clients.get(server.name);
    if (existing && existing.fingerprint === print) return existing.client;
    // 连接参数变了：旧连接必须先断，否则 stdio 子进程会一直挂着。
    if (existing) { this.#clients.delete(server.name); await existing.client.close().catch(() => undefined); }
    const client = new Client({ name: 'luolicore', version: '0.1.0' });
    const transport = server.transport === 'stdio'
      ? new StdioClientTransport({ command: server.command!, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) })
      : new StreamableHTTPClientTransport(new URL(server.url!), server.headers ? { requestInit: { headers: server.headers } } : undefined);
    await client.connect(transport as Parameters<Client['connect']>[0]);
    this.#clients.set(server.name, { client, fingerprint: print });
    const tools = await client.listTools();
    this.db.prepare(`INSERT INTO mcp_servers(name,transport,command,args_json,env_json,url,headers_json,min_role,enabled,tool_allow_json,tool_deny_json,timeout_ms,state,tools_json,connected_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET state='up',tools_json=excluded.tools_json,connected_at=excluded.connected_at,updated_at=excluded.updated_at,last_error=NULL`)
      .run(server.name, server.transport, server.command ?? null, JSON.stringify(server.args ?? []), JSON.stringify(server.env ?? {}), server.url ?? null, JSON.stringify(server.headers ?? {}), server.minRole ?? this.#config().defaultMinRole,
        server.enabled === false ? 0 : 1, JSON.stringify(server.toolAllow ?? []), JSON.stringify(server.toolDeny ?? []), server.timeoutMs ?? 30_000, 'up', JSON.stringify(tools.tools), Date.now(), Date.now());
    return client;
  }

  async discover(server: ServerConfig): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown>; minRole: Role; call: (input: unknown) => Promise<unknown> }>> {
    const client = await this.connect(server);
    const tools = (await client.listTools()).tools.filter((tool) => !(server.toolAllow?.length) || server.toolAllow.some((pattern) => minimatch(tool.name, pattern)))
      .filter((tool) => !server.toolDeny?.some((pattern) => minimatch(tool.name, pattern)));
    return tools.map((entry) => ({ name: `mcp__${server.name}__${entry.name}`, description: entry.description ?? `MCP ${server.name}/${entry.name}`, inputSchema: entry.inputSchema as Record<string, unknown>, minRole: (server.minRole as Role | undefined) ?? this.#config().defaultMinRole,
      call: async (input) => {
        const started = performance.now();
        // timeoutMs 此前只存进 mcp_servers 表，从没用来限制 callTool：一台卡住的 MCP server
        // 能把整轮拖到轮次超时（docs/20 · W-MCP-01）。
        try { return await client.callTool({ name: entry.name, arguments: input as Record<string, unknown> }, undefined, { timeout: server.timeoutMs ?? 30_000 }); }
        finally { this.log.event({ level: 'info', kind: 'tool.mcp', summary: `${server.name}/${entry.name}`, durationMs: Math.round(performance.now() - started) }); }
      } }));
  }

  async reconcile(): Promise<void> {
    this.registry?.unregisterBySource('mcp');
    this.#tools.clear();
    const config = this.#config();
    const wanted = config.enabled
      ? new Set((config.servers as unknown as ServerConfig[]).filter((server) => server.enabled !== false).map((server) => server.name))
      : new Set<string>();
    // 从配置里移除或被停用的 server 必须断开：只 unregister 工具的话，stdio 子进程会一直挂着，
    // 而下一次 reconcile 又会把它当成「已连接」复用（docs/20 · W-MCP-01）。
    for (const [name, entry] of [...this.#clients]) {
      if (wanted.has(name)) continue;
      this.#clients.delete(name);
      await entry.client.close().catch(() => undefined);
      this.db.prepare("UPDATE mcp_servers SET state='disabled',updated_at=? WHERE name=?").run(Date.now(), name);
      this.log.event({ level: 'info', kind: 'mcp.disconnect', summary: `${name} removed from configuration`, data: { server: name } });
    }
    if (!config.enabled) return;
    for (const raw of config.servers) {
      const server = raw as unknown as ServerConfig;
      if (server.enabled === false) continue;
      try {
        for (const entry of await this.discover(server)) this.#tools.set(entry.name, entry);
        this.log.event({ level: 'info', kind: 'mcp.connect', summary: `${server.name} connected`, data: { server: server.name, transport: server.transport } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.prepare(`INSERT INTO mcp_servers(name,transport,min_role,enabled,timeout_ms,state,last_error,updated_at) VALUES (?,?,?,?,?,'down',?,?) ON CONFLICT(name) DO UPDATE SET state='down',last_error=excluded.last_error,updated_at=excluded.updated_at`).run(server.name, server.transport, server.minRole ?? this.#config().defaultMinRole, 1, server.timeoutMs ?? 30_000, message, Date.now());
        this.log.event({ level: 'warn', kind: 'mcp.error', summary: message, data: { server: server.name } });
      }
    }
    // 入参 schema 要真的接上：换成通配之后模型只能猜参数名，猜错了 safeParse 也不拦（docs/20 · W-MCP-01）。
    if (this.registry) for (const entry of this.#tools.values()) this.registry.registerExternal({ name: entry.name, description: entry.description, inputSchema: jsonSchemaToZod(entry.inputSchema), minRole: entry.minRole, source: 'mcp', execute: entry.call });
  }

  toolEntries(): Array<{ name: string; description: string; inputSchema: Record<string, unknown>; minRole: Role; call: (input: unknown) => Promise<unknown> }> {
    return [...this.#tools.values()];
  }

  async close(): Promise<void> {
    await Promise.all([...this.#clients.values()].map((entry) => entry.client.close()));
    this.#clients.clear();
  }
}
