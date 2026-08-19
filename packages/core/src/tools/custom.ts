import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { roleRank, type Role } from '@luoli/shared';
import type { CustomTool, CustomToolRepository, CustomToolRuntime, NewCustomTool } from '@luoli/db';
import { jsonSchemaToZod } from '../mcp/schema.js';
import type { Config } from '../config/schema.js';
import type { LogSink } from '../log/sink.js';
import type { Sandbox } from '../sandbox/index.js';
import { TOOL_POLICY } from './policy.js';
import type { ToolExecutionContext, ToolRegistry } from './registry.js';

/** 脚本与参数文件的落点，与 `python` 内建共用同一个目录。 */
const TMP_DIR = '.luoli-tmp';
const NAME_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
/** 注册名的命名空间。docs/05 §3.9 已经占了 `skill_` / `<plugin>_` / `mcp__`。 */
export const CUSTOM_TOOL_PREFIX = 'custom_';
const MAX_DESCRIPTION_CHARS = 200;
const MAX_PARAM_PROPERTIES = 12;
const MAX_PARAM_DEPTH = 4;
/** 环境变量总量上界：`E2BIG` 是真实的失败模式，而它的表现是「脚本根本没跑起来」。 */
const MAX_ENV_BYTES = 32_768;

export interface CustomToolDefineInput {
  name: string; description: string; runtime: CustomToolRuntime; body: string;
  params?: unknown | undefined; minRole?: 'trusted' | 'owner' | undefined; timeoutMs?: number | undefined;
}

type CustomToolConfig = Config['tools']['selfExtend'];

/**
 * 参数的嵌套层数。**只数 `properties` / `items` 这两跳**，不数 JSON Schema 自己的关键字层级 ——
 * 后者会把一份平铺的 `{type:'object',properties:{x:{...}}}` 数成 2 层，于是 `MAX_PARAM_DEPTH: 4`
 * 实际只允许一层嵌套，而报错信息还告诉模型「最多 4 层」。它照着那句话重试，再被拒一次。
 */
function paramDepth(node: unknown, depth = 1): number {
  if (!node || typeof node !== 'object') return depth;
  const schema = node as Record<string, unknown>;
  let deepest = depth;
  const children = [
    ...(schema.properties && typeof schema.properties === 'object' ? Object.values(schema.properties as Record<string, unknown>) : []),
    ...(schema.items ? [schema.items] : []),
  ];
  for (const child of children) deepest = Math.max(deepest, paramDepth(child, depth + 1));
  return deepest;
}

/** 描述会进每一轮的 TOOL CATALOG，所以压成单行并截断 —— 控制字符还能伪造目录里的分隔。 */
function normalizeDescription(value: string): string {
  return value.replaceAll(/[\u0000-\u001F\u007F]+/g, ' ').replaceAll(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * 模型自撰写工具的注册与执行。形状照 `McpManager`：真相在 SQLite，进程内这份只是缓存，
 * 每次 `reconcile()` 都能从库里重建（docs/01 §3.1 单实例纪律）。
 *
 * **授权时点与执行时点是分离的**（docs/14 T18）—— 模型调 `bash` 时命令正文在转录里、在人眼前；
 * 调 `custom_backup` 时提示词里只有 `{"target":"/etc"}`，正文是若干轮之前写下的。这个类里的
 * 每一道闸都是这句话的推论。
 */
export class CustomToolManager {
  #fingerprint = '';
  #registry?: ToolRegistry;

  constructor(private readonly repo: CustomToolRepository, private readonly config: () => Readonly<CustomToolConfig>,
    private readonly sandbox: Sandbox, private readonly log: LogSink, private readonly execMaxTimeoutMs: () => number) {}

  bindRegistry(registry: ToolRegistry): void { this.#registry = registry; }

  registeredName(name: string): string { return `${CUSTOM_TOOL_PREFIX}${name}` }

  enabled(): boolean {
    const config = this.config();
    return config.enabled && config.customTools.enabled;
  }

  /**
   * 每轮开始时调一次。指纹没变就什么都不做 —— 重扫本身不贵，但重扫会换掉注册表里那批对象，
   * 而本轮的 `toolSet` 已经在 `runMainAgentInternal` 里冻结了。
   */
  syncIfChanged(): void {
    const fingerprint = `${this.enabled() ? '1' : '0'}:${this.repo.fingerprint()}`;
    if (fingerprint === this.#fingerprint) return;
    this.reconcile();
  }

  reconcile(): void {
    this.#registry?.unregisterBySource('custom');
    if (!this.enabled() || !this.#registry) { this.#stamp(); return; }
    for (const tool of this.repo.listEnabled()) {
      // 每行各自 try：一份畸形的 params 不能把其余工具一起带走，更不能从这里抛到启动路径上
      // （docs/27 · C-04 是同一个教训的 MCP 版本）。
      try {
        this.#register(tool);
        if (tool.lastError) this.repo.markError(tool.name, null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.repo.markError(tool.name, message);
        this.log.event({ level: 'warn', kind: 'tool.custom_invalid', summary: `${tool.name} 注册失败：${message}`, data: { tool: tool.name } });
      }
    }
    this.#stamp();
  }

  /**
   * 指纹**必须在注册循环之后取**：循环里的 `markError`（写 `last_error`，成功时清空）会推高
   * `updated_at`。在循环之前记的话，记下的永远是一个已经过时的值 —— 于是每一轮的
   * `syncIfChanged()` 都判成「变了」，把全部自定义工具重新注册一遍、再写一次 `markError`，
   * 一个注册失败的工具就能让这件事每轮发生一次，永远收敛不了。
   */
  #stamp(): void {
    this.#fingerprint = `${this.enabled() ? '1' : '0'}:${this.repo.fingerprint()}`;
  }

  #register(tool: CustomTool): void {
    const inputSchema = jsonSchemaToZod(JSON.parse(tool.paramsJson)) as z.ZodType<unknown>;
    const name = this.registeredName(tool.name);
    const ok = this.#registry!.registerExternal({
      name, description: tool.description, inputSchema, minRole: tool.minRole, scope: tool.scope === 'chat' ? 'chat' : 'global',
      // `always` 而不是 `conditional`：默认的 `approval.rules` 是空数组，conditional 在那种配置下
      // 等于 never（`main.ts` 启动时就为此打了一行警告）。
      approval: 'always', source: 'custom',
      // 自己管超时：`Sandbox.run` 按 `tools.exec.maxTimeoutMs` kill，外面再套一层 race 只会在脚本
      // 正常跑完之前把调用砍掉，而进程还在后台跑着。
      timeoutMs: null,
      available: (role, context) => this.#available(tool, role, context),
      execute: (input, context) => this.#execute(tool, input, context),
    });
    if (!ok) throw new Error('name_taken_by_other_source');
  }

  /**
   * 三道闸，运维的 `tools.overrides` 一道都绕不过（它只动 `effectivePolicy()` 的角色与审批档，
   * 碰不到 `available()`，docs/09 §3.7）：
   *
   * 1. **角色地板**：不得低于 `bash`。一个自定义工具就是一段 shell，把它开给 `limited`
   *    等于绕过 `TOOL_POLICY.bash.minRole`。
   * 2. **沙箱可用性**：与 `bash` / `python` 同一个判据；`requireSandbox` 再往上加一档，
   *    连 owner 的宿主直跑也不给（默认关，见 docs/14 T19）。
   * 3. **会话作用域**：`scope='chat'` 的工具只在它被写下的那个会话里可见 —— owner 私聊里写的
   *    脚本不该自动变成任意群里 trusted 成员的可调用项。
   */
  #available(tool: CustomTool, role: Role, context: ToolExecutionContext): boolean {
    if (!this.enabled()) return false;
    if (roleRank(role) < roleRank(TOOL_POLICY.bash.minRole)) return false;
    const plan = this.sandbox.plan(role, context.workspace);
    if (!plan.allowed) return false;
    if (this.config().customTools.requireSandbox && plan.mode === 'host') return false;
    return tool.scope !== 'chat' || tool.ownerChatId === context.turn.chatId;
  }

  /**
   * 参数**绝不拼进命令串**：正文与参数各落一个文件，命令串里只剩两个 uuid（字符集 `[0-9a-f-]`）。
   * 相对路径在宿主（`cwd=workspace`）与容器（`-w /workspace`）下指的是同一个文件。
   *
   * 顶层标量参数额外给一份 `LUOLI_ARG_*` 环境变量，走 `spawn` options / `docker -e` —— 两条路
   * 都不经过 shell 解析。前缀白名单是那道闸：没有它，一个叫 `path` 的参数就变成了 `PATH`。
   */
  async #execute(tool: CustomTool, input: unknown, context: ToolExecutionContext): Promise<object> {
    // 注册发生在开轮，执行发生在若干步之后 —— 这中间它可能被改掉、被停用、被删掉。**三种要分开报**：
    // 都说成「定义变了」的话，模型会去 `list_tools` 看见定义原封不动，然后原样重试。
    const row = this.repo.get(tool.name);
    if (!row) return { ok: false, error: 'custom_tool_removed', hint: `${tool.name} 在本轮中途被删掉了，这一次不执行。` };
    if (row.enabled !== 1) return { ok: false, error: 'custom_tool_disabled', hint: `${tool.name} 在本轮中途被运维停用了，这一次不执行；换个办法或如实告诉用户。` };
    if (row.definitionHash !== tool.definitionHash) return { ok: false, error: 'custom_tool_redefined', hint: `${tool.name} 的定义在本轮中途变了，这一次不执行；重新看一下它现在是什么样。` };
    const directory = join(context.workspace, TMP_DIR);
    const id = randomUUID();
    const scriptName = `${id}.${tool.runtime === 'python' ? 'py' : 'sh'}`;
    const paramsName = `${id}.json`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, scriptName), tool.body, { mode: 0o600 });
    writeFileSync(join(directory, paramsName), JSON.stringify(input ?? {}), { mode: 0o600 });
    const scriptPath = `${TMP_DIR}/${scriptName}`;
    const paramsPath = `${TMP_DIR}/${paramsName}`;
    const runner = tool.runtime === 'python' ? 'python3' : 'sh';
    const command = `${runner} ${JSON.stringify(scriptPath)} ${JSON.stringify(paramsPath)}`;
    const timeout = Math.min(tool.timeoutMs ?? this.config().customTools.timeoutMs, this.execMaxTimeoutMs());
    try {
      const result = await this.sandbox.run(command, context.turn.effectiveRole, context.workspace, context.turn.abortSignal, timeout, context.turn.turnId,
        { extraEnv: { LUOLI_PARAMS: paramsPath, ...environmentFor(input) }, chatId: context.turn.chatId });
      return { ...result, tool: tool.name };
    } finally {
      for (const file of [scriptName, paramsName]) try { rmSync(join(directory, file)); } catch { /* 沙箱里删掉了、或整个 workspace 被清了 */ }
    }
  }

  /** 定义期校验。返回错误码而不是抛：调用方要把它原样交回模型，让它自己改了再来。 */
  validate(input: CustomToolDefineInput): { ok: false; error: string; hint: string } | { ok: true; value: Omit<NewCustomTool, 'createdBy' | 'createdTurn' | 'ownerChatId' | 'scope'> } {
    const config = this.config().customTools;
    const name = input.name.startsWith(CUSTOM_TOOL_PREFIX) ? input.name.slice(CUSTOM_TOOL_PREFIX.length) : input.name;
    if (!NAME_PATTERN.test(name)) return { ok: false, error: 'invalid_tool_name', hint: '名字只能是小写字母开头的 2–41 位 [a-z0-9_]，注册时会自动加 custom_ 前缀。' };
    const description = normalizeDescription(input.description);
    if (!description) return { ok: false, error: 'invalid_description', hint: '描述不能为空 —— 模型下一轮只能靠它决定要不要调这个工具。' };
    const body = input.body.trim();
    if (!body) return { ok: false, error: 'empty_body', hint: '脚本正文不能为空。' };
    if (body.length > config.maxBodyChars) return { ok: false, error: 'body_too_long', hint: `正文上限 ${config.maxBodyChars} 字符，现在 ${body.length}。` };
    const params = input.params ?? { type: 'object', properties: {} };
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params', hint: 'params 必须是一份 object 型 JSON Schema。' };
    const node = params as Record<string, unknown>;
    if (node.type !== 'object') return { ok: false, error: 'invalid_params', hint: 'params 的顶层 type 必须是 "object"。' };
    const properties = node.properties && typeof node.properties === 'object' ? node.properties as Record<string, unknown> : {};
    if (Object.keys(properties).length > MAX_PARAM_PROPERTIES) return { ok: false, error: 'too_many_params', hint: `顶层参数最多 ${MAX_PARAM_PROPERTIES} 个。` };
    if (paramDepth(params) > MAX_PARAM_DEPTH) return { ok: false, error: 'params_too_deep', hint: `参数 schema 最多 ${MAX_PARAM_DEPTH} 层（顶层对象算 1 层，它下面的每个对象 / 数组元素各算一层）。` };
    try { jsonSchemaToZod(params); } catch (error) { return { ok: false, error: 'invalid_params', hint: error instanceof Error ? error.message : 'params 转换失败' }; }
    const registeredName = this.registeredName(name);
    // 与既有工具重名要在定义期就说清楚：`registerExternal` 那边只会 warn 一行然后返回 false，
    // 而模型看到的会是「定义成功了但工具从来没出现过」。
    const conflict = this.#registry?.describe().find((entry) => entry.name === registeredName && entry.defaults.source !== 'custom');
    if (conflict) return { ok: false, error: 'name_taken', hint: `${registeredName} 已被 ${conflict.defaults.source} 占用，换个名字。` };
    if (!this.repo.get(name) && this.repo.count() >= config.maxTools) {
      return { ok: false, error: 'custom_tool_limit', hint: `自定义工具上限 ${config.maxTools} 个，先用 delete_tool 删一个再来。` };
    }
    const minRole = input.minRole ?? config.defaultMinRole;
    const timeoutMs = input.timeoutMs === undefined ? null : Math.min(input.timeoutMs, this.execMaxTimeoutMs());
    return { ok: true, value: { name, description, paramsJson: JSON.stringify(params), runtime: input.runtime, body, minRole, timeoutMs } };
  }

  /**
   * 定义（或改写）一个工具。**落库即禁用**，除非运维显式打开 `autoEnable` —— 网页 / 群聊注入
   * → `define_tool` → owner 因 `skipForOwner` 无感放行 → 立刻成为持久能力，这条链里本来没有人。
   */
  define(input: CustomToolDefineInput, context: ToolExecutionContext): object {
    const checked = this.validate(input);
    if (!checked.ok) return checked;
    const { tool, created, reset } = this.repo.upsert({ ...checked.value, scope: 'chat', ownerChatId: context.turn.chatId,
      createdBy: context.turn.initiatorUserId, createdTurn: context.turn.turnId });
    if (this.config().customTools.autoEnable) this.repo.setEnabled(tool.name, true);
    this.reconcile();
    const live = this.repo.get(tool.name)!;
    this.log.event({ level: 'info', kind: 'tool.custom_defined', summary: `${created ? '新建' : '改写'}自定义工具 ${tool.name}`, traceId: context.turn.turnId,
      chatId: context.turn.chatId, data: { tool: tool.name, runtime: tool.runtime, enabled: live.enabled === 1, reset } });
    return { ok: true, name: this.registeredName(tool.name), created, enabled: live.enabled === 1,
      hint: live.enabled === 1
        ? '已启用，下一轮就能调用。'
        : `${reset ? '正文变了，已打回未启用。' : '已保存，但还没启用。'}owner 要在 WebUI 的扩展页看过正文再点启用，之后下一轮才会出现在工具目录里。` };
  }

  remove(name: string, context: ToolExecutionContext): object {
    const plain = name.startsWith(CUSTOM_TOOL_PREFIX) ? name.slice(CUSTOM_TOOL_PREFIX.length) : name;
    const removed = this.repo.remove(plain);
    if (!removed) return { ok: false, error: 'not_found', hint: `没有叫 ${plain} 的自定义工具，先用 list_tools 看看。` };
    this.reconcile();
    this.log.event({ level: 'info', kind: 'tool.custom_removed', summary: `删除自定义工具 ${plain}`, traceId: context.turn.turnId, chatId: context.turn.chatId, data: { tool: plain } });
    return { ok: true, removed: plain };
  }

  /** 列表交回给模型：带上 `enabled` 与作用域，否则它看不出「定义了却调不到」是为什么。 */
  list(context: ToolExecutionContext): object {
    return { ok: true, tools: this.repo.list().map((tool) => ({
      name: this.registeredName(tool.name), description: tool.description, runtime: tool.runtime, minRole: tool.minRole,
      enabled: tool.enabled === 1, scope: tool.scope, thisChat: tool.scope !== 'chat' || tool.ownerChatId === context.turn.chatId,
      reviewed: tool.reviewedAt !== null, lastError: tool.lastError })) };
  }
}

/**
 * 顶层标量参数 → `LUOLI_ARG_*`。非标量只留在 JSON 文件里：把一个数组塞进环境变量就得选一种
 * 分隔符，而任何分隔符都会在某个值里出现。
 */
export function environmentFor(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const name = `LUOLI_ARG_${key.toUpperCase()}`;
    // 大小写只差一个字母的两个参数（`path` / `Path`）会撞成同一个变量名。先到先得而不是后来者
    // 覆盖：至少「脚本读到的是哪一个」是确定的，而两个值都还在参数 JSON 文件里。
    if (name in out) continue;
    const serialized = String(value);
    // NUL 在 `spawn` 的 env 里会抛 ERR_INVALID_ARG_VALUE，整个调用直接失败而不是少一个变量。
    if (serialized.includes('\0')) continue;
    // 按**字节**算：`E2BIG` 数的是字节，而 `.length` 数的是 UTF-16 码元 —— 一份中文参数会被
    // 少算三倍左右，预算就不再是预算了。
    bytes += Buffer.byteLength(name) + Buffer.byteLength(serialized) + 2;
    if (bytes > MAX_ENV_BYTES) break;
    out[name] = serialized;
  }
  return out;
}
