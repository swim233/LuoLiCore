import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import { jsonSchemaToZod } from './schema.js';
import { McpOAuthProvider, beginMcpAuthorization, completeMcpAuthorization, looksLikeAuthFailure, type PendingAuthorizations } from './oauth.js';
import { KeyedMutex } from '../turn/keyed-mutex.js';
import type { Role } from '@luoli/shared';
import type { ToolRegistry } from '../tools/registry.js';
import type { Config, LogSink } from '../index.js';
import type { McpAuthRepository, Sqlite } from '@luoli/db';

export interface McpServerAuthConfig {
  mode: 'none' | 'bearer' | 'oauth';
  scope?: string | undefined;
  clientId?: string | undefined;
  issuer?: string | undefined;
}

/**
 * 一台 server 的连接参数。可选项一律写 `?: T | undefined` 而不是 `?: T`：
 * 根 tsconfig 开了 `exactOptionalPropertyTypes`，而调用方手里那份是 zod 出来的
 * `minRole?: Role | undefined` —— 不带 `| undefined` 的话每个调用点都得再套一次 cast。
 */
export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
  minRole?: string | undefined;
  enabled?: boolean | undefined;
  toolAllow?: string[] | undefined;
  toolDeny?: string[] | undefined;
  timeoutMs?: number | undefined;
  auth?: McpServerAuthConfig | undefined;
}
type ServerConfig = McpServerConfig;

/**
 * 登录相关的外挂件。整块可选：`tests/mcp.runtime.test.ts` 与 `api.contract` 都不需要它，
 * 而 `McpAuthRepository` 要一个 `Secrets`，那是 `main.ts` 才装得起来的东西。
 * 没给的时候 `auth.mode` 只有 `none` 有意义，另两种在连接时如实报错而不是静默降级。
 */
export interface McpAuthDependencies {
  store: McpAuthRepository;
  pending: PendingAuthorizations;
  /** `webui.publicUrl`，每次现读 —— 运维在界面上补完它之后不该还要重启才能登录。 */
  publicUrl: () => string;
}

/**
 * 连接标识：url / command / args / env / headers 任何一项变了，缓存的 client 就不再是这台服务器。
 *
 * **`authVersion` 是必须的一项。** 凭据从 `headers` 搬进 `mcp_auth` 之后，轮换一次 token
 * 不会改变上面任何一项，于是 `existing.fingerprint === print` 命中旧连接、拿着已经作废的
 * token 一直用下去；界面上那台 server 还显示「已连接」。
 */
function fingerprint(server: ServerConfig, authVersion: number): string {
  return JSON.stringify([server.transport, server.command ?? null, server.args ?? [], server.env ?? {}, server.url ?? null, server.headers ?? {}, server.auth?.mode ?? 'none', authVersion]);
}

/** SDK 没从 exports 里放出 `Transport` 接口，而这里只需要这三个面 —— stdio 与 streamable-http
 *  两个 transport 都有。挂 onclose/onerror 要在 `client.connect()` **之前**：
 *  `Protocol.connect()` 会把已存在的那两个回调串到自己前面（sdk 1.30 `shared/protocol.js`），
 *  所以先挂不会被顶掉，反过来（connect 之后再挂）才会把 SDK 自己的清理覆盖掉。 */
type McpTransport = { close(): Promise<void>; onclose?: () => void; onerror?: (error: Error) => void };

/**
 * `reconcile()` 与 `connect()` 各占一个键空间。**必须不同** —— `reconcile()` 持锁期间会走到
 * `connect()` 去取 `server:<name>`，同键就是自己等自己。server 名过 `^[a-z0-9][a-z0-9_-]{0,63}$`，
 * 撞不上带 `~` / `:` 的这两种键。
 */
const RECONCILE_KEY = '~reconcile';
const connectKey = (name: string): string => `server:${name}`;

/** 超时后拒绝，但不取消底层操作 —— MCP SDK 的 connect 没有 abort 入口。调用方随即把这台
 *  server 记成 down，并且**当场把 transport 关掉**（否则 `mcp-health` 每 5 分钟就给一台
 *  「spawn 得起来但握不上手」的 server 留一个子进程，docs/28 · L-EXT-03）。 */
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
  /**
   * 连接状态整块都是 per-instance 的：stdio 子进程的句柄跨不过进程边界，另一个实例既看不见
   * 也关不掉。所以 `alive` / `#transports` 不算 `docs/01 §3.1` 说的那种「进程内状态当唯一真相」——
   * 真相仍在 `mcp.servers` 配置与 `mcp_servers` 表里，这里只是本实例握着的那几条连接。
   */
  readonly #clients = new Map<string, { client: Client; transport: McpTransport; fingerprint: string; alive: boolean }>();
  /** 所有建过、还没关完的 transport。`close()` 关它而不是只关 `#clients`：握手超时被丢掉的、
   *  被顶替的、竞态泄漏的都不在 `#clients` 里，而 SDK 的 `StdioClientTransport` **不 unref**
   *  子进程 —— 剩一条 refed handle 就够让 `shutdown()` 回不去（docs/28 · L-EXT-03）。 */
  readonly #transports = new Set<McpTransport>();
  /** 正在关的那些。`close()` 必须等这些 promise，不能只是再调一次 `transport.close()`：
   *  第一次已经把 `_process` 摘走了，第二次会立刻返回 —— 等于没等子进程死。 */
  readonly #closing = new Set<Promise<void>>();
  /** 我们主动关的 transport。onclose 靠它区分「运维停用 / 换指纹」与「子进程自己死了」，
   *  后者才值得告警 —— 否则每次正常关停都刷一条「连接意外断开」。 */
  readonly #intentional = new WeakSet<McpTransport>();
  readonly #mutex = new KeyedMutex();
  readonly #tools = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; minRole: Role; call: (input: unknown) => Promise<unknown> }>();
  readonly #config: () => Readonly<Config['mcp']>;
  /** config 传 getter 时每次 reconcile 都取最新值：吃启动快照的话，新增 MCP server 必须重启，
   *  `/api/mcp/:name/reconnect` 重连的也永远是启动时那份列表（docs/20 · W-CFG-02）。 */
  constructor(private readonly db: Sqlite, config: Readonly<Config['mcp']> | (() => Readonly<Config['mcp']>), private readonly log: LogSink, private registry?: ToolRegistry, private readonly authDeps?: McpAuthDependencies) {
    this.#config = typeof config === 'function' ? config : () => config;
  }
  bindRegistry(registry: ToolRegistry): void { this.registry = registry; }

  /** 这台 server 现在这一版凭据的号。没接凭据库时恒为 0 —— 指纹里也就等于没有这一项。 */
  #authVersion(name: string): number {
    return this.authDeps?.store.version(name) ?? 0;
  }

  #providerFor(server: ServerConfig): McpOAuthProvider {
    if (!this.authDeps) throw new Error(`${server.name} 配了 auth.mode=oauth，但这个运行时没有凭据库（缺 LUOLI_MASTER_KEY？）`);
    this.authDeps.store.ensureOAuth(server.name, server.auth?.scope ?? null);
    return new McpOAuthProvider(server.name, this.authDeps.store, this.authDeps.pending, {
      publicUrl: this.authDeps.publicUrl(),
      ...(server.auth?.scope ? { scope: server.auth.scope } : {}),
      ...(server.auth?.clientId ? { clientId: server.auth.clientId } : {}),
    });
  }

  /**
   * 开一次授权。返回授权 URL 给界面 —— 人点了才去，`reconcile()` 自己不弹浏览器。
   * 已经有可用 token 时 SDK 直接回 `'AUTHORIZED'`，这时顺手重连一次就行。
   */
  async authorize(server: ServerConfig): Promise<{ status: 'AUTHORIZED' | 'REDIRECT'; authorizationUrl: string | null; expiresAt: number | null }> {
    if (server.transport !== 'http' || !server.url) throw new Error(`${server.name} 不是 http transport，没有 OAuth 可走`);
    const provider = this.#providerFor(server);
    if (!provider.redirectUrl) throw new Error('还没配 `webui.publicUrl`，OAuth 回调没有可注册的地址 —— 去设置页填上它再登录。');
    const status = await beginMcpAuthorization(provider, server.url, server.auth?.scope);
    const entry = this.authDeps!.pending.peek(server.name);
    this.log.event({ level: 'info', kind: 'mcp.auth', summary: `${server.name} ${status === 'AUTHORIZED' ? '已有可用凭据' : '开始授权'}`, data: { server: server.name, status } });
    return { status, authorizationUrl: entry?.authorizationUrl ?? null, expiresAt: entry?.expiresAt ?? null };
  }

  /** 回调那一步：用 code 换 token，成功后单台重连。 */
  async completeAuthorization(server: ServerConfig, code: string): Promise<'AUTHORIZED' | 'REDIRECT'> {
    if (server.transport !== 'http' || !server.url) throw new Error(`${server.name} 不是 http transport，没有 OAuth 可走`);
    const status = await completeMcpAuthorization(this.#providerFor(server), server.url, code);
    this.log.event({ level: status === 'AUTHORIZED' ? 'info' : 'warn', kind: 'mcp.auth', summary: `${server.name} 换取 token ${status === 'AUTHORIZED' ? '成功' : '未完成'}`, data: { server: server.name, status } });
    return status;
  }

  /** 注销：凭据全清、pending 清、当场断开。下一次 reconcile 会把它重新记成 `needs_auth`。 */
  async signOut(server: ServerConfig): Promise<void> {
    if (!this.authDeps) return;
    this.authDeps.store.invalidate(server.name, 'all');
    this.authDeps.pending.forget(server.name);
    const existing = this.#clients.get(server.name);
    if (existing) { this.#clients.delete(server.name); await this.#discard(existing.transport, existing.client); }
    this.log.event({ level: 'info', kind: 'mcp.auth', summary: `${server.name} 已注销`, data: { server: server.name } });
  }

  /**
   * 按 server 名串行。这一处才是「两条 reconcile 各 spawn 一个子进程」的真正入口：查缓存与
   * `#clients.set` 之间夹着 stdio 握手的 await，两条并发的 connect 都会在那之前看到
   * `existing === undefined`，而 `set` 只留住后来的那个 —— 前一个子进程从此没人引用得到
   * （docs/28 · L-EXT-03）。
   */
  async connect(server: ServerConfig): Promise<Client> {
    return this.#mutex.run(connectKey(server.name), () => this.#connect(server));
  }

  async #connect(server: ServerConfig): Promise<Client> {
    const print = fingerprint(server, this.#authVersion(server.name));
    const existing = this.#clients.get(server.name);
    // 指纹相同还不够，得判活性：子进程被 kill -9 之后这条缓存永远命中，而拿死 client 调
    // `listTools()` 必抛 —— cron 与 `/api/mcp/:name/reconnect` 就都成了同一条死路，那个
    // 「重连」按钮结构上点不动任何东西（docs/28 · L-EXT-02）。
    if (existing && existing.fingerprint === print && existing.alive) return existing.client;
    // 换指纹的、以及已经判死的那条，都从这里走：**先关再建**。死了就直接从 `#clients` 删掉的话，
    // 下一次 connect 看到的是空位，于是又 spawn 一个，而上一个的 handle 已经没人拿得到了。
    if (existing) { this.#clients.delete(server.name); await this.#discard(existing.transport, existing.client); }
    const client = new Client({ name: 'luolicore', version: '0.1.0' });
    const transport: McpTransport = server.transport === 'stdio'
      // **`stderr: 'pipe'`**：SDK 的默认是 `'inherit'`，于是一台 server 打印的
      // 「打开这个链接授权」「缺 XXX_TOKEN」直接写进 bot 进程的 stderr —— 不进 LogSink、
      // 不落库、界面上一个字都没有，而这恰好是「为什么它连不上」最常见的答案所在。
      ? new StdioClientTransport({ command: server.command!, args: server.args ?? [], stderr: 'pipe', ...(server.env ? { env: server.env } : {}) })
      : new StreamableHTTPClientTransport(new URL(server.url!), this.#httpOptions(server));
    if (server.transport === 'stdio') this.#pipeStderr(server.name, transport);
    this.#transports.add(transport);
    transport.onclose = () => this.#markDead(server.name, transport);
    // **只有 onclose 判死。** transport 的 onerror 也会为「一行读不动的 JSON」「stdin 写失败」
    // 触发，把它一律当死会让一台健康的 server 每 5 分钟被重启一次，而重启本身就是泄漏的来源。
    transport.onerror = (error) => this.log.event({ level: 'warn', kind: 'mcp.error', summary: `${server.name}: ${error.message}`, data: { server: server.name } });
    // `mcp.connectTimeoutMs`：握手本身也要有上界。一台 stdio server 卡在启动里（等一个不存在的
    // 凭据、DNS 打不通）会让 `reconcile()` 永远回不来，而 reconcile 在启动路径上 —— 整个进程起不来。
    // `server.timeoutMs` 管的是 callTool，两者不是一回事。
    const connectTimeoutMs = this.#config().connectTimeoutMs;
    try {
      await withTimeout(client.connect(transport as Parameters<Client['connect']>[0]), connectTimeoutMs, `${server.name} connect`);
      this.#clients.set(server.name, { client, transport, fingerprint: print, alive: true });
      const tools = await withTimeout(client.listTools(), connectTimeoutMs, `${server.name} listTools`);
      this.db.prepare(`INSERT INTO mcp_servers(name,transport,command,args_json,env_json,url,headers_json,min_role,enabled,tool_allow_json,tool_deny_json,timeout_ms,state,tools_json,connected_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET state='up',tools_json=excluded.tools_json,connected_at=excluded.connected_at,updated_at=excluded.updated_at,last_error=NULL`)
        .run(server.name, server.transport, server.command ?? null, JSON.stringify(server.args ?? []), JSON.stringify(server.env ?? {}), server.url ?? null, JSON.stringify(server.headers ?? {}), server.minRole ?? this.#config().defaultMinRole,
          server.enabled === false ? 0 : 1, JSON.stringify(server.toolAllow ?? []), JSON.stringify(server.toolDeny ?? []), server.timeoutMs ?? 30_000, 'up', JSON.stringify(tools.tools), Date.now(), Date.now());
      return client;
    } catch (error) {
      // 失败的那一条当场收掉，但**不 await**：stdio 的 close 要走 stdin.end → SIGTERM → SIGKILL
      // 三级（SDK 里各 2 秒），而 reconcile 在启动路径上。`#closing` 替 `close()` 记着这份 promise。
      if (this.#clients.get(server.name)?.transport === transport) this.#clients.delete(server.name);
      void this.#discard(transport, client);
      throw error;
    }
  }

  /**
   * http transport 的构造参数。凭据在这里注入，**不经过配置** —— `mcp.servers` 要进
   * `config_revisions` 与配置导出，而按键名判密的那条正则匹配不到 `Authorization`。
   */
  #httpOptions(server: ServerConfig): { requestInit?: { headers: Record<string, string> }; authProvider?: McpOAuthProvider } | undefined {
    const mode = server.auth?.mode ?? 'none';
    const headers = { ...(server.headers ?? {}) };
    if (mode === 'bearer') {
      const token = this.authDeps?.store.bearerToken(server.name);
      // 拿不到就**不编一个空 Bearer 发出去**：那样对方回的是「token 无效」，而真相是本地没有
      // 这一份（没配、或者换过 LUOLI_MASTER_KEY 解不开了）。让它照常撞 401，然后被记成 needs_auth。
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (mode === 'oauth') return { authProvider: this.#providerFor(server), ...(Object.keys(headers).length ? { requestInit: { headers } } : {}) };
    return Object.keys(headers).length ? { requestInit: { headers } } : undefined;
  }

  /**
   * 把 stdio server 的 stderr 逐行收进日志。**这是「需要登录的 stdio server」唯一能给出的线索** ——
   * 那类 server 的登录是它自己在带外做的（照 harness 的先例，docs/07 §4.5），我们能做的
   * 就是别把它说的话丢掉。
   *
   * 逐行而不是整块：一条 500 KB 的栈会把日志行撑爆，而 `LogSink` 的载荷是要落盘的。
   */
  #pipeStderr(name: string, transport: McpTransport): void {
    const stream = (transport as { stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): void } }).stderr;
    if (!stream) return;
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      // 最后一段可能是半行，留到下一块。上界 8 KB：一台不打换行的 server 不该让这个缓冲无界涨。
      buffered = (lines.pop() ?? '').slice(-8192);
      for (const line of lines) {
        const text = line.trim();
        if (text) this.log.event({ level: 'warn', kind: 'mcp.stderr', summary: `${name}: ${text.slice(0, 2000)}`, data: { server: name } });
      }
    });
  }

  /** 连接没了。**不从 `#clients` 删**，只标死 —— 留着这条才保得住那个还得关的 handle。 */
  #markDead(name: string, transport: McpTransport): void {
    const entry = this.#clients.get(name);
    if (entry && entry.transport === transport) entry.alive = false;
    // 已经关了，`close()` 不用再管它；留在集合里只会让它无界增长。
    this.#transports.delete(transport);
    if (this.#intentional.has(transport)) return;
    this.log.event({ level: 'warn', kind: 'mcp.disconnect', summary: `${name} 连接断开，下一次 reconcile 会重连`, data: { server: name } });
  }

  /** 关一条连接。`client` 在时走 `client.close()`（顺带做 SDK 侧的 pending-request 清理）。 */
  #discard(transport: McpTransport, client?: Client): Promise<void> {
    this.#intentional.add(transport);
    const done = (async () => {
      try { await (client ? client.close() : transport.close()); }
      catch { /* 关不掉的（子进程已消失、http 已断）照旧要从账上摘掉 */ }
      finally { this.#transports.delete(transport); }
    })();
    this.#closing.add(done);
    void done.finally(() => this.#closing.delete(done));
    return done;
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

  /**
   * 整体串行。一次 `mcp.servers` 写入会触发**两条重叠**的 reconcile —— 端点自己 `await` 一条，
   * `config.changed` 的订阅者在 `loadConfig` 落地后再来一条。不串行化的话两条会一起 spawn
   * 子进程，而只有后来的那个进得了 `#clients`（docs/28 · L-EXT-03）。
   * 键与 `connect()` 的不同：reconcile 持锁期间嵌套去取 `server:<name>` 不会自等。
   */
  async reconcile(): Promise<void> {
    return this.#mutex.run(RECONCILE_KEY, () => this.#reconcile());
  }

  async #reconcile(): Promise<void> {
    const config = this.#config();
    const wanted = config.enabled
      ? new Set((config.servers as unknown as ServerConfig[]).filter((server) => server.enabled !== false).map((server) => server.name))
      : new Set<string>();
    // 从配置里移除或被停用的 server 必须断开：只 unregister 工具的话，stdio 子进程会一直挂着，
    // 而下一次 reconcile 又会把它当成「已连接」复用（docs/20 · W-MCP-01）。
    for (const [name, entry] of [...this.#clients]) {
      if (wanted.has(name)) continue;
      this.#clients.delete(name);
      await this.#discard(entry.transport, entry.client);
      this.db.prepare("UPDATE mcp_servers SET state='disabled',updated_at=? WHERE name=?").run(Date.now(), name);
      this.log.event({ level: 'info', kind: 'mcp.disconnect', summary: `${name} removed from configuration`, data: { server: name } });
    }
    const targets = config.enabled ? (config.servers as unknown as ServerConfig[]).filter((server) => server.enabled !== false) : [];
    // 配置里已经没有的 server，它的凭据不该永远留着（照 `SkillLoader.scan()` 末尾清陈行的做法）。
    // 判据用**整份 servers** 而不是 `targets`：停用一台 server 不该把它的 token 一起丢掉，
    // 否则「停一下再开」等于要人重新登录一次。
    this.authDeps?.store.prune((config.servers as unknown as ServerConfig[]).map((server) => server.name));
    // **先并行 discover 到临时表，全部落定之后才在一个同步段里换掉注册表。** 反过来（先
    // `unregisterBySource` 再逐台串行 await）会给模型开一段「一个 MCP 工具都没有」的窗口，
    // 每台最长 `connectTimeoutMs`（默认 15s），而 `mcp.healthCheckCron` 默认 5 分钟就开一次
    // （docs/28 · L-EXT-05）。并行还顺带把启动时的总等待从「累加」变成「取最大」。
    const settled = await Promise.allSettled(targets.map((server) => this.discover(server)));
    this.registry?.unregisterBySource('mcp');
    this.#tools.clear();
    for (const [index, result] of settled.entries()) {
      const server = targets[index]!;
      if (result.status === 'rejected') { this.#recordDown(server, result.reason); continue; }
      // **schema 转换也在这个 try 里。** 它此前在循环外统一做，于是一台 server 的畸形
      // `inputSchema` 会让异常从 `reconcile()` 抛出去：`POST /api/mcp` 500，而
      // `main.ts` 的 `await mcp.reconcile()` 在启动路径上 —— 整个进程起不来（docs/27 · C-04）。
      // 单条工具转换失败就退回宽松放行那一个工具，别拖着同一台 server 的其余工具。
      try {
        for (const entry of result.value) this.#tools.set(entry.name, entry);
        if (this.registry) for (const entry of result.value) this.#register(entry);
        this.log.event({ level: 'info', kind: 'mcp.connect', summary: `${server.name} connected`, data: { server: server.name, transport: server.transport } });
      } catch (error) { this.#recordDown(server, error); }
    }
  }

  /**
   * 判死。**「要登录」单独一档**：它跟「连不上」在运维动作上是两件完全不同的事 —— 前者要人去
   * 点一次授权，后者要人去看命令行/网络。此前两者挤在 `down` 里，而 `last_error` 是一句
   * `Error POSTing to endpoint: <原始响应体>`，从里面读不出该做什么。
   */
  #recordDown(server: ServerConfig, error: unknown): void {
    const authFailure = server.transport === 'http' && looksLikeAuthFailure(error);
    const state = authFailure ? 'needs_auth' : 'down';
    const message = authFailure ? this.#authHint(server) : error instanceof Error ? error.message : String(error);
    this.db.prepare(`INSERT INTO mcp_servers(name,transport,min_role,enabled,timeout_ms,state,last_error,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state,last_error=excluded.last_error,updated_at=excluded.updated_at`).run(server.name, server.transport, server.minRole ?? this.#config().defaultMinRole, 1, server.timeoutMs ?? 30_000, state, message, Date.now());
    this.log.event({ level: 'warn', kind: authFailure ? 'mcp.auth' : 'mcp.error', summary: `${server.name}: ${message}`, data: { server: server.name, ...(authFailure ? { authMode: server.auth?.mode ?? 'none' } : {}) } });
  }

  /** 「要登录」这一档要说清**下一步做什么**，而下一步取决于 `auth.mode` 配的是哪一种。 */
  #authHint(server: ServerConfig): string {
    switch (server.auth?.mode) {
      case 'oauth': return '这台 server 要求登录。在扩展页点〔登录〕走一遍浏览器授权。';
      case 'bearer': return this.authDeps?.store.bearerToken(server.name)
        ? '这台 server 拒收了保存的 token（过期或被撤销）。在扩展页重新填一次。'
        : '这台 server 要求登录，而本地没有保存 token。在扩展页填一个。';
      default: return '这台 server 要求登录，而它的 auth.mode 是 none。编辑它，选 bearer（填 token）或 oauth（浏览器授权）。';
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
    for (const entry of [...this.#clients.values()]) void this.#discard(entry.transport, entry.client);
    this.#clients.clear();
    // `#clients` 之外还挂着的那些：握手超时被丢掉的、被顶替的、竞态泄漏的。漏掉一条就是漏掉
    // 一个 refed 的 stdio 子进程，而 `shutdown()` 只设 `process.exitCode` —— event loop 不空，
    // 进程就是不退（实测 >100 秒，docs/28 · L-EXT-03）。
    for (const transport of [...this.#transports]) void this.#discard(transport);
    await Promise.all([...this.#closing]);
  }
}
