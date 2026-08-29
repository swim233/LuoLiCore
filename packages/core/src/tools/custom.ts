import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { roleRank, type Role } from "@luoli/shared";
import type {
  CustomTool,
  CustomToolRepository,
  CustomToolRuntime,
  NewCustomTool,
} from "@luoli/db";
import { jsonSchemaToZod } from "../mcp/schema.js";
import type { Config } from "../config/schema.js";
import type { LogSink } from "../log/sink.js";
import type { Sandbox } from "../sandbox/index.js";
import { TOOL_POLICY } from "./policy.js";
import type { ToolExecutionContext, ToolRegistry } from "./registry.js";

/** 脚本与参数文件的落点，与 `python` 内建共用同一目录。 */
const TMP_DIR = ".luoli-tmp";
const NAME_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
/** 注册名的命名空间。docs/05 §3.9 已占用 `skill_` / `<plugin>_` / `mcp__`。 */
export const CUSTOM_TOOL_PREFIX = "custom_";
const MAX_DESCRIPTION_CHARS = 200;
const MAX_PARAM_PROPERTIES = 12;
const MAX_PARAM_DEPTH = 4;
/** 环境变量总量上界：`E2BIG` 是真实的失败模式，表现为脚本未能启动。 */
const MAX_ENV_BYTES = 32_768;

export interface CustomToolDefineInput {
  name: string;
  description: string;
  runtime: CustomToolRuntime;
  body: string;
  params?: unknown | undefined;
  minRole?: "trusted" | "owner" | undefined;
  timeoutMs?: number | undefined;
}

type CustomToolConfig = Config["tools"]["selfExtend"];

/**
 * 参数的嵌套层数。只统计 `properties` / `items` 两跳，不统计 JSON Schema 自身的关键字层级 ——
 * 后者会把平铺的 `{type:'object',properties:{x:{...}}}` 计为 2 层，使 `MAX_PARAM_DEPTH: 4`
 * 实际只允许一层嵌套，而错误信息仍告知模型上限为 4 层，模型据此重试并再次被拒。
 */
function paramDepth(node: unknown, depth = 1): number {
  if (!node || typeof node !== "object") return depth;
  const schema = node as Record<string, unknown>;
  let deepest = depth;
  const children = [
    ...(schema.properties && typeof schema.properties === "object"
      ? Object.values(schema.properties as Record<string, unknown>)
      : []),
    ...(schema.items ? [schema.items] : []),
  ];
  for (const child of children)
    deepest = Math.max(deepest, paramDepth(child, depth + 1));
  return deepest;
}

/** 描述会进入每一轮的 TOOL CATALOG，因此压为单行并截断 —— 控制字符还可伪造目录中的分隔。 */
function normalizeDescription(value: string): string {
  return value
    .replaceAll(/[\u0000-\u001F\u007F]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * 模型自撰写工具的注册与执行。结构参照 `McpManager`：真相存于 SQLite，进程内的副本仅为缓存，
 * 每次 `reconcile()` 均可从库中重建（docs/01 §3.1 单实例纪律）。
 *
 * 授权时点与执行时点是分离的（docs/14 T18）—— 模型调用 `bash` 时命令正文在转录中可见；
 * 调用 `custom_backup` 时提示词里只有 `{"target":"/etc"}`，正文写于若干轮之前。本类中的
 * 每一道闸都由此推导而来。
 */
export class CustomToolManager {
  #fingerprint = "";
  #registry?: ToolRegistry;

  constructor(
    private readonly repo: CustomToolRepository,
    private readonly config: () => Readonly<CustomToolConfig>,
    private readonly sandbox: Sandbox,
    private readonly log: LogSink,
    private readonly execMaxTimeoutMs: () => number,
  ) {}

  bindRegistry(registry: ToolRegistry): void {
    this.#registry = registry;
  }

  registeredName(name: string): string {
    return `${CUSTOM_TOOL_PREFIX}${name}`;
  }

  enabled(): boolean {
    const config = this.config();
    return config.enabled && config.customTools.enabled;
  }

  /**
   * 每轮开始时调用一次。指纹未变则不做任何事 —— 重扫本身开销不大，但会替换注册表中的对象，
   * 而本轮的 `toolSet` 已在 `runMainAgentInternal` 中冻结。
   */
  syncIfChanged(): void {
    const fingerprint = `${this.enabled() ? "1" : "0"}:${this.repo.fingerprint()}`;
    if (fingerprint === this.#fingerprint) return;
    this.reconcile();
  }

  reconcile(): void {
    this.#registry?.unregisterBySource("custom");
    if (!this.enabled() || !this.#registry) {
      this.#stamp();
      return;
    }
    for (const tool of this.repo.listEnabled()) {
      // 每行独立 try：一份畸形的 params 不应影响其余工具，更不应从此处抛到启动路径
      // （docs/27 · C-04 是同一问题的 MCP 版本）。
      try {
        this.#register(tool);
        if (tool.lastError) this.repo.markError(tool.name, null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.repo.markError(tool.name, message);
        this.log.event({
          level: "warn",
          kind: "tool.custom_invalid",
          summary: `${tool.name} 注册失败：${message}`,
          data: { tool: tool.name },
        });
      }
    }
    this.#stamp();
  }

  /**
   * 指纹必须在注册循环之后取：循环中的 `markError`（写 `last_error`，成功时清空）会推高
   * `updated_at`。若在循环之前记录，记下的始终是过时的值 —— 每一轮的
   * `syncIfChanged()` 都会判为已变更，重新注册全部自定义工具并再次写入 `markError`，
   * 一个注册失败的工具即可使该过程每轮重复且无法收敛。
   */
  #stamp(): void {
    this.#fingerprint = `${this.enabled() ? "1" : "0"}:${this.repo.fingerprint()}`;
  }

  #register(tool: CustomTool): void {
    const inputSchema = jsonSchemaToZod(
      JSON.parse(tool.paramsJson),
    ) as z.ZodType<unknown>;
    const name = this.registeredName(tool.name);
    const ok = this.#registry!.registerExternal({
      name,
      description: tool.description,
      inputSchema,
      minRole: tool.minRole,
      scope: tool.scope === "chat" ? "chat" : "global",
      // 取 `always` 而非 `conditional`：默认的 `approval.rules` 为空数组，conditional 在该配置下
      // 等同于 never（`main.ts` 启动时已为此输出一行警告）。
      approval: "always",
      source: "custom",
      // 自行管理超时：`Sandbox.run` 按 `tools.exec.maxTimeoutMs` 终止进程，外层再套一层 race 只会在
      // 脚本正常结束前中断调用，而进程仍在后台运行。
      timeoutMs: null,
      available: (role, context) => this.#available(tool, role, context),
      execute: (input, context) => this.#execute(tool, input, context),
    });
    if (!ok) throw new Error("name_taken_by_other_source");
  }

  /**
   * 三道闸，运维的 `tools.overrides` 无法绕过任何一道（它只影响 `effectivePolicy()` 的角色与审批档，
   * 不涉及 `available()`，docs/09 §3.7）：
   *
   * 1. 角色下限：不得低于 `bash`。自定义工具本质是一段 shell，开放给 `limited`
   *    等于绕过 `TOOL_POLICY.bash.minRole`。
   * 2. 沙箱可用性：与 `bash` / `python` 同一判据；`requireSandbox` 再收紧一档，
   *    连 owner 的宿主直跑也不允许（默认关闭，见 docs/14 T19）。
   * 3. 会话作用域：`scope='chat'` 的工具仅在其定义所在会话中可见 —— owner 私聊中编写的
   *    脚本不应自动成为任意群组中 trusted 成员的可调用项。
   */
  #available(
    tool: CustomTool,
    role: Role,
    context: ToolExecutionContext,
  ): boolean {
    if (!this.enabled()) return false;
    if (roleRank(role) < roleRank(TOOL_POLICY.bash.minRole)) return false;
    const plan = this.sandbox.plan(role, context.workspace);
    if (!plan.allowed) return false;
    if (this.config().customTools.requireSandbox && plan.mode === "host")
      return false;
    return tool.scope !== "chat" || tool.ownerChatId === context.turn.chatId;
  }

  /**
   * 参数绝不拼接进命令串：正文与参数各落一个文件，命令串中只保留两个 uuid（字符集 `[0-9a-f-]`）。
   * 相对路径在宿主（`cwd=workspace`）与容器（`-w /workspace`）下指向同一个文件。
   *
   * 顶层标量参数额外提供一份 `LUOLI_ARG_*` 环境变量，走 `spawn` options / `docker -e` —— 两条路径
   * 均不经 shell 解析。前缀白名单构成该闸：缺少它时，一个名为 `path` 的参数会变成 `PATH`。
   */
  async #execute(
    tool: CustomTool,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<object> {
    // 注册发生在开轮，执行发生在若干步之后 —— 期间它可能被修改、停用或删除。三种情形须分别报告：
    // 若统一报为定义已变更，模型会通过 `list_tools` 看到定义未变，随即原样重试。
    const row = this.repo.get(tool.name);
    if (!row)
      return {
        ok: false,
        error: "custom_tool_removed",
        hint: `${tool.name} 在本轮中途被删除，不要执行。`,
      };
    if (row.enabled !== 1)
      return {
        ok: false,
        error: "custom_tool_disabled",
        hint: `${tool.name} 在本轮中途被停用，不要执行；改用其他方式或如实告知用户。`,
      };
    if (row.definitionHash !== tool.definitionHash)
      return {
        ok: false,
        error: "custom_tool_redefined",
        hint: `${tool.name} 的定义在本轮中途已变更，不要执行；重新查看它当前的定义。`,
      };
    const directory = join(context.workspace, TMP_DIR);
    const id = randomUUID();
    const scriptName = `${id}.${tool.runtime === "python" ? "py" : "sh"}`;
    const paramsName = `${id}.json`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, scriptName), tool.body, { mode: 0o600 });
    writeFileSync(join(directory, paramsName), JSON.stringify(input ?? {}), {
      mode: 0o600,
    });
    const scriptPath = `${TMP_DIR}/${scriptName}`;
    const paramsPath = `${TMP_DIR}/${paramsName}`;
    const runner = tool.runtime === "python" ? "python3" : "sh";
    const command = `${runner} ${JSON.stringify(scriptPath)} ${JSON.stringify(paramsPath)}`;
    const timeout = Math.min(
      tool.timeoutMs ?? this.config().customTools.timeoutMs,
      this.execMaxTimeoutMs(),
    );
    try {
      const result = await this.sandbox.run(
        command,
        context.turn.effectiveRole,
        context.workspace,
        context.turn.abortSignal,
        timeout,
        context.turn.turnId,
        {
          extraEnv: { LUOLI_PARAMS: paramsPath, ...environmentFor(input) },
          chatId: context.turn.chatId,
          // 参见 `builtins.ts` 的 bash：不向下传递则 `sandbox.run` 无法挂在本次 `tool.call` 之下。
          ...(context.parentSpanId
            ? { parentSpanId: context.parentSpanId }
            : {}),
        },
      );
      return { ...result, tool: tool.name };
    } finally {
      for (const file of [scriptName, paramsName])
        try {
          rmSync(join(directory, file));
        } catch {
          /* 文件已在沙箱内被删除，或整个 workspace 已被清理 */
        }
    }
  }

  /** 定义期校验。返回错误码而不抛出：调用方需将其原样交回模型，由模型修正后重试。 */
  validate(input: CustomToolDefineInput):
    | { ok: false; error: string; hint: string }
    | {
        ok: true;
        value: Omit<
          NewCustomTool,
          "createdBy" | "createdTurn" | "ownerChatId" | "scope"
        >;
      } {
    const config = this.config().customTools;
    const name = input.name.startsWith(CUSTOM_TOOL_PREFIX)
      ? input.name.slice(CUSTOM_TOOL_PREFIX.length)
      : input.name;
    if (!NAME_PATTERN.test(name))
      return {
        ok: false,
        error: "invalid_tool_name",
        hint: "名字只能是小写字母开头的 2–41 位 [a-z0-9_]，注册时会自动加 custom_ 前缀。",
      };
    const description = normalizeDescription(input.description);
    if (!description)
      return {
        ok: false,
        error: "invalid_description",
        hint: "描述不能为空 —— 模型下一轮只能据此判断是否调用这个工具。",
      };
    const body = input.body.trim();
    if (!body)
      return { ok: false, error: "empty_body", hint: "脚本正文不能为空。" };
    if (body.length > config.maxBodyChars)
      return {
        ok: false,
        error: "body_too_long",
        hint: `正文上限 ${config.maxBodyChars} 字符，当前 ${body.length}。`,
      };
    const params = input.params ?? { type: "object", properties: {} };
    if (!params || typeof params !== "object" || Array.isArray(params))
      return {
        ok: false,
        error: "invalid_params",
        hint: "params 必须是一份 object 型 JSON Schema。",
      };
    const node = params as Record<string, unknown>;
    if (node.type !== "object")
      return {
        ok: false,
        error: "invalid_params",
        hint: 'params 的顶层 type 必须是 "object"。',
      };
    const properties =
      node.properties && typeof node.properties === "object"
        ? (node.properties as Record<string, unknown>)
        : {};
    if (Object.keys(properties).length > MAX_PARAM_PROPERTIES)
      return {
        ok: false,
        error: "too_many_params",
        hint: `顶层参数最多 ${MAX_PARAM_PROPERTIES} 个。`,
      };
    if (paramDepth(params) > MAX_PARAM_DEPTH)
      return {
        ok: false,
        error: "params_too_deep",
        hint: `参数 schema 最多 ${MAX_PARAM_DEPTH} 层（顶层对象算 1 层，其下每个对象 / 数组元素各算一层）。`,
      };
    try {
      jsonSchemaToZod(params);
    } catch (error) {
      return {
        ok: false,
        error: "invalid_params",
        hint: error instanceof Error ? error.message : "params 转换失败",
      };
    }
    const registeredName = this.registeredName(name);
    // 与既有工具重名须在定义期明确报出：`registerExternal` 一侧只输出一行 warn 并返回 false，
    // 模型观察到的现象是定义成功但工具始终未出现。
    const conflict = this.#registry
      ?.describe()
      .find(
        (entry) =>
          entry.name === registeredName && entry.defaults.source !== "custom",
      );
    if (conflict)
      return {
        ok: false,
        error: "name_taken",
        hint: `${registeredName} 已被 ${conflict.defaults.source} 占用，请更换名字。`,
      };
    if (!this.repo.get(name) && this.repo.count() >= config.maxTools) {
      return {
        ok: false,
        error: "custom_tool_limit",
        hint: `自定义工具上限 ${config.maxTools} 个，先使用 delete_tool 删除一个再重试。`,
      };
    }
    const minRole = input.minRole ?? config.defaultMinRole;
    const timeoutMs =
      input.timeoutMs === undefined
        ? null
        : Math.min(input.timeoutMs, this.execMaxTimeoutMs());
    return {
      ok: true,
      value: {
        name,
        description,
        paramsJson: JSON.stringify(params),
        runtime: input.runtime,
        body,
        minRole,
        timeoutMs,
      },
    };
  }

  /**
   * 定义或改写一个工具。落库即禁用，除非运维显式开启 `autoEnable` —— 网页 / 群聊注入
   * → `define_tool` → owner 因 `skipForOwner` 无感放行 → 立即成为持久能力，该链路中没有人工环节。
   */
  define(input: CustomToolDefineInput, context: ToolExecutionContext): object {
    const checked = this.validate(input);
    if (!checked.ok) return checked;
    const { tool, created, reset } = this.repo.upsert({
      ...checked.value,
      scope: "chat",
      ownerChatId: context.turn.chatId,
      createdBy: context.turn.initiatorUserId,
      createdTurn: context.turn.turnId,
    });
    if (this.config().customTools.autoEnable)
      this.repo.setEnabled(tool.name, true);
    this.reconcile();
    const live = this.repo.get(tool.name)!;
    this.log.event({
      level: "info",
      kind: "tool.custom_defined",
      summary: `${created ? "新建" : "改写"}自定义工具 ${tool.name}`,
      traceId: context.turn.turnId,
      chatId: context.turn.chatId,
      data: {
        tool: tool.name,
        runtime: tool.runtime,
        enabled: live.enabled === 1,
        reset,
      },
    });
    return {
      ok: true,
      name: this.registeredName(tool.name),
      created,
      enabled: live.enabled === 1,
      hint:
        live.enabled === 1
          ? "已启用，下一轮即可调用。"
          : `${reset ? "正文已变更，已打回未启用。" : "已保存，但尚未启用。"}owner 需在 WebUI 的扩展页复核正文后点击启用，之后下一轮才会出现在工具目录中。`,
    };
  }

  remove(name: string, context: ToolExecutionContext): object {
    const plain = name.startsWith(CUSTOM_TOOL_PREFIX)
      ? name.slice(CUSTOM_TOOL_PREFIX.length)
      : name;
    const removed = this.repo.remove(plain);
    if (!removed)
      return {
        ok: false,
        error: "not_found",
        hint: `不存在名为 ${plain} 的自定义工具，先使用 list_tools 查看。`,
      };
    this.reconcile();
    this.log.event({
      level: "info",
      kind: "tool.custom_removed",
      summary: `删除自定义工具 ${plain}`,
      traceId: context.turn.turnId,
      chatId: context.turn.chatId,
      data: { tool: plain },
    });
    return { ok: true, removed: plain };
  }

  /** 返回给模型的列表：带上 `enabled` 与作用域，否则模型无法判断已定义却不可调用的原因。 */
  list(context: ToolExecutionContext): object {
    return {
      ok: true,
      tools: this.repo.list().map((tool) => ({
        name: this.registeredName(tool.name),
        description: tool.description,
        runtime: tool.runtime,
        minRole: tool.minRole,
        enabled: tool.enabled === 1,
        scope: tool.scope,
        thisChat:
          tool.scope !== "chat" || tool.ownerChatId === context.turn.chatId,
        reviewed: tool.reviewedAt !== null,
        lastError: tool.lastError,
      })),
    };
  }
}

/**
 * 顶层标量参数 → `LUOLI_ARG_*`。非标量仅保留在 JSON 文件中：将数组放入环境变量须选定一种
 * 分隔符，而任何分隔符都可能出现在某个值中。
 */
export function environmentFor(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null || value === undefined || typeof value === "object")
      continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const name = `LUOLI_ARG_${key.toUpperCase()}`;
    // 仅大小写不同的两个参数（`path` / `Path`）会映射到同一变量名。取先到先得而非后者覆盖：
    // 至少脚本读到的是哪一个是确定的，且两个值都仍保留在参数 JSON 文件中。
    if (name in out) continue;
    const serialized = String(value);
    // NUL 在 `spawn` 的 env 中会抛出 ERR_INVALID_ARG_VALUE，导致整个调用失败而非少一个变量。
    if (serialized.includes("\0")) continue;
    // 按字节计算：`E2BIG` 统计的是字节，而 `.length` 统计 UTF-16 码元 —— 中文参数会被
    // 少计约三倍，预算随之失效。
    bytes += Buffer.byteLength(name) + Buffer.byteLength(serialized) + 2;
    if (bytes > MAX_ENV_BYTES) break;
    out[name] = serialized;
  }
  return out;
}
