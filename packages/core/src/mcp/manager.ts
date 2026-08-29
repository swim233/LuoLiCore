import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { minimatch } from "minimatch";
import { z } from "zod";
import { jsonSchemaToZod } from "./schema.js";
import {
  McpOAuthProvider,
  beginMcpAuthorization,
  completeMcpAuthorization,
  looksLikeAuthFailure,
  type PendingAuthorizations,
} from "./oauth.js";
import { KeyedMutex } from "../turn/keyed-mutex.js";
import type { Role } from "@luoli/shared";
import type { ToolRegistry } from "../tools/registry.js";
import type { Config, LogSink } from "../index.js";
import type { McpAuthRepository, Sqlite } from "@luoli/db";

export interface McpServerAuthConfig {
  mode: "none" | "bearer" | "oauth";
  scope?: string | undefined;
  clientId?: string | undefined;
  issuer?: string | undefined;
}

/**
 * 一台 server 的连接参数。可选项一律写作 `?: T | undefined` 而非 `?: T`：
 * 根 tsconfig 启用了 `exactOptionalPropertyTypes`，而调用方持有的是 zod 产出的
 * `minRole?: Role | undefined` —— 不带 `| undefined` 时每个调用点都需额外做一次类型断言。
 */
export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
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
 * 登录相关的可插拔组件。整块可选：`tests/mcp.runtime.test.ts` 与 `api.contract` 都不需要它，
 * 而 `McpAuthRepository` 需要一个 `Secrets`，那是只有 `main.ts` 才能装配的对象。
 * 未提供时 `auth.mode` 只有 `none` 有意义，另两种在连接时如实报错而不是静默降级。
 */
export interface McpAuthDependencies {
  store: McpAuthRepository;
  pending: PendingAuthorizations;
  /** `webui.publicUrl`，每次实时读取 —— 运维在界面上补全它之后不应还需重启才能登录。 */
  publicUrl: () => string;
}

/**
 * 连接标识：url / command / args / env / headers 中任何一项变化，缓存的 client 即不再对应该服务器。
 *
 * `authVersion` 是必需项。凭据从 `headers` 迁入 `mcp_auth` 之后，轮换一次 token
 * 不会改变上述任何一项，于是 `existing.fingerprint === print` 命中旧连接、持续使用已作废的
 * token；而界面上该 server 仍显示为已连接。
 */
function fingerprint(server: ServerConfig, authVersion: number): string {
  return JSON.stringify([
    server.transport,
    server.command ?? null,
    server.args ?? [],
    server.env ?? {},
    server.url ?? null,
    server.headers ?? {},
    server.auth?.mode ?? "none",
    authVersion,
  ]);
}

/** SDK 未从 exports 中导出 `Transport` 接口，而此处只需要这三个成员 —— stdio 与 streamable-http
 *  两个 transport 均具备。挂载 onclose/onerror 必须在 `client.connect()` 之前：
 *  `Protocol.connect()` 会将已存在的这两个回调串接到自身之前（sdk 1.30 `shared/protocol.js`），
 *  因此先挂载不会被覆盖，反之（connect 之后再挂载）会覆盖 SDK 自身的清理逻辑。 */
type McpTransport = {
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
};

/**
 * `reconcile()` 与 `connect()` 各占一个键空间，两者必须不同 —— `reconcile()` 持锁期间会进入
 * `connect()` 获取 `server:<name>`，同键即构成自等待。server 名匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，
 * 不会与带 `~` / `:` 的这两类键冲突。
 */
const RECONCILE_KEY = "~reconcile";
const connectKey = (name: string): string => `server:${name}`;

/** 超时后 reject，但不取消底层操作 —— MCP SDK 的 connect 没有 abort 入口。调用方随即将该
 *  server 记为 down，并立即关闭 transport（否则 `mcp-health` 每 5 分钟就会为一台可启动但
 *  无法完成握手的 server 留下一个子进程，docs/28 · L-EXT-03）。 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class McpManager {
  /**
   * 连接状态整体是 per-instance 的：stdio 子进程的句柄无法跨进程边界，其它实例既看不到
   * 也无法关闭。因此 `alive` / `#transports` 不属于 `docs/01 §3.1` 所述的进程内状态当唯一真相 ——
   * 真相仍在 `mcp.servers` 配置与 `mcp_servers` 表中，此处只是本实例持有的那几条连接。
   */
  readonly #clients = new Map<
    string,
    {
      client: Client;
      transport: McpTransport;
      fingerprint: string;
      alive: boolean;
    }
  >();
  /** 全部已创建且未关闭完成的 transport。`close()` 关闭的是它而非仅 `#clients`：握手超时被丢弃的、
   *  被替换的、竞态泄漏的都不在 `#clients` 中，而 SDK 的 `StdioClientTransport` 不对子进程执行
   *  unref —— 残留一条 refed handle 即可使 `shutdown()` 无法返回（docs/28 · L-EXT-03）。 */
  readonly #transports = new Set<McpTransport>();
  /** 正在关闭中的条目。`close()` 必须等待这些 promise，不能仅再调用一次 `transport.close()`：
   *  第一次调用已移除 `_process`，第二次会立即返回 —— 等同于未等待子进程终止。 */
  readonly #closing = new Set<Promise<void>>();
  /** 主动关闭的 transport。onclose 据此区分运维停用或指纹变更与子进程自行终止，
   *  只有后者需要告警 —— 否则每次正常关停都会产生一条连接意外断开的记录。 */
  readonly #intentional = new WeakSet<McpTransport>();
  readonly #mutex = new KeyedMutex();
  readonly #tools = new Map<
    string,
    {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      minRole: Role;
      call: (input: unknown) => Promise<unknown>;
    }
  >();
  readonly #config: () => Readonly<Config["mcp"]>;
  /** config 传入 getter 时每次 reconcile 都取最新值：使用启动快照的话，新增 MCP server 必须重启，
   *  且 `/api/mcp/:name/reconnect` 重连的永远是启动时的那份列表（docs/20 · W-CFG-02）。 */
  constructor(
    private readonly db: Sqlite,
    config: Readonly<Config["mcp"]> | (() => Readonly<Config["mcp"]>),
    private readonly log: LogSink,
    private registry?: ToolRegistry,
    private readonly authDeps?: McpAuthDependencies,
  ) {
    this.#config = typeof config === "function" ? config : () => config;
  }
  bindRegistry(registry: ToolRegistry): void {
    this.registry = registry;
  }

  /** 该 server 当前凭据的版本号。未接入凭据库时恒为 0 —— 相当于指纹中不含该项。 */
  #authVersion(name: string): number {
    return this.authDeps?.store.version(name) ?? 0;
  }

  #providerFor(server: ServerConfig): McpOAuthProvider {
    if (!this.authDeps)
      throw new Error(
        `${server.name} 已配置 auth.mode=oauth，但当前运行时未装配凭据库（可能缺少 LUOLI_MASTER_KEY）`,
      );
    this.authDeps.store.ensureOAuth(server.name, server.auth?.scope ?? null);
    return new McpOAuthProvider(
      server.name,
      this.authDeps.store,
      this.authDeps.pending,
      {
        publicUrl: this.authDeps.publicUrl(),
        ...(server.auth?.scope ? { scope: server.auth.scope } : {}),
        ...(server.auth?.clientId ? { clientId: server.auth.clientId } : {}),
      },
    );
  }

  /**
   * 发起一次授权。将授权 URL 返回给界面 —— 由用户点击后跳转，`reconcile()` 自身不打开浏览器。
   * 已有可用 token 时 SDK 直接返回 `'AUTHORIZED'`，此时顺带重连一次即可。
   */
  async authorize(
    server: ServerConfig,
  ): Promise<{
    status: "AUTHORIZED" | "REDIRECT";
    authorizationUrl: string | null;
    expiresAt: number | null;
  }> {
    if (server.transport !== "http" || !server.url)
      throw new Error(`${server.name} 不是 http transport，不支持 OAuth`);
    const provider = this.#providerFor(server);
    if (!provider.redirectUrl)
      throw new Error(
        "未配置 `webui.publicUrl`，OAuth 回调无可注册的地址。请先在设置页填写该项再登录。",
      );
    const status = await beginMcpAuthorization(
      provider,
      server.url,
      server.auth?.scope,
    );
    const entry = this.authDeps!.pending.peek(server.name);
    this.log.event({
      level: "info",
      kind: "mcp.auth",
      summary: `${server.name} ${status === "AUTHORIZED" ? "已有可用凭据" : "开始授权"}`,
      data: { server: server.name, status },
    });
    return {
      status,
      authorizationUrl: entry?.authorizationUrl ?? null,
      expiresAt: entry?.expiresAt ?? null,
    };
  }

  /** 回调阶段：用 code 换取 token，成功后对该台执行重连。 */
  async completeAuthorization(
    server: ServerConfig,
    code: string,
  ): Promise<"AUTHORIZED" | "REDIRECT"> {
    if (server.transport !== "http" || !server.url)
      throw new Error(`${server.name} 不是 http transport，不支持 OAuth`);
    const status = await completeMcpAuthorization(
      this.#providerFor(server),
      server.url,
      code,
    );
    this.log.event({
      level: status === "AUTHORIZED" ? "info" : "warn",
      kind: "mcp.auth",
      summary: `${server.name} 换取 token ${status === "AUTHORIZED" ? "成功" : "未完成"}`,
      data: { server: server.name, status },
    });
    return status;
  }

  /** 注销：清除全部凭据与 pending 状态并立即断开。下一次 reconcile 会将其重新记为 `needs_auth`。 */
  async signOut(server: ServerConfig): Promise<void> {
    if (!this.authDeps) return;
    this.authDeps.store.invalidate(server.name, "all");
    this.authDeps.pending.forget(server.name);
    const existing = this.#clients.get(server.name);
    if (existing) {
      this.#clients.delete(server.name);
      await this.#discard(existing.transport, existing.client);
    }
    this.log.event({
      level: "info",
      kind: "mcp.auth",
      summary: `${server.name} 已注销`,
      data: { server: server.name },
    });
  }

  /**
   * 按 server 名串行执行。此处才是两条 reconcile 各自 spawn 一个子进程的真正入口：查询缓存与
   * `#clients.set` 之间存在 stdio 握手的 await，两条并发的 connect 都会在此之前看到
   * `existing === undefined`，而 `set` 只保留后到达的那个 —— 前一个子进程从此无法被引用
   * （docs/28 · L-EXT-03）。
   */
  async connect(server: ServerConfig): Promise<Client> {
    return this.#mutex.run(connectKey(server.name), () =>
      this.#connect(server),
    );
  }

  async #connect(server: ServerConfig): Promise<Client> {
    const print = fingerprint(server, this.#authVersion(server.name));
    const existing = this.#clients.get(server.name);
    // 仅指纹相同不足，还需判定连接活性：子进程被 kill -9 之后该缓存会永久命中，而用已失效的
    // client 调用 `listTools()` 必然抛出 —— cron 与 `/api/mcp/:name/reconnect` 因此都成为死路，
    // 重连按钮在结构上无法产生任何效果（docs/28 · L-EXT-02）。
    if (existing && existing.fingerprint === print && existing.alive)
      return existing.client;
    // 指纹变更的以及已判定失效的连接都走此路径：先关闭再创建。若判定失效后直接从 `#clients`
    // 删除，下一次 connect 看到的是空位，于是再次 spawn 一个，而上一个的 handle 已无法获取。
    if (existing) {
      this.#clients.delete(server.name);
      await this.#discard(existing.transport, existing.client);
    }
    const client = new Client({ name: "luolicore", version: "0.1.0" });
    const transport: McpTransport =
      server.transport === "stdio"
        ? // `stderr: 'pipe'`：SDK 的默认值是 `'inherit'`，导致 server 输出的授权链接提示、
          // 缺少某个 token 的提示直接写入 bot 进程的 stderr —— 不进入 LogSink、不写库、
          // 界面上无任何显示，而这恰恰是连接失败原因最常见的所在。
          new StdioClientTransport({
            command: server.command!,
            args: server.args ?? [],
            stderr: "pipe",
            ...(server.env ? { env: server.env } : {}),
          })
        : new StreamableHTTPClientTransport(
            new URL(server.url!),
            this.#httpOptions(server),
          );
    if (server.transport === "stdio") this.#pipeStderr(server.name, transport);
    this.#transports.add(transport);
    transport.onclose = () => this.#markDead(server.name, transport);
    // 只有 onclose 判定为失效。transport 的 onerror 也会因单行 JSON 解析失败、stdin 写入失败而
    // 触发，将其一律视为失效会使一台正常的 server 每 5 分钟被重启一次，而重启本身即是泄漏来源。
    transport.onerror = (error) =>
      this.log.event({
        level: "warn",
        kind: "mcp.error",
        summary: `${server.name}: ${error.message}`,
        data: { server: server.name },
      });
    // `mcp.connectTimeoutMs`：握手本身也需设上界。一台 stdio server 卡在启动阶段（等待一个不存在的
    // 凭据、DNS 不通）会使 `reconcile()` 永不返回，而 reconcile 位于启动路径上 —— 整个进程无法启动。
    // `server.timeoutMs` 控制的是 callTool，两者不是同一回事。
    const connectTimeoutMs = this.#config().connectTimeoutMs;
    try {
      await withTimeout(
        client.connect(transport as Parameters<Client["connect"]>[0]),
        connectTimeoutMs,
        `${server.name} connect`,
      );
      this.#clients.set(server.name, {
        client,
        transport,
        fingerprint: print,
        alive: true,
      });
      const tools = await withTimeout(
        client.listTools(),
        connectTimeoutMs,
        `${server.name} listTools`,
      );
      this.db
        .prepare(
          `INSERT INTO mcp_servers(name,transport,command,args_json,env_json,url,headers_json,min_role,enabled,tool_allow_json,tool_deny_json,timeout_ms,state,tools_json,connected_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET state='up',tools_json=excluded.tools_json,connected_at=excluded.connected_at,updated_at=excluded.updated_at,last_error=NULL`,
        )
        .run(
          server.name,
          server.transport,
          server.command ?? null,
          JSON.stringify(server.args ?? []),
          JSON.stringify(server.env ?? {}),
          server.url ?? null,
          JSON.stringify(server.headers ?? {}),
          server.minRole ?? this.#config().defaultMinRole,
          server.enabled === false ? 0 : 1,
          JSON.stringify(server.toolAllow ?? []),
          JSON.stringify(server.toolDeny ?? []),
          server.timeoutMs ?? 30_000,
          "up",
          JSON.stringify(tools.tools),
          Date.now(),
          Date.now(),
        );
      return client;
    } catch (error) {
      // 失败的连接立即回收，但不 await：stdio 的 close 需经 stdin.end → SIGTERM → SIGKILL
      // 三级（SDK 中各 2 秒），而 reconcile 位于启动路径上。`#closing` 代 `close()` 保存该 promise。
      if (this.#clients.get(server.name)?.transport === transport)
        this.#clients.delete(server.name);
      void this.#discard(transport, client);
      throw error;
    }
  }

  /**
   * http transport 的构造参数。凭据在此注入，不经过配置 —— `mcp.servers` 会进入
   * `config_revisions` 与配置导出，而按键名判密的正则无法匹配 `Authorization`。
   */
  #httpOptions(
    server: ServerConfig,
  ):
    | {
        requestInit?: { headers: Record<string, string> };
        authProvider?: McpOAuthProvider;
      }
    | undefined {
    const mode = server.auth?.mode ?? "none";
    const headers = { ...(server.headers ?? {}) };
    if (mode === "bearer") {
      const token = this.authDeps?.store.bearerToken(server.name);
      // 获取不到时不构造空 Bearer 发送：那样对方返回的是 token 无效，而实际原因是本地没有该凭据
      // （未配置，或更换 LUOLI_MASTER_KEY 后无法解密）。让它照常返回 401，随后记为 needs_auth。
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (mode === "oauth")
      return {
        authProvider: this.#providerFor(server),
        ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
      };
    return Object.keys(headers).length
      ? { requestInit: { headers } }
      : undefined;
  }

  /**
   * 将 stdio server 的 stderr 逐行收入日志。这是需要登录的 stdio server 唯一能提供的线索 ——
   * 这类 server 的登录由其自身在带外完成（沿用 harness 的先例，docs/07 §4.5），我方能做的
   * 就是不丢弃它的输出。
   *
   * 逐行而非整块处理：一条 500 KB 的调用栈会撑爆日志行，而 `LogSink` 的载荷需要落盘。
   */
  #pipeStderr(name: string, transport: McpTransport): void {
    const stream = (
      transport as {
        stderr?: { on(event: "data", listener: (chunk: Buffer) => void): void };
      }
    ).stderr;
    if (!stream) return;
    let buffered = "";
    stream.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      // 最后一段可能是半行，保留到下一块处理。上界 8 KB：不输出换行的 server 不应使该缓冲无限增长。
      buffered = (lines.pop() ?? "").slice(-8192);
      for (const line of lines) {
        const text = line.trim();
        if (text)
          this.log.event({
            level: "warn",
            kind: "mcp.stderr",
            summary: `${name}: ${text.slice(0, 2000)}`,
            data: { server: name },
          });
      }
    });
  }

  /** 连接已断开。不从 `#clients` 删除，只标记为失效 —— 保留该条才能持有仍需关闭的 handle。 */
  #markDead(name: string, transport: McpTransport): void {
    const entry = this.#clients.get(name);
    if (entry && entry.transport === transport) entry.alive = false;
    // 已关闭，`close()` 无需再处理它；保留在集合中只会使其无限增长。
    this.#transports.delete(transport);
    if (this.#intentional.has(transport)) return;
    this.log.event({
      level: "warn",
      kind: "mcp.disconnect",
      summary: `${name} 连接断开，下一次 reconcile 会重连`,
      data: { server: name },
    });
  }

  /** 关闭一条连接。`client` 存在时走 `client.close()`（同时完成 SDK 侧的 pending-request 清理）。 */
  #discard(transport: McpTransport, client?: Client): Promise<void> {
    this.#intentional.add(transport);
    const done = (async () => {
      try {
        await (client ? client.close() : transport.close());
      } catch {
        /* 无法关闭的（子进程已消失、http 已断开）同样要从记录中移除 */
      } finally {
        this.#transports.delete(transport);
      }
    })();
    this.#closing.add(done);
    void done.finally(() => this.#closing.delete(done));
    return done;
  }

  async discover(
    server: ServerConfig,
  ): Promise<
    Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      minRole: Role;
      call: (input: unknown) => Promise<unknown>;
    }>
  > {
    const client = await this.connect(server);
    const tools = (await client.listTools()).tools
      .filter(
        (tool) =>
          !server.toolAllow?.length ||
          server.toolAllow.some((pattern) => minimatch(tool.name, pattern)),
      )
      .filter(
        (tool) =>
          !server.toolDeny?.some((pattern) => minimatch(tool.name, pattern)),
      );
    return tools.map((entry) => ({
      name: `mcp__${server.name}__${entry.name}`,
      description: entry.description ?? `MCP ${server.name}/${entry.name}`,
      inputSchema: entry.inputSchema as Record<string, unknown>,
      minRole:
        (server.minRole as Role | undefined) ?? this.#config().defaultMinRole,
      call: async (input) => {
        const started = performance.now();
        // timeoutMs 此前只写入 mcp_servers 表，从未用于限制 callTool：一台卡住的 MCP server
        // 可将整轮拖至轮次超时（docs/20 · W-MCP-01）。
        try {
          return await client.callTool(
            { name: entry.name, arguments: input as Record<string, unknown> },
            undefined,
            { timeout: server.timeoutMs ?? 30_000 },
          );
        } finally {
          this.log.event({
            level: "info",
            kind: "tool.mcp",
            summary: `${server.name}/${entry.name}`,
            durationMs: Math.round(performance.now() - started),
          });
        }
      },
    }));
  }

  /**
   * 整体串行执行。一次 `mcp.servers` 写入会触发两条重叠的 reconcile —— 端点自身 `await` 一条，
   * `config.changed` 的订阅者在 `loadConfig` 生效后再触发一条。不串行化的话两条会同时 spawn
   * 子进程，而只有后到达的那个能进入 `#clients`（docs/28 · L-EXT-03）。
   * 键与 `connect()` 不同：reconcile 持锁期间嵌套获取 `server:<name>` 不会自等待。
   */
  async reconcile(): Promise<void> {
    return this.#mutex.run(RECONCILE_KEY, () => this.#reconcile());
  }

  async #reconcile(): Promise<void> {
    const config = this.#config();
    const wanted = config.enabled
      ? new Set(
          (config.servers as unknown as ServerConfig[])
            .filter((server) => server.enabled !== false)
            .map((server) => server.name),
        )
      : new Set<string>();
    // 从配置中移除或被停用的 server 必须断开：仅 unregister 工具的话，stdio 子进程会持续存在，
    // 而下一次 reconcile 又会将其视为已连接并复用（docs/20 · W-MCP-01）。
    for (const [name, entry] of [...this.#clients]) {
      if (wanted.has(name)) continue;
      this.#clients.delete(name);
      await this.#discard(entry.transport, entry.client);
      this.db
        .prepare(
          "UPDATE mcp_servers SET state='disabled',updated_at=? WHERE name=?",
        )
        .run(Date.now(), name);
      this.log.event({
        level: "info",
        kind: "mcp.disconnect",
        summary: `${name} removed from configuration`,
        data: { server: name },
      });
    }
    const targets = config.enabled
      ? (config.servers as unknown as ServerConfig[]).filter(
          (server) => server.enabled !== false,
        )
      : [];
    // 配置中已不存在的 server，其凭据不应长期保留（沿用 `SkillLoader.scan()` 末尾清理陈旧行的做法）。
    // 判据使用完整的 servers 列表而非 `targets`：停用一台 server 不应连带丢弃其 token，
    // 否则停用后重新启用即要求用户再次登录。
    this.authDeps?.store.prune(
      (config.servers as unknown as ServerConfig[]).map(
        (server) => server.name,
      ),
    );
    // 先并行 discover 到临时表，全部完成后才在一个同步段内替换注册表。反向做法（先
    // `unregisterBySource` 再逐台串行 await）会给模型留下一段没有任何 MCP 工具的窗口，
    // 每台最长 `connectTimeoutMs`（默认 15s），而 `mcp.healthCheckCron` 默认每 5 分钟触发一次
    // （docs/28 · L-EXT-05）。并行同时将启动时的总等待从累加变为取最大值。
    const settled = await Promise.allSettled(
      targets.map((server) => this.discover(server)),
    );
    this.registry?.unregisterBySource("mcp");
    this.#tools.clear();
    for (const [index, result] of settled.entries()) {
      const server = targets[index]!;
      if (result.status === "rejected") {
        this.#recordDown(server, result.reason);
        continue;
      }
      // schema 转换同样位于该 try 内。它此前在循环外统一执行，导致一台 server 的畸形
      // `inputSchema` 会使异常从 `reconcile()` 抛出：`POST /api/mcp` 返回 500，而
      // `main.ts` 的 `await mcp.reconcile()` 位于启动路径上 —— 整个进程无法启动（docs/27 · C-04）。
      // 单条工具转换失败时对该工具退回宽松放行，不影响同一 server 的其余工具。
      try {
        for (const entry of result.value) this.#tools.set(entry.name, entry);
        if (this.registry)
          for (const entry of result.value) this.#register(entry);
        this.log.event({
          level: "info",
          kind: "mcp.connect",
          summary: `${server.name} connected`,
          data: { server: server.name, transport: server.transport },
        });
      } catch (error) {
        this.#recordDown(server, error);
      }
    }
  }

  /**
   * 判定失效。需要登录单独作为一档：它与连接失败在运维动作上完全不同 —— 前者需要用户执行一次
   * 授权，后者需要检查命令行或网络。此前两者合并在 `down` 中，而 `last_error` 是一句
   * `Error POSTing to endpoint: <原始响应体>`，无法从中判断应采取的操作。
   */
  #recordDown(server: ServerConfig, error: unknown): void {
    const authFailure =
      server.transport === "http" && looksLikeAuthFailure(error);
    const state = authFailure ? "needs_auth" : "down";
    const message = authFailure
      ? this.#authHint(server)
      : error instanceof Error
        ? error.message
        : String(error);
    this.db
      .prepare(
        `INSERT INTO mcp_servers(name,transport,min_role,enabled,timeout_ms,state,last_error,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state,last_error=excluded.last_error,updated_at=excluded.updated_at`,
      )
      .run(
        server.name,
        server.transport,
        server.minRole ?? this.#config().defaultMinRole,
        1,
        server.timeoutMs ?? 30_000,
        state,
        message,
        Date.now(),
      );
    this.log.event({
      level: "warn",
      kind: authFailure ? "mcp.auth" : "mcp.error",
      summary: `${server.name}: ${message}`,
      data: {
        server: server.name,
        ...(authFailure ? { authMode: server.auth?.mode ?? "none" } : {}),
      },
    });
  }

  /** 需要登录这一档必须说明下一步操作，而下一步取决于 `auth.mode` 的取值。 */
  #authHint(server: ServerConfig): string {
    switch (server.auth?.mode) {
      case "oauth":
        return "该 server 要求登录。在扩展页点击〔登录〕完成浏览器授权。";
      case "bearer":
        return this.authDeps?.store.bearerToken(server.name)
          ? "该 server 拒绝了已保存的 token（已过期或已撤销）。请在扩展页重新填写。"
          : "该 server 要求登录，而本地没有保存 token。请在扩展页填写。";
      default:
        return "该 server 要求登录，而其 auth.mode 为 none。编辑该 server，选择 bearer（填写 token）或 oauth（浏览器授权）。";
    }
  }

  /**
   * 入参 schema 必须真正接入：替换为通配后模型只能猜测参数名，猜错时 safeParse 也不会拦截
   * （docs/20 · W-MCP-01）。而转换本身也可能抛出（畸形 schema、zod 拒绝的字面量），因此降级的
   * 粒度是单个工具 —— 该 server 的其余工具照常携带精确 schema 进入目录（docs/27 · C-04）。
   */
  #register(entry: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    minRole: Role;
    call: (input: unknown) => Promise<unknown>;
  }): void {
    let inputSchema: z.ZodTypeAny;
    try {
      inputSchema = jsonSchemaToZod(entry.inputSchema);
    } catch (error) {
      inputSchema = z.record(z.unknown());
      this.log.event({
        level: "warn",
        kind: "mcp.error",
        summary: `${entry.name} 的入参 schema 转换失败，已退回宽松放行`,
        data: {
          tool: entry.name,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    this.registry!.registerExternal({
      name: entry.name,
      description: entry.description,
      inputSchema,
      minRole: entry.minRole,
      source: "mcp",
      execute: entry.call,
    });
  }

  toolEntries(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    minRole: Role;
    call: (input: unknown) => Promise<unknown>;
  }> {
    return [...this.#tools.values()];
  }

  async close(): Promise<void> {
    for (const entry of [...this.#clients.values()])
      void this.#discard(entry.transport, entry.client);
    this.#clients.clear();
    // `#clients` 之外仍存在的连接：握手超时被丢弃的、被替换的、竞态泄漏的。遗漏一条即遗漏
    // 一个 refed 的 stdio 子进程，而 `shutdown()` 只设置 `process.exitCode` —— event loop 不空，
    // 进程即不会退出（实测超过 100 秒，docs/28 · L-EXT-03）。
    for (const transport of [...this.#transports])
      void this.#discard(transport);
    await Promise.all([...this.#closing]);
  }
}
