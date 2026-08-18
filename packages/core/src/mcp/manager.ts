import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { minimatch } from 'minimatch';
import { z } from 'zod';
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

/** 超时后拒绝，但不取消底层操作 —— MCP SDK 的 connect 没有 abort 入口。调用方随即把这台
 *  server 记成 down 并丢掉 client 引用，挂着的握手最终自己失败或被 close 收掉。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
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
    // `mcp.connectTimeoutMs`：握手本身也要有上界。一台 stdio server 卡在启动里（等一个不存在的
    // 凭据、DNS 打不通）会让 `reconcile()` 永远回不来，而 reconcile 在启动路径上 —— 整个进程起不来。
    // `server.timeoutMs` 管的是 callTool，两者不是一回事。
    const connectTimeoutMs = this.#config().connectTimeoutMs;
    await withTimeout(client.connect(transport as Parameters<Client['connect']>[0]), connectTimeoutMs, `${server.name} connect`);
    this.#clients.set(server.name, { client, fingerprint: print });
    const tools = await withTimeout(client.listTools(), connectTimeoutMs, `${server.name} listTools`);
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
        const discovered = await this.discover(server);
        for (const entry of discovered) this.#tools.set(entry.name, entry);
        // **schema 转换也在这个 try 里。** 它此前在循环外统一做，于是一台 server 的畸形
        // `inputSchema` 会让异常从 `reconcile()` 抛出去：`POST /api/mcp` 500，而
        // `main.ts` 的 `await mcp.reconcile()` 在启动路径上 —— 整个进程起不来（docs/27 · C-04）。
        // 单条工具转换失败就退回宽松放行那一个工具，别拖着同一台 server 的其余工具。
        if (this.registry) for (const entry of discovered) this.#register(entry);
        this.log.event({ level: 'info', kind: 'mcp.connect', summary: `${server.name} connected`, data: { server: server.name, transport: server.transport } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.prepare(`INSERT INTO mcp_servers(name,transport,min_role,enabled,timeout_ms,state,last_error,updated_at) VALUES (?,?,?,?,?,'down',?,?) ON CONFLICT(name) DO UPDATE SET state='down',last_error=excluded.last_error,updated_at=excluded.updated_at`).run(server.name, server.transport, server.minRole ?? this.#config().defaultMinRole, 1, server.timeoutMs ?? 30_000, message, Date.now());
        this.log.event({ level: 'warn', kind: 'mcp.error', summary: message, data: { server: server.name } });
      }
    }
  }

  /**
   * 入参 schema 要真的接上：换成通配之后模型只能猜参数名，猜错了 safeParse 也不拦
   * （docs/20 · W-MCP-01）。而转换本身也可能抛（畸形 schema、zod 拒收的字面量），所以降级的
   * 粒度是**一个工具** —— 整台 server 的其余工具照常带着精确 schema 进目录（docs/27 · C-04）。
   */
  #register(entry: { name: string; description: string; inputSchema: Record<string, unknown>; minRole: Role; call: (input: unknown) => Promise<unknown> }): void {
    let inputSchema: z.ZodTypeAny;
    try { inputSchema = jsonSchemaToZod(entry.inputSchema); }
    catch (error) {
      inputSchema = z.record(z.unknown());
      this.log.event({ level: 'warn', kind: 'mcp.error', summary: `${entry.name} 的入参 schema 转换失败，已退回宽松放行`, data: { tool: entry.name, error: error instanceof Error ? error.message : String(error) } });
    }
    this.registry!.registerExternal({ name: entry.name, description: entry.description, inputSchema, minRole: entry.minRole, source: 'mcp', execute: entry.call });
  }

  toolEntries(): Array<{ name: string; description: string; inputSchema: Record<string, unknown>; minRole: Role; call: (input: unknown) => Promise<unknown> }> {
    return [...this.#tools.values()];
  }

  async close(): Promise<void> {
    await Promise.all([...this.#clients.values()].map((entry) => entry.client.close()));
    this.#clients.clear();
  }
}
