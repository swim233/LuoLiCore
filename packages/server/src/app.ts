import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import { Hono } from "hono";
import YAML from "yaml";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import type {
  AgentManager,
  Config,
  ConfigChangedEvent,
  ConfigStore,
  ContextEngine,
  DatabaseApprovalBroker,
  EventBus,
  LogSink,
  LwWorkerRuntimeEvent,
  MaintenanceService,
  McpManager,
  MemoryStore,
  ModelCatalog,
  PluginManager,
  PromptDocuments,
  ProviderStore,
  Sandbox,
  ScheduleUpdateRequest,
  SkillLoader,
  SkillWriteInput,
  TurnRegistry,
} from "@luoli/core";
import {
  ALIAS_NAME_PATTERN,
  CONFIG_ENUM_NOTES,
  HOT_RELOADABLE_CONFIG_KEYS,
  chatCandidates,
  createScheduledJob,
  scheduledJobView,
  testApprovalRules,
  toolCallableBy,
  updateScheduledJob,
  KNOWN_UNIMPLEMENTED_CONFIG_KEYS,
  TOOL_POLICY,
  aliasSettingsSchema,
  checkWakeword,
  configSchema as runtimeConfigSchema,
  envPinnedConfigKeys,
  perChatConfig,
  probeProvider,
  quotaBucket,
  rejectedWakewords,
} from "@luoli/core";
import {
  APPROVAL_POLICIES,
  BUNDLED_SKILLS,
  MCP_OAUTH_CALLBACK_PATH,
  SkillPackageError,
  effectiveToolPolicy,
  installSkillPackage,
  looksSecret,
  persistMcpServers as persistMcpServersShared,
  publicConfig,
  relaxedFields,
  revisionJson,
} from "@luoli/core";
import type {
  CatalogIndex,
  ContainerManager,
  CustomToolManager,
  ModelMetadata,
  PendingAuthorizations,
  ProviderProbe,
  ToolOverride,
  ToolRegistry,
} from "@luoli/core";
import type {
  ArchiveRepository,
  CustomToolRepository,
  McpAuthRepository,
  OperationsRepository,
  PrincipalRepository,
  ScheduleRepository,
  ScheduledJob,
  Sqlite,
} from "@luoli/db";
import {
  decodeLogPayload,
  deleteAppKv,
  modelAliasKey,
  readAppKv,
  writeConfigRows as writeConfigRowsToDatabase,
} from "@luoli/db";
import {
  assignDotted,
  parsePrincipal,
  readDotted,
  ROLES,
  TG_ID_PATTERN,
  type Role,
} from "@luoli/shared";
import type { EventStreamRegistry } from "./events.js";

export interface PromptPreviewResult {
  key: string;
  role: Role;
  instructions: string;
  /** `cached=false` 的块在缓存断点之后，每轮都要重新计费（docs/06 §1）。 */
  blocks: Array<{
    name: string;
    tokens: number;
    content: string;
    truncated: boolean;
    cached: boolean;
  }>;
  totalTokens: number;
  context: { messages: number; tokens: number };
}

export type WorkerDryRunEvent =
  | LwWorkerRuntimeEvent
  | { type: "final"; summary: string; fullRef: string; truncated: boolean }
  | { type: "error"; message: string };

export interface ServerDependencies {
  config: Readonly<Config> | ConfigStore;
  db: Sqlite;
  operations: OperationsRepository;
  principals: PrincipalRepository;
  archive: ArchiveRepository;
  context: ContextEngine;
  providers: ProviderStore;
  modelCatalog?: ModelCatalog;
  approvals: DatabaseApprovalBroker;
  rebuildModels?: () => void;
  maintenance: MaintenanceService;
  /** 用量聚合（`GET /api/usage/report`）。缺它时该端点返回空数组而不是 500，明细表照常。 */
  ledger?: {
    report(
      from: number,
      to: number,
      groupBy: "day" | "chat" | "user" | "model" | "alias" | "agent",
      timezone?: string,
    ): unknown[];
  };
  /** `POST /api/restart` 的落点。优雅关闭那套在 apps/bot，服务器包只负责把请求转过去。 */
  restart?: (reason: string) => Promise<void> | void;
  /**
   * 定时任务的运行时（`ScheduleRepository` + `ScheduledJobRunner`）。缺它时那四个端点返回
   * `schedule_unavailable`，界面据此提示该部署未接入定时任务运行时，而不是显示零条任务：
   * 空列表与读不到对运维是两种结论（docs/16 §5：摘除比伪造安全）。
   */
  schedules?: {
    jobs: ScheduleRepository;
    runner: {
      loaded: boolean;
      register(job: ScheduledJob): boolean;
      unregister(id: string): boolean;
      nextRun(id: string): Date | null;
      fire(id: string): Promise<void>;
    };
  };
  events: EventBus;
  memory?: MemoryStore;
  promptDocuments?: PromptDocuments;
  skills?: SkillLoader;
  plugins?: PluginManager;
  mcp?: McpManager;
  /**
   * MCP 凭据库与待授权表。缺它时四条 auth 端点一律返回 `mcp_auth_unavailable`（缺
   * `LUOLI_MASTER_KEY` 的部署即此形态）：不伪造保存成功，参照 `PUT /api/quota` 返回
   * `not_implemented` 的先例。
   */
  mcpAuth?: { store: McpAuthRepository; pending: PendingAuthorizations };
  agents?: AgentManager;
  /**
   * 工具注册表。缺它时 `GET /api/tools` 退回 `TOOL_POLICY` 加覆盖层那份静态表：少了
   * MCP / plugin 注册进来的工具与每个工具声明的超时，但策略与启停仍然正确。
   */
  tools?: ToolRegistry;
  /** 自撰写工具的库与注册器。缺它时 `/api/custom-tools` 一律返回 `not_implemented`：空列表与
   *  该部署未安装对运维是两种结论（docs/16 §5：摘除比伪造安全）。 */
  customTools?: CustomToolRepository;
  customToolManager?: CustomToolManager;
  turnRegistry?: TurnRegistry;
  sandbox?: Sandbox;
  eventStreams?: EventStreamRegistry;
  previewPrompt?: (
    key: string,
    role: Role,
  ) => PromptPreviewResult | Promise<PromptPreviewResult>;
  /**
   * lw-worker 的隔离试跑（`POST /api/workers/dryrun`）。没有 `name` 参数 —— 定义体系已删除，
   * 一次试跑要说清的只有任务本身与两个可选旋钮。
   */
  dryRunWorker?: (
    input: { task: string; tools?: string[]; modelAlias?: string },
    signal: AbortSignal,
    emit: (event: LwWorkerRuntimeEvent) => void | Promise<void>,
  ) => Promise<{ summary: string; fullRef: string; truncated: boolean }>;
  log: LogSink;
  configSchema: unknown;
  startedAt: number;
  setup: { token: string; expiresAt: number } | undefined;
}

interface AuthVariables {
  sessionId: string;
  csrf: string;
}

type ServerEnv = { Variables: AuthVariables };

function cookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const entry of header.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

const apiError = (
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 = 400,
) => ({ body: { ok: false as const, error: { code, message } }, status });

/**
 * 展开一律走 `assignDotted`：裸 `cursor[part]` 遇到 `__proto__` 会在校验之前污染 `Object.prototype`，
 * 此后每一次 `safeParse` 都会失败，一次已登录请求即可让配置面板永久不可用（docs/20 · W-CFG-01）。
 * 被拒的键必须返回 400，不得跳过后按成功处理：写入端是这条路径的最后一道闸。
 */
function mergeDotted(
  base: unknown,
  updates: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; key: string } {
  const clone = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates))
    if (!assignDotted(clone, key, value)) return { ok: false, key };
  return { ok: true, value: clone };
}
const invalidKey = (result: { ok: false; key: string }) =>
  apiError("invalid_config_key", `非法配置键：${result.key}`);
/**
 * 配置校验失败的统一信封。原因必须拼进 `message`：`details` 一直都在，而前端的 toast 只读取
 * `message`，界面上只剩一句配置校验失败，既看不出是哪一项、也看不出原因。跨字段的那几条
 * （`memory.softLimitTokens` 与硬上限、`concurrency.perKey` 与全局并发）因此退化为无信息的 400：
 * 报错内容是所改项与另一项冲突，而运维无从得知是哪两项。
 *
 * 只拼前两条：一次改一项时它即是全部；整棵树提交（YAML / 导入）时拼十条会把 toast 撑得过长，
 * 其余仍在 `details` 里，那一份是结构化的，可按 path 定位到具体控件。
 */
const invalidConfig = (
  summary: string,
  issues: ReadonlyArray<{
    path: ReadonlyArray<string | number>;
    message: string;
  }>,
) => {
  const details = issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  const head = details
    .slice(0, 2)
    .map((entry) =>
      entry.path ? `${entry.path} —— ${entry.message}` : entry.message,
    )
    .join("；");
  return {
    body: {
      ok: false as const,
      error: {
        code: "invalid_config",
        message:
          details.length > 2
            ? `${summary}（共 ${details.length} 条）：${head} 等`
            : `${summary}：${head}`,
        details,
      },
    },
    status: 400 as const,
  };
};
/**
 * 一棵配置树里的叶子路径，即 `PUT /api/config/yaml` 的落库粒度。按顶层段落库时 zod 已把每个
 * `.default()` 填满，写回的是填满之后的整棵子树，一次未作任何修改的往返即把当时的代码默认值
 * 永久固定（docs/28 · L-WEB-02）。
 *
 * 两条刻意的取舍：数组按叶子处理 —— `approval.rules` / `mcp.servers` / `agent.acp.agents` 是整块语义，
 * 逐下标落库既无人这样读取，也会被 `sortOverrideKeys` 拼回原样；空对象不产生叶子 —— 它表达的是
 * 此处不做任何覆盖，而写成一行 `{}` 会让 `writeConfigRows` 连带删除同一子树下的密钥行，
 * 那正是 docs/28 · L-WEB-04 的形态。
 */
function configLeafPaths(node: unknown, prefix = ""): string[] {
  if (!node || typeof node !== "object" || Array.isArray(node))
    return prefix ? [prefix] : [];
  return Object.entries(node as Record<string, unknown>).flatMap(
    ([key, value]) => configLeafPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}
function page<T>(
  items: T[],
  pageNumber: number,
  size: number,
): { items: T[]; total: number; page: number; size: number } {
  return {
    items: items.slice((pageNumber - 1) * size, pageNumber * size),
    total: items.length,
    page: pageNumber,
    size,
  };
}
/**
 * 四个分页端点（`/api/messages`、`/api/turns`、`/api/approvals`、`/api/tasks`）共用的 `?page=`/`?size=` 解析。
 *
 * 各端点原地写 `Math.min(max, Math.max(1, Number(ctx.req.query('size') ?? 50)))` 拦不住非法输入：
 * `Number('abc')` 是 `NaN`，而 `Math.max(1, NaN)` / `Math.min(200, NaN)` 返回的仍是 `NaN`。
 * `NaN` 作为 better-sqlite3 的绑定参数不会被当成 0，而是整条查询抛 `TypeError: datatype mismatch`，
 * 于是一个写错的 query 会把端点打成 500 而不是返回一页默认结果。小数同理（`size=1.5` 落到 `LIMIT` 上同样报错）。
 *
 * 非法值一律回退默认而不是返回 400：分页参数由界面拼出，非法 query 应退化为第一页，
 * 而不应让整块列表进入错误态。每个端点的 `defaultSize`/`maxSize` 各自独立，这里只统一解析规则。
 */
function pageParams(
  ctx: Context,
  limits: { defaultSize: number; maxSize: number },
): { page: number; size: number; offset: number } {
  // Number(undefined)=NaN、Number('')=Number(' ')=0，都落在 `>= 1` 的整数之外，统一被判非法。
  const positiveInt = (raw: string | undefined): number | null => {
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  };
  const pageNumber = positiveInt(ctx.req.query("page")) ?? 1;
  const size = Math.min(
    limits.maxSize,
    positiveInt(ctx.req.query("size")) ?? limits.defaultSize,
  );
  return { page: pageNumber, size, offset: (pageNumber - 1) * size };
}

/** 可以内联渲染的 mime：只有光栅图，刻意不含 image/svg+xml（SVG 能带脚本）。 */
const INLINE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** 文件名来自 Telegram，是攻击者可控的：引号会破坏参数解析，CR/LF 会让 Response 构造直接抛错。 */
function contentDisposition(name: string): string {
  const ascii =
    [...name]
      .map((char) =>
        char >= " " && char <= "~" && char !== '"' && char !== "\\"
          ? char
          : "_",
      )
      .join("")
      .slice(0, 120) || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 系统信息里的三个占用（docs/09 §3.1）：DB 本体、WAL、workspace。只统计不清理：
 * 这张卡片是判断是否需要执行维护操作的依据，自行清理会让它变成带副作用的读端点。
 * 目录递归有深度上界：workspace 里存放模型自建的目录树，一个自指软链即可让这次请求不返回。
 */
function directorySize(root: string, depth = 0): number {
  if (depth > 8) return 0;
  let total = 0;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) total += directorySize(path, depth + 1);
    else if (entry.isFile()) {
      try {
        total += statSync(path).size;
      } catch {
        /* 竞态删除 */
      }
    }
  }
  return total;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 用量聚合按 chat / user 分组时 bucket 是裸 id，运维无法判断 `-1002492583774` 对应哪个群。
 * 反查规则与会话页一致：已登记的用显示名，未登记的明确标注为未登记，而不是留空。
 * `scope='chat'` 且 id 为正数时回落到 `kind='user'`：私聊已不占 `chat:` 行（docs/05 §2.2），
 * 只查 chat 的话每一条私聊用量都会显示成「未登记会话」。
 */
function principalLabel(
  db: Sqlite,
  kind: "chat" | "user",
  tgId: string | null,
): string | null {
  if (!tgId) return null;
  const lookup = db.prepare(
    "SELECT display_name AS name,username FROM principals WHERE kind=? AND tg_id=?",
  );
  const row = (lookup.get(kind, tgId) ??
    (kind === "chat" && !tgId.startsWith("-")
      ? lookup.get("user", tgId)
      : undefined)) as
    { name: string | null; username: string | null } | undefined;
  if (row?.name)
    return row.username ? `${row.name} (@${row.username})` : row.name;
  return `未登记${kind === "chat" ? "会话" : "用户"} ${tgId}`;
}

/**
 * 把 `approvals.decided_by` 转成可读的裁决者。三种写法（[03](../../../docs/03-data-model.md) 的
 * `approvals` 段）里只有 `user:<tgId>` 需要反查：`owner`（WebUI 一侧只有一个 owner 身份）与
 * `system`（TTL / 轮次取消 / 启动扫描）本身即可读。
 *
 * 格式解析走 `parsePrincipal`（三个 Telegram 命令与 `POST /api/principals/bulk` 共用的那一份），
 * 不在这里手写 `slice(5)`：`user:<id>` 是主体串的格式，多一份解析就多一处会失配的位置。
 * 反查不到时返回 `null` 而不是原串：前端已在显示原串，这一列只负责在查得到时补一个名字。
 */
function decidedByLabel(db: Sqlite, decidedBy: unknown): string | null {
  if (typeof decidedBy !== "string") return null;
  const principal = parsePrincipal(decidedBy);
  return principal?.kind === "user"
    ? principalLabel(db, "user", principal.tgId)
    : null;
}

function diskUsage(config: Readonly<Config>): {
  bytes: number;
  walBytes: number;
  /** 日志库（`logs.dbPath`）连同它的 -wal / -shm。它是独立文件，不计进 `bytes` 里
   *  —— 合并成一个数之后，「主库在涨」与「日志在涨」这两件事就分不开了。 */
  logsBytes: number;
  workspaceBytes: number;
} {
  return {
    bytes: fileSize(config.db.path),
    walBytes: fileSize(`${config.db.path}-wal`),
    logsBytes:
      fileSize(config.logs.dbPath) +
      fileSize(`${config.logs.dbPath}-wal`) +
      fileSize(`${config.logs.dbPath}-shm`),
    workspaceBytes: directorySize(resolve(config.sandbox.workspaceDir)),
  };
}

/**
 * 对库里存储的那类路径做包含性校验：先绝对化再判包含，而不是把它当成相对 `root` 的引用 ——
 * `attachments.local_path` 是 `join('./data/files', chatId, …)` 这种相对 cwd 的路径，
 * 按「相对 root 拼接」处理会被拼成 `<root>/data/files/…`，全部无法匹配。
 *
 * 这两列目前只由本进程写入，因此这属于纵深防御；但 DB 里的路径值可信是一个会随时间失效的假设：
 * 导入、迁移、手工修库都能改动它（docs/27 · S-07）。
 *
 * 〔曾经与它并列的 `safeRef` 已删除：它唯一的用途是把 `log_events.file_ref` 解析到
 * `logs/<day>/blobs/` 下，而载荷现在就在行上，那条路径连同 `GET /api/logs/blob` 一起没有了。〕
 */
function storedPathWithin(root: string, stored: string): string {
  const absolute = resolve(stored);
  const base = resolve(root);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`))
    throw new Error("invalid_file_ref");
  return absolute;
}

/**
 * 登录限流的桶键与 `sessions.ip` 的来源。`trustProxy` 为假时不读取任何请求头：
 * 桶键若取自请求头，绕过限流的代价只是换一个头值。docs/18 · N-WEB-02 那一轮的修复原文写明
 * `trustProxy` 为假时恒返回 `local`，后来丢了这一半，于是 docs/27 · S-01 实测 12 次轮换
 * `X-Real-IP` 全部 401、一次 429 都没有。直连时只取连接的远端地址；取不到时（`app.request()`
 * 这类没有底层 socket 的调用）全部落进同一个 `local` 桶，fail-closed 的方向是一并锁定。
 */
function requestIp(ctx: Context, config: Readonly<Config>): string {
  if (config.webui.trustProxy) {
    const chain =
      ctx.req
        .header("x-forwarded-for")
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
    return (
      chain.at(-config.webui.trustedProxyHops) ??
      ctx.req.header("x-real-ip")?.trim() ??
      "direct"
    );
  }
  try {
    return getConnInfo(ctx).remote.address?.trim() || "local";
  } catch {
    return "local";
  }
}
function requestIsSecure(
  ctx: { req: { header(name: string): string | undefined; url: string } },
  config: Readonly<Config>,
): boolean {
  return (
    ctx.req.url.startsWith("https:") ||
    (config.webui.trustProxy &&
      ctx.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https")
  );
}
function allowedOrigin(
  ctx: { req: { header(name: string): string | undefined; url: string } },
  config: Readonly<Config>,
): boolean {
  const origin = ctx.req.header("origin");
  if (!origin) return true;
  const own = new URL(ctx.req.url).origin;
  return origin === own || config.webui.allowOrigins.includes(origin);
}
export function createServer(
  dependencies: ServerDependencies,
): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const currentConfig = (): Readonly<Config> =>
    "snapshot" in dependencies.config
      ? dependencies.config.snapshot()
      : dependencies.config;
  const validRoles: Record<Role, true> = {
    owner: true,
    trusted: true,
    limited: true,
    blocked: true,
  };
  /**
   * 配置写入的唯一出口：写入 `config_kv` 与 `config_revisions`，并删除被本次写入覆盖的后代行。
   * 覆盖层按点分深度应用（`sortOverrideKeys`：更具体的路径优先），因此写 `tools.overrides` 整块时若
   * 库里仍留着此前逐项写下的 `tools.overrides.<name>`，该项会局部否决整块里的对应位置，
   * 界面上表现为 JSON 里写着开启、刷新回来仍是关闭。祖先键代表整棵子树，后代行因此作废；
   * 作废同样要进变更历史，否则历史里查不出逐项覆盖是被谁清除的。
   * 同时把六个写入点的四条重复语句收敛到一处：`PUT /api/sandbox` 此前只写 `config_kv` 不写
   * `config_revisions`，沙箱 mode / bypassRoles 这类安全相关改动完全不进变更历史。
   * `prune` 是显式删除集（只有叶子粒度的 YAML 端点用得上），与被覆盖的后代行走同一个事务。
   */
  const writeConfigRows = (
    entries: Array<[string, unknown]>,
    actor: string,
    prune: readonly string[] = [],
  ): string[] =>
    writeConfigRowsToDatabase(
      dependencies.db,
      entries,
      actor,
      revisionJson,
      prune,
    );
  const persistedConfigRows = (): Array<{ key: string; value: unknown }> =>
    (
      dependencies.db
        .prepare("SELECT key,value_json AS value FROM config_kv ORDER BY key")
        .all() as Array<{ key: string; value: string }>
    ).map((row) => ({ key: row.key, value: JSON.parse(row.value) as unknown }));
  /**
   * 判定某一行是密钥、不参与 YAML 往返的唯一依据。`GET` 用它决定整行跳过哪些，`PUT` 用它决定哪些
   * 旧键永不删除；两者是独立请求，`PUT` 必须自行重算一次，不能采信客户端交回的 `skipped`
   * （docs/28 · L-WEB-04）。整块写入（`mcp.servers`）里也可能包含密钥字段，`publicConfig` 会把它们
   * 替换成占位符，这类块同样不能出现在往返里。
   */
  const secretConfigRow = (key: string, value: unknown): boolean =>
    looksSecret(key, value) ||
    JSON.stringify(publicConfig(value)).includes("«redacted»");
  /**
   * 被环境变量固定的键一律拒收，而不是写库之后由 `loadConfig` 静默返回 env 的值。
   * 祖先写入（`webui` 整块）同样命中：它对那个叶子同样不会生效。
   */
  const envConflicts = (keys: string[]): Array<{ key: string; env: string }> =>
    envPinnedConfigKeys().filter((pinned) =>
      keys.some(
        (key) =>
          key === pinned.key ||
          pinned.key.startsWith(`${key}.`) ||
          key.startsWith(`${pinned.key}.`),
      ),
    );
  const envPinnedError = (conflicts: Array<{ key: string; env: string }>) =>
    apiError(
      "config_pinned_by_env",
      `${conflicts.map((entry) => `${entry.key} 由环境变量 ${entry.env} 决定`).join("；")}。此处修改不生效，请修改环境变量后重启进程`,
    );
  /**
   * `«redacted»` 是 `GET /api/config` 的脱敏占位符，不是任何配置项的合法值。原样回传只可能是
   * 界面把读出来的脱敏值当真值又提交了一遍（`mcp.servers` 那种整块 JSON 里就嵌着它）：
   * 接受它等于把真实密钥替换成这个占位符，且 `config_kv` 里那一行会持续生效。
   */
  const redactedKeys = (body: Record<string, unknown>): string[] =>
    Object.entries(body)
      .filter(([, value]) =>
        JSON.stringify(value ?? null).includes("«redacted»"),
      )
      .map(([key]) => key);
  // 与 `install_mcp` 工具共用同一份校验与写入（`persistMcpServers`，core）：各写一份的必然结果是
  // WebUI 能建出的 server 工具建不出来，或者相反。
  // `reconciled: ['mcp']`：这三个端点都会在写完之后自行 `await dependencies.mcp.reconcile()`
  // （响应里要给出真实 state），因此 `main.ts` 的订阅者不能再执行一次：两次重叠的 reconcile 会
  // 各自 spawn 一个 stdio 子进程（`ConfigChangedEvent`，docs/28 · L-EXT-03）。
  const persistMcpServers = (
    servers: unknown[],
  ):
    | { ok: true; servers: Readonly<Config["mcp"]["servers"]> }
    | { ok: false; details: unknown } =>
    persistMcpServersShared(
      {
        db: dependencies.db,
        config: currentConfig,
        apply: (next, keys) => {
          if ("replace" in dependencies.config)
            dependencies.config.replace(next, keys);
        },
        emit: (keys) =>
          dependencies.events.emit("config.changed", {
            keys,
            reconciled: ["mcp"],
          } satisfies ConfigChangedEvent),
      },
      servers,
      "webui",
    );
  // 刚写入 config_kv、但 config.changed 的重载尚未落到 configStore 的那一份口令。仅在快照仍是
  // 写入前那个值时生效；快照一旦变成别的值（例如 PUT /api/config 又改了一次），立即回退到配置：
  // 无条件缓存即 V-AUTH-02 在另一处复发：写入返回 200，登录仍按旧值校验（docs/24 · R-AUTH-01）。
  let pendingHash: { next: string; previous: string } | null = null;
  const activePasswordHash = (): string => {
    const stored = currentConfig().webui.passwordHash;
    if (!pendingHash) return stored;
    if (stored === pendingHash.previous) return pendingHash.next;
    pendingHash = null;
    return stored;
  };
  const failures = new Map<
    string,
    { count: number; lockedUntil: number; touchedAt: number }
  >();
  let globalFailures: number[] = [];
  const pruneFailures = (now: number, windowMs: number): void => {
    globalFailures = globalFailures.filter((at) => now - at < windowMs);
    for (const [key, entry] of failures)
      if (entry.lockedUntil <= now && now - entry.touchedAt >= windowMs)
        failures.delete(key);
    while (failures.size > 1024) failures.delete(failures.keys().next().value!);
  };

  app.use("*", async (ctx, next) => {
    // `frame-ancestors` 写进 CSP 而不是只靠 `X-Frame-Options`（后者已过时，且不覆盖嵌套框架）；
    // `object-src` 挡 <embed>/<object>，`base-uri` 挡注入 <base> 改写所有相对 URL，
    // `form-action` 挡把表单 POST 到外站（docs/22 · I-12）。X-Frame-Options 保留给老浏览器。
    ctx.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    ctx.header("X-Frame-Options", "DENY");
    ctx.header("X-Content-Type-Options", "nosniff");
    ctx.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.use("/api/*", async (ctx, next) => {
    if (!allowedOrigin(ctx, currentConfig()))
      return ctx.json(apiError("origin", "Origin 不允许", 403).body, 403);
    await next();
  });
  /**
   * 请求体上界。`ctx.req.json()` 把整份请求体读进内存，而 `/api/setup` 与两条登录端点注册在鉴权
   * 中间件之前：未登录即可推入任意大小的请求体（docs/27 · S-05）。`login` 那条
   * `password.length > 1024` 的检查发生在 `await ctx.req.json()` 之后，拦不住这件事。
   * 挂在 Origin 闸之后、所有路由之前：`bodyLimit` 同样要在真正读体之前拦截，装在具体端点上已经太晚。
   * 三条业务上确实较大的端点各自放宽，其余一律 1 MiB：上界要按端点给定，而不是取一个通用值。
   */
  const DEFAULT_BODY_LIMIT = 1_048_576;
  const WIDE_BODY_LIMITS: Array<[RegExp, number]> = [
    [/^\/api\/config\/yaml$/, 4_194_304],
    [/^\/api\/models\/import$/, 4_194_304],
    [/^\/api\/prompts\/[^/]+$/, 2_097_152],
  ];
  const bodyLimiters = new Map<number, ReturnType<typeof bodyLimit>>();
  const limiterFor = (max: number): ReturnType<typeof bodyLimit> => {
    const existing = bodyLimiters.get(max);
    if (existing) return existing;
    const created = bodyLimit({
      maxSize: max,
      onError: (ctx) =>
        ctx.json(
          apiError(
            "payload_too_large",
            `请求体超过 ${Math.round(max / 1024)} KiB 上限`,
            413,
          ).body,
          413,
        ),
    });
    bodyLimiters.set(max, created);
    return created;
  };
  /**
   * 装 skill 包这条取配置而不是常量：`skills.package.maxTotalBytes` 默认 64 MiB，而这里的默认
   * 上界是 1 MiB。不接入配置时，一个 4.9 MB 的包在到达端点之前即被 413 拒绝，而该错误里
   * 不会提示应调大上限。额外的 1 MiB 是 multipart 信封的余量，使报错来自端点里那条明确的提示，
   * 而不是这道闸。
   */
  const bodyLimitFor = (path: string): number =>
    path === "/api/skills/package"
      ? currentConfig().skills.package.maxTotalBytes + 1_048_576
      : (WIDE_BODY_LIMITS.find(([pattern]) => pattern.test(path))?.[1] ??
        DEFAULT_BODY_LIMIT);
  app.use("/api/*", (ctx, next) =>
    limiterFor(bodyLimitFor(ctx.req.path))(ctx, next),
  );

  // 无鉴权的那份只返回存活状态。provider 列表（含 baseUrl）、MCP 服务器、沙箱 plan、在途轮次数
  // 都属于内部拓扑：默认绑定 127.0.0.1 时影响有限，但 `webui.host` 一旦放开即构成无鉴权信息泄露
  // （docs/20 · W-API-01）。详细信息移到鉴权之后的 /api/health/detail。
  app.get("/api/health", (ctx) => {
    let dbOk = true;
    try {
      dependencies.db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    return ctx.json({
      ok: dbOk,
      uptimeMs: Date.now() - dependencies.startedAt,
    });
  });

  app.post("/api/setup", async (ctx) => {
    const body = await ctx.req
      .json<{ token?: string; password?: string }>()
      .catch((): { token?: string; password?: string } => ({}));
    const expected = dependencies.setup?.token ?? "";
    const validToken = Boolean(
      dependencies.setup &&
      Date.now() <= dependencies.setup.expiresAt &&
      body.token &&
      body.token.length === expected.length &&
      timingSafeEqual(Buffer.from(body.token), Buffer.from(expected)),
    );
    if (!validToken)
      return ctx.json(
        apiError("invalid_setup", "Setup token is invalid", 403).body,
        403,
      );
    if (
      !body.password ||
      body.password.length < 12 ||
      body.password.length > 1024
    )
      return ctx.json(
        apiError("weak_password", "Password must contain 12–1024 characters")
          .body,
        400,
      );
    const hash = await argon2.hash(body.password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    pendingHash = { next: hash, previous: currentConfig().webui.passwordHash };
    const now = Date.now();
    dependencies.db
      .prepare(
        `INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES ('webui.passwordHash',?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
      )
      .run(JSON.stringify(hash), now, "setup");
    dependencies.db
      .prepare(
        "INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)",
      )
      .run(
        randomBytes(16).toString("hex"),
        now,
        "setup",
        "webui.passwordHash",
        JSON.stringify(""),
        JSON.stringify("«redacted»"),
      );
    dependencies.setup = undefined;
    dependencies.events.emit("config.changed", {
      keys: ["webui.passwordHash"],
    });
    const session = dependencies.operations.createSession(
      currentConfig().webui.sessionTtlHours,
      requestIp(ctx, currentConfig()),
      ctx.req.header("user-agent"),
    );
    const secure = requestIsSecure(ctx, currentConfig()) ? "; Secure" : "";
    ctx.header(
      "Set-Cookie",
      `luoli_sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/${secure}`,
    );
    return ctx.json({
      ok: true,
      data: { csrf: session.csrf, expiresAt: session.expiresAt },
    });
  });

  app.post("/api/auth/login", async (ctx) => {
    const now = Date.now();
    const webui = currentConfig().webui;
    const windowMs = webui.loginRateLimit.windowMinutes * 60_000;
    pruneFailures(now, windowMs);
    const ip = requestIp(ctx, currentConfig());
    const failure = failures.get(ip);
    if (failure && failure.lockedUntil > now)
      return ctx.json(
        apiError("locked", "登录失败次数过多，请稍后再试", 429).body,
        429,
      );
    if (globalFailures.length >= webui.loginRateLimit.attempts * 20) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }
    const body = await ctx.req
      .json<{ password?: string }>()
      .catch((): { password?: string } => ({}));
    if (!body.password || body.password.length > 1024)
      return ctx.json(
        apiError("invalid_credentials", "密码错误", 401).body,
        401,
      );
    let valid = false;
    try {
      const hash = activePasswordHash();
      valid = Boolean(hash && (await argon2.verify(hash, body.password)));
    } catch {
      valid = false;
    }
    if (!valid) {
      const count = (failure?.count ?? 0) + 1;
      failures.delete(ip);
      failures.set(ip, {
        count,
        lockedUntil:
          count >= webui.loginRateLimit.attempts ? now + windowMs : 0,
        touchedAt: now,
      });
      globalFailures.push(now);
      dependencies.log.event({
        level: "warn",
        kind: "webui.action",
        summary: "login failed",
        data: { ip },
      });
      return ctx.json(
        apiError("invalid_credentials", "密码错误", 401).body,
        401,
      );
    }
    failures.delete(ip);
    const session = dependencies.operations.createSession(
      webui.sessionTtlHours,
      ip,
      ctx.req.header("user-agent"),
    );
    const secure = requestIsSecure(ctx, currentConfig()) ? "; Secure" : "";
    ctx.header(
      "Set-Cookie",
      `luoli_sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/${secure}`,
    );
    return ctx.json({
      ok: true,
      data: { csrf: session.csrf, expiresAt: session.expiresAt },
    });
  });

  /**
   * Telegram `/webui` 发来的一次性登录（docs/09 §2.3）。token 保存在内存里：进程重启即失效，
   * 这也正是它应有的语义 —— 一条能换取 owner 全权限 session 的链接若落进数据库或日志，
   * 暴露面大于口令本身。因此这里也不记录 token 本身，只记录使用成功或失败。
   *
   * 三道闸：单次使用（取出即删）、5 分钟过期、常量时间比较。
   */
  app.post("/api/auth/token", async (ctx) => {
    const body = await ctx.req
      .json<{ token?: string }>()
      .catch((): { token?: string } => ({}));
    const now = Date.now();
    for (const [value, entry] of loginTokens)
      if (entry.expiresAt <= now) loginTokens.delete(value);
    const supplied = typeof body.token === "string" ? body.token : "";
    // 先删再判：一个错误的 token 不该让攻击者反复试同一个值。
    const entry = supplied ? loginTokens.get(supplied) : undefined;
    if (entry) loginTokens.delete(supplied);
    if (!entry || entry.expiresAt <= now) {
      dependencies.log.event({
        level: "warn",
        kind: "webui.action",
        summary: "one-time login token rejected",
        data: { ip: requestIp(ctx, currentConfig()) },
      });
      return ctx.json(
        apiError("invalid_token", "登录链接无效或已过期", 401).body,
        401,
      );
    }
    const webui = currentConfig().webui;
    const session = dependencies.operations.createSession(
      webui.sessionTtlHours,
      requestIp(ctx, currentConfig()),
      ctx.req.header("user-agent"),
    );
    const secure = requestIsSecure(ctx, currentConfig()) ? "; Secure" : "";
    ctx.header(
      "Set-Cookie",
      `luoli_sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/${secure}`,
    );
    dependencies.log.event({
      level: "info",
      kind: "webui.action",
      summary: "logged in via one-time token",
    });
    return ctx.json({
      ok: true,
      data: { csrf: session.csrf, expiresAt: session.expiresAt },
    });
  });

  app.use("/api/*", async (ctx, next) => {
    // MCP 的 OAuth 回调进白名单是必要的而非从简：session cookie 是 `SameSite=Strict`，
    // 而这一跳是授权服务器发起的跨站重定向，浏览器不会携带它，要求登录态即等于这条路走不通。
    // 准入判据改用 OAuth 自身的 `state`：32 字节随机、单次使用、10 分钟 TTL、只存在进程内
    // （`PendingAuthorizations`）。没有有效 state 的请求在那里即被拒绝。
    if (
      ctx.req.path === "/api/health" ||
      ctx.req.path === "/api/auth/login" ||
      ctx.req.path === "/api/auth/token" ||
      ctx.req.path === "/api/setup" ||
      ctx.req.path === MCP_OAUTH_CALLBACK_PATH
    )
      return next();
    const id = cookie(ctx.req.header("cookie"), "luoli_sid");
    const session = id ? dependencies.operations.session(id) : null;
    if (!session)
      return ctx.json(apiError("unauthorized", "未登录", 401).body, 401);
    ctx.set("sessionId", session.id);
    ctx.set("csrf", session.csrf);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(ctx.req.method) &&
      ctx.req.header("x-csrf-token") !== session.csrf
    )
      return ctx.json(apiError("csrf", "CSRF token 无效", 403).body, 403);
    await next();
  });

  app.use("/api/*", async (ctx, next) => {
    await next();
    if (!["GET", "HEAD", "OPTIONS"].includes(ctx.req.method))
      dependencies.log.event({
        level: "info",
        kind: "webui.action",
        summary: `${ctx.req.method} ${ctx.req.path}`,
        data: { method: ctx.req.method, path: ctx.req.path },
      });
  });
  app.post("/api/auth/password", async (ctx) => {
    const body = await ctx.req
      .json<{ current?: string; next?: string }>()
      .catch((): { current?: string; next?: string } => ({}));
    // WEBUI_PASSWORD 在环境变量里时，改口令能写进 config_kv、当前进程也认新口令，但重启后 envOverlay
    // 会用 env 那份哈希覆盖回来：这是改了口令却仍不安全的最坏形态，因此当场拒绝（摘除比伪造安全）。
    const pinned = envConflicts(["webui.passwordHash"]);
    if (pinned.length)
      return ctx.json(
        apiError(
          "password_pinned_by_env",
          "口令由环境变量 WEBUI_PASSWORD 固定：此处修改在重启后会被环境变量覆盖。请修改该环境变量，或清除后再使用此表单。",
          409,
        ).body,
        409,
      );
    if (
      !body.current ||
      body.current.length > 1024 ||
      !body.next ||
      body.next.length < 12 ||
      body.next.length > 1024
    )
      return ctx.json(
        apiError("invalid_password", "新口令必须为 12–1024 个字符").body,
        400,
      );
    let valid = false;
    try {
      const hash = activePasswordHash();
      valid = Boolean(hash && (await argon2.verify(hash, body.current)));
    } catch {
      valid = false;
    }
    // 返回 403 而不是 401：session 有效，出错的是表单里那一项。客户端 `api()` 对任何 401 都执行
    // `location.assign("/login")`，返回 401 会让页面整体跳转，当前口令错误无法渲染出来，
    // 同页其他未保存的表单一并丢失，而登录实际并未过期（docs/29 · M-WEB-13）。
    if (!valid)
      return ctx.json(
        apiError("invalid_credentials", "当前口令错误", 403).body,
        403,
      );
    const nextHash = await argon2.hash(body.next, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const now = Date.now();
    const staleHash = currentConfig().webui.passwordHash;
    const currentSession = ctx.get("sessionId");
    const previous = dependencies.db
      .prepare("SELECT value_json AS value FROM config_kv WHERE key=?")
      .get("webui.passwordHash") as { value: string } | undefined;
    dependencies.db.transaction(() => {
      dependencies.db
        .prepare(
          "INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES ('webui.passwordHash',?,?,'webui') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
        )
        .run(JSON.stringify(nextHash), now);
      dependencies.db
        .prepare(
          "INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)",
        )
        .run(
          randomBytes(16).toString("hex"),
          now,
          "webui",
          "webui.passwordHash",
          previous?.value ? JSON.stringify("«redacted»") : null,
          JSON.stringify("«redacted»"),
        );
      dependencies.db
        .prepare("DELETE FROM sessions WHERE id<>?")
        .run(currentSession);
    })();
    pendingHash = { next: nextHash, previous: staleHash };
    dependencies.events.emit("config.changed", {
      keys: ["webui.passwordHash"],
    });
    return ctx.json({ ok: true, data: { sessionsRevoked: true } });
  });
  app.get("/api/health/detail", (ctx) => {
    let dbOk = true;
    try {
      dependencies.db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    const providers = dependencies.providers.list() as Array<{
      enabled?: number;
      healthState?: string | null;
    }>;
    const mcp = dependencies.db
      .prepare(
        "SELECT name,state,last_error AS error FROM mcp_servers ORDER BY name",
      )
      .all();
    return ctx.json({
      ok: dbOk,
      data: {
        ok: dbOk,
        version: process.env.npm_package_version ?? "dev",
        uptimeMs: Date.now() - dependencies.startedAt,
        db: { ok: dbOk, ...diskUsage(currentConfig()) },
        providers,
        mcp,
        sandbox: dependencies.sandbox?.plan("trusted") ?? { allowed: false },
        inFlightTurns: dependencies.turnRegistry?.size ?? 0,
      },
    });
  });
  app.post("/api/auth/logout", (ctx) => {
    dependencies.operations.deleteSession(ctx.get("sessionId"));
    ctx.header(
      "Set-Cookie",
      "luoli_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    return ctx.json({ ok: true });
  });
  // SPA 只把 csrf 放在内存里，刷新页面就丢了；不在这里发回去，刷新之后每个写操作都是 403。
  // 这不削弱 CSRF 防护：跨站请求既读不到响应（无 CORS 放行），也过不了上面的 Origin 中间件。
  app.get("/api/auth/me", (ctx) =>
    ctx.json({
      ok: true,
      data: {
        role: "owner",
        csrf: ctx.get("csrf"),
        expiresAt:
          dependencies.operations.session(ctx.get("sessionId"))?.expiresAt ??
          null,
      },
    }),
  );
  app.get("/api/dashboard", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.operations.dashboard(currentConfig().general.timezone),
    }),
  );
  app.get("/api/chats", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.db
        .prepare(
          `SELECT c.key,c.chat_id AS chatId,c.thread_id AS threadId,c.scope,c.claim_watermark AS claimWatermark,
    cc.head_ordinal AS headOrdinal,cc.tokens_total AS tokens,cc.msg_count AS messages FROM contexts c LEFT JOIN refs r ON r.key=c.key AND r.name='done' LEFT JOIN context_commits cc ON cc.id=r.commit_id ORDER BY c.updated_at DESC`,
        )
        .all(),
    }),
  );
  app.get("/api/config", (ctx) =>
    ctx.json({ ok: true, data: publicConfig(currentConfig()) }),
  );
  // 带上热更新前缀：不在 hotReloadable 里的键保存后需重启才生效，WebUI 据此显示待重启标记。
  // 保存成功但运行时未变，是 docs/20 · W-CFG-02 里最具误导性的一类。
  // 三件套一律放进 `data`：统一信封的客户端只解析 `data`，挂在信封顶层的兄弟键会被静默丢弃，
  // 自动生成的表单正是依据这两份前缀表判断热更新 / 需重启与未接线。
  // `envPinned` 是第三份前缀表：这些键的 config_kv 行会被 env 层覆盖，表单据此禁用控件并标明环境变量。
  // `enumNotes` 是第四份：同一项内取值不等价时（`telegram.allowedUpdates` 23 个取值只有 4 个有
  // 处理器）逐个取值给出说明，否则界面上那 23 个复选框完全相同。同样只能挂在 `data` 里。
  app.get("/api/config/schema", (ctx) =>
    ctx.json({
      ok: true,
      data: {
        schema: dependencies.configSchema,
        hotReloadable: HOT_RELOADABLE_CONFIG_KEYS,
        unimplemented: KNOWN_UNIMPLEMENTED_CONFIG_KEYS,
        envPinned: envPinnedConfigKeys(),
        enumNotes: CONFIG_ENUM_NOTES,
      },
    }),
  );
  // 不安全或过短的唤醒词在匹配时被静默跳过（trigger.ts）。接受这种模式会让运维误认为配置已生效，
  // 实际表现为 bot 不响应，因此写入端直接拒绝；只在本次写操作确实改动了唤醒词时校验。
  app.post("/api/config/wakewords/check", async (ctx) => {
    const body = await ctx.req.json<{
      wakewords?: unknown;
      minLength?: unknown;
    }>();
    const patterns = Array.isArray(body.wakewords)
      ? body.wakewords.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const minLength =
      typeof body.minLength === "number"
        ? body.minLength
        : currentConfig().trigger.wakewordMinLength;
    return ctx.json({
      ok: true,
      data: patterns.map((pattern) => {
        const checked = checkWakeword(pattern, minLength);
        return {
          pattern,
          kind: checked.kind,
          ok: checked.ok,
          reason: checked.ok ? null : checked.reason,
        };
      }),
    });
  });
  app.put("/api/config", async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    const pinned = envConflicts(Object.keys(body));
    if (pinned.length) return ctx.json(envPinnedError(pinned).body, 400);
    const redacted = redactedKeys(body);
    if (redacted.length)
      return ctx.json(
        apiError(
          "redacted_placeholder",
          `${redacted.join("、")} 的值含脱敏占位符 «redacted»，写入会覆盖真实密钥`,
        ).body,
        400,
      );
    const merged = mergeDotted(currentConfig(), body);
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success)
      return ctx.json(
        invalidConfig("配置校验失败", parsed.error.issues).body,
        400,
      );
    if (
      Object.keys(body).some(
        (key) => key === "trigger" || key.startsWith("trigger."),
      )
    ) {
      const rejected = rejectedWakewords(
        parsed.data.trigger.wakewords,
        parsed.data.trigger.wakewordMinLength,
      );
      if (rejected.length)
        return ctx.json(
          apiError("invalid_wakeword", `唤醒词不会生效：${rejected.join("；")}`)
            .body,
          400,
        );
    }
    // 落库的是校验后的值，而不是请求体原值：否则 zod 的默认值与强制转换不会进入 `config_kv`，
    // 下次启动重放覆盖层得到的是另一份配置（docs/22 · I-06）。键仍以请求体为准：
    // 只发送实际改动的那几项是这个端点的契约，不能连带把整棵树写下去。
    const rows: Array<[string, unknown]> = Object.keys(body).map((key) => [
      key,
      readDotted(parsed.data, key),
    ]);
    // JSON 无法表达 undefined，因此校验后取不到值只有一个原因：该路径不在 schema 里，被 zod
    // 整段剥除。此前这类键仍会落进 `config_kv`，由 `loadConfig` 下次启动逐条剔除并告警，
    // 而那是兜底不是许可（CLAUDE.md）。这里当场拒绝，避免保存成功把无效键留在库里。
    const unknownKeys = rows
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    if (unknownKeys.length)
      return ctx.json(
        apiError(
          "unknown_config_key",
          `${unknownKeys.join("、")} 不是 schema 里的配置路径`,
        ).body,
        400,
      );
    const subsumed = writeConfigRows(rows, "webui");
    dependencies.events.emit("config.changed", { keys: Object.keys(body) });
    // `subsumed` 交回前端逐条列出：整块写入作废的逐项覆盖必须明示，否则运维只看到保存成功，
    // 而工具页上某个开关的状态已被这次保存静默改变。
    return ctx.json({ ok: true, data: { keys: Object.keys(body), subsumed } });
  });
  /**
   * `modelAlias` 是 Telegram `/model` 写入 `app_kv` 的那份会话别名，它优先于 WebUI 可改的
   * `perChat.<key>.agent.main.modelAlias` 与全局 `agent.main.modelAlias`（`runtime.ts` 先读它）。
   * 界面上此前只有一行小字说明，运维改了全局别名却不生效时无从排查；现在可见且可清除。
   */
  app.get("/api/chats/:key", (ctx) => {
    const key = ctx.req.param("key");
    // `timeline: true`：会话页要 commit 列表与逐条消息。工具那一侧刻意只拿摘要（docs/27 · R-03）。
    return ctx.json({
      ok: true,
      data: {
        ...dependencies.context.stats(key, { timeline: true }),
        modelAlias:
          readAppKv<string>(dependencies.db, modelAliasKey(key)) ?? null,
      },
    });
  });
  app.delete("/api/chats/:key/model-alias", (ctx) => {
    const key = ctx.req.param("key");
    const changes = deleteAppKv(dependencies.db, modelAliasKey(key));
    return ctx.json({ ok: true, data: { cleared: changes > 0 } });
  });
  app.patch("/api/chats/:key", async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    const key = `perChat.${ctx.req.param("key")}`;
    // 必须走 schema：perChat 覆盖白名单是安全边界（[11 §2.1]），绕过它既能给单个群关掉权限检查，
    // 又会让下次启动时的配置校验失败（docs/19-review-round4.md · R-CFG-02）。
    const merged = mergeDotted(currentConfig(), { [key]: body });
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success)
      return ctx.json(
        invalidConfig("会话覆盖校验失败", parsed.error.issues).body,
        400,
      );
    if (body.trigger) {
      const merged = perChatConfig(parsed.data, ctx.req.param("key")).trigger;
      const rejected = rejectedWakewords(
        merged.wakewords,
        merged.wakewordMinLength,
      );
      if (rejected.length)
        return ctx.json(
          apiError("invalid_wakeword", `唤醒词不会生效：${rejected.join("；")}`)
            .body,
          400,
        );
    }
    writeConfigRows([[key, body]], "webui");
    dependencies.events.emit("config.changed", { keys: [key] });
    return ctx.json({ ok: true, data: body });
  });
  app.get("/api/config/revisions", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.db
        .prepare("SELECT * FROM config_revisions ORDER BY ts DESC LIMIT 500")
        .all(),
    }),
  );
  /**
   * 配置导出（docs/09 §3.13）。导出的是 `config_kv` 里的覆盖层，而不是合并后的全量配置：
   * 全量里绝大多数是代码默认值，导入另一个部署等于把当时的默认值全部固定，此后升级
   * 无法获得新的默认值。密钥类键（`publicConfig` 那套判据）不导出，而不是导成
   * `«redacted»`：导成占位符会让导入端把真实密钥覆盖成一个字面量。
   */
  app.get("/api/config/export", (ctx) => {
    const overrides: Record<string, unknown> = {};
    const skipped: string[] = [];
    // 判据与 YAML 那条路共用 `secretConfigRow`：整块写入（`mcp.servers`）里也可能包含密钥字段，
    // 而两份各自演化的判据最终必然在其中一条路径上泄露真实密钥。
    for (const row of persistedConfigRows()) {
      if (secretConfigRow(row.key, row.value)) {
        skipped.push(row.key);
        continue;
      }
      overrides[row.key] = row.value;
    }
    return ctx.json({
      ok: true,
      data: { exportedAt: Date.now(), overrides, skipped },
    });
  });
  /**
   * `[原始 YAML]` 模式（docs/09 §3.13）。解析在服务端进行：`loadConfig` 用的就是这个 YAML
   * 解析器，放到前端会让两处方言各自漂移（缩进 tab、锚点、`yes/no` 当布尔这些边角都有差异），
   * 而界面校验通过、启动时失败是最难排查的一类。同时省掉前端 40KB 的 yaml bundle。
   *
   * GET 渲染的是覆盖层而不是合并后的全量，理由与导出相同：全量里绝大多数是代码默认值。
   */
  app.get("/api/config/yaml", (ctx) => {
    const tree: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const row of persistedConfigRows()) {
      if (secretConfigRow(row.key, row.value)) {
        skipped.push(row.key);
        continue;
      }
      assignDotted(tree, row.key, row.value);
    }
    // 被跳过的键在 YAML 顶部生成注释逐条列出：此前界面上只有一个 `skipped` 数组，运维看不出
    // 所提交的这份缺了什么，而提交一份缺少 `webui.passwordHash` 的树曾等同于删除口令哈希
    // （docs/28 · L-WEB-04）。注释拼在 `YAML.stringify` 结果之前：写进配置树就会变成一个键。
    const banner = skipped.length
      ? `# 这份 YAML 不含以下 ${skipped.length} 个密钥类键（值不回显）：\n${skipped.map((key) => `#   ${key}\n`).join("")}# 它们保持原值：提交这份 YAML 不会删除它们，删除这段注释也不会。\n`
      : "";
    return ctx.json({
      ok: true,
      data: { yaml: banner + YAML.stringify(tree, { indent: 2 }), skipped },
    });
  });
  app.put("/api/config/yaml", async (ctx) => {
    const body = await ctx.req.json<{ yaml?: string }>().catch(() => null);
    if (typeof body?.yaml !== "string")
      return ctx.json(
        apiError("invalid_body", 'body 需要 { yaml: "…" }').body,
        400,
      );
    let tree: unknown;
    try {
      tree = YAML.parse(body.yaml) ?? {};
    } catch (error) {
      // yaml 的错误自带 linePos：把行号交回去，界面才能把错误定位到行。
      const cause = error as {
        message?: string;
        linePos?: Array<{ line: number; col: number }>;
      };
      const at = cause.linePos?.[0];
      return ctx.json(
        {
          ok: false,
          error: {
            code: "invalid_yaml",
            message: cause.message ?? "YAML 解析失败",
            ...(at ? { line: at.line, column: at.col } : {}),
          },
        },
        400,
      );
    }
    if (!tree || typeof tree !== "object" || Array.isArray(tree))
      return ctx.json(
        apiError(
          "invalid_yaml",
          "顶层必须是一个映射（key: value），不是数组或标量",
        ).body,
        400,
      );
    const parsed = runtimeConfigSchema.safeParse(tree);
    if (!parsed.success)
      return ctx.json(
        invalidConfig("配置校验失败", parsed.error.issues).body,
        400,
      );
    // 落库粒度是所提交那棵树的叶子（`configLeafPaths`），而不是顶层段：按段落库时写回的是
    // zod 把 `.default()` 填满之后的整棵子树，一次未作任何修改的往返即把生效覆盖叶子从 73 增至
    // 171，并把当时的代码默认值永久固定（docs/28 · L-WEB-02）。键取自所提交的树、值取自
    // `parsed.data`，后者保持落库的是校验后的值这条既有契约（同 `PUT /api/config` 的注释）。
    const sections = Object.keys(tree as Record<string, unknown>);
    const leaves = configLeafPaths(tree);
    // 被 env 固定的键同样按叶子跳过：此前是把含该键的整个顶层段一起跳过，一条 `LUOLI_WEBUI_HOST`
    // 即可让 `webui` 段其余的键在这条路径上全部无法保存。
    const pinnedConflicts = envConflicts(leaves);
    const applicable = leaves.filter(
      (leaf) =>
        !pinnedConflicts.some(
          (entry) =>
            leaf === entry.key ||
            entry.key.startsWith(`${leaf}.`) ||
            leaf.startsWith(`${entry.key}.`),
        ),
    );
    const rows: Array<[string, unknown]> = applicable.map((key) => [
      key,
      readDotted(parsed.data, key),
    ]);
    const unknownKeys = rows
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    if (unknownKeys.length)
      return ctx.json(
        apiError(
          "unknown_config_key",
          `${unknownKeys.join("、")} 不是 schema 里的配置路径`,
        ).body,
        400,
      );
    // 这份 YAML 是所提交段落的全量视图，此前依靠 `writeConfigRows` 删除祖先键的后代行实现；
    // 改为叶子粒度后没有祖先键可依赖，删除必须显式计算，否则从 YAML 里删掉一个键不会产生任何效果。
    const written = new Set(applicable);
    const submitted = new Set(sections);
    const pinnedNames = new Set(
      envPinnedConfigKeys().map((entry) => entry.key),
    );
    const prune: string[] = [];
    const preserved: string[] = [];
    for (const row of persistedConfigRows()) {
      if (!submitted.has(row.key.split(".")[0]!) || written.has(row.key))
        continue;
      // 密钥行与被 env 固定的键永不删除：前者本就不出现在运维那棵树里（`GET` 整行跳过），
      // 把树里没有当作运维删除即 docs/28 · L-WEB-04：一次往返清除 `webui.passwordHash`，
      // 进程静默退回 setup-token 形态。
      if (secretConfigRow(row.key, row.value) || pinnedNames.has(row.key)) {
        preserved.push(row.key);
        continue;
      }
      prune.push(row.key);
    }
    const subsumed = writeConfigRows(rows, "webui:yaml", prune);
    dependencies.events.emit("config.changed", {
      keys: [...new Set([...applicable, ...prune])],
    });
    return ctx.json({
      ok: true,
      data: {
        keys: applicable,
        skipped: pinnedConflicts.map((entry) => entry.key),
        pruned: prune,
        preserved,
        subsumed,
      },
    });
  });
  /**
   * 配置导入：走与 `PUT /api/config` 完全一致的校验与落库路径（点分键 → mergeDotted →
   * `runtimeConfigSchema` → `writeConfigRows`），只是一次处理多条。它不是恢复快照：
   * 导入不删除现有覆盖行，只按键覆盖；需要清空时要单独改那几项。
   */
  app.post("/api/config/import", async (ctx) => {
    const body = await ctx.req
      .json<{ overrides?: Record<string, unknown> }>()
      .catch(() => null);
    const overrides = body?.overrides;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      return ctx.json(
        apiError("invalid_body", "body 需要 { overrides: { 点分键: 值 } }")
          .body,
        400,
      );
    const keys = Object.keys(overrides);
    if (!keys.length)
      return ctx.json({ ok: true, data: { keys: [], skipped: [] } });
    // 被 env 固定的键不应导致整次导入失败：跳过并逐条列出，优于要求先删环境变量再重新导入。
    const conflicts = envConflicts(keys);
    const pinned = new Set(conflicts.map((entry) => entry.key));
    const applicable = keys.filter(
      (key) =>
        !conflicts.some(
          (entry) =>
            key === entry.key ||
            key.startsWith(`${entry.key}.`) ||
            entry.key.startsWith(`${key}.`),
        ),
    );
    const merged = mergeDotted(
      currentConfig(),
      Object.fromEntries(applicable.map((key) => [key, overrides[key]])),
    );
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success)
      return ctx.json(
        invalidConfig("导入的配置校验失败", parsed.error.issues).body,
        400,
      );
    const rows: Array<[string, unknown]> = applicable.map((key) => [
      key,
      readDotted(parsed.data, key),
    ]);
    const unknownKeys = rows
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    if (unknownKeys.length)
      return ctx.json(
        apiError(
          "unknown_config_key",
          `${unknownKeys.join("、")} 不是 schema 里的配置路径`,
        ).body,
        400,
      );
    const subsumed = writeConfigRows(rows, "webui:import");
    dependencies.events.emit("config.changed", { keys: applicable });
    return ctx.json({
      ok: true,
      data: { keys: applicable, skipped: [...pinned], subsumed },
    });
  });
  /**
   * 工具页那张表。扁平的 `minRole` / `approval` / `scope` / `source` / `enabled` / `timeoutMs`
   * 一律是生效值（既有消费点因此无需改动），`defaults` 是代码里那份，`relaxed` 是比默认更宽松的
   * 字段名；两者都给出才能看出当前偏离默认的程度（docs/09 §3.7）。
   *
   * 有注册表时向它查询（合并逻辑只有一份，还能一并列出 MCP / plugin 的工具）；没有则退回静态表。
   *
   * `sides` 现算，取的正是运行时那个判据 `toolCallableBy()`（`#eligible()` 与 `admit()` 共用的
   * 那一份，docs/05 §4）。不在前端也不在这里另写一遍分叉规则：写第二份必然漂移，而漂移的表现是
   * 界面说某个工具 worker 用得上、实际调过去撞 `tool_unavailable_for_worker`。
   */
  const toolSides = (name: string): Array<"main" | "worker"> => [
    ...(toolCallableBy("main", name) ? (["main"] as const) : []),
    ...(toolCallableBy("lw", name) ? (["worker"] as const) : []),
  ];
  app.get("/api/tools", (ctx) => {
    const overrides = currentConfig().tools.overrides;
    if (dependencies.tools) {
      return ctx.json({
        ok: true,
        data: Object.fromEntries(
          dependencies.tools.describe().map((entry) => [
            entry.name,
            {
              ...entry.effective,
              enabled: entry.enabled,
              timeoutMs: entry.timeoutMs,
              selfManagedTimeout: entry.selfManagedTimeout,
              defaults: {
                minRole: entry.defaults.minRole,
                approval: entry.defaults.approval,
                timeoutMs: entry.defaultTimeoutMs,
              },
              // 这个工具当前是常驻还是折叠（`tools.catalog.*`，docs/05 §3.12）。它不是启停开关的
              // 另一种表述：折叠工具照旧可执行，只是模型默认看不到 schema，要先 `search_tools` 展开。
              deferred: entry.deferred,
              // 主 agent 与 lw-worker 的可用集分叉。与 `enabled` 正交：`enabled=false` 是两侧都没有。
              sides: toolSides(entry.name),
              relaxed: entry.relaxed,
            },
          ]),
        ),
      });
    }
    return ctx.json({
      ok: true,
      data: Object.fromEntries(
        Object.entries(TOOL_POLICY).map(([name, policy]) => {
          const override = overrides[name];
          return [
            name,
            {
              ...effectiveToolPolicy(policy, override),
              enabled: override?.enabled !== false,
              timeoutMs: override?.timeoutMs ?? null,
              selfManagedTimeout: false,
              // 这条路没有注册表，折叠判不出来（判据要 `#limits()` 与实际注册进来的那批工具）。
              // 报 false 而不是省掉这个字段：形状统一，前端不必分两种响应处理。
              deferred: false,
              // `sides` 在这条路上照样是真的：判据只看工具名，与有没有注册表无关。
              sides: toolSides(name),
              defaults: {
                minRole: policy.minRole,
                approval: policy.approval,
                timeoutMs: null,
              },
              relaxed: relaxedFields(policy, override),
            },
          ];
        }),
      ),
    });
  });
  /**
   * `chat` 主体的两条硬约束（docs/05 §2.2），四条写入路径共用一份 —— 与 `/grant` 的
   * `chatSubjectError` 同源，端点自己抄一遍的话 WebUI 迟早能建出命令建不出来的主体行。
   * 私聊已不占 `chat:` 行，正数 id 写进去只是一行永不参与判定的死数据；而群 / 频道内的有效角色
   * 封顶 trusted，chat 行的 owner 档在全库零效果，收下它等于让表格说谎。
   */
  const chatSubjectError = (tgId: string, role?: unknown) =>
    !tgId.startsWith("-")
      ? apiError(
          "invalid_chat_id",
          "chat 主体只能是群 / 频道，ID 以 -100 开头。私聊改用 user 主体。",
        )
      : role === "owner"
        ? apiError(
            "invalid_role",
            "chat 主体不能设为 owner：群 / 频道内的有效权限封顶 trusted。",
          )
        : null;
  /**
   * 原样返回主体行，不再合成任何有效角色（docs/05 §2.2）。私聊只占 `user:X` 一行，那一行的
   * 角色就是有效角色，没有第二个数可报；群 / 频道行的角色是**下限**而非有效角色 —— 群里每个
   * 成员各不相同，编一个确定值出来比不给更坏。
   */
  app.get("/api/principals", (ctx) =>
    ctx.json({ ok: true, data: dependencies.principals.list() }),
  );
  app.patch("/api/principals/:id", async (ctx) => {
    const body = await ctx.req.json<{
      role: "owner" | "trusted" | "limited" | "blocked";
    }>();
    const id = ctx.req.param("id");
    const denied = id.startsWith("chat:")
      ? chatSubjectError(id.slice(5), body.role)
      : null;
    if (denied) return ctx.json(denied.body, denied.status);
    const changed = dependencies.principals.setRole(id, body.role, "webui");
    dependencies.log.event({
      level: "info",
      kind: "webui.action",
      summary: "principal role changed",
      data: { id, role: body.role },
    });
    return ctx.json({ ok: true, data: { changed } });
  });
  interface ProviderRow {
    id: string;
    name: string;
    kind: string;
    baseUrl: string | null;
    headers: string | null;
  }
  const providerProbe = async (
    id: string,
    overrides: { kind?: unknown; baseUrl?: unknown; apiKey?: unknown } = {},
  ): Promise<{
    row: ProviderRow;
    result: ProviderProbe;
    adhoc: boolean;
  } | null> => {
    const row = dependencies.db
      .prepare(
        "SELECT id,name,kind,base_url AS baseUrl,headers_json AS headers FROM providers WHERE id=?",
      )
      .get(id) as ProviderRow | undefined;
    if (!row) return null;
    const overrideKey =
      typeof overrides.apiKey === "string" && overrides.apiKey
        ? overrides.apiKey
        : null;
    const adhoc =
      Boolean(overrideKey) ||
      typeof overrides.baseUrl === "string" ||
      typeof overrides.kind === "string";
    let apiKey = overrideKey;
    // 停用的 provider 也要能在启用前先探一次，所以 includeDisabled。
    if (!apiKey)
      try {
        apiKey = dependencies.providers.key(row.id, true);
      } catch {
        return {
          row,
          adhoc,
          result: {
            reachable: false,
            code: "no_master_key",
            message:
              "LUOLI_MASTER_KEY 缺失或已更换，无法解密该 provider 的 API Key",
            status: null,
            latencyMs: 0,
            models: [],
          },
        };
      }
    let headers: Record<string, string> | null = null;
    try {
      headers = row.headers
        ? (JSON.parse(row.headers) as Record<string, string>)
        : null;
    } catch {
      headers = null;
    }
    const kind =
      typeof overrides.kind === "string" && overrides.kind
        ? overrides.kind
        : row.kind;
    const baseUrl =
      typeof overrides.baseUrl === "string" ? overrides.baseUrl : row.baseUrl;
    return {
      row,
      adhoc,
      result: await probeProvider(
        { name: row.name, kind, baseUrl, headers },
        apiKey,
        15_000,
        currentConfig().provider.allowPrivateBaseUrl,
      ),
    };
  };
  app.get("/api/providers", (ctx) =>
    ctx.json({ ok: true, data: dependencies.providers.list() }),
  );
  app.post("/api/providers", async (ctx) => {
    try {
      const id = dependencies.providers.save(await ctx.req.json());
      dependencies.rebuildModels?.();
      return ctx.json({ ok: true, data: { id } });
    } catch (error) {
      return ctx.json(
        apiError(
          "provider_invalid",
          error instanceof Error ? error.message : "Provider 配置无效",
        ).body,
        400,
      );
    }
  });
  /**
   * 能力位里运行时会实际读取的那几个，目前只有 `vision`（`ModelRegistry.supportsVision`，
   * 含图轮次据它自动切换 `vision` 别名，见 `docs/04 §5.2`）。其余能力位只用于 WebUI 的标记，放开
   * 它们等于给运维一个关闭工具的开关，而代码照旧发送工具目录：无效开关比不提供开关更糟
   * （`reviews/16` §5：摘除比伪造安全）。运行时开始读取某个能力位时，再把它加进这里。
   */
  const OVERRIDABLE_CAPABILITIES = ["vision"] as const;
  /**
   * 把 owner 的能力标记合并进 `capabilities_json`。生效值写在顶层：运行时与界面标记都读那里，
   * 无需各自再实现一层人工优先于目录的规则；而人工标记这一事实记在 `manual` 里：`enrich` / `import`
   * 会用目录那份整块覆盖能力位，不保留该意图时一次补齐元数据即静默撤销标记。
   *
   * `null` 表示取消标记：只移除 `manual` 里的键，顶层维持现状（这里不做目录查询，撤销不应依赖出网），
   * 下一次补齐元数据再按目录重新填充，界面上那行提示说明的即是此行为。
   *
   * @returns 新的 JSON 串；本次 patch 未改动任何字段时返回 `null`，调用方据此跳过 UPDATE。
   */
  const applyManualCapabilities = (
    current: string | null,
    patch: Record<string, unknown>,
  ): string | null => {
    let block: Record<string, unknown> = {};
    try {
      block = current ? (JSON.parse(current) as Record<string, unknown>) : {};
    } catch {
      block = {};
    }
    const previous = block.manual;
    const manual: Record<string, unknown> =
      previous && typeof previous === "object" && !Array.isArray(previous)
        ? { ...(previous as Record<string, unknown>) }
        : {};
    let touched = false;
    for (const key of OVERRIDABLE_CAPABILITIES) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === null) {
        if (key in manual) {
          delete manual[key];
          touched = true;
        }
        continue;
      }
      if (typeof value !== "boolean") continue;
      manual[key] = value;
      block[key] = value;
      touched = true;
    }
    if (!touched) return null;
    if (Object.keys(manual).length) block.manual = manual;
    else delete block.manual;
    return JSON.stringify(block);
  };
  /** 把某一行现存的人工标记覆盖回新算出的能力块（`enrich` 用）。损坏的 JSON 一律视为没有标记。 */
  const keepManualCapabilities = (
    next: string,
    current: string | null,
  ): string => {
    let block: Record<string, unknown> = {};
    try {
      block = current ? (JSON.parse(current) as Record<string, unknown>) : {};
    } catch {
      return next;
    }
    const manual = block.manual;
    if (!manual || typeof manual !== "object" || Array.isArray(manual))
      return next;
    return (
      applyManualCapabilities(next, manual as Record<string, unknown>) ?? next
    );
  };
  app.get("/api/models", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.db
        .prepare("SELECT * FROM models ORDER BY provider_id,sort")
        .all(),
    }),
  );
  app.post("/api/models", async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    if (
      typeof body.providerId !== "string" ||
      !body.providerId ||
      typeof body.modelId !== "string" ||
      !body.modelId
    )
      return ctx.json(
        apiError("model_invalid", "providerId 与 modelId 必填").body,
        400,
      );
    const contextWindow = Number(body.contextWindow);
    const maxOutput = Number(body.maxOutput);
    if (
      !Number.isInteger(contextWindow) ||
      contextWindow <= 0 ||
      !Number.isInteger(maxOutput) ||
      maxOutput <= 0
    )
      return ctx.json(
        apiError("model_invalid", "contextWindow 与 maxOutput 必须是正整数")
          .body,
        400,
      );
    const id =
      typeof body.id === "string" && body.id
        ? body.id
        : randomBytes(16).toString("hex");
    // 手工建的行没有目录来源，`capabilities` 整块均由人工给出，其中可覆盖的那几位同时记入
    // `manual`，否则第一次补齐元数据就会按目录改写它们。（这里不校验键名：这条路径同时承载
    // 备份导入的完整能力块；标记这一操作只在 PATCH 上，由那里逐键拦截。）
    const declared =
      body.capabilities &&
      typeof body.capabilities === "object" &&
      !Array.isArray(body.capabilities)
        ? (body.capabilities as Record<string, unknown>)
        : {};
    const capabilities =
      applyManualCapabilities(JSON.stringify(declared), declared) ??
      JSON.stringify(declared);
    try {
      dependencies.db
        .prepare(
          `INSERT INTO models(id,provider_id,model_id,display_name,context_window,max_output,capabilities_json,price_in,price_out,price_cache_read,price_cache_write,enabled,sort,created_at,updated_at)
      VALUES (@id,@providerId,@modelId,@displayName,@contextWindow,@maxOutput,@capabilities,@priceIn,@priceOut,@priceCacheRead,@priceCacheWrite,@enabled,@sort,@now,@now)`,
        )
        .run({
          id,
          providerId: body.providerId,
          modelId: body.modelId,
          displayName: body.displayName ?? null,
          contextWindow,
          maxOutput,
          capabilities,
          priceIn: body.priceIn ?? null,
          priceOut: body.priceOut ?? null,
          priceCacheRead: body.priceCacheRead ?? null,
          priceCacheWrite: body.priceCacheWrite ?? null,
          enabled: body.enabled === false ? 0 : 1,
          sort: body.sort ?? 0,
          now: Date.now(),
        });
    } catch (error) {
      return ctx.json(
        apiError(
          "model_invalid",
          error instanceof Error ? error.message : "模型配置无效",
        ).body,
        400,
      );
    }
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true, data: { id } });
  });
  app.patch("/api/providers/:id", async (ctx) => {
    try {
      const id = dependencies.providers.save({
        ...(await ctx.req.json()),
        id: ctx.req.param("id"),
      });
      dependencies.rebuildModels?.();
      return ctx.json({ ok: true, data: { id } });
    } catch (error) {
      return ctx.json(
        apiError(
          "provider_invalid",
          error instanceof Error ? error.message : "Provider 配置无效",
        ).body,
        400,
      );
    }
  });
  /**
   * 别名链里指向这些模型的 id 一并清除；被清空的别名整行删除并各留一条 warn。
   *
   * `model_aliases.model_ids_json` 存的是 JSON 数组且没有外键，因此删模型不会自动清理它们。
   * 运行时对悬空 id 是静默过滤的（`runtime.ts` 那条 `.filter(Boolean)`），链为空的别名不会注册、
   * `#pick` 直接回退到 `main`，保留它等于在界面上展示一个看似还在、实际早已不生效的别名。
   * 因此删掉它，并把该别名已删除写成 warn 作为唯一凭据（参照 `schedule.purged` 的先例）。
   *
   * 必须在删模型的那个事务内执行：分两次时中途崩溃，留下的正是这些悬空 id。
   */
  const pruneAliases = (
    modelIds: readonly string[],
  ): Array<{ alias: string; removed: string[]; emptied: boolean }> => {
    if (!modelIds.length) return [];
    const gone = new Set(modelIds);
    const touched: Array<{
      alias: string;
      removed: string[];
      emptied: boolean;
    }> = [];
    const rows = dependencies.db
      .prepare("SELECT alias,model_ids_json AS modelIds FROM model_aliases")
      .all() as Array<{ alias: string; modelIds: string }>;
    for (const row of rows) {
      let chain: string[];
      // 手工改过库或历史损坏行：损坏的 JSON 不应让整次删除失败，跳过它（那一行本就不生效）。
      try {
        chain = JSON.parse(row.modelIds) as string[];
      } catch {
        continue;
      }
      if (!Array.isArray(chain)) continue;
      const kept = chain.filter((id) => !gone.has(id));
      if (kept.length === chain.length) continue;
      const removed = chain.filter((id) => gone.has(id));
      if (kept.length)
        dependencies.db
          .prepare(
            "UPDATE model_aliases SET model_ids_json=?, updated_at=? WHERE alias=?",
          )
          .run(JSON.stringify(kept), Date.now(), row.alias);
      else
        dependencies.db
          .prepare("DELETE FROM model_aliases WHERE alias=?")
          .run(row.alias);
      touched.push({ alias: row.alias, removed, emptied: !kept.length });
    }
    return touched;
  };
  /**
   * 默认拒绝，`?cascade=1` 才级联删除。此前这里是一条没有 try/catch 的裸 `DELETE`，触发
   * `models.provider_id` 那个 `NO ACTION` 外键后抛出 `SqliteError` 并返回 500，界面上只剩一句
   * 服务端出错、已记录，给不出原因，而审计中间件那条 `webui.action` 照常记一行，
   * 表现为删除成功（docs/29 · `M-WEB-05`）。
   *
   * 两个动词分开是参照 `schedules` 的先例（`DELETE` 软取消与 `POST …/purge` 硬删）：
   * 删掉这个 provider 与连同它名下 12 行已调好定价与能力位的模型一起删掉，不是同一个决定。
   */
  app.delete("/api/providers/:id", (ctx) => {
    const id = ctx.req.param("id");
    const models = dependencies.db
      .prepare("SELECT id FROM models WHERE provider_id=?")
      .pluck()
      .all(id) as string[];
    if (models.length && ctx.req.query("cascade") !== "1")
      return ctx.json(
        apiError(
          "provider_has_models",
          `还有 ${models.length} 个模型指向该 provider。请先删除这些模型，或使用 ?cascade=1 级联删除。`,
          409,
        ).body,
        409,
      );
    let aliases: Array<{ alias: string; removed: string[]; emptied: boolean }> =
      [];
    const changes = dependencies.db.transaction(() => {
      aliases = pruneAliases(models);
      if (models.length)
        dependencies.db
          .prepare("DELETE FROM models WHERE provider_id=?")
          .run(id);
      return dependencies.db.prepare("DELETE FROM providers WHERE id=?").run(id)
        .changes;
    })();
    for (const entry of aliases.filter((one) => one.emptied))
      dependencies.log.event({
        level: "warn",
        kind: "model.alias_emptied",
        summary: `Alias ${entry.alias} lost every model and was removed`,
        data: { alias: entry.alias, removed: entry.removed, provider: id },
      });
    dependencies.rebuildModels?.();
    return ctx.json({
      ok: true,
      data: { changes, models: models.length, aliases },
    });
  });
  app.post("/api/providers/:id/test", async (ctx) => {
    const body = await ctx.req
      .json<Record<string, unknown>>()
      .catch(() => ({}));
    const probe = await providerProbe(ctx.req.param("id"), body);
    if (!probe)
      return ctx.json(apiError("not_found", "Provider 不存在", 404).body, 404);
    const { row, result, adhoc } = probe;
    // 只有测试库里那份配置才改动健康状态：用临时 key 试错不应摘除线上 provider。
    // 成功写回 up 是 markProviderDown 之后唯一的人工恢复路径；而 404/超时/5xx 不写 down：
    // 网关缺少 /models 不等于对话不可用，据此摘除 provider 会中断可用的模型链。
    if (!adhoc) {
      const now = Date.now();
      if (result.reachable)
        dependencies.db
          .prepare(
            "UPDATE providers SET health_state='up',health_checked_at=?,health_error=NULL WHERE id=?",
          )
          .run(now, row.id);
      else if (result.code === "unauthorized")
        dependencies.db
          .prepare(
            "UPDATE providers SET health_state='down',health_checked_at=?,health_error=? WHERE id=?",
          )
          .run(now, result.message.slice(0, 500), row.id);
      else
        dependencies.db
          .prepare("UPDATE providers SET health_checked_at=? WHERE id=?")
          .run(now, row.id);
      dependencies.rebuildModels?.();
    }
    dependencies.log.event({
      level: result.reachable ? "info" : "warn",
      kind: "provider.health",
      summary: `provider test ${result.code}`,
      data: {
        provider: row.name,
        code: result.code,
        status: result.status,
        latencyMs: result.latencyMs,
        models: result.models.length,
        adhoc,
      },
    });
    if (!adhoc)
      dependencies.events.emit("health", {
        source: "provider",
        name: row.name,
        ok: result.reachable,
        code: result.code,
      });
    return ctx.json({
      ok: true,
      data: {
        reachable: result.reachable,
        code: result.code,
        message: result.message,
        status: result.status,
        latencyMs: result.latencyMs,
        models: result.models.length,
      },
    });
  });
  // 上游的 /models 只给模型名（Google 额外给窗口/输出）。窗口、最大输出、定价、输入模态、
  // 可用思考档位来自 models.dev 的本地缓存目录（docs/04 §5.4.1）；缓存缺失或过期时才出网一次。
  const catalogMeta = async (
    force = false,
  ): Promise<{
    index: CatalogIndex | null;
    status: Record<string, unknown>;
  }> => {
    if (!dependencies.modelCatalog)
      return {
        index: null,
        status: { enabled: false, available: false, outcome: "disabled" },
      };
    const load = await dependencies.modelCatalog.ensure(force);
    return {
      index: load.index,
      status: {
        ...dependencies.modelCatalog.status(),
        outcome: load.outcome,
        error: load.error,
      },
    };
  };
  /** capabilities_json 里那份元数据快照：能力布尔值、思考档位、模态，以及本次匹配的来源信息。
   *  `priceSource` 记录这一行的价格由谁给出，owner 手工改价后会翻成 manual：界面上的
   *  官方价标记必须可被推翻，否则改价后仍显示官方价即是错误信息。 */
  const capabilityBlock = (
    meta: ModelMetadata,
    fetchedAt: number | null,
    priceSource: string | null,
  ): string =>
    JSON.stringify({
      ...meta.capabilities,
      reasoningControl: meta.reasoningControl,
      reasoningEfforts: meta.reasoningEfforts,
      modalities: meta.modalities,
      knowledge: meta.knowledge,
      releaseDate: meta.releaseDate,
      catalog: {
        source: "models.dev",
        match: meta.match,
        providerId: meta.catalogProviderId,
        modelId: meta.catalogModelId,
        normalized: meta.normalized,
        priceRange: meta.priceRange,
        priceSource,
        fetchedAt,
      },
    });
  /** 这一行当前记录的定价出处（`official` / `provider` / `manual`）；未记录或块损坏均视为未知。 */
  const recordedPriceSource = (capabilities: string | null): string | null => {
    try {
      const catalog = (
        JSON.parse(capabilities ?? "{}") as {
          catalog?: { priceSource?: unknown };
        }
      ).catalog;
      return typeof catalog?.priceSource === "string"
        ? catalog.priceSource
        : null;
    } catch {
      return null;
    }
  };
  app.get("/api/providers/:id/models", async (ctx) => {
    const probe = await providerProbe(ctx.req.param("id"));
    if (!probe)
      return ctx.json(apiError("not_found", "Provider 不存在", 404).body, 404);
    const { row, result } = probe;
    if (!result.reachable) {
      const status =
        result.code === "unauthorized"
          ? 403
          : result.code === "missing_base_url" ||
              result.code === "no_master_key"
            ? 400
            : 502;
      return ctx.json(
        apiError(result.code, result.message, status).body,
        status,
      );
    }
    const catalog = await catalogMeta();
    const models = result.models.map((entry) => {
      const meta =
        dependencies.modelCatalog?.lookup(
          catalog.index,
          { kind: row.kind, baseUrl: row.baseUrl },
          entry.modelId,
        ) ?? null;
      return {
        ...entry,
        // 上游自己报的窗口/输出是它这台机器上的事实，比目录更权威；只有上游没给才用目录补。
        contextWindow: entry.contextWindow ?? meta?.contextWindow ?? null,
        maxOutput: entry.maxOutput ?? meta?.maxOutput ?? null,
        limitSource:
          entry.contextWindow !== null || entry.maxOutput !== null
            ? "upstream"
            : meta?.contextWindow
              ? "models.dev"
              : null,
        displayName: entry.displayName ?? meta?.displayName ?? null,
        priceIn: meta?.priceIn ?? null,
        priceOut: meta?.priceOut ?? null,
        priceCacheRead: meta?.priceCacheRead ?? null,
        priceCacheWrite: meta?.priceCacheWrite ?? null,
        meta: meta ?? null,
      };
    });
    return ctx.json({
      ok: true,
      data: { models, latencyMs: result.latencyMs, catalog: catalog.status },
    });
  });
  app.get("/api/models/catalog", async (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.modelCatalog?.status() ?? {
        enabled: false,
        available: false,
      },
    }),
  );
  app.post("/api/models/catalog/refresh", async (ctx) => {
    if (!dependencies.modelCatalog)
      return ctx.json(
        apiError("catalog_disabled", "模型元数据目录未启用").body,
        400,
      );
    const load = await dependencies.modelCatalog.ensure(true);
    dependencies.log.event({
      level: load.error ? "warn" : "info",
      kind: "provider.catalog",
      summary: `models.dev ${load.outcome}`,
      data: {
        outcome: load.outcome,
        error: load.error,
        models: load.state?.models ?? 0,
      },
    });
    // 出网失败但盘上还有旧缓存时返回 200 + error：目录是降级可用的，硬报错会让界面以为一条都没有。
    if (load.outcome === "unavailable")
      return ctx.json(
        apiError(
          "catalog_unavailable",
          load.error ?? "无法拉取模型元数据目录",
          502,
        ).body,
        502,
      );
    return ctx.json({
      ok: true,
      data: {
        ...dependencies.modelCatalog.status(),
        outcome: load.outcome,
        error: load.error,
      },
    });
  });
  app.post("/api/models/import", async (ctx) => {
    const body = await ctx.req.json<{
      providerId?: unknown;
      models?: unknown;
      contextWindow?: unknown;
      maxOutput?: unknown;
    }>();
    const providerId =
      typeof body.providerId === "string" ? body.providerId : "";
    const provider = dependencies.db
      .prepare("SELECT kind,base_url AS baseUrl FROM providers WHERE id=?")
      .get(providerId) as { kind: string; baseUrl: string | null } | undefined;
    if (!providerId || !provider)
      return ctx.json(
        apiError("not_found", "providerId 不存在", 404).body,
        404,
      );
    if (!Array.isArray(body.models) || body.models.length === 0)
      return ctx.json(
        apiError("model_invalid", "models 必须是非空数组").body,
        400,
      );
    if (body.models.length > 200)
      return ctx.json(
        apiError("model_invalid", "单次最多导入 200 个模型").body,
        400,
      );
    const int = (value: unknown): number | null =>
      Number.isInteger(Number(value)) && Number(value) > 0
        ? Number(value)
        : null;
    const price = (value: unknown): number | null =>
      value === null || value === undefined || value === ""
        ? null
        : Number.isFinite(Number(value)) && Number(value) >= 0
          ? Number(value)
          : null;
    const fallbackWindow = int(body.contextWindow) ?? 128_000;
    const fallbackOutput = int(body.maxOutput) ?? 8192;
    const entries: Array<{
      modelId: string;
      displayName: string | null;
      contextWindow: number;
      maxOutput: number;
      prices: Array<number | null>;
    }> = [];
    for (const raw of body.models) {
      const entry =
        raw && typeof raw === "object"
          ? (raw as Record<string, unknown>)
          : null;
      const modelId =
        entry && typeof entry.modelId === "string" ? entry.modelId.trim() : "";
      if (!modelId)
        return ctx.json(
          apiError("model_invalid", "每一项必须包含非空 modelId").body,
          400,
        );
      entries.push({
        modelId,
        displayName:
          typeof entry?.displayName === "string" && entry.displayName
            ? entry.displayName
            : null,
        contextWindow: int(entry?.contextWindow) ?? fallbackWindow,
        maxOutput: int(entry?.maxOutput) ?? fallbackOutput,
        prices: [
          price(entry?.priceIn),
          price(entry?.priceOut),
          price(entry?.priceCacheRead),
          price(entry?.priceCacheWrite),
        ],
      });
    }
    // 能力与定价出处一律在服务端重新解析：请求体里的 capabilities 是客户端说的，落库的必须是目录里实际有的那条。
    const catalog = await catalogMeta();
    // 已存在的 (provider,model) 跳过而不是覆盖：覆盖会冲掉已调好的定价；补齐已有行走 /api/models/enrich。
    const insert = dependencies.db
      .prepare(`INSERT INTO models(id,provider_id,model_id,display_name,context_window,max_output,capabilities_json,price_in,price_out,price_cache_read,price_cache_write,enabled,sort,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?,?) ON CONFLICT(provider_id,model_id) DO NOTHING`);
    const ids: string[] = [];
    const now = Date.now();
    const fetchedAt =
      typeof catalog.status.fetchedAt === "number"
        ? catalog.status.fetchedAt
        : null;
    let priced = 0;
    dependencies.db.transaction(() => {
      for (const entry of entries) {
        const id = randomBytes(16).toString("hex");
        const meta =
          dependencies.modelCatalog?.lookup(
            catalog.index,
            provider,
            entry.modelId,
          ) ?? null;
        const capabilities = meta
          ? capabilityBlock(
              meta,
              fetchedAt,
              entry.prices[0] !== null ? meta.match : null,
            )
          : "{}";
        if (
          insert.run(
            id,
            providerId,
            entry.modelId,
            entry.displayName,
            entry.contextWindow,
            entry.maxOutput,
            capabilities,
            ...entry.prices,
            now,
            now,
          ).changes > 0
        ) {
          ids.push(id);
          if (entry.prices[0] !== null) priced += 1;
        }
      }
    })();
    dependencies.rebuildModels?.();
    return ctx.json({
      ok: true,
      data: {
        inserted: ids.length,
        skipped: entries.length - ids.length,
        priced,
        ids,
      },
    });
  });
  /** 为已导入的模型行补充元数据：能力块照写，但人工标记要覆盖回去（能力块不再是纯信息，
   *  `vision` 具有运行时行为）；定价只填补为空的那几项；
   *  窗口与最大输出默认不动：运维可能按自身预算调小过，覆盖需显式 overwrite。 */
  app.post("/api/models/enrich", async (ctx) => {
    const body = await ctx.req
      .json<{ ids?: unknown; overwrite?: unknown }>()
      .catch((): { ids?: unknown; overwrite?: unknown } => ({}));
    const wanted = Array.isArray(body.ids)
      ? new Set(
          body.ids.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        )
      : null;
    const overwrite = body.overwrite === true;
    const rows = dependencies.db
      .prepare(
        `SELECT m.id,m.model_id AS modelId,m.context_window AS contextWindow,m.max_output AS maxOutput,m.price_in AS priceIn,m.price_out AS priceOut,
      m.price_cache_read AS priceCacheRead,m.price_cache_write AS priceCacheWrite,m.capabilities_json AS capabilities,p.kind,p.base_url AS baseUrl FROM models m JOIN providers p ON p.id=m.provider_id`,
      )
      .all() as Array<Record<string, unknown>>;
    const targets = rows.filter((row) => !wanted || wanted.has(String(row.id)));
    if (!targets.length)
      return ctx.json({
        ok: true,
        data: { updated: 0, priced: 0, unmatched: 0, scanned: 0 },
      });
    const catalog = await catalogMeta();
    if (!catalog.index)
      return ctx.json(
        apiError(
          "catalog_unavailable",
          String(catalog.status.error ?? "模型元数据目录不可用，无法补齐"),
          502,
        ).body,
        502,
      );
    const fetchedAt =
      typeof catalog.status.fetchedAt === "number"
        ? catalog.status.fetchedAt
        : null;
    const update = dependencies.db.prepare(
      `UPDATE models SET capabilities_json=?,context_window=?,max_output=?,price_in=?,price_out=?,price_cache_read=?,price_cache_write=?,updated_at=? WHERE id=?`,
    );
    let updated = 0;
    let priced = 0;
    let unmatched = 0;
    const now = Date.now();
    dependencies.db.transaction(() => {
      for (const row of targets) {
        const meta = dependencies.modelCatalog!.lookup(
          catalog.index,
          { kind: String(row.kind), baseUrl: row.baseUrl as string | null },
          String(row.modelId),
        );
        if (meta.match === "none") {
          unmatched += 1;
          continue;
        }
        const keep = (current: unknown, next: number | null): number | null =>
          current !== null && current !== undefined ? Number(current) : next;
        const nextPrices = [
          keep(row.priceIn, meta.priceIn),
          keep(row.priceOut, meta.priceOut),
          keep(row.priceCacheRead, meta.priceCacheRead),
          keep(row.priceCacheWrite, meta.priceCacheWrite),
        ];
        const filled = row.priceIn === null && nextPrices[0] !== null;
        // 既有价格不一定是人工填写的：导入时从 models.dev 带进来的行同样非空，而这里此前一律标为
        // `manual`，数字未变而出处被静默改写，`AC-WEB-013c` 关注的价格可信度被一次操作清零
        // 且不可逆（docs/29 · M-WEB-09）。价格未变时沿用原有出处；从未记录过出处的行早于目录
        // 导入，只可能是人工填写的。
        const priceSource =
          row.priceIn !== null
            ? (recordedPriceSource(row.capabilities as string | null) ??
              "manual")
            : nextPrices[0] !== null
              ? meta.match
              : null;
        update.run(
          keepManualCapabilities(
            capabilityBlock(meta, fetchedAt, priceSource),
            row.capabilities as string | null,
          ),
          overwrite
            ? (meta.contextWindow ?? Number(row.contextWindow))
            : Number(row.contextWindow),
          overwrite
            ? (meta.maxOutput ?? Number(row.maxOutput))
            : Number(row.maxOutput),
          ...nextPrices,
          now,
          row.id,
        );
        updated += 1;
        if (filled) priced += 1;
      }
    })();
    dependencies.rebuildModels?.();
    dependencies.log.event({
      level: "info",
      kind: "webui.action",
      summary: "model metadata enriched",
      data: { scanned: targets.length, updated, priced, unmatched, overwrite },
    });
    return ctx.json({
      ok: true,
      data: { scanned: targets.length, updated, priced, unmatched },
    });
  });
  app.get("/api/aliases", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.db
        .prepare("SELECT * FROM model_aliases ORDER BY alias")
        .all(),
    }),
  );
  app.put("/api/aliases/:alias", async (ctx) => {
    const body = await ctx.req.json<{
      modelIds?: string[];
      settings?: unknown;
      description?: string;
    }>();
    const alias = ctx.req.param("alias");
    if (!ALIAS_NAME_PATTERN.test(alias))
      return ctx.json(
        apiError("alias_invalid", "别名只能是小写字母开头的 1-32 位 [a-z0-9_-]")
          .body,
        400,
      );
    if (
      !Array.isArray(body.modelIds) ||
      body.modelIds.some((id) => typeof id !== "string")
    )
      return ctx.json(
        apiError("alias_invalid", "modelIds 必须是模型 ID 数组").body,
        400,
      );
    // 空链会让别名在 registry 里静默消失（chain[0] 不存在就整条跳过），删别名要走 DELETE。
    if (!body.modelIds.length)
      return ctx.json(
        apiError(
          "alias_invalid",
          "fallback 链至少包含一个模型；移除别名请使用 DELETE",
        ).body,
        400,
      );
    const placeholders = body.modelIds.map(() => "?").join(",");
    const found = Number(
      dependencies.db
        .prepare(`SELECT COUNT(*) FROM models WHERE id IN (${placeholders})`)
        .pluck()
        .get(...body.modelIds),
    );
    if (found !== body.modelIds.length)
      return ctx.json(
        apiError("alias_invalid", "fallback 链包含不存在的模型").body,
        400,
      );
    const settings = aliasSettingsSchema.safeParse(body.settings ?? {});
    if (!settings.success)
      return ctx.json(
        apiError(
          "alias_invalid",
          settings.error.issues
            .map(
              (issue) =>
                `settings${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`,
            )
            .join("；"),
        ).body,
        400,
      );
    const hasSettings = Object.keys(settings.data).length > 0;
    dependencies.db
      .prepare(
        `INSERT INTO model_aliases(alias,model_ids_json,settings_json,description,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(alias) DO UPDATE SET model_ids_json=excluded.model_ids_json,settings_json=excluded.settings_json,description=excluded.description,updated_at=excluded.updated_at`,
      )
      .run(
        alias,
        JSON.stringify(body.modelIds),
        hasSettings ? JSON.stringify(settings.data) : null,
        body.description ?? null,
        Date.now(),
      );
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true });
  });
  app.delete("/api/aliases/:alias", (ctx) => {
    const changed = dependencies.db
      .prepare("DELETE FROM model_aliases WHERE alias=?")
      .run(ctx.req.param("alias")).changes;
    if (!changed)
      return ctx.json(apiError("not_found", "别名不存在", 404).body, 404);
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true });
  });
  // 触发消息自身不带 turn_id（只有回复落盘时才写那一列），而这条消息触发的那一轮发生了什么，
  // 恰是检索结果里最需要展开的内容，因此回填一次，让搜索命中也能跳转到对话详情。
  const attachTurnIds = (rows: unknown[]): unknown[] => {
    const items = rows as Array<Record<string, unknown>>;
    const pending = items
      .filter((row) => !row.turnId)
      .map((row) => Number(row.id));
    if (!pending.length) return items;
    const owners = new Map(
      (
        dependencies.db
          .prepare(
            `SELECT trigger_message_id AS messageId,id FROM turns WHERE trigger_message_id IN (${pending.map(() => "?").join(",")})`,
          )
          .all(...pending) as Array<{ messageId: number; id: string }>
      ).map((row) => [row.messageId, row.id]),
    );
    for (const row of items)
      if (!row.turnId) row.turnId = owners.get(Number(row.id)) ?? null;
    return items;
  };
  // 图片与文件此前在管理端完全不可见：消息行不带 attachment id，界面上也就没有可展开的入口
  // （docs/21 · G-API-08）。一次 IN 查询按 message_id 归组，不返回 local_path：
  // 磁盘路径对界面没有用途，暴露出去只会泄露部署布局。
  const withAttachments = (rows: unknown[]): unknown[] => {
    const items = rows as Array<Record<string, unknown>>;
    const ids = [
      ...new Set(
        items.map((row) => Number(row.id)).filter((id) => Number.isInteger(id)),
      ),
    ];
    if (!ids.length) return items;
    const grouped = new Map<number, Array<Record<string, unknown>>>();
    for (const row of dependencies.db
      .prepare(
        `SELECT id,message_id AS messageId,kind,mime,file_name AS fileName,size_bytes AS sizeBytes,width,height,
      duration_sec AS durationSec,download_state AS downloadState,download_error AS downloadError,extract_state AS extractState,
      local_path IS NOT NULL AS hasLocal FROM attachments WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...ids) as Array<Record<string, unknown>>) {
      const list = grouped.get(Number(row.messageId)) ?? [];
      list.push(row);
      grouped.set(Number(row.messageId), list);
    }
    for (const row of items)
      row.attachments = grouped.get(Number(row.id)) ?? [];
    return items;
  };
  app.get("/api/messages", (ctx) => {
    const query = ctx.req.query("q") ?? "";
    const {
      page: pageNumber,
      size,
      offset,
    } = pageParams(ctx, { defaultSize: 50, maxSize: 200 });
    // 非搜索分支此前是 `LIMIT 1000` 拉回来再在内存里切：`size=50` 时第 21 页起永远是空的，
    // `total` 也封顶在 1000，界面上的页码是假的（docs/22 · I-01）。改成和 /api/turns 一样
    // 走 SQL 的 LIMIT/OFFSET + 单独 COUNT(*)。搜索分支仍走 FTS，它自己有命中上限。
    if (!query) {
      const total = Number(
        dependencies.db
          .prepare("SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL")
          .pluck()
          .get(),
      );
      const items = dependencies.db
        .prepare(
          `SELECT id,chat_id AS chatId,message_thread_id AS threadId,tg_message_id AS tgMessageId,direction,from_kind AS fromKind,from_user_id AS fromUserId,from_name AS fromName,from_username AS fromUsername,kind,text,tg_date AS tgDate,triggered,trigger_reason AS triggerReason,turn_id AS turnId,revision,deleted_at AS deletedAt
        FROM messages WHERE deleted_at IS NULL ORDER BY tg_date DESC,id DESC LIMIT ? OFFSET ?`,
        )
        .all(size, offset);
      return ctx.json({
        ok: true,
        data: {
          page: pageNumber,
          size,
          total,
          items: withAttachments(attachTurnIds(items)),
        },
      });
    }
    const paged = page(
      dependencies.archive.adminSearchAll(query, pageNumber * size),
      pageNumber,
      size,
    );
    // 搜索分支只取回了 page*size 条，`items.length` 不是命中总数 —— total 必须单独数（docs/20 · W-API-03）。
    return ctx.json({
      ok: true,
      data: {
        ...paged,
        total: dependencies.archive.adminSearchCount(query),
        items: withAttachments(attachTurnIds(paged.items)),
      },
    });
  });
  // 消息页默认展示最近几次模型对话而不是逐条消息流：一次 turn 的提问与回答分散在多行，
  // 按行翻页无法还原对话结构。分页走 SQL 的 LIMIT/OFFSET，turns 表可能很大，不整表读回再切分。
  app.get("/api/turns", (ctx) => {
    const {
      page: pageNumber,
      size,
      offset,
    } = pageParams(ctx, { defaultSize: 20, maxSize: 100 });
    const total = Number(
      dependencies.db.prepare("SELECT COUNT(*) FROM turns").pluck().get(),
    );
    const items = dependencies.db
      .prepare(
        `SELECT t.id,t.key,t.chat_id AS chatId,t.initiator_user_id AS userId,t.effective_role AS role,t.state,t.trigger_reason AS triggerReason,
      COALESCE(t.started_at,t.queued_at) AS startedAt,t.finished_at AS finishedAt,t.steps,t.tool_calls AS toolCalls,t.input_tokens AS inputTokens,t.output_tokens AS outputTokens,t.cost_usd AS costUsd,t.error,t.rebased,
      m.id AS promptMessageId,m.text AS prompt,m.kind AS promptKind,m.from_name AS fromName,m.from_username AS fromUsername
      FROM turns t LEFT JOIN messages m ON m.id=t.trigger_message_id AND m.deleted_at IS NULL
      ORDER BY COALESCE(t.started_at,t.queued_at) DESC,t.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(size, offset) as Array<Record<string, unknown>>;
    if (items.length) {
      const placeholders = items.map(() => "?").join(",");
      const replies = dependencies.db
        .prepare(
          `SELECT turn_id AS turnId,text FROM messages WHERE turn_id IN (${placeholders}) AND direction='out' AND deleted_at IS NULL ORDER BY id`,
        )
        .all(...items.map((item) => item.id)) as Array<{
        turnId: string;
        text: string | null;
      }>;
      // 流式回复被切成多条 Telegram 消息时，归档里每条存的都是同一份全文（archive.append 拿的是 answer），
      // 直接拼会把回答重复 N 遍，所以按内容去重。
      const grouped = new Map<string, string[]>();
      for (const row of replies) {
        const previous = grouped.get(row.turnId) ?? [];
        if (row.text && !previous.includes(row.text))
          grouped.set(row.turnId, [...previous, row.text]);
      }
      for (const item of items)
        item.reply = (grouped.get(String(item.id)) ?? []).join("\n\n");
      // 附件挂在触发消息上，不是 turn 上：借 promptMessageId 走同一条归组逻辑，再搬回 turn 行。
      const carriers: Array<Record<string, unknown>> = items
        .filter((item) => item.promptMessageId !== null)
        .map((item) => ({ id: item.promptMessageId }));
      withAttachments(carriers);
      const byMessage = new Map(
        carriers.map((row) => [Number(row.id), row.attachments]),
      );
      for (const item of items)
        item.attachments = byMessage.get(Number(item.promptMessageId)) ?? [];
    }
    return ctx.json({
      ok: true,
      data: { items, total, page: pageNumber, size },
    });
  });
  // 在途 turn 的权威来源是进程内的 TurnRegistry，不是 turns 表：崩溃残留的 running 行要等
  // 下次启动的 recoverAfterCrash 才归零，只读表会把它们也画成「正在跑」。步数与花费仍来自表
  // （记账侧一直在写），一次 IN 查询取回。
  app.get("/api/turns/active", (ctx) => {
    const active = dependencies.turnRegistry?.list() ?? [];
    if (!active.length) return ctx.json({ ok: true, data: [] });
    const stats = new Map(
      (
        dependencies.db
          .prepare(
            `SELECT id,steps,tool_calls AS toolCalls,cost_usd AS costUsd,input_tokens AS inputTokens,output_tokens AS outputTokens
      FROM turns WHERE id IN (${active.map(() => "?").join(",")})`,
          )
          .all(...active.map((turn) => turn.id)) as Array<
          Record<string, unknown>
        >
      ).map((row) => [String(row.id), row]),
    );
    return ctx.json({
      ok: true,
      data: active.map((turn) => ({
        id: turn.id,
        key: turn.key,
        chatId: turn.chatId,
        userId: turn.userId,
        role: turn.role,
        startedAt: turn.startedAt,
        steps: 0,
        toolCalls: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        ...stats.get(turn.id),
      })),
    });
  });
  // WebUI 此前没有任何取消通道：Telegram 侧有 /cancel 与流式消息上的取消按钮，管理端只能干等
  // 到 concurrency.turnTimeoutMs（docs/21 · G-SRV-01）。取消是 abort 信号，不是删除：
  // 该轮走 abortTurn 落成 cancelled，上下文与已发出的消息都还在。
  app.post("/api/turns/:id/cancel", (ctx) => {
    if (!dependencies.turnRegistry)
      return ctx.json(
        apiError(
          "not_implemented",
          "这个部署没有装配 TurnRegistry，无法取消",
          500,
        ).body,
        500,
      );
    // WebUI 是单角色 owner（GET /api/auth/me），owner 可以取消任何人的轮次。
    const cancelled = dependencies.turnRegistry.cancel(
      ctx.req.param("id"),
      "webui",
      "owner",
    );
    dependencies.log.event({
      level: "info",
      kind: "turn.cancel",
      summary: cancelled
        ? "turn cancelled from webui"
        : "turn already finished",
      traceId: ctx.req.param("id"),
      data: { cancelled },
    });
    return ctx.json({ ok: true, data: { cancelled } });
  });
  // 本轮向上游发送了什么，只有日志里那一份记录：turns 表存的是统计，messages 表存的是最终文本。
  // trace_id 就是 turn id，把该轮的 span 连同载荷一起读出来即可。
  //
  // 本函数收的是**已经解码好**的 JSON 文本，不是那个 BLOB —— 它同时服务于
  // `context_messages.parts_json`（那一列本来就是 TEXT），把解码塞进来会让两条路的入参
  // 变成两种东西。日志侧的解码在调用点用 `decodeLogPayload` 完成（docs/10 §3）。
  const DETAIL_MAX_CHARS = 120_000;
  interface DetailPayload {
    text: string | null;
    bytes: number;
    truncated: boolean;
  }
  const detailPayload = (raw: string | null): DetailPayload => {
    if (!raw) return { text: null, bytes: 0, truncated: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        text: raw.slice(0, DETAIL_MAX_CHARS),
        bytes: Buffer.byteLength(raw),
        truncated: raw.length > DETAIL_MAX_CHARS,
      };
    }
    const text = JSON.stringify(parsed, null, 2) ?? "";
    return {
      text: text.slice(0, DETAIL_MAX_CHARS),
      bytes: Buffer.byteLength(text),
      truncated: text.length > DETAIL_MAX_CHARS,
    };
  };
  app.get("/api/turns/:id/detail", (ctx) => {
    const id = ctx.req.param("id");
    const turn = dependencies.db
      .prepare(
        `SELECT t.id,t.key,t.chat_id AS chatId,t.initiator_user_id AS userId,t.effective_role AS role,t.state,t.trigger_reason AS triggerReason,
      COALESCE(t.started_at,t.queued_at) AS startedAt,t.finished_at AS finishedAt,t.steps,t.model_calls AS modelCalls,t.tool_calls AS toolCalls,t.input_tokens AS inputTokens,
      t.output_tokens AS outputTokens,t.cost_usd AS costUsd,t.error,t.rebased,m.text AS prompt,m.kind AS promptKind,m.from_name AS fromName,m.from_username AS fromUsername
      FROM turns t LEFT JOIN messages m ON m.id=t.trigger_message_id AND m.deleted_at IS NULL WHERE t.id=?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!turn)
      return ctx.json(
        apiError("not_found", "该轮次不存在（可能已被日志/数据清理）", 404)
          .body,
        404,
      );
    const rows = dependencies.db
      .prepare(
        `SELECT id,ts,level,kind,summary,span_id AS spanId,parent_span_id AS parentSpanId,duration_ms AS durationMs,data,data_codec AS codec
      FROM log_events WHERE trace_id=? ORDER BY ts,id LIMIT 500`,
      )
      .all(id) as Array<
      Record<string, unknown> & { data: Buffer | null; codec: string | null }
    >;
    const events = rows.map(({ data, codec, ...row }) => ({
      ...row,
      ...detailPayload(decodeLogPayload(data, codec)),
    }));
    // 工具输入的第二个来源，也是唯一对历史轮次有效的那个：`log_events` 按 logs.retentionDays 清理，
    // 且 `logs.captureBodies=false` 时不带请求体，而 `context_messages.parts_json` 永久保留。
    // 刻意不走 `ContextRepository.messages()`：那条路会执行 elidePart，把降级过的行改写成
    // `{elided:true}`。分级降级只翻转 prune_applied 标志位、原始 parts 始终保留（docs/02 §裁剪）,
    // 因此这里直接读列，并把 prune 状态一并送出：界面要能说明模型已看不到这段参数，以及它的原文。
    const contextRows = dependencies.db
      .prepare(
        `SELECT ordinal,id,role,origin,prune_level AS pruneLevel,prune_applied AS pruneApplied,
      parts_json AS parts,text_preview AS textPreview,tokens,created_at AS createdAt
      FROM context_messages WHERE key=? AND turn_id=? ORDER BY ordinal LIMIT 500`,
      )
      .all(turn.key, id) as Array<Record<string, unknown> & { parts: string }>;
    const contextMessages = contextRows.map(({ parts, ...row }) => ({
      ...row,
      pruneApplied: Boolean(row.pruneApplied),
      ...detailPayload(parts),
    }));
    // 这一轮派出去的 worker。主 run（`worker_kind IS NULL`）就是这一轮本身，列在自己的子表里
    // 只会让人以为它派了一个自己。三种 worker 共用这一张表，`workerKind` 是它们唯一的区分符。
    const workerRuns = dependencies.db
      .prepare(
        `SELECT id,worker_kind AS workerKind,agent_name AS agentName,model_alias AS modelAlias,state,steps,
      tool_calls AS toolCalls,cost_usd AS costUsd,external_cost_usd AS externalCostUsd,result_summary AS resultSummary,
      error,started_at AS startedAt,finished_at AS finishedAt
      FROM agent_runs WHERE turn_id=? AND worker_kind IS NOT NULL ORDER BY started_at`,
      )
      .all(id);
    return ctx.json({
      ok: true,
      data: {
        turn,
        captureBodies: currentConfig().logs.captureBodies,
        events,
        contextMessages,
        workerRuns,
      },
    });
  });
  // `raw_json` 只在单条详情里返回，不进列表：一页 50 条各带一份完整 Telegram update，
  // 一次检索即需传输数 MB。这一列从 `0001_init.sql` 起就在写，而在此之前全仓没有一处读过它
  // （`get_message` 也没有，`MESSAGE_COLUMNS` 里就没有这一列），界面上没有任何入口
  // （docs/29 · `M-WEB-06`）。返回的是入库时经 `redactArchivePayload` 处理过的那份。
  app.get("/api/messages/:id", (ctx) => {
    const row = dependencies.db
      .prepare(
        "SELECT id,chat_id AS chatId,message_thread_id AS threadId,tg_message_id AS tgMessageId,direction,from_kind AS fromKind,from_user_id AS fromUserId,from_name AS fromName,from_username AS fromUsername,kind,text,tg_date AS tgDate,triggered,trigger_reason AS triggerReason,turn_id AS turnId,revision,deleted_at AS deletedAt,raw_json AS rawJson FROM messages WHERE id=?",
      )
      .get(Number(ctx.req.param("id")));
    return row
      ? ctx.json({ ok: true, data: row })
      : ctx.json(apiError("not_found", "消息不存在", 404).body, 404);
  });
  app.delete("/api/messages/:id", (ctx) => {
    const id = Number(ctx.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0)
      return ctx.json(apiError("invalid_message_id", "消息 id 无效").body, 400);
    const changes = dependencies.db
      .prepare(
        "UPDATE messages SET deleted_at=? WHERE id=? AND deleted_at IS NULL",
      )
      .run(Date.now(), id).changes;
    dependencies.log.event({
      level: "info",
      kind: "webui.action",
      summary: changes
        ? "archive message soft-deleted"
        : "archive message already absent",
      data: { id, changes },
    });
    return ctx.json({ ok: true, data: { id, changes } });
  });
  app.get("/api/files/:attachmentId", (ctx) => {
    const row = dependencies.db
      .prepare(
        "SELECT local_path AS path,mime,file_name AS name FROM attachments WHERE id=?",
      )
      .get(ctx.req.param("attachmentId")) as
      | { path: string | null; mime: string | null; name: string | null }
      | undefined;
    if (!row?.path)
      return ctx.json(apiError("not_found", "附件不存在", 404).body, 404);
    let absolute: string;
    try {
      absolute = storedPathWithin(currentConfig().media.dir, row.path);
    } catch {
      return ctx.json(
        apiError("not_found", "附件路径不在媒体目录内", 404).body,
        404,
      );
    }
    if (!existsSync(absolute))
      return ctx.json(apiError("not_found", "附件不存在", 404).body, 404);
    // `?inline=1` 只对光栅图放行。同源内联渲染 SVG/HTML 等于把用户上传的内容变成本站脚本，
    // 而附件的 mime 来自 Telegram、是发送方可控的 —— 白名单之外一律照旧当附件下载。
    const inline =
      ctx.req.query("inline") === "1" && INLINE_MIME.has(row.mime ?? "");
    // 流式而不是 `readFileSync`：一份 20 MB 的文档此前是一次 20 MB 堆分配加一次 20 MB 响应缓冲，
    // 而 `media.maxDocBytes` 就是 20 MiB（docs/27 · S-07）。
    return new Response(
      Readable.toWeb(createReadStream(absolute)) as ReadableStream,
      {
        headers: {
          "content-type": row.mime ?? "application/octet-stream",
          "content-length": String(statSync(absolute).size),
          "content-disposition": inline
            ? "inline"
            : contentDisposition(row.name ?? ctx.req.param("attachmentId")),
        },
      },
    );
  });
  app.get("/api/chats/:key/context", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.context.materialize(
        ctx.req.param("key"),
        ctx.req.query("commit") ?? null,
        currentConfig().context.cacheCommits,
      ),
    }),
  );
  app.get("/api/chats/:key/commits", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.context.stats(ctx.req.param("key"), {
        timeline: true,
      }),
    }),
  );
  app.post("/api/chats/:key/commits/:id/checkout", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.context.setHead(
        ctx.req.param("key"),
        ctx.req.param("id"),
        "webui",
      ),
    }),
  );
  // `advanceClaims` 跟着 `context.recallBarrier`：开着时清空要连背景认领水位一起推，否则清空前
  // 那些没被认领的群发言会从另一扇门进到新窗口里（`ContextEngine.reset` 的 docstring）。
  app.post("/api/chats/:key/reset", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.context.reset(ctx.req.param("key"), "webui", {
        advanceClaims: currentConfig().context.recallBarrier,
      }),
    }),
  );
  app.post("/api/chats/:key/undo", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.context.undo(ctx.req.param("key")),
    }),
  );
  app.patch("/api/models/:id", async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    const map: Record<string, string> = {
      displayName: "display_name",
      contextWindow: "context_window",
      maxOutput: "max_output",
      priceIn: "price_in",
      priceOut: "price_out",
      priceCacheRead: "price_cache_read",
      priceCacheWrite: "price_cache_write",
      enabled: "enabled",
      sort: "sort",
    };
    const entries = Object.entries(body).filter(([key]) => map[key]);
    /**
     * 能力标记：中转站照搬官方模型名却不实际转发图片时，`capabilities_json` 里继承的
     * `vision:true` 会让含图轮次不切换到 `vision` 别名，图片留在一个读不到它的模型上
     * （实测 `logs/2026-08-19`：同一家网关的 grok-4.5 接收 image_url、返回 200，
     * usage 里没有 image_tokens，四次回复均为推测；同一家的 grok-4.3 正常）。目录改变不了该事实，
     * 因此要给运维一条推翻它的途径，这是本项存在的唯一理由。
     *
     * 白名单之外的键报错而不是静默忽略：让人误以为标记了不支持工具就不会发送工具目录，
     * 比不提供这个选项更糟。
     */
    const patch =
      body.capabilities &&
      typeof body.capabilities === "object" &&
      !Array.isArray(body.capabilities)
        ? (body.capabilities as Record<string, unknown>)
        : null;
    if (patch) {
      const stray = Object.keys(patch).filter(
        (key) => !(OVERRIDABLE_CAPABILITIES as readonly string[]).includes(key),
      );
      if (stray.length)
        return ctx.json(
          apiError(
            "model_invalid",
            `只有 ${OVERRIDABLE_CAPABILITIES.join(" / ")} 支持人工标记；${stray.join("、")} 运行时不读取，标记后不影响行为`,
          ).body,
          400,
        );
      if (
        Object.values(patch).some(
          (value) => value !== null && typeof value !== "boolean",
        )
      )
        return ctx.json(
          apiError(
            "model_invalid",
            "能力标记只能是 true / false / null（null = 取消标记，回到目录判断）",
          ).body,
          400,
        );
    }
    if (!entries.length && !patch)
      return ctx.json({ ok: true, data: { changes: 0 } });
    let changes = 0;
    if (entries.length) {
      const sql = entries.map(([key]) => `${map[key]}=?`).join(",");
      const values = entries.map(([key, value]) =>
        key === "enabled" ? (value ? 1 : 0) : value,
      );
      changes = dependencies.db
        .prepare(`UPDATE models SET ${sql},updated_at=? WHERE id=?`)
        .run(...values, Date.now(), ctx.req.param("id")).changes;
    }
    // 手工改价后仍显示官方价标记即是错误信息：把出处翻成 manual，界面据此更新标记。
    if (changes && entries.some(([key]) => key.startsWith("price"))) {
      const row = dependencies.db
        .prepare(
          "SELECT capabilities_json AS capabilities FROM models WHERE id=?",
        )
        .get(ctx.req.param("id")) as
        { capabilities: string | null } | undefined;
      try {
        const parsed = row?.capabilities
          ? (JSON.parse(row.capabilities) as Record<string, unknown>)
          : {};
        const catalog =
          parsed.catalog && typeof parsed.catalog === "object"
            ? (parsed.catalog as Record<string, unknown>)
            : null;
        if (catalog) {
          catalog.priceSource = "manual";
          dependencies.db
            .prepare("UPDATE models SET capabilities_json=? WHERE id=?")
            .run(JSON.stringify(parsed), ctx.req.param("id"));
        }
      } catch {
        /* 历史行里可能是坏 JSON，改价不该因此失败 */
      }
    }
    if (patch) {
      // 上面那段可能刚改过 capabilities_json（priceSource），所以在它之后再读一次。
      const row = dependencies.db
        .prepare(
          "SELECT capabilities_json AS capabilities FROM models WHERE id=?",
        )
        .get(ctx.req.param("id")) as
        { capabilities: string | null } | undefined;
      const next = row
        ? applyManualCapabilities(row.capabilities, patch)
        : null;
      if (next !== null) {
        changes = Math.max(
          changes,
          dependencies.db
            .prepare(
              "UPDATE models SET capabilities_json=?,updated_at=? WHERE id=?",
            )
            .run(next, Date.now(), ctx.req.param("id")).changes,
        );
        // 这条标记会改变含图轮次使用哪个模型，需单独留一行：中间件那条只记方法与路径。
        dependencies.log.event({
          level: "info",
          kind: "webui.action",
          summary: "model capability marked",
          data: { id: ctx.req.param("id"), capabilities: patch },
        });
      }
    }
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true, data: { changes } });
  });
  // 别名清理与 provider 级联删除走同一条路径：否则同一种悬空状态换一个入口仍会发生，
  // 而这个入口（模型表的行内〔删除〕）才是运维日常使用的那个。
  app.delete("/api/models/:id", (ctx) => {
    const id = ctx.req.param("id");
    let aliases: Array<{ alias: string; removed: string[]; emptied: boolean }> =
      [];
    const changes = dependencies.db.transaction(() => {
      aliases = pruneAliases([id]);
      return dependencies.db.prepare("DELETE FROM models WHERE id=?").run(id)
        .changes;
    })();
    for (const entry of aliases.filter((one) => one.emptied))
      dependencies.log.event({
        level: "warn",
        kind: "model.alias_emptied",
        summary: `Alias ${entry.alias} lost every model and was removed`,
        data: { alias: entry.alias, removed: entry.removed, model: id },
      });
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true, data: { changes, aliases } });
  });
  app.post("/api/principals/bulk", async (ctx) => {
    const body = await ctx.req.json<{
      ids?: unknown;
      role?: unknown;
      kind?: unknown;
    }>();
    const kind = body.kind === "chat" ? "chat" : "user";
    const role = body.role;
    if (
      role !== "owner" &&
      role !== "trusted" &&
      role !== "limited" &&
      role !== "blocked"
    )
      return ctx.json(
        apiError(
          "invalid_role",
          "role 必须是 owner / trusted / limited / blocked 之一",
        ).body,
        400,
      );
    const raw = Array.isArray(body.ids) ? body.ids : [];
    const ids = [
      ...new Set(
        raw
          .filter(
            (entry): entry is string | number =>
              typeof entry === "string" || typeof entry === "number",
          )
          .map((entry) => String(entry).trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length)
      return ctx.json(
        apiError("invalid_ids", "ids 至少包含一个 Telegram 数字 ID").body,
        400,
      );
    if (ids.length > 500)
      return ctx.json(
        apiError("invalid_ids", "单次最多导入 500 个主体").body,
        400,
      );
    // Telegram ID 是整数（群/频道为负）。放行 @username 只会写出一条永远匹配不到任何消息的主体记录。
    // 判据与三个 Telegram 命令共用一份（`TG_ID_PATTERN` / `parsePrincipal`，docs/27 · C-05）。
    const malformed = ids.filter((id) => !TG_ID_PATTERN.test(id));
    if (malformed.length)
      return ctx.json(
        apiError(
          "invalid_ids",
          `不是合法的 Telegram 数字 ID：${malformed.slice(0, 5).join("、")}${malformed.length > 5 ? ` 等 ${malformed.length} 个` : ""}`,
        ).body,
        400,
      );
    if (kind === "chat")
      for (const tgId of ids) {
        const denied = chatSubjectError(tgId, role);
        if (denied) return ctx.json(denied.body, denied.status);
      }
    // upsertSeen 的 ON CONFLICT 分支刻意不动 role（避免每条消息把手工设的角色冲掉），
    // 所以只调它的话已存在的主体会「导入成功」却什么都没变 —— 角色必须再走一次 setRole。
    // 已存在的行也不能再走一次 upsertSeen：这里的 displayName/username 只有 null，
    // 而 ON CONFLICT 分支会照写，等于把 Telegram 那边同步来的真名清空。
    let created = 0;
    let updated = 0;
    dependencies.db.transaction(() => {
      for (const tgId of ids) {
        const id = `${kind}:${tgId}`;
        if (dependencies.principals.has(id)) {
          if (dependencies.principals.setRole(id, role, "webui")) updated += 1;
          continue;
        }
        dependencies.principals.upsertSeen(
          {
            id,
            kind,
            tgId,
            role,
            displayName: null,
            username: null,
            chatType: null,
          },
          "webui",
        );
        created += 1;
      }
    })();
    dependencies.log.event({
      level: "info",
      kind: "webui.action",
      summary: "principals bulk import",
      data: { kind, role, created, updated },
    });
    return ctx.json({
      ok: true,
      data: { count: ids.length, created, updated },
    });
  });
  // 表格里勾一批人改角色：只动已存在的主体，不建新行 —— 新建走 /api/principals/bulk（那边收的是 Telegram 数字 ID）。
  app.post("/api/principals/roles", async (ctx) => {
    const body = await ctx.req.json<{ ids?: unknown; role?: unknown }>();
    const role = body.role;
    if (
      role !== "owner" &&
      role !== "trusted" &&
      role !== "limited" &&
      role !== "blocked"
    )
      return ctx.json(
        apiError(
          "invalid_role",
          "role 必须是 owner / trusted / limited / blocked 之一",
        ).body,
        400,
      );
    const ids = [
      ...new Set(
        (Array.isArray(body.ids) ? body.ids : [])
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length)
      return ctx.json(
        apiError("invalid_ids", "ids 至少包含一个主体 id").body,
        400,
      );
    if (ids.length > 500)
      return ctx.json(
        apiError("invalid_ids", "单次最多修改 500 个主体").body,
        400,
      );
    for (const id of ids) {
      const denied = id.startsWith("chat:")
        ? chatSubjectError(id.slice(5), role)
        : null;
      if (denied) return ctx.json(denied.body, denied.status);
    }
    // 不存在的 id 单独报回去而不是静默跳过：勾选来自表格，出现缺失说明这一批和库里对不上了。
    const missing: string[] = [];
    let changed = 0;
    dependencies.db.transaction(() => {
      for (const id of ids) {
        if (!dependencies.principals.has(id)) {
          missing.push(id);
          continue;
        }
        if (dependencies.principals.setRole(id, role, "webui")) changed += 1;
      }
    })();
    dependencies.log.event({
      level: "info",
      kind: "webui.action",
      summary: "principal roles changed",
      data: { role, changed, missing: missing.length, ids: ids.slice(0, 50) },
    });
    return ctx.json({
      ok: true,
      data: { count: ids.length, changed, missing },
    });
  });
  app.patch("/api/tools/:name", async (ctx) => {
    const name = ctx.req.param("name");
    const body = await ctx.req.json<{
      enabled?: boolean;
      minRole?: unknown;
      approval?: unknown;
      timeoutMs?: unknown;
      confirmRelax?: boolean;
    }>();
    const known = dependencies.tools
      ?.describe()
      .find((entry) => entry.name === name);
    if (!known && !Object.hasOwn(TOOL_POLICY, name))
      return ctx.json(apiError("not_found", "工具不存在", 404).body, 404);
    const base =
      known?.defaults ?? TOOL_POLICY[name as keyof typeof TOOL_POLICY];
    const key = `tools.overrides.${name}`;
    const pinned = envConflicts([key]);
    if (pinned.length) return ctx.json(envPinnedError(pinned).body, 400);
    // 一个 key 对应 `config_kv` 里一条整叶 JSON，因此必须先读当前覆盖再整体写回：只写请求里
    // 携带的那个字段，会一并抹掉同一条 JSON 里其余的覆盖（一次启停操作即丢失刚调好的 minRole）。
    // 三个策略字段显式给 `null` 表示恢复默认，即从这条 JSON 里删掉它。
    //
    // 基准优先取库里那一行而不是 `currentConfig()`：`config.changed` 之后的重载是异步的
    // （`main.ts` 里 `void loadConfig(...).then(...)`），连续改两次时第二次会读到重载前的旧快照，
    // 把第一次的改动原样覆盖。没有那一行时才回落到快照：覆盖也可能来自 config.yaml 或
    // `tools.overrides` 整块那一层，这两层只有快照能看到。
    const persisted = dependencies.db
      .prepare("SELECT value_json AS value FROM config_kv WHERE key=?")
      .get(key) as { value: string } | undefined;
    const current: ToolOverride = persisted
      ? (JSON.parse(persisted.value) as ToolOverride)
      : { ...currentConfig().tools.overrides[name] };
    const next: ToolOverride = { ...current };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean")
        return ctx.json(
          apiError("invalid_tool_override", "enabled 必须是布尔值").body,
          400,
        );
      next.enabled = body.enabled;
    }
    if (body.minRole !== undefined) {
      if (body.minRole !== null && !ROLES.includes(body.minRole as Role))
        return ctx.json(
          apiError(
            "invalid_tool_override",
            `minRole 必须是 ${ROLES.join(" / ")} 之一`,
          ).body,
          400,
        );
      if (body.minRole === null) delete next.minRole;
      else next.minRole = body.minRole as Role;
    }
    if (body.approval !== undefined) {
      if (
        body.approval !== null &&
        !APPROVAL_POLICIES.includes(
          body.approval as (typeof APPROVAL_POLICIES)[number],
        )
      )
        return ctx.json(
          apiError(
            "invalid_tool_override",
            `approval 必须是 ${APPROVAL_POLICIES.join(" / ")} 之一`,
          ).body,
          400,
        );
      if (body.approval === null) delete next.approval;
      else next.approval = body.approval as (typeof APPROVAL_POLICIES)[number];
    }
    if (body.timeoutMs !== undefined) {
      if (
        body.timeoutMs !== null &&
        (typeof body.timeoutMs !== "number" ||
          !Number.isInteger(body.timeoutMs) ||
          body.timeoutMs <= 0)
      )
        return ctx.json(
          apiError("invalid_tool_override", "timeoutMs 必须是正整数毫秒").body,
          400,
        );
      if (body.timeoutMs === null) delete next.timeoutMs;
      else next.timeoutMs = body.timeoutMs;
    }
    // 放宽（minRole 调低 / 审批降档）要二次确认。校验在落库之前：未确认时不写入任何内容，
    // 否则先保存再询问的确认框只是事后通知（docs/09 §3.7）。超时与启停不在其列。
    const relaxed = relaxedFields(base, next);
    if (relaxed.length && body.confirmRelax !== true) {
      const effective = effectiveToolPolicy(base, next);
      return ctx.json(
        {
          ok: false,
          error: {
            code: "relax_requires_confirmation",
            message: `${name} 的${relaxed.map((field) => (field === "minRole" ? "最低角色" : "审批策略")).join(" 与 ")}宽于代码内置默认，需要二次确认`,
            details: relaxed.map((field) => ({
              path: field,
              from: base[field],
              to: effective[field],
            })),
          },
        },
        409,
      );
    }
    const merged = mergeDotted(currentConfig(), { [key]: next });
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success)
      return ctx.json(
        invalidConfig("工具覆盖校验失败", parsed.error.issues).body,
        400,
      );
    writeConfigRows([[key, readDotted(parsed.data, key)]], "webui");
    dependencies.events.emit("config.changed", { keys: [key] });
    // 放宽记 warn 而不是 info：这是日志页上最该一眼看见的运维动作。这个端点此前一条日志都不记。
    dependencies.log.event({
      level: relaxed.length ? "warn" : "info",
      kind: "webui.action",
      summary: relaxed.length
        ? `tool policy relaxed: ${name}`
        : `tool override changed: ${name}`,
      data: { tool: name, override: next, relaxed },
    });
    return ctx.json({
      ok: true,
      data: {
        name,
        override: next,
        relaxed,
        effective: {
          ...effectiveToolPolicy(base, next),
          enabled: next.enabled !== false,
        },
      },
    });
  });
  app.get("/api/sandbox", (ctx) =>
    ctx.json({
      ok: true,
      data: {
        config: publicConfig(currentConfig().sandbox),
        // 它不在 `sandbox.*` 那棵子树下，但控制的是同一件事的另一半：谁可以绕过隔离。此前沙箱页上
        // 没有任何入口（`grep allowHostFsForOwner packages/webui/src` 零命中），只能在全部配置里
        // 被 SchemaForm 渲染成一个普通开关，切换一次即生效（docs/29 · M-WEB-10）。
        // 这里只读出来，写回照旧走 `PUT /api/config`，那条路径上有白名单与 `runtimeConfigSchema`。
        allowHostFsForOwner: currentConfig().tools.fs.allowHostFsForOwner,
        plan: dependencies.sandbox?.plan("owner"),
      },
    }),
  );
  app.put("/api/sandbox", async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    const dotted = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [`sandbox.${key}`, value]),
    );
    const pinned = envConflicts(Object.keys(dotted));
    if (pinned.length) return ctx.json(envPinnedError(pinned).body, 400);
    const redacted = redactedKeys(dotted);
    if (redacted.length)
      return ctx.json(
        apiError(
          "redacted_placeholder",
          `${redacted.join("、")} 的值含脱敏占位符 «redacted»`,
        ).body,
        400,
      );
    const merged = mergeDotted(currentConfig(), dotted);
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success)
      return ctx.json(
        invalidConfig("沙箱配置校验失败", parsed.error.issues).body,
        400,
      );
    writeConfigRows(Object.entries(dotted), "webui");
    dependencies.events.emit("config.changed", { keys: Object.keys(dotted) });
    return ctx.json({ ok: true, data: body });
  });
  app.post("/api/sandbox/probe", async (ctx) =>
    ctx.json({
      ok: true,
      data: (await dependencies.sandbox?.probe()) ?? {
        available: false,
        error: "sandbox_unconfigured",
      },
    }),
  );
  /**
   * 会话级持久容器（docs/09 §3.7，语义见 docs/05 §5.5）。三个端点共用这一道：运行时未装配时
   * 返回 `not_implemented` 而不是空列表：读不到与一个都没有对运维是两种结论。
   */
  const containersOr501 = (): ContainerManager | null =>
    dependencies.sandbox?.containers() ?? null;
  app.get("/api/containers", (ctx) => {
    const boxes = containersOr501();
    if (!boxes)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配持久容器运行时", 500).body,
        500,
      );
    const labels = new Map(
      chatCandidates(dependencies.db).map((candidate) => [
        candidate.chatId,
        candidate.label,
      ]),
    );
    return ctx.json({
      ok: true,
      data: {
        enabled: boxes.enabled(),
        ...boxes.capacity(),
        containers: boxes.list().map((row) => ({
          ...row,
          pinned: row.pinned !== 0,
          hasSetsid: row.hasSetsid !== 0,
          chatLabel: labels.get(row.chatId) ?? null,
        })),
      },
    });
  });
  app.delete("/api/containers/:chatId", async (ctx) => {
    const boxes = containersOr501();
    if (!boxes)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配持久容器运行时", 500).body,
        500,
      );
    const chatId = ctx.req.param("chatId");
    const workspace = dependencies.sandbox!.hostWorkspaceFor(chatId);
    if (workspace === null)
      return ctx.json(
        apiError(
          "workspace_unmappable",
          "该会话的工作目录无法映射到宿主路径，无法创建容器",
        ).body,
        400,
      );
    // `?wipe=1` 才改动文件。更换环境与删除数据是两件事，默认那一档不触碰任何文件
    // （同 `container_reset` 的默认值，docs/05 §3.11）。
    if (ctx.req.query("wipe") === "1") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const wipe = await boxes.exec({
        chatId,
        mountedWorkspace: workspace,
        timeoutMs: 60_000,
        abortSignal: AbortSignal.timeout(90_000),
        command: `set -e; mkdir -p .luoli-trash/${stamp}; for entry in * .[!.]*; do [ -e "$entry" ] || continue; case "$entry" in .luoli-trash) continue;; esac; mv -- "$entry" .luoli-trash/${stamp}/; done`,
      });
      if ("error" in wipe)
        return ctx.json(
          apiError(wipe.error, wipe.hint ?? "清理工作区失败，容器未变更").body,
          400,
        );
      if (!wipe.ok)
        return ctx.json(
          apiError(
            "workspace_wipe_failed",
            `文件未能移入回收站，容器未变更：${wipe.stderr.slice(0, 400)}`,
          ).body,
          400,
        );
    }
    const reset = await boxes.reset(chatId, workspace);
    if (!reset.ok)
      return ctx.json(
        apiError(reset.error, reset.hint ?? "重置失败").body,
        400,
      );
    return ctx.json({
      ok: true,
      data: {
        chatId,
        name: reset.row.name,
        wiped: ctx.req.query("wipe") === "1",
      },
    });
  });
  app.post("/api/containers/:chatId/keep", async (ctx) => {
    const boxes = containersOr501();
    if (!boxes)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配持久容器运行时", 500).body,
        500,
      );
    const body = await ctx.req.json<{ hours?: number; pin?: boolean }>();
    const kept = boxes.keep(ctx.req.param("chatId"), {
      ...(body.hours === undefined ? {} : { hours: body.hours }),
      ...(body.pin === undefined ? {} : { pin: body.pin }),
    });
    if (!kept.ok)
      return ctx.json(
        apiError(kept.error, kept.hint ?? "无法修改到期时间").body,
        404,
      );
    return ctx.json({
      ok: true,
      data: {
        ...kept.row,
        pinned: kept.row.pinned !== 0,
        hasSetsid: kept.row.hasSetsid !== 0,
      },
    });
  });
  /**
   * 拉取沙箱镜像（docs/09 §3.7）。只执行 pull，不执行 build：build 需要 Dockerfile 上下文、
   * 会运行任意构建指令、耗时以分钟计，属于部署动作而非控制台按钮。镜像名取自当前配置，
   * 不接受请求体里的名字：允许 owner 在界面上指定任意镜像等于绕开 `sandbox.image` 这道配置。
   */
  app.post("/api/sandbox/image", async (ctx) => {
    if (!dependencies.sandbox)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配 Sandbox", 500).body,
        500,
      );
    const config = currentConfig().sandbox;
    if (config.mode !== "docker")
      return ctx.json(
        apiError(
          "sandbox_not_docker",
          `当前 sandbox.mode=${config.mode}，无镜像可拉取`,
        ).body,
        400,
      );
    const result = await dependencies.sandbox.pullImage();
    return result.ok
      ? ctx.json({ ok: true, data: result })
      : ctx.json(
          apiError("image_pull_failed", result.error ?? "拉取失败").body,
          502,
        );
  });
  /**
   * 审批规则的逐行试跑（docs/09 §3.7）：用一条样例输入过一遍运行时那份 `ApprovalRules`，
   * 返回命中的规则与最终风险档位。在界面上另行实现一遍匹配必然与运行时漂移，而配置了审批
   * 却永不命中正是这条规则最常见的错误。
   */
  app.post("/api/approvals/test", async (ctx) => {
    const body = await ctx.req
      .json<{ rules?: unknown[]; tool?: string; input?: unknown }>()
      .catch(() => null);
    if (!body?.tool)
      return ctx.json(
        apiError("invalid_body", "body 需要 { tool, input?, rules? }").body,
        400,
      );
    // 规则先过一遍完整 schema（`approval.rules` 的那条 superRefine 会拦下编译不了的正则），
    // 再交给运行时那份匹配器 —— 试跑一个自己都不合法的规则表毫无意义。
    const rules = body.rules ?? currentConfig().approval.rules;
    const merged = mergeDotted(currentConfig(), { "approval.rules": rules });
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success)
      return ctx.json(
        invalidConfig("规则校验失败", parsed.error.issues).body,
        400,
      );
    const matched = testApprovalRules(
      parsed.data.approval.rules,
      body.tool,
      body.input ?? {},
    );
    return ctx.json({ ok: true, data: matched });
  });
  app.get("/api/prompts", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.db
        .prepare("SELECT * FROM memory_docs ORDER BY scope,subject")
        .all(),
    }),
  );
  /** 控制台是 owner 单口令的，因此查看者只有一个；判据是所查看的是否为他人那一份。 */
  const auditPrimemoryAccess = (
    row: { scope?: unknown; subject?: unknown },
    op: "read" | "write",
  ): void => {
    if (row.scope !== "primemory") return;
    const subject = typeof row.subject === "string" ? row.subject : null;
    if (subject && subject === currentConfig().access.bootstrapOwnerId) return;
    dependencies.memory?.auditPrivateAccess(subject, "webui", op);
  };
  app.get("/api/prompts/:id", (ctx) => {
    const row = dependencies.db
      .prepare("SELECT * FROM memory_docs WHERE id=?")
      .get(ctx.req.param("id")) as
      { path?: string; scope?: string; subject?: string | null } | undefined;
    if (!row?.path)
      return ctx.json(apiError("not_found", "文档不存在", 404).body, 404);
    // `memory_docs.path` 今天只由本进程写，但「库里的路径值可信」是一个会随时间失效的假设
    // （导入、迁移、手工修库）。同一个文件里读日志目录就是过 `safeRef()` 的（docs/27 · S-07）。
    let content: string;
    try {
      content = readFileSync(
        storedPathWithin(currentConfig().memory.dir, row.path),
        "utf8",
      );
    } catch {
      return ctx.json(
        apiError("not_found", "文档文件无法读取，或不在记忆目录内", 404).body,
        404,
      );
    }
    // 读取成功之后才记录：文件读不到时返回 404，那不算一次查看（docs/29 · M-MEM-01）。
    auditPrimemoryAccess(row, "read");
    return ctx.json({ ok: true, data: { ...row, content } });
  });
  app.get("/api/prompts/:id/revisions", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.db
        .prepare(
          "SELECT id,doc_id AS docId,ts,actor,turn_id AS turnId,chat_id AS chatId,user_id AS userId,op,diff,bytes_after AS bytesAfter FROM memory_revisions WHERE doc_id=? ORDER BY ts DESC,id DESC LIMIT 200",
        )
        .all(ctx.req.param("id")),
    }),
  );
  app.put("/api/prompts/:id", async (ctx) => {
    const body = await ctx.req.json<{ content?: string }>();
    const row = dependencies.db
      .prepare("SELECT scope,subject FROM memory_docs WHERE id=?")
      .get(ctx.req.param("id")) as
      | {
          scope: "assist" | "character" | "pubmemory" | "primemory";
          subject: string | null;
        }
      | undefined;
    if (!row || !dependencies.promptDocuments)
      return ctx.json(apiError("not_found", "文档不存在", 404).body, 404);
    if (typeof body.content !== "string")
      return ctx.json(
        apiError("invalid_content", "content 必须是字符串").body,
        400,
      );
    // 改别人的私有记忆比看更重，同样要留痕（`memory_revisions` 记的是内容变更，这条记的是「谁」）。
    auditPrimemoryAccess(row, "write");
    dependencies.promptDocuments.save(
      row.scope,
      row.subject,
      body.content,
      "webui",
    );
    return ctx.json({
      ok: true,
      data: { id: ctx.req.param("id"), bytes: Buffer.byteLength(body.content) },
    });
  });
  app.post("/api/prompts/:id/rollback", async (ctx) => {
    const body = await ctx.req.json<{ revisionId?: string }>();
    if (!body.revisionId || !dependencies.promptDocuments)
      return ctx.json(
        apiError("invalid_revision", "revisionId 必填").body,
        400,
      );
    try {
      return ctx.json({
        ok: true,
        data: dependencies.promptDocuments.rollback(
          ctx.req.param("id"),
          body.revisionId,
          "webui",
        ),
      });
    } catch (error) {
      return ctx.json(
        apiError(
          "rollback_failed",
          error instanceof Error ? error.message : "回滚失败",
          500,
        ).body,
        500,
      );
    }
  });
  app.post("/api/prompts/preview", async (ctx) => {
    const body = await ctx.req
      .json<{ key?: unknown; role?: unknown }>()
      .catch((): { key?: unknown; role?: unknown } => ({}));
    if (typeof body.key !== "string" || !body.key)
      return ctx.json(apiError("invalid_key", "key 必填").body, 400);
    if (typeof body.role !== "string" || !(body.role in validRoles))
      return ctx.json(
        apiError(
          "invalid_role",
          "role 必须是 owner / trusted / limited / blocked",
        ).body,
        400,
      );
    if (!dependencies.previewPrompt)
      return ctx.json(
        apiError("not_implemented", "提示词预览未接入运行时", 500).body,
        500,
      );
    try {
      return ctx.json({
        ok: true,
        data: await dependencies.previewPrompt(body.key, body.role as Role),
      });
    } catch (error) {
      return ctx.json(
        apiError(
          "preview_failed",
          error instanceof Error ? error.message : "提示词组装失败",
          404,
        ).body,
        404,
      );
    }
  });
  /**
   * 审批列表。此前是硬编码 `LIMIT 200`，触顶即静默截断，界面上看不出是否还有更多。
   *
   * 三处不能调整：
   * - 过期扫描必须留在 `COUNT` 与 `SELECT` 之前。夹在两者之间时，`total` 统计的是扫描前的状态、
   *   页内容是扫描后的状态，两个数字不一致且无法解释。
   * - `pending` 是全表计数，而不是本页统计出来的。左侧导航那个角标读的就是它，要求不切到任务页
   *   也能看见（`AC-WEB-049`）：按页统计时翻到第 2 页角标即归零，这是整次分页改造里唯一一处会
   *   静默导致功能退化的位置。
   * - 排序是 `(state='pending') DESC, requested_at DESC`：待办始终在第一页。`ix_approvals_state`
   *   覆盖这个前缀。
   */
  app.get("/api/approvals", (ctx) => {
    const now = Date.now();
    dependencies.db
      .prepare(
        "UPDATE approvals SET state='expired',decided_by='system',decided_at=?,decision_channel='system' WHERE state='pending' AND expires_at<=?",
      )
      .run(now, now);
    const {
      page: pageNumber,
      size,
      offset,
    } = pageParams(ctx, { defaultSize: 50, maxSize: 200 });
    const total = Number(
      dependencies.db.prepare("SELECT COUNT(*) FROM approvals").pluck().get(),
    );
    const pending = Number(
      dependencies.db
        .prepare("SELECT COUNT(*) FROM approvals WHERE state='pending'")
        .pluck()
        .get(),
    );
    // 列表收窄为显式列（原先是 `SELECT *`）：列集与 `ApprovalRow` 逐字对齐，多一列或少一列都能在
    // 这里看出来。没有新增语句，仍是原来那一条，只是不再依赖 `*` 推断。
    const items = (
      dependencies.db
        .prepare(
          `SELECT id,turn_id,agent_run_id,span_id,chat_id,requester_user_id,tool_name,input_json,risk,state,
      requested_at,expires_at,decided_by,decided_at,decision_channel FROM approvals ORDER BY (state='pending') DESC,requested_at DESC LIMIT ? OFFSET ?`,
        )
        .all(size, offset) as Array<Record<string, unknown>>
    )
      // `decided_by` 有三种写法（`user:<tgId>` / `owner` / `system`，[03] 的 approvals 段）。
      // `user:<tgId>` 是 Telegram 那条裁决通道引入的新格式，而这一页的用途正是事后查询由谁批准，
      // 一串数字回答不了该问题。反查规则只有服务端这一份（`principalLabel`，与任务页和定时任务页
      // 使用同一个 helper）：前端不得自行拆解 `user:` 前缀，那会让格式变成前后端各存一半的隐式
      // 契约，出现下一种写法时前端会静默渲染出错误内容。
      .map((row) => ({
        ...row,
        decidedByLabel: decidedByLabel(dependencies.db, row.decided_by),
      }));
    return ctx.json({
      ok: true,
      data: { items, total, page: pageNumber, size, pending },
    });
  });
  app.post("/api/approvals/:id/decide", async (ctx) => {
    const body = await ctx.req
      .json<{ approved?: unknown }>()
      .catch((): { approved?: unknown } => ({}));
    if (typeof body.approved !== "boolean")
      return ctx.json(
        apiError("invalid_decision", "approved 必须是布尔值").body,
        400,
      );
    return ctx.json({
      ok: true,
      data: {
        changed: dependencies.approvals.decide(
          ctx.req.param("id"),
          body.approved,
          "owner",
          "webui",
        ),
      },
    });
  });
  /**
   * 定时任务面板（docs/21 · `G-API-16`）。此前运维在 WebUI 里既看不到部署中有哪些任务在排、
   * 也停不掉任何一条，止损只能在 Telegram 让 bot 执行 `schedule_cancel`。
   *
   * 建任务与工具共用 `createScheduledJob`：两边各写一遍校验时，WebUI 迟早会建出工具建不出来的
   * 任务（例如每分钟一次的 agent 轮次）。
   */
  const scheduleRuntime = (): NonNullable<
    ServerDependencies["schedules"]
  > | null => dependencies.schedules ?? null;
  const scheduleRow = (job: ScheduledJob): Record<string, unknown> => ({
    id: job.id,
    key: job.key,
    chatId: job.chatId,
    threadId: job.threadId,
    createdBy: job.createdBy,
    chatLabel: principalLabel(dependencies.db, "chat", job.chatId),
    creatorLabel: principalLabel(dependencies.db, "user", job.createdBy),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    // `silent` 由 `scheduledJobView` 提供（DB 列 `allow_silent`）；连续静默次数只有面板可见，
    // 它是判断该任务是否已变成持续消耗配额却从不投递的唯一凭据（docs/02 §10.5）。
    silentStreak: job.silentStreak,
    ...scheduledJobView(
      job,
      job.state === "active"
        ? (scheduleRuntime()?.runner.nextRun(job.id) ?? null)
        : null,
    ),
  });
  app.get("/api/schedules", (ctx) => {
    const runtime = scheduleRuntime();
    const live = currentConfig();
    if (!runtime)
      return ctx.json({
        ok: true,
        data: {
          available: false,
          enabled: live.schedule.enabled,
          timezone: live.general.timezone,
          jobs: [],
          total: 0,
          truncated: false,
        },
      });
    // 不分页（行数有界，DataGrid 自行切片），但 `listAll` 有 500 条上限，触顶时必须明确告知。
    // 静默截断的表现是已创建的任务在面板上找不到，而界面没有任何依据判断自己看到的不完整。
    const jobs = runtime.jobs.listAll();
    const total = Number(
      dependencies.db
        .prepare("SELECT COUNT(*) FROM scheduled_jobs")
        .pluck()
        .get(),
    );
    return ctx.json({
      ok: true,
      data: {
        available: true,
        enabled: live.schedule.enabled,
        timezone: live.general.timezone,
        settings: {
          maxPerChat: live.schedule.maxPerChat,
          minIntervalMinutes: live.schedule.minIntervalMinutes,
          maxPayloadChars: live.schedule.maxPayloadChars,
        },
        jobs: jobs.map(scheduleRow),
        total,
        truncated: total > jobs.length,
      },
    });
  });
  app.post("/api/schedules", async (ctx) => {
    const runtime = scheduleRuntime();
    if (!runtime)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配定时任务运行时", 500).body,
        500,
      );
    const body = await ctx.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const key = typeof body.key === "string" ? body.key : "";
    // 落点从 `contexts` 反查，不收客户端给的 chatId/threadId：那一对是会话隔离的锚点，
    // 让调用方自己拼等于凭一个字段就能把任务塞进任意会话（同 docs/05 §8 对工具的要求）。
    const target = dependencies.db
      .prepare(
        "SELECT chat_id AS chatId,thread_id AS threadId FROM contexts WHERE key=?",
      )
      .get(key) as { chatId: string; threadId: number | null } | undefined;
    if (!target)
      return ctx.json(
        apiError("chat_not_found", "会话不存在：只能为已有上下文的会话创建任务")
          .body,
        400,
      );
    const mode =
      body.mode === "agent" || body.mode === "notify" ? body.mode : null;
    if (!mode)
      return ctx.json(
        apiError("invalid_mode", "mode 只能是 agent 或 notify").body,
        400,
      );
    const live = currentConfig();
    // WebUI 只有 owner 一个身份（docs/14 A15），所以任务归属 `access.bootstrapOwnerId`。
    // 它仍然要过 D9：触发时重算有效角色（群里任一侧 blocked 即 blocked，否则取两侧较高者封顶
    // trusted），落在群里的任务不会因为「owner 建的」而拿到 owner。
    const createdBy = live.access.bootstrapOwnerId;
    if (!createdBy)
      return ctx.json(
        apiError(
          "owner_unset",
          "未配置 access.bootstrapOwnerId：任务需要归属主体才能在触发时重算权限",
        ).body,
        400,
      );
    const result = createScheduledJob(
      runtime.jobs,
      runtime.runner,
      // `silent` 是对外使用的名称（DB 列 `allow_silent`）。接受它是契约里命名收敛的一半：
      // 不接受时 WebUI 建不出静默任务，而弹窗上那个开关不会产生任何效果。
      {
        name: String(body.name ?? ""),
        mode,
        text: String(body.text ?? ""),
        ...(typeof body.cron === "string" && body.cron
          ? { cron: body.cron }
          : {}),
        ...(typeof body.at === "string" && body.at ? { at: body.at } : {}),
        ...(typeof body.silent === "boolean" ? { silent: body.silent } : {}),
      },
      {
        key,
        chatId: target.chatId,
        threadId: target.threadId,
        createdBy,
        timezone: live.general.timezone,
        settings: live.schedule,
      },
    );
    if (!result.ok)
      return ctx.json(apiError(result.error, result.hint).body, 400);
    dependencies.log.event({
      level: "info",
      kind: "schedule.created",
      summary: `WebUI 新建定时任务 ${result.job.name}`,
      chatId: result.job.chatId,
      key: result.job.key,
      data: {
        job: result.job.id,
        name: result.job.name,
        mode: result.job.mode,
        cron: result.job.cron,
        runAt: result.job.runAt,
        actor: "webui",
      },
    });
    return ctx.json({ ok: true, data: scheduleRow(result.job) });
  });
  /**
   * 修改一条活跃任务。校验与 `schedule_update` 工具共用 `updateScheduledJob`，理由同建任务那条：
   * 两边各写一遍时，WebUI 迟早会改出工具改不出来的任务。
   *
   * `gateEnabled` 是建与改唯一不共用的那道闸：总开关（`schedule.enabled`）关着时这条路放行，
   * 而 `POST /api/schedules` 仍返回 `schedule_disabled`。该不对称是有意的：拒绝编辑意味着要修正
   * 一条异常任务必须先打开总开关，而那一步会把所有任务一起重新武装（理由与出处见
   * `updateScheduledJob` 的注释与 docs/09 §3.10.1）。
   *
   * body 里的 `name` 是新名称（HTTP 已用 `:id` 定位）；工具一侧 `name` 是定位符、`newName` 才是
   * 新名称（docs/09 §4）。`key`/`chatId`/`threadId`/`createdBy`/`mode` 一律不读取：前四项是
   * 会话隔离与触发时重算有效角色的锚点，接受它们等于提供了把任务迁入任意群、或更换担保人的
   * 原语（同 `POST /api/schedules` 反查 `contexts` 的理由）；`mode` 会同时改变 `payload` 的语义与
   * 是否产生费用。只发这几项时落进 `nothing_to_update`，而不是返回假成功。
   */
  app.patch("/api/schedules/:id", async (ctx) => {
    const runtime = scheduleRuntime();
    if (!runtime)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配定时任务运行时", 500).body,
        500,
      );
    const id = ctx.req.param("id");
    const job = runtime.jobs.byId(id);
    if (!job)
      return ctx.json(
        apiError("not_found", "任务不存在（可能已被保留策略清理）", 404).body,
        404,
      );
    const body = await ctx.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const request: ScheduleUpdateRequest = {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.cron === "string" ? { cron: body.cron } : {}),
      ...(typeof body.at === "string" ? { at: body.at } : {}),
      ...(typeof body.silent === "boolean" ? { silent: body.silent } : {}),
    };
    const result = updateScheduledJob(
      runtime.jobs,
      runtime.runner,
      job,
      request,
      currentConfig().schedule,
    );
    // 只有「这条已经结束了」是状态冲突，其余都是这次请求本身不合法。
    if (!result.ok)
      return result.error === "not_active"
        ? ctx.json(apiError(result.error, result.hint, 409).body, 409)
        : ctx.json(apiError(result.error, result.hint).body, 400);
    dependencies.log.event({
      level: "info",
      kind: "schedule.updated",
      summary: `WebUI 改定时任务 ${result.job.name}`,
      chatId: result.job.chatId,
      key: result.job.key,
      data: {
        job: id,
        name: result.job.name,
        changed: Object.keys(request),
        actor: "webui",
      },
    });
    return ctx.json({ ok: true, data: scheduleRow(result.job) });
  });
  app.delete("/api/schedules/:id", (ctx) => {
    const runtime = scheduleRuntime();
    if (!runtime)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配定时任务运行时", 500).body,
        500,
      );
    const id = ctx.req.param("id");
    const job = runtime.jobs.byId(id);
    if (!job)
      return ctx.json(
        apiError("not_found", "任务不存在（可能已被保留策略清理）", 404).body,
        404,
      );
    // 已结束的行返回 `cancelled:false` 而不是假成功：界面据此说「这条本来就已经停了」。
    const changed = runtime.jobs.finish(id, "cancelled");
    runtime.runner.unregister(id);
    if (changed) {
      dependencies.log.event({
        level: "warn",
        kind: "schedule.cancelled",
        summary: `WebUI 停用定时任务 ${job.name}`,
        chatId: job.chatId,
        key: job.key,
        data: { job: id, name: job.name, actor: "webui" },
      });
    }
    return ctx.json({ ok: true, data: { cancelled: changed, name: job.name } });
  });
  /**
   * 硬删一行（`ScheduleRepository.remove`，不是按保留期清理的 `purge(before)`）。它与上面那条
   * 软取消是两件事：停用的行仍在列表上、仍能看到触发次数，删除的不留任何记录。
   *
   * 顺序不能颠倒：active 的先 `runner.unregister` 再删行。顺序颠倒时，删行到下一次 cron 之间
   * 那条任务仍排在 `Scheduler` 里，而界面上已不可见。
   *
   * 日志记 warn：硬删一条 active 任务后，bot 停止提醒在库里不留痕迹，这一行即是那个痕迹
   * （`schedule.cancelled` 同理）。
   */
  app.post("/api/schedules/:id/purge", (ctx) => {
    const runtime = scheduleRuntime();
    if (!runtime)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配定时任务运行时", 500).body,
        500,
      );
    const id = ctx.req.param("id");
    const job = runtime.jobs.byId(id);
    if (!job)
      return ctx.json(
        apiError("not_found", "任务不存在（可能已被保留策略清理）", 404).body,
        404,
      );
    const wasActive = job.state === "active";
    if (wasActive) runtime.runner.unregister(id);
    const removed = runtime.jobs.remove(id);
    if (removed) {
      dependencies.log.event({
        level: "warn",
        kind: "schedule.purged",
        summary: `WebUI 永久删除定时任务 ${job.name}`,
        chatId: job.chatId,
        key: job.key,
        data: {
          job: id,
          name: job.name,
          state: job.state,
          wasActive,
          actor: "webui",
        },
      });
    }
    return ctx.json({ ok: true, data: { removed, name: job.name, wasActive } });
  });
  /**
   * 立即触发一次，不等待它执行完成：`mode='agent'` 的一次触发是一整轮真实模型调用，
   * 同步等待会把这个请求挂到 `concurrency.turnTimeoutMs`。因此先返回响应（与
   * `POST /api/restart` 做法相同），结果记录在这一行的 `lastState` / `lastError` 与日志里。
   * 不影响下一次的正常触发：cron 一侧的计时器未被改动。
   */
  app.post("/api/schedules/:id/trigger", (ctx) => {
    const runtime = scheduleRuntime();
    if (!runtime)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配定时任务运行时", 500).body,
        500,
      );
    // 启动窗口：HTTP 自 `serve()` 起即在监听，而 runner 的 `load()` 要等 bot 启动完成。该窗口内触发
    // 一条任务会开出完整轮次、调用模型并计费，最终以 `delivery_failed:telegram_unavailable` 收尾且
    // 不提交（docs/28 · L-SCH-01）。原因必须写进响应，否则界面上只剩一句触发失败。
    if (!runtime.runner.loaded)
      return ctx.json(
        apiError(
          "not_ready",
          "定时任务运行时尚未装载完成（Telegram 投递通道未就绪），请稍后重试；未配置可用 BOT_TOKEN 的部署无法手动触发",
          400,
        ).body,
        400,
      );
    const id = ctx.req.param("id");
    const job = runtime.jobs.byId(id);
    if (!job)
      return ctx.json(apiError("not_found", "任务不存在", 404).body, 404);
    if (job.state !== "active")
      return ctx.json(
        apiError("not_active", `任务状态为 ${job.state}，不会再触发`, 409).body,
        409,
      );
    dependencies.log.event({
      level: "info",
      kind: "schedule.fired",
      summary: `WebUI 手动触发定时任务 ${job.name}`,
      chatId: job.chatId,
      key: job.key,
      data: {
        job: id,
        name: job.name,
        mode: job.mode,
        actor: "webui",
        manual: true,
      },
    });
    void runtime.runner.fire(id).catch((error: unknown) =>
      dependencies.log.event({
        level: "error",
        kind: "schedule.failed",
        summary: `手动触发 ${job.name} 失败`,
        chatId: job.chatId,
        key: job.key,
        data: {
          job: id,
          error: error instanceof Error ? error.message : String(error),
        },
      }),
    );
    return ctx.json({
      ok: true,
      data: { started: true, name: job.name, mode: job.mode },
    });
  });
  /**
   * 这里不用 `SELECT *`：那会把 `path`（宿主文件系统路径）、`content_hash` 与整份
   * `frontmatter_json` 一并发给前端。
   *
   * `requires_tools` 是从 `frontmatter_json` 里只取该字段再发出，而不是放行整份 frontmatter。
   * 它需要出现在列表上：`requires-tools` 未被满足的 skill 不会进入模型的目录
   * （`SkillLoader.catalog()`），而 `tools.selfExtend.*` 出厂全部关闭，于是一份说明文档在这一页上
   * 显示为可用，模型一侧却始终不可见。实测代价记录在 `packages/core/src/skills/loader.ts` 的
   * `requires-tools` 注释里（模型读到用 install_mcp 装 MCP，调用时却没有这个工具，
   * 于是花了八分钟用 bash 逆向代码库、从 sessions 表取 owner 会话去访问 WebUI）。
   */
  app.get("/api/skills", (ctx) => {
    const rows = dependencies.db
      .prepare(
        "SELECT name,description,min_role,enabled,source,load_error,updated_at,allowed_tools_json,frontmatter_json FROM skills ORDER BY name",
      )
      .all() as Array<Record<string, unknown>>;
    const stringList = (raw: unknown): string[] => {
      if (typeof raw !== "string" || !raw) return [];
      try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === "string")
          : [];
      } catch {
        return [];
      }
    };
    return ctx.json({
      ok: true,
      data: rows.map((row) => {
        let requires: string[] = [];
        try {
          const frontmatter =
            typeof row.frontmatter_json === "string"
              ? (JSON.parse(row.frontmatter_json) as Record<string, unknown>)
              : {};
          requires = stringList(
            JSON.stringify(frontmatter["requires-tools"] ?? []),
          );
        } catch {
          requires = [];
        }
        const {
          frontmatter_json: _dropped,
          allowed_tools_json: allowed,
          ...rest
        } = row;
        return {
          ...rest,
          allowed_tools: stringList(allowed),
          requires_tools: requires,
        };
      }),
    });
  });
  app.get("/api/skills/:name", (ctx) => {
    const skill = dependencies.skills?.read(ctx.req.param("name"));
    return skill
      ? ctx.json({ ok: true, data: skill })
      : ctx.json(apiError("not_found", "Skill 不存在", 404).body, 404);
  });
  /**
   * 随包发布的四份说明文档只允许启停。`write_skill` 从一开始就拒绝修改它们（模型改坏自己的说明
   * 文档后，下一次就会照着改坏的那份写），而这一侧此前可改可删，同一条不变量只覆盖了一半。
   * 停用属于正当运维动作，因此只拦截修改 `enabled` 以外的字段与删除。
   */
  const reservedSkill = (
    ctx: Context<ServerEnv>,
    body?: Record<string, unknown>,
  ): Response | null => {
    const name = ctx.req.param("name") ?? "";
    if (!(BUNDLED_SKILLS as readonly string[]).includes(name)) return null;
    if (body && Object.keys(body).every((key) => key === "enabled"))
      return null;
    return ctx.json(
      apiError(
        "skill_reserved",
        `${name} 是随包发的说明文档，只能启停，不能改正文或删除`,
        403,
      ).body,
      403,
    );
  };
  // PUT 与 PATCH 走同一条路：SkillLoader.update 本来就是「只覆盖给到的字段」，
  // 两个动词分别抄一份 body 映射，改 frontmatter 字段时必然漏掉其中一个。
  const skillWriteInput = (body: Record<string, unknown>): SkillWriteInput => ({
    description: body.description as string | undefined,
    body: body.body as string | undefined,
    allowedTools: body.allowedTools as string[] | undefined,
    requiresTools: body.requiresTools as string[] | undefined,
    minRole: body.minRole as Role | undefined,
    model: body.model as string | null | undefined,
    enabled: body.enabled as boolean | undefined,
  });
  const updateSkill = async (ctx: Context<ServerEnv>): Promise<Response> => {
    if (!dependencies.skills)
      return ctx.json(
        apiError("not_implemented", "SkillLoader 未配置", 500).body,
        500,
      );
    const body = await ctx.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const reserved = reservedSkill(ctx, body);
    if (reserved) return reserved;
    try {
      return ctx.json({
        ok: true,
        data: dependencies.skills.update(
          ctx.req.param("name") ?? "",
          skillWriteInput(body),
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Skill 更新失败";
      return message === "skill_not_found"
        ? ctx.json(apiError("not_found", "Skill 不存在", 404).body, 404)
        : ctx.json(apiError("skill_update_failed", message, 400).body, 400);
    }
  };
  app.post("/api/skills", async (ctx) => {
    if (!dependencies.skills)
      return ctx.json(
        apiError("not_implemented", "SkillLoader 未配置", 500).body,
        500,
      );
    const body = await ctx.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    if (typeof body.name !== "string")
      return ctx.json(apiError("invalid_skill_name", "name 必填").body, 400);
    try {
      return ctx.json(
        {
          ok: true,
          data: dependencies.skills.create(body.name, skillWriteInput(body)),
        },
        201,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Skill 新建失败";
      // 重名表示名称已被占用，而不是请求不合法：返回 409 使前端能把它与校验错误分开提示。
      return message === "skill_already_exists"
        ? ctx.json(
            apiError("conflict", `Skill ${body.name} 已存在`, 409).body,
            409,
          )
        : ctx.json(apiError("invalid_skill", message, 400).body, 400);
    }
  });
  /**
   * 安装一个 skill 包（docs/07 §2.5）。与 `install_skill` 工具共用 `installSkillPackage`：
   * 端点自行实现一遍解包逻辑时，两条路径迟早在校验上分叉，而那里的每一条都是安全判据。
   *
   * 上传的 zip 落在 `<skillsDir>/.uploads/` 而不是 `os.tmpdir()`：安装目标在同一个卷上，
   * 且点号开头的目录 `SkillLoader.scan()` 不扫描。用完即删。
   */
  app.post("/api/skills/package", async (ctx) => {
    if (!dependencies.skills)
      return ctx.json(
        apiError("not_implemented", "SkillLoader 未配置", 500).body,
        500,
      );
    const limits = currentConfig().skills.package;
    const body = await ctx.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!(file instanceof File))
      return ctx.json(
        apiError("invalid_package", "需要 multipart 表单里的 file 字段").body,
        400,
      );
    if (file.size > limits.maxTotalBytes)
      return ctx.json(
        apiError(
          "skill_package_too_large",
          `压缩包超过 ${limits.maxTotalBytes} 字节`,
          413,
        ).body,
        413,
      );
    const uploads = join(dependencies.skills.directory, ".uploads");
    mkdirSync(uploads, { recursive: true, mode: 0o700 });
    const staged = join(
      uploads,
      `${Date.now()}-${randomBytes(8).toString("hex")}.zip`,
    );
    const text = (key: string): string | undefined =>
      typeof body?.[key] === "string" && body[key] ? body[key] : undefined;
    try {
      writeFileSync(staged, Buffer.from(await file.arrayBuffer()), {
        mode: 0o600,
      });
      const installed = await installSkillPackage(dependencies.skills, staged, {
        limits,
        minRoleFloor: currentConfig().tools.selfExtend.skills.minRole,
        origin: file.name,
        ...(text("name") ? { name: text("name") } : {}),
        ...(text("subdir") ? { subdir: text("subdir") } : {}),
        ...(body?.overwrite === "true" ? { overwrite: true } : {}),
      });
      return ctx.json({ ok: true, data: installed }, 201);
    } catch (error) {
      if (!(error instanceof SkillPackageError)) {
        return ctx.json(
          apiError(
            "skill_package_failed",
            error instanceof Error ? error.message : "装包失败",
          ).body,
          400,
        );
      }
      const status =
        error.code === "skill_already_exists"
          ? 409
          : error.code === "skill_reserved"
            ? 403
            : 400;
      // 包根有歧义时必须返回候选：前端要用它渲染一个选择安装哪一个的界面，
      // 只返回存在歧义等于让运维自行推测 subdir 该填什么。
      return ctx.json(
        {
          ok: false as const,
          error: {
            code: error.code,
            message: error.hint ?? error.code,
            ...(error.candidates
              ? { details: { candidates: error.candidates } }
              : {}),
          },
        },
        status,
      );
    } finally {
      rmSync(staged, { force: true });
    }
  });
  app.put("/api/skills/:name", updateSkill);
  app.patch("/api/skills/:name", updateSkill);
  app.delete("/api/skills/:name", (ctx) => {
    if (!dependencies.skills)
      return ctx.json(
        apiError("not_implemented", "SkillLoader 未配置", 500).body,
        500,
      );
    const reserved = reservedSkill(ctx);
    if (reserved) return reserved;
    try {
      return ctx.json({
        ok: true,
        data: { removed: dependencies.skills.remove(ctx.req.param("name")) },
      });
    } catch (error) {
      return ctx.json(
        apiError(
          "skill_delete_failed",
          error instanceof Error ? error.message : "Skill 删除失败",
          400,
        ).body,
        400,
      );
    }
  });
  app.get("/api/plugins", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.db
        .prepare("SELECT * FROM plugins ORDER BY name")
        .all(),
    }),
  );
  app.patch("/api/plugins/:name", async (ctx) => {
    const body = await ctx.req.json<{ enabled?: boolean; config?: unknown }>();
    const changes = dependencies.db
      .prepare(
        "UPDATE plugins SET enabled=COALESCE(?,enabled),config_json=COALESCE(?,config_json),updated_at=? WHERE name=?",
      )
      .run(
        body.enabled === undefined ? null : body.enabled ? 1 : 0,
        body.config === undefined ? null : JSON.stringify(body.config),
        Date.now(),
        ctx.req.param("name"),
      ).changes;
    if (!changes)
      return ctx.json(apiError("not_found", "Plugin 不存在", 404).body, 404);
    await dependencies.plugins?.reconcile();
    return ctx.json({ ok: true, data: { changes } });
  });
  // 重载在 tsx（`pnpm dev`）下表现为成功、实际一直运行旧代码，且无法修复（tsx 的 loader
  // 按路径缓存、忽略 cache-busting 查询串）。返回 200 时必须在响应里说明这一点，否则界面上的
  // 已重载是错误信息（docs/28 · L-EXT-04）。与启动告警共用同一句 `hotReloadWarning`。
  app.post("/api/plugins/:name/reload", async (ctx) => {
    await dependencies.plugins?.reconcile();
    const warning = dependencies.plugins?.hotReloadWarning ?? null;
    return ctx.json({
      ok: true,
      data: {
        name: ctx.req.param("name"),
        hotReloadReliable: warning === null,
        ...(warning ? { warning } : {}),
      },
    });
  });
  // 启用前先审阅源码是 plugin 那道闸的全部内容（进程内完全信任，等同 root，docs/14 A27），
  // 而模型现在可以往 `plugins/` 里写文件：没有这个读端点，该要求无法执行。
  app.get("/api/plugins/:name/source", (ctx) => {
    if (!dependencies.plugins)
      return ctx.json(
        apiError("not_implemented", "PluginManager 未配置", 500).body,
        500,
      );
    try {
      const source = dependencies.plugins.readSource(ctx.req.param("name"));
      return source === null
        ? ctx.json(apiError("not_found", "plugin.js 不存在", 404).body, 404)
        : ctx.json({ ok: true, data: { name: ctx.req.param("name"), source } });
    } catch {
      return ctx.json(
        apiError("invalid_plugin_name", "名称必须是 kebab-case").body,
        400,
      );
    }
  });
  app.delete("/api/plugins/:name", async (ctx) => {
    if (!dependencies.plugins)
      return ctx.json(
        apiError("not_implemented", "PluginManager 未配置", 500).body,
        500,
      );
    try {
      // 什么都没删掉时 404，与隔壁 `DELETE /api/custom-tools/:name` 同一口径 —— 回 200 的话
      // 界面会对着一个拼错的名字弹「已删除」。
      const removed = await dependencies.plugins.remove(ctx.req.param("name"));
      return removed
        ? ctx.json({ ok: true, data: { removed } })
        : ctx.json(apiError("not_found", "Plugin 不存在", 404).body, 404);
    } catch (error) {
      return ctx.json(
        apiError(
          "plugin_delete_failed",
          error instanceof Error ? error.message : "plugin 删除失败",
          400,
        ).body,
        400,
      );
    }
  });
  /**
   * 自撰写工具的复审面。它与工具页那条 `PATCH /api/tools/:name` 是两个动词：这里管该工具是否
   * 存在、是否已复审，那边管当前是否启用。合并两者时，一次运维停用会表现为复审记录也被撤销。
   */
  app.get("/api/custom-tools", (ctx) => {
    if (!dependencies.customTools)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配自撰写工具", 500).body,
        500,
      );
    return ctx.json({ ok: true, data: dependencies.customTools.list() });
  });
  app.patch("/api/custom-tools/:name", async (ctx) => {
    if (!dependencies.customTools || !dependencies.customToolManager)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配自撰写工具", 500).body,
        500,
      );
    // 只接受 `enabled`。`scope` / `minRole` 属于模型一侧的定义（修改后需重新复审），从这里改会让
    // `definition_hash` 与模型认定的那份定义脱节：声明一个不会被读取的字段比不声明更糟。
    const body = await ctx.req
      .json<{ enabled?: boolean }>()
      .catch(() => ({}) as { enabled?: boolean });
    const name = ctx.req.param("name");
    if (!dependencies.customTools.get(name))
      return ctx.json(apiError("not_found", "自定义工具不存在", 404).body, 404);
    if (typeof body.enabled !== "boolean")
      return ctx.json(
        apiError("invalid_custom_tool", "enabled 必须是布尔值").body,
        400,
      );
    dependencies.customTools.setEnabled(name, body.enabled);
    dependencies.customToolManager.reconcile();
    // 启用一段模型写的脚本是最该在日志页一眼看见的运维动作，记 warn 而不是 info。
    dependencies.log.event({
      level: body.enabled ? "warn" : "info",
      kind: "webui.action",
      summary: `custom tool ${body.enabled ? "enabled" : "disabled"}: ${name}`,
      data: { tool: name, enabled: body.enabled },
    });
    return ctx.json({ ok: true, data: dependencies.customTools.get(name) });
  });
  app.delete("/api/custom-tools/:name", (ctx) => {
    if (!dependencies.customTools || !dependencies.customToolManager)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配自撰写工具", 500).body,
        500,
      );
    const removed = dependencies.customTools.remove(ctx.req.param("name"));
    if (!removed)
      return ctx.json(apiError("not_found", "自定义工具不存在", 404).body, 404);
    dependencies.customToolManager.reconcile();
    return ctx.json({ ok: true, data: { removed } });
  });
  app.get("/api/mcp", (ctx) => {
    const persisted = dependencies.db
      .prepare("SELECT * FROM mcp_servers ORDER BY name")
      .all() as Array<Record<string, unknown>>;
    const byName = new Map(persisted.map((row) => [String(row.name), row]));
    const data = currentConfig().mcp.servers.map((server) => {
      const row = byName.get(server.name) ?? {};
      let tools: unknown[] = [];
      try {
        tools = row.tools_json
          ? (JSON.parse(String(row.tools_json)) as unknown[])
          : [];
      } catch {
        tools = [];
      }
      // `auth` 只返回不含密文的那一份（由 `McpAuthRepository.get` 的返回类型保证），
      // 外加一条授权链接仍在等待的状态：刷新页面后〔登录〕按钮仍要可用。
      const credential = dependencies.mcpAuth?.store.get(server.name) ?? null;
      const pending = dependencies.mcpAuth?.pending.peek(server.name) ?? null;
      return {
        ...row,
        ...server,
        min_role: server.minRole ?? currentConfig().mcp.defaultMinRole,
        enabled: server.enabled === false ? 0 : 1,
        state: server.enabled === false ? "disabled" : (row.state ?? "pending"),
        last_error: row.last_error ?? null,
        tools,
        credential,
        pendingAuthorization: pending
          ? {
              authorizationUrl: pending.authorizationUrl,
              expiresAt: pending.expiresAt,
            }
          : null,
      };
    });
    return ctx.json({ ok: true, data });
  });
  app.post("/api/mcp", async (ctx) => {
    const body = await ctx.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const existing = [...currentConfig().mcp.servers];
    if (typeof body.name !== "string")
      return ctx.json(apiError("invalid_mcp_name", "name 必填").body, 400);
    // 409 让前端能把它和校验错误分开提示 —— skills 那条路一直是这么做的，MCP 这边此前回的是
    // 400，和 `invalid_mcp` 挤在同一个 status 上（docs/29 · M-WEB-12）。
    if (existing.some((server) => server.name === body.name))
      return ctx.json(apiError("conflict", "同名 MCP server 已存在").body, 409);
    if (redactedKeys({ server: body }).length)
      return ctx.json(
        apiError(
          "redacted_placeholder",
          "env / headers 含脱敏占位符 «redacted»，写入会覆盖真实凭据",
        ).body,
        400,
      );
    const saved = persistMcpServers([...existing, body]);
    if (!saved.ok)
      return ctx.json(
        {
          ok: false,
          error: {
            code: "invalid_mcp",
            message: "MCP 配置校验失败",
            details: saved.details,
          },
        },
        400,
      );
    await dependencies.mcp?.reconcile();
    return ctx.json(
      {
        ok: true,
        data: saved.servers.find((server) => server.name === body.name),
      },
      201,
    );
  });
  app.patch("/api/mcp/:name", async (ctx) => {
    const name = ctx.req.param("name");
    const body = await ctx.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const existing = [...currentConfig().mcp.servers];
    const index = existing.findIndex((server) => server.name === name);
    if (index < 0)
      return ctx.json(
        apiError("not_found", "MCP server 不存在", 404).body,
        404,
      );
    if (redactedKeys({ server: body }).length)
      return ctx.json(
        apiError(
          "redacted_placeholder",
          "env / headers 含脱敏占位符 «redacted»，写入会覆盖真实凭据",
        ).body,
        400,
      );
    existing[index] = {
      ...existing[index]!,
      ...body,
      name,
    } as Config["mcp"]["servers"][number];
    const saved = persistMcpServers(existing);
    if (!saved.ok)
      return ctx.json(
        {
          ok: false,
          error: {
            code: "invalid_mcp",
            message: "MCP 配置校验失败",
            details: saved.details,
          },
        },
        400,
      );
    await dependencies.mcp?.reconcile();
    return ctx.json({ ok: true, data: saved.servers[index] });
  });
  app.delete("/api/mcp/:name", async (ctx) => {
    const name = ctx.req.param("name");
    const existing = [...currentConfig().mcp.servers];
    if (!existing.some((server) => server.name === name))
      return ctx.json({ ok: true, data: { removed: false } });
    const saved = persistMcpServers(
      existing.filter((server) => server.name !== name),
    );
    if (!saved.ok)
      return ctx.json(
        {
          ok: false,
          error: {
            code: "invalid_mcp",
            message: "MCP 配置校验失败",
            details: saved.details,
          },
        },
        400,
      );
    await dependencies.mcp?.reconcile();
    dependencies.db.prepare("DELETE FROM mcp_servers WHERE name=?").run(name);
    return ctx.json({ ok: true, data: { removed: true } });
  });
  /**
   * 四条 auth 端点共用的前置检查：凭据库是否存在、这台 server 是否存在、是否为 http。
   * 返回的是收窄到 http 那一支的 server：`auth` 只存在于该分支，判别联合不收窄就读不到它。
   */
  type HttpMcpServer = Extract<
    Config["mcp"]["servers"][number],
    { transport: "http" }
  >;
  const mcpAuthTarget = (
    name: string,
  ): { server: HttpMcpServer } | { error: ReturnType<typeof apiError> } => {
    if (!dependencies.mcpAuth || !dependencies.mcp)
      return {
        error: apiError(
          "mcp_auth_unavailable",
          "这个部署未接入 MCP 凭据库（通常是缺 LUOLI_MASTER_KEY）：凭据无法存储，不返回保存成功。",
          500,
        ),
      };
    const server = currentConfig().mcp.servers.find(
      (entry) => entry.name === name,
    );
    if (!server)
      return { error: apiError("not_found", "MCP server 不存在", 404) };
    if (server.transport !== "http")
      return {
        error: apiError(
          "mcp_auth_stdio",
          "stdio server 的登录在带外自行完成（其 stderr 会进日志），此处没有可用的授权流程。",
          400,
        ),
      };
    return { server };
  };

  /**
   * 发起一次授权。把授权 URL 返回给界面，由用户点击：reconcile 自行打开浏览器是另一类问题。
   * `webui.publicUrl` 未配置时在此中止：`redirect_uri` 一旦注册到对方就难以修改，
   * 构造一个 127.0.0.1 的地址会让这次授权在注册完成后即失效。
   */
  app.post("/api/mcp/:name/auth/start", async (ctx) => {
    const target = mcpAuthTarget(ctx.req.param("name"));
    if ("error" in target)
      return ctx.json(target.error.body, target.error.status as 400);
    if (target.server.auth?.mode !== "oauth")
      return ctx.json(
        apiError(
          "mcp_auth_mode",
          "该 server 的 auth.mode 不是 oauth。浏览器授权需先改为 oauth；仅有静态 token 时改用 PUT /api/mcp/:name/auth。",
        ).body,
        400,
      );
    try {
      const started = await dependencies.mcp!.authorize(target.server);
      return ctx.json({ ok: true, data: started });
    } catch (error) {
      return ctx.json(
        apiError(
          "mcp_auth_failed",
          error instanceof Error ? error.message : String(error),
          400,
        ).body,
        400,
      );
    }
  });

  /**
   * 授权服务器重定向回来的那一跳。判据只有 `state`：单次使用、10 分钟有效、仅存在于进程内。
   * 成功后单台重连，然后 302 回控制台：这一跳的落点是浏览器地址栏而不是 fetch，
   * 返回 JSON 会让用户看到一屏原始数据。
   */
  app.get(MCP_OAUTH_CALLBACK_PATH, async (ctx) => {
    const state = ctx.req.query("state");
    const code = ctx.req.query("code");
    const upstreamError = ctx.req.query("error");
    const back = (status: string, detail?: string): Response =>
      ctx.redirect(
        `/?mcpAuth=${encodeURIComponent(status)}${detail ? `&detail=${encodeURIComponent(detail)}` : ""}`,
        302,
      );
    if (!dependencies.mcpAuth || !dependencies.mcp) return back("unavailable");
    // 先消费 state 再做其他判断：已回调过的 state 不应因后续某个判据失败而保留、可被重放。
    const pending = state ? dependencies.mcpAuth.pending.take(state) : null;
    if (!pending) {
      dependencies.log.event({
        level: "warn",
        kind: "mcp.auth",
        summary: "OAuth 回调的 state 无效或已过期",
      });
      return back("bad_state");
    }
    if (upstreamError || !code) {
      dependencies.log.event({
        level: "warn",
        kind: "mcp.auth",
        summary: `${pending.server} 授权被拒绝或取消`,
        data: { server: pending.server, error: upstreamError ?? "no_code" },
      });
      return back("denied", upstreamError ?? undefined);
    }
    const target = mcpAuthTarget(pending.server);
    if ("error" in target) return back("not_found");
    const server = target.server;
    try {
      const status = await dependencies.mcp.completeAuthorization(server, code);
      if (status !== "AUTHORIZED") return back("incomplete");
      // 单台重连而不是整体 reconcile：整体的话另外几台健康 server 也要跟着断一次。
      await dependencies.mcp.connect(server).catch(() => undefined);
      dependencies.events.emit("health", {
        source: "mcp",
        name: server.name,
        ok: true,
        code: "authorized",
      });
      return back("ok", server.name);
    } catch (error) {
      dependencies.log.event({
        level: "warn",
        kind: "mcp.auth",
        summary: `${server.name} 换取 token 失败`,
        data: {
          server: server.name,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return back("failed", error instanceof Error ? error.message : undefined);
    }
  });

  /** 静态 bearer token。写入即加密，此后任何读路径都不返回它，界面上只能看到末 4 位。 */
  app.put("/api/mcp/:name/auth", async (ctx) => {
    const target = mcpAuthTarget(ctx.req.param("name"));
    if ("error" in target)
      return ctx.json(target.error.body, target.error.status as 400);
    const body = await ctx.req
      .json<{ token?: unknown }>()
      .catch((): { token?: unknown } => ({}));
    if (typeof body.token !== "string" || !body.token.trim())
      return ctx.json(apiError("invalid_token", "token 必填").body, 400);
    // 读出来的脱敏值原样提交回来只会把真凭据换成那几个字（照 POST/PATCH /api/mcp 的既有守卫）。
    if (body.token.includes("«redacted»"))
      return ctx.json(
        apiError(
          "redacted_placeholder",
          "token 是脱敏占位符 «redacted»，非真实凭据",
        ).body,
        400,
      );
    if (target.server.auth?.mode !== "bearer")
      return ctx.json(
        apiError(
          "mcp_auth_mode",
          "该 server 的 auth.mode 不是 bearer。请先改为 bearer 再填写 token。",
        ).body,
        400,
      );
    dependencies.mcpAuth!.store.setBearer(
      target.server.name,
      body.token.trim(),
    );
    // 凭据版本提升后指纹随之变化，本次 reconcile 必然重连而不是复用旧连接。
    await dependencies.mcp!.reconcile();
    const row = dependencies.db
      .prepare("SELECT state,last_error AS error FROM mcp_servers WHERE name=?")
      .get(target.server.name) as
      { state: string; error: string | null } | undefined;
    dependencies.events.emit("health", {
      source: "mcp",
      name: target.server.name,
      ok: row?.state === "up",
      code: row?.state ?? "unknown",
    });
    return ctx.json({
      ok: true,
      data: {
        name: target.server.name,
        credential: dependencies.mcpAuth!.store.get(target.server.name),
        state: row?.state ?? null,
        error: row?.error ?? null,
      },
    });
  });

  /** 注销。清空凭据但保留那一行的 `mode`：使用 OAuth 但未登录与不需要登录是两种状态。 */
  app.delete("/api/mcp/:name/auth", async (ctx) => {
    const target = mcpAuthTarget(ctx.req.param("name"));
    if ("error" in target)
      return ctx.json(target.error.body, target.error.status as 400);
    await dependencies.mcp!.signOut(target.server);
    await dependencies.mcp!.reconcile();
    const row = dependencies.db
      .prepare("SELECT state,last_error AS error FROM mcp_servers WHERE name=?")
      .get(target.server.name) as
      { state: string; error: string | null } | undefined;
    dependencies.events.emit("health", {
      source: "mcp",
      name: target.server.name,
      ok: false,
      code: row?.state ?? "unknown",
    });
    return ctx.json({
      ok: true,
      data: {
        name: target.server.name,
        credential: dependencies.mcpAuth!.store.get(target.server.name),
        state: row?.state ?? null,
        error: row?.error ?? null,
      },
    });
  });

  app.post("/api/mcp/:name/reconnect", async (ctx) => {
    await dependencies.mcp?.reconcile();
    const row = dependencies.db
      .prepare("SELECT state,last_error AS error FROM mcp_servers WHERE name=?")
      .get(ctx.req.param("name")) as
      { state: string; error: string | null } | undefined;
    dependencies.events.emit("health", {
      source: "mcp",
      name: ctx.req.param("name"),
      ok: row?.state === "up",
      code: row?.state ?? "unknown",
    });
    return ctx.json({
      ok: true,
      data: {
        name: ctx.req.param("name"),
        state: row?.state ?? null,
        error: row?.error ?? null,
      },
    });
  });
  /**
   * lw-worker 的隔离试跑。**没有 `:name`** —— 定义体系已删除，worker 只有一种，权限来自调用者。
   *
   * 保留这条路的理由与试跑某份定义无关：它是唯一能不开一条真轮次、用真模型真工具跑一遍、
   * 并逐步看到 step / usage / 工具输入输出的入口，而 lw-worker 是重构后唯一执行工具的一档。
   * `tools` 与 `modelAlias` 只做形状校验，取值合法性由运行时判（未知别名、越权工具名都在那边拦）。
   */
  app.post("/api/workers/dryrun", async (ctx) => {
    if (!dependencies.dryRunWorker)
      return ctx.json(
        apiError("not_implemented", "Worker 试跑未接入运行时", 500).body,
        500,
      );
    type DryRunBody = {
      task?: unknown;
      tools?: unknown;
      modelAlias?: unknown;
    };
    const body = await ctx.req.json<DryRunBody>().catch((): DryRunBody => ({}));
    if (typeof body.task !== "string" || !body.task.trim())
      return ctx.json(apiError("invalid_task", "task 必填").body, 400);
    if (body.task.length > 20_000)
      return ctx.json(
        apiError("task_too_large", "task 最多 20000 字符").body,
        400,
      );
    if (
      body.tools !== undefined &&
      (!Array.isArray(body.tools) ||
        body.tools.some((name: unknown) => typeof name !== "string" || !name))
    )
      return ctx.json(
        apiError("invalid_tools", "tools 只能是工具名数组").body,
        400,
      );
    if (
      body.modelAlias !== undefined &&
      (typeof body.modelAlias !== "string" ||
        !ALIAS_NAME_PATTERN.test(body.modelAlias))
    )
      return ctx.json(
        apiError("invalid_model_alias", "modelAlias 不是合法别名").body,
        400,
      );
    // 空数组与不给是两件事：不给 = 调用者角色下的全集，给了空数组 = 一个工具都不许用。
    // 两者都送出去，由运行时决定，端点不替它归一。
    const input = {
      task: body.task.trim(),
      ...(body.tools === undefined ? {} : { tools: body.tools as string[] }),
      ...(body.modelAlias === undefined ? {} : { modelAlias: body.modelAlias }),
    };
    const abort = new AbortController();
    const requestSignal = ctx.req.raw.signal;
    const onRequestAbort = (): void => abort.abort();
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: WorkerDryRunEvent): void => {
          if (!closed)
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        void dependencies.dryRunWorker!(input, abort.signal, send)
          .then((result) => send({ type: "final", ...result }))
          .catch((error) =>
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            }),
          )
          .finally(() => {
            requestSignal.removeEventListener("abort", onRequestAbort);
            if (!closed) {
              closed = true;
              controller.close();
            }
          });
      },
      cancel() {
        closed = true;
        abort.abort();
        requestSignal.removeEventListener("abort", onRequestAbort);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
  /**
   * Worker 运行记录（`agent_runs` 里 `worker_kind IS NOT NULL` 的那些，迁移 `0018`）。
   *
   * 判据用 `worker_kind` 而不是 `kind`：主 run 的 `worker_kind` 恒 NULL，三种 worker 各占一档
   * （`lw` / `harness` / `acp`）。此前全仓唯一读 `agent_runs` 的是 `GET /api/tasks/:id` 那条 join，
   * 入口是 `tasks.agent_run_id` —— harness / ACP 两条路不建 `tasks` 行，那条 join 永远够不着
   * （docs/21 · G-API-25）。
   *
   * 列表不带 `task_input` / `external_usage_json` / `progress`：一页 50 行各带一份完整任务正文
   * 只是往浏览器推死重量，理由同 `GET /api/tasks` 不带 `progress_json`。排序照 `GET /api/tasks`：
   * 正在跑的那几条才是关注对象。
   *
   * **`external_cost_usd` 原样透出，不与 `cost_usd` 相加。** 那是外部 agent 自报的数字，口径由它定、
   * 无法核对，结构上被挡在每一个聚合之外（迁移 `0014`）；在这里合并等于把一条有意为之的边界当缺口修掉。
   */
  const WORKER_KINDS = ["lw", "harness", "acp"];
  const RUN_STATES = ["running", "done", "failed", "cancelled"];
  app.get("/api/worker-runs", (ctx) => {
    const {
      page: pageNumber,
      size,
      offset,
    } = pageParams(ctx, { defaultSize: 50, maxSize: 200 });
    const workerKind = ctx.req.query("workerKind");
    const state = ctx.req.query("state");
    // 非法过滤值 400 而不是忽略：忽略的表现是「筛了 acp 却看见 lw 的行」，比报错更难察觉。
    if (workerKind !== undefined && !WORKER_KINDS.includes(workerKind))
      return ctx.json(
        apiError(
          "invalid_worker_kind",
          `workerKind 只能是 ${WORKER_KINDS.join(" / ")}`,
        ).body,
        400,
      );
    if (state !== undefined && !RUN_STATES.includes(state))
      return ctx.json(
        apiError("invalid_state", `state 只能是 ${RUN_STATES.join(" / ")}`)
          .body,
        400,
      );
    const filters = ["worker_kind IS NOT NULL"];
    const bindings: string[] = [];
    if (workerKind !== undefined) {
      filters.push("worker_kind=?");
      bindings.push(workerKind);
    }
    if (state !== undefined) {
      filters.push("state=?");
      bindings.push(state);
    }
    const where = filters.join(" AND ");
    const total = Number(
      dependencies.db
        .prepare(`SELECT COUNT(*) FROM agent_runs WHERE ${where}`)
        .pluck()
        .get(...bindings),
    );
    const rows = dependencies.db
      .prepare(
        `SELECT id,turn_id AS turnId,parent_run_id AS parentRunId,depth,worker_kind AS workerKind,agent_name AS agentName,
      model_alias AS modelAlias,effective_role AS effectiveRole,state,steps,tool_calls AS toolCalls,
      input_tokens AS inputTokens,output_tokens AS outputTokens,cost_usd AS costUsd,external_cost_usd AS externalCostUsd,
      task_input AS taskInput,result_summary AS resultSummary,error,started_at AS startedAt,finished_at AS finishedAt
      FROM agent_runs WHERE ${where} ORDER BY (state='running') DESC,started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...bindings, size, offset) as Array<
      Record<string, unknown> & { taskInput: string | null }
    >;
    // 列表只给任务的第一行：整份 `task_input` 是详情的事。ACP 那条路的任务正文可以是一整段
    // 提示词，五十行各带一份就是往浏览器推死重量（同 `GET /api/tasks` 不带 `progress_json`）。
    const items = rows.map(({ taskInput, ...row }) => ({
      ...row,
      taskLine: (taskInput?.split("\n")[0] ?? "").slice(0, 160),
    }));
    return ctx.json({
      ok: true,
      data: { items, total, page: pageNumber, size },
    });
  });
  /**
   * 单条 worker run 的只读详情。多出的四列（`task_input` / `external_usage_json` /
   * `result_full_ref` / `provider_id`+`model_id`）都只有这条路取得到。
   *
   * `worker_kind IS NULL` 的行（主 run）按 404 处理而不是原样返回：这个入口的语义是 worker 运行记录，
   * 把主 run 从这里放出去等于让页面上出现一条它解释不了的行。
   */
  app.get("/api/worker-runs/:id", (ctx) => {
    const row = dependencies.db
      .prepare(
        `SELECT id,turn_id AS turnId,parent_run_id AS parentRunId,depth,worker_kind AS workerKind,agent_name AS agentName,
      model_alias AS modelAlias,provider_id AS providerId,model_id AS modelId,effective_role AS effectiveRole,task_input AS taskInput,
      state,steps,tool_calls AS toolCalls,input_tokens AS inputTokens,output_tokens AS outputTokens,cost_usd AS costUsd,
      external_cost_usd AS externalCostUsd,external_usage_json AS externalUsageJson,result_summary AS resultSummary,
      result_full_ref AS resultFullRef,error,started_at AS startedAt,finished_at AS finishedAt
      FROM agent_runs WHERE id=? AND worker_kind IS NOT NULL`,
      )
      .get(ctx.req.param("id")) as Record<string, unknown> | undefined;
    if (!row)
      return ctx.json(
        apiError("not_found", "这条 worker 运行记录不存在", 404).body,
        404,
      );
    // 与 `GET /api/tasks/:id` 同形：run 上只记它自己那一段，而排障要知道它挂在哪一轮、那一轮怎么了。
    const turn =
      (dependencies.db
        .prepare(
          "SELECT key,chat_id AS chatId,state,error FROM turns WHERE id=?",
        )
        .get(row.turnId as string) as Record<string, unknown> | undefined) ??
      null;
    return ctx.json({
      ok: true,
      data: {
        ...row,
        turn,
        chatLabel: principalLabel(
          dependencies.db,
          "chat",
          (turn?.chatId as string | undefined) ?? null,
        ),
      },
    });
  });
  // `minLevel` 让总览页的「最近错误」卡片真的只看 warn 以上（docs/09 §3.1）。
  app.get("/api/logs", (ctx) => {
    const minLevel = ctx.req.query("minLevel");
    const level =
      minLevel && ["debug", "info", "warn", "error"].includes(minLevel)
        ? (minLevel as "debug" | "info" | "warn" | "error")
        : undefined;
    // 这一条不分页（只夹 size），但 `size` 的解析必须与那四个分页端点同源：`Math.min(1000, NaN)`
    // 还是 `NaN`，照样把端点打成 500。走同一个 `pageParams` 就不会再有第二种写法可抄。
    return ctx.json({
      ok: true,
      data: dependencies.operations.logs(
        pageParams(ctx, { defaultSize: 200, maxSize: 1000 }).size,
        ctx.req.query("traceId"),
        level,
      ),
    });
  });
  app.get("/api/logs/trace/:traceId", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.operations.logs(2000, ctx.req.param("traceId")),
    }),
  );
  /**
   * 单条日志事件的详情（日志页展开一行）。必须注册在 `/api/logs/trace/:traceId` 之后：
   * Hono 按注册顺序匹配，`:id` 放在前面会把它完全覆盖。非数字 id 直接 404，避免 `trace`
   * 这类字符串进入 `Number()` 变成 NaN 查询。
   *
   * 列表刻意不带载荷（见 `OperationsRepository.logs` 的注释），因此正文只有这条路径能取到，
   * 且与对话详情共用 `detailPayload` 的截断语义。载荷先经 `decodeLogPayload` 还原
   * —— 行在就意味着载荷在，不再有「有行没载荷」那一档（docs/10 §3）。
   */
  app.get("/api/logs/:id", (ctx) => {
    const raw = ctx.req.param("id");
    if (!/^\d+$/.test(raw))
      return ctx.json(apiError("not_found", "日志 id 无效", 404).body, 404);
    const row = dependencies.db
      .prepare(
        `SELECT id,ts,level,kind,trace_id AS traceId,span_id AS spanId,parent_span_id AS parentSpanId,
      chat_id AS chatId,user_id AS userId,key,summary,duration_ms AS durationMs,data,data_codec AS codec
      FROM log_events WHERE id=?`,
      )
      .get(Number(raw)) as
      | (Record<string, unknown> & {
          data: Buffer | null;
          codec: string | null;
        })
      | undefined;
    if (!row)
      return ctx.json(
        apiError("not_found", "该日志不存在（可能已被保留策略清理）", 404).body,
        404,
      );
    const { data, codec, ...rest } = row;
    return ctx.json({
      ok: true,
      data: { ...rest, ...detailPayload(decodeLogPayload(data, codec)) },
    });
  });
  // 对话详情里的 JSON 按 DETAIL_MAX_CHARS 截断（单个 span 的请求体实测均 29 KB、最大 5 MB），排查时要能拿到完整的那一份。
  app.get("/api/logs/:id/data", (ctx) => {
    const row = dependencies.db
      .prepare(
        "SELECT kind,data,data_codec AS codec FROM log_events WHERE id=?",
      )
      .get(Number(ctx.req.param("id"))) as
      { kind: string; data: Buffer | null; codec: string | null } | undefined;
    const decoded = row ? decodeLogPayload(row.data, row.codec) : null;
    if (!row || !decoded)
      return ctx.json(apiError("not_found", "该事件没有载荷", 404).body, 404);
    let value: unknown;
    try {
      value = JSON.parse(decoded);
    } catch {
      value = decoded;
    }
    return new Response(JSON.stringify(value, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": contentDisposition(
          `${row.kind}-${ctx.req.param("id")}.json`,
        ),
      },
    });
  });
  app.get("/api/usage", (ctx) =>
    ctx.json({
      ok: true,
      data: dependencies.db
        .prepare("SELECT * FROM usage_ledger ORDER BY ts DESC LIMIT 1000")
        .all(),
    }),
  );
  /**
   * 用量的时间范围与维度聚合（docs/09 §3.11）。聚合逻辑早已实现：
   * `UsageLedger.report(from,to,groupBy)` 六个维度齐全，只是从未有端点调用它，
   * 界面上因此只有一张不分维度的明细表。这里把那条路径接上。
   */
  app.get("/api/usage/report", (ctx) => {
    const groupBy = ctx.req.query("groupBy") ?? "day";
    if (
      !["day", "chat", "user", "model", "alias", "agent", "provider"].includes(
        groupBy,
      )
    )
      return ctx.json(
        apiError(
          "invalid_group_by",
          `维度只能是 day|chat|user|model|alias|agent|provider，收到 ${groupBy}`,
        ).body,
        400,
      );
    const now = Date.now();
    const from = Number(ctx.req.query("from") ?? now - 30 * 86_400_000);
    const to = Number(ctx.req.query("to") ?? now);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
      return ctx.json(
        apiError("invalid_range", "from/to 必须是毫秒时间戳且 from ≤ to").body,
        400,
      );
    // 时区必须传：日界与总览趋势、配额窗口用同一个口径，否则同一天在两个页面上是两个数字（docs/27 · C-02）。
    const rows =
      dependencies.ledger?.report(
        from,
        to,
        groupBy as "day",
        currentConfig().general.timezone,
      ) ?? [];
    // chat / user / provider 维度的 bucket 是裸 id，界面上认不出是谁。在这里补显示名，别让前端再实现一遍
    // `principals` 的反查规则（会话页已经有一份，两份必然漂移）。
    const labelled = ["chat", "user"].includes(groupBy)
      ? (rows as Array<{ bucket: string | null }>).map((row) => ({
          ...row,
          label: principalLabel(
            dependencies.db,
            groupBy === "chat" ? "chat" : "user",
            row.bucket,
          ),
        }))
      : groupBy === "provider"
        ? (rows as Array<{ bucket: string | null }>).map((row) => ({
            ...row,
            label:
              (row.bucket
                ? (dependencies.db
                    .prepare("SELECT name FROM providers WHERE id=?")
                    .pluck()
                    .get(row.bucket) as string | undefined)
                : undefined) ?? row.bucket,
          }))
        : rows;
    return ctx.json({ ok: true, data: { groupBy, from, to, rows: labelled } });
  });
  const QUOTA_UNIMPLEMENTED = KNOWN_UNIMPLEMENTED_CONFIG_KEYS.filter((key) =>
    key.startsWith("quota."),
  );
  interface CounterRow {
    scope: "global" | "chat" | "user";
    subject: string;
    window: "day" | "month";
    bucket: string;
    costUsd: number;
    reservedUsd: number;
    turns: number;
    updatedAt: number;
  }
  /** 已用量在 quota_counters 里，上限在配置里，两者只有 (scope,window) 可以对应。
   *  分开返回等于让界面另行实现一遍 bot.ts 的取值规则（含 byRole 覆盖），因此在这里合成完毕。 */
  app.get("/api/quota", (ctx) => {
    const config = currentConfig();
    const now = new Date();
    const buckets = {
      day: quotaBucket(now, config.general.timezone, "day"),
      month: quotaBucket(now, config.general.timezone, "month"),
    };
    const rows = dependencies.db
      .prepare(
        `SELECT scope,subject,window,bucket,cost_usd AS costUsd,reserved_usd AS reservedUsd,turns,updated_at AS updatedAt
      FROM quota_counters ORDER BY bucket DESC,scope,subject LIMIT 500`,
      )
      .all() as CounterRow[];
    const byRole = config.quota.perUser.byRole;
    const scopedRoles = Object.keys(byRole).length > 0;
    // 一次取回而不是逐行点查：这一页会被反复刷新，500 行 × 一条 SELECT 是白烧的 IO。
    const principals = new Map(
      (
        dependencies.db
          .prepare(
            "SELECT kind,tg_id AS tgId,role,display_name AS displayName,username FROM principals",
          )
          .all() as Array<{
          kind: string;
          tgId: string;
          role: string;
          displayName: string | null;
          username: string | null;
        }>
      ).map((entry) => [`${entry.kind}:${entry.tgId}`, entry]),
    );
    const counters = rows.map((row) => {
      // 私聊的 chat 桶回落到 `user:` 行：私聊已不占 `chat:` 行（docs/05 §2.2），只查 chat 的话
      // 每一条私聊用量的名字与角色都是空的。
      const principal =
        row.scope === "global"
          ? null
          : (principals.get(`${row.scope}:${row.subject}`) ??
            (row.scope === "chat" && !row.subject.startsWith("-")
              ? (principals.get(`user:${row.subject}`) ?? null)
              : null));
      const base =
        row.scope === "global"
          ? config.quota.global
          : row.scope === "chat"
            ? config.quota.perChat
            : config.quota.perUser;
      const override =
        row.scope === "user" && principal ? byRole[principal.role] : undefined;
      const limit =
        (row.scope === "user"
          ? override?.[row.window === "day" ? "daily" : "monthly"]
          : undefined) ?? base[row.window === "day" ? "daily" : "monthly"];
      // 群里的有效角色取用户与会话两档中较高者再封顶 trusted，可能高于用户自己这一档：
      // 这里只看得到用户那一档，配了 byRole 时实际套用的限额未必是这一行报的这个。
      return {
        ...row,
        current: buckets[row.window] === row.bucket,
        limit,
        limitApprox: row.scope === "user" && scopedRoles,
        role: principal?.role ?? null,
        label: principal?.displayName ?? null,
        username: principal?.username ?? null,
      };
    });
    // 缺少定价的模型按 0 记账：配额页的限额再准确，这些轮次也不会被计入。
    const unpriced = dependencies.db
      .prepare(
        "SELECT provider_id AS providerId,model_id AS modelId FROM models WHERE enabled=1 AND (price_in IS NULL OR price_out IS NULL) ORDER BY provider_id,model_id LIMIT 20",
      )
      .all() as Array<{ providerId: string; modelId: string }>;
    return ctx.json({
      ok: true,
      data: {
        quota: config.quota,
        timezone: config.general.timezone,
        buckets,
        counters,
        unpriced,
        unpricedTotal: Number(
          dependencies.db
            .prepare(
              "SELECT COUNT(*) FROM models WHERE enabled=1 AND (price_in IS NULL OR price_out IS NULL)",
            )
            .pluck()
            .get(),
        ),
        unimplemented: QUOTA_UNIMPLEMENTED,
      },
    });
  });
  // body 是相对 quota 的点分键（`global.daily`），与 PUT /api/sandbox 一致；校验与审计同 PUT /api/config。
  app.put("/api/quota", async (ctx) => {
    const body = await ctx.req
      .json<Record<string, unknown>>()
      .catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return ctx.json(
        apiError("invalid_body", "body 必须是点分键对象").body,
        400,
      );
    const dotted = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [`quota.${key}`, value]),
    );
    if (!Object.keys(dotted).length)
      return ctx.json({ ok: true, data: { keys: [] } });
    const merged = mergeDotted(currentConfig(), dotted);
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success)
      return ctx.json(
        invalidConfig("配额配置校验失败", parsed.error.issues).body,
        400,
      );
    writeConfigRows(Object.entries(dotted), "webui");
    dependencies.events.emit("config.changed", { keys: Object.keys(dotted) });
    return ctx.json({ ok: true, data: { keys: Object.keys(dotted) } });
  });
  // 不带 body 仍是全部清零（既有行为）；带 scope/subject/window/bucket 时只删那一行：
  // 某个人用满当日额度，没有理由把全局与其他所有人的当月计数一并清空。
  app.post("/api/quota/reset", async (ctx) => {
    const body = await ctx.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const filters: Array<[string, string]> = [];
    for (const field of ["scope", "subject", "window", "bucket"] as const) {
      const value = body[field];
      if (typeof value === "string" && value) filters.push([field, value]);
    }
    if (filters.length && !filters.some(([field]) => field === "scope"))
      return ctx.json(
        apiError("invalid_filter", "按条件重置时必须给出 scope").body,
        400,
      );
    const where = filters.length
      ? ` WHERE ${filters.map(([field]) => `${field}=?`).join(" AND ")}`
      : "";
    const changes = dependencies.db
      .prepare(`DELETE FROM quota_counters${where}`)
      .run(...filters.map(([, value]) => value)).changes;
    dependencies.log.event({
      level: "info",
      kind: "webui.action",
      summary: "quota counters reset",
      data: { filters: Object.fromEntries(filters), changes },
    });
    return ctx.json({ ok: true, data: { changes } });
  });
  /**
   * `spawn_worker` 派发出去的 worker 任务（docs/09 §3.12）。
   *
   * 列表不返回 `progress_json`：`AgentManager.progress` 每一帧都覆盖同一列，一行可达数 KB，
   * 而列表上只显示标题与状态，理由同 `GET /api/logs` 不返回 `data_json`。查看进度走详情。
   * `chatLabel`/`userLabel` 在服务端补齐：裸 id 无法辨认是哪个群（docs/09 §3.11 明确显示名在服务端
   * 反查，前端不实现第二份规则）。排序把 running 置于第一页：正在运行的那几条才是关注对象。
   */
  app.get("/api/tasks", (ctx) => {
    const {
      page: pageNumber,
      size,
      offset,
    } = pageParams(ctx, { defaultSize: 50, maxSize: 200 });
    const total = Number(
      dependencies.db.prepare("SELECT COUNT(*) FROM tasks").pluck().get(),
    );
    const rows = dependencies.db
      .prepare(
        `SELECT id,turn_id,agent_run_id,chat_id,user_id,title,state,placeholder_tg_message_id,result_summary,created_at,updated_at,finished_at
      FROM tasks ORDER BY (state='running') DESC,updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(size, offset) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      ...row,
      chatLabel: principalLabel(
        dependencies.db,
        "chat",
        row.chat_id as string | null,
      ),
      userLabel: principalLabel(
        dependencies.db,
        "user",
        row.user_id as string | null,
      ),
    }));
    return ctx.json({
      ok: true,
      data: { items, total, page: pageNumber, size },
    });
  });
  /**
   * 单条任务的只读详情。`progress_json` 与 `result_summary` 运行时一直在写，但界面上从未展示
   * （docs/21 §8）。两条 join 提供排障所需的另一半：任务本身只记标题与状态，执行了几步、花费多少、
   * 失败原因在 `turns` 上，属于哪个 agent、哪个别名在 `agent_runs` 上。
   *
   * `progress` 是解析后的那一份，不再同时发送原始 JSON 串（同一份数据发两遍，而前端只读其中
   * 一份）。解析失败时返回 null 而不是原样回传字符串：那一列只由 `AgentManager` 写入，解析失败
   * 意味着库被外部改动过，界面照原样渲染只会增加排查难度。
   */
  app.get("/api/tasks/:id", (ctx) => {
    const row = dependencies.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(ctx.req.param("id")) as
      (Record<string, unknown> & { progress_json: string | null }) | undefined;
    if (!row)
      return ctx.json(
        apiError("not_found", "任务不存在（可能已被删除）", 404).body,
        404,
      );
    const { progress_json: raw, ...rest } = row;
    let progress: unknown = null;
    if (raw) {
      try {
        progress = JSON.parse(raw);
      } catch {
        progress = null;
      }
    }
    const turn =
      dependencies.db
        .prepare(
          "SELECT state,steps,tool_calls AS toolCalls,cost_usd AS costUsd,error FROM turns WHERE id=?",
        )
        .get(row.turn_id as string) ?? null;
    const agentRun = row.agent_run_id
      ? (dependencies.db
          .prepare(
            "SELECT worker_kind AS workerKind,agent_name AS agentName,model_alias AS modelAlias,state,result_summary AS resultSummary FROM agent_runs WHERE id=?",
          )
          .get(row.agent_run_id as string) ?? null)
      : null;
    return ctx.json({
      ok: true,
      data: {
        ...rest,
        progress,
        chatLabel: principalLabel(
          dependencies.db,
          "chat",
          row.chat_id as string | null,
        ),
        userLabel: principalLabel(
          dependencies.db,
          "user",
          row.user_id as string | null,
        ),
        turn,
        agentRun,
      },
    });
  });
  /**
   * 删除的是记录，而不是取消通道：这里没有 `POST /api/tasks/:id/cancel`（docs/09 §4），取消一条
   * 正在运行的子 agent 要走 `POST /api/turns/:id/cancel`。因此 `running` 一律返回 409：删除行不会
   * 让那个 agent 停下来，只会让它变成一条不可见的在途任务。404 的口径同
   * `DELETE /api/custom-tools/:name`：未删除任何内容时不返回 200，否则界面会对一个错误 id 提示已删除。
   */
  app.delete("/api/tasks/:id", (ctx) => {
    const id = ctx.req.param("id");
    const row = dependencies.db
      .prepare("SELECT state FROM tasks WHERE id=?")
      .get(id) as { state: string } | undefined;
    if (!row)
      return ctx.json(apiError("not_found", "任务不存在", 404).body, 404);
    if (row.state === "running")
      return ctx.json(
        apiError(
          "task_running",
          "任务仍在执行：删除记录不会终止它，请在对应轮次上取消",
          409,
        ).body,
        409,
      );
    const removed =
      dependencies.db.prepare("DELETE FROM tasks WHERE id=?").run(id)
        .changes === 1;
    return ctx.json({ ok: true, data: { removed } });
  });
  app.post("/api/maintenance/:action", (ctx) => {
    const action = ctx.req.param("action");
    const result =
      action === "backup"
        ? dependencies.maintenance.backup()
        : action === "vacuum"
          ? (dependencies.maintenance.vacuum(), "ok")
          : action === "cleanup-logs"
            ? dependencies.maintenance.cleanup()
            : action === "gc-files"
              ? dependencies.maintenance.gcFiles()
              : action === "rebuild-fts"
                ? (dependencies.maintenance.rebuildFts(), "ok")
                : null;
    return result === null
      ? ctx.json(apiError("unknown_action", "未知维护操作", 404).body, 404)
      : ctx.json({ ok: true, data: result });
  });
  /**
   * `[重启进程]`（docs/09 §3.13）。先返回响应再退出：在同一个 tick 内 `process.exit` 会让
   * 这次请求收不到响应，界面上表现为点击无反应。走 `dependencies.restart` 而不是
   * 直接 `process.exit`：优雅关闭那一套（排空轮次、刷日志、WAL checkpoint）在 `main.ts` 里，
   * 服务器包不应也不能重复实现。
   *
   * 没有 supervisor 时进程不会自行恢复，界面上的二次确认必须写明这一点。
   */
  app.post("/api/restart", (ctx) => {
    if (!dependencies.restart)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配重启入口", 500).body,
        500,
      );
    setTimeout(() => {
      void dependencies.restart?.("webui");
    }, 100).unref?.();
    return ctx.json({
      ok: true,
      data: {
        restarting: true,
        note: "无 systemd / docker 等 supervisor 时进程不会自动重启",
      },
    });
  });
  app.get("/api/events", (ctx) => {
    let cleanup = (): void => undefined;
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let unsubscribe = (): void => undefined;
        let unregister = (): void => undefined;
        controller.enqueue(encoder.encode(": connected\n\n"));
        // channel:true —— 这根管子对面坐着能点「批准」的人，审批据此判断有没有裁决通道（docs/24 · R-APPR-01）。
        unsubscribe = dependencies.events.subscribe(
          (event) => {
            if (!closed)
              controller.enqueue(
                encoder.encode(
                  `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
                ),
              );
          },
          { channel: true },
        );
        const heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": ping\n\n"));
        }, 20_000);
        heartbeat.unref?.();
        const close = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          unregister();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        unregister =
          dependencies.eventStreams?.add({ close }) ?? (() => undefined);
        cleanup = close;
        ctx.req.raw.signal.addEventListener("abort", close, { once: true });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });
  /**
   * I-13 的另一半。那一轮修的是未匹配的 `/api/*` 返回 200 与 index.html，前端在
   * `response.json()` 处抛 SyntaxError，报错与真实原因无关；下面那行 `app.all` 即是它。
   * 但端点内抛出的异常走的是 Hono 的默认处理器，实测返回的是
   * `text/plain "Internal Server Error"`，同一问题在 500 上原样复现：界面上看到的是
   * `Unexpected token 'I'`，而不是可读的错误信息。这个部署里最常见的触发方式是非法请求体：
   * 39 处 `ctx.req.json()` 里有 17 处没有自己的 `.catch()`。
   *
   * 三个分支，顺序有意义：
   * - `HTTPException`（`bodyLimit` 这类中间件抛出的）原样返回，与 Hono 默认处理器一致：
   *   它们本身已带好状态码与响应体。
   * - `SyntaxError` 对应 `ctx.req.json()` 里那次 `JSON.parse` 失败。这一条把那 17 处一次性收口，
   *   也不会在下一个新端点上重新遗漏：逐个添加 `.catch()` 只修当下，这里修的是这一类。
   * - 其余一律 500，异常消息不进响应：它可能包含库路径、SQL、密钥片段。全文只落
   *   `webui.error` 那一行，返回给前端的只有它的 id（`ref:`，与 `bot.ts` 给用户的形状一致）。
   *
   * 非 `/api/` 路径返回纯文本：给静态资源套 JSON 信封只会让浏览器收到无法解析的内容。
   */
  app.onError((error, ctx) => {
    if (typeof error === "object" && error !== null && "getResponse" in error)
      return (error as { getResponse: () => Response }).getResponse();
    if (!ctx.req.path.startsWith("/api/"))
      return ctx.text("Internal Server Error", 500);
    if (error instanceof SyntaxError)
      return ctx.json(
        apiError("invalid_json", "请求体不是合法 JSON", 400).body,
        400,
      );
    const id = dependencies.log.event({
      level: "error",
      kind: "webui.error",
      summary: `${ctx.req.method} ${ctx.req.path} 未处理异常`,
      data: {
        method: ctx.req.method,
        path: ctx.req.path,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      },
    });
    return ctx.json(
      apiError("internal", `服务端出错，已记录（ref: ${id}）`, 500).body,
      500,
    );
  });
  const webRoot = fileURLToPath(new URL("../../webui/dist", import.meta.url));
  // 未匹配的 /api/* 必须在静态兜底之前拦下：否则它们会拿到 200 与 index.html，前端的 `api()`
  // 在 `response.json()` 处抛 SyntaxError，报错信息与真实原因（路径写错）无关（docs/22 · I-13）。
  app.all("/api/*", (ctx) =>
    ctx.json(
      apiError(
        "not_found",
        `端点不存在：${ctx.req.method} ${new URL(ctx.req.url).pathname}`,
        404,
      ).body,
      404,
    ),
  );
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", (ctx) =>
    existsSync(resolve(webRoot, "index.html"))
      ? ctx.html(readFileSync(resolve(webRoot, "index.html"), "utf8"))
      : ctx.text("LuoLiCore WebUI 尚未构建", 503),
  );
  return app;
}

/**
 * 一次性登录 token 的内存表。导出的是签发函数而不是这张表：允许装配方直接写入，
 * 等于多出一个可以凭空创建 owner session 的入口。
 */
const loginTokens = new Map<string, { expiresAt: number }>();

/** 由 Telegram 的 `/webui` 命令调用（owner 私聊）。返回明文 token，调用方负责只发给 owner 本人。 */
export function issueLoginToken(ttlMs = 5 * 60_000): {
  token: string;
  expiresAt: number;
} {
  const now = Date.now();
  for (const [value, entry] of loginTokens)
    if (entry.expiresAt <= now) loginTokens.delete(value);
  // 有界：`/webui` 被连续调用时不应让这张表无限增长，最多保留 16 个未使用的。
  while (loginTokens.size >= 16)
    loginTokens.delete(loginTokens.keys().next().value!);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + ttlMs;
  loginTokens.set(token, { expiresAt });
  return { token, expiresAt };
}

export function setupToken(): { token: string; expiresAt: number } {
  return {
    token: randomBytes(24).toString("base64url"),
    expiresAt: Date.now() + 15 * 60_000,
  };
}
