import { minimatch } from "minimatch";
import { z } from "zod";
import type { Role, RuntimeTurnContext } from "@luoli/shared";
import { elideMiddleBytes, roleRank, untrusted } from "@luoli/shared";
import type { ToolPolicyEntry, ToolName, ToolOverride } from "./policy.js";
import {
  DEFER_EXEMPT,
  SKILL_NARROWING_EXEMPT,
  TOOL_POLICY,
  effectiveToolPolicy,
  relaxedFields,
} from "./policy.js";
import type { LogSink, LogSpan } from "../log/sink.js";
import { ApprovalRules, type ApprovalRisk } from "../approval/rules.js";
export type { ApprovalRisk } from "../approval/rules.js";
import type { ApprovalPolicy, ToolScope } from "./policy.js";

export interface ToolExecutionContext {
  turn: RuntimeTurnContext;
  workspace: string;
  agentKind: "main" | "sub";
  agentRunId?: string;
  /**
   * 子 agent 专有的字段，在主 agent 的上下文中恒为 `undefined`。工具侧此前对子 agent 一无所知
   * （别名、名称、张数均为 `runSubAgent` 的局部变量），而图片路径需要这三项（`docs/04 §5.2`）。
   */
  subAgent?: {
    /** 子 agent 自身的模型别名 —— 图片能否进入上下文按它判定，按主轮别名判定即查询了无关的模型。 */
    alias: string;
    /** 子 agent 的名称。父轮的文字记录需写明获取方（例如所派出的 researcher 取过一张图）。 */
    name: string;
    /** 本次 run 已注入的图片数。父轮 delta 中不含它们，`maxImagesPerTurn` 只能按 run 自行统计。 */
    images: () => number;
    /** 置位本 run 已注入图片 —— vision 切换应作用于实际接收该图片的那个 agent。 */
    onMediaInjected: () => void;
  };
  allow?: ReadonlySet<string>;
  /**
   * 本次工具调用应挂在哪个 span 之下（`docs/10 §1`）。主 agent 由 `onStepStart` 写入该项
   * （该步的 `model.call` span），子 agent 写入自身的 `agent.run`。
   *
   * `execute()` 之后它经浅拷贝替换为本次 `tool.call` 的 span id 再传给 `tool.execute` ——
   * 若修改共享对象，同一步内并行的多个 `spawn_agent` 会互相覆盖父边。
   */
  parentSpanId?: string;
}

export interface RegisteredTool<I = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  inputSchemaFor?(context: ToolExecutionContext): z.ZodType<I>;
  policy: ToolPolicyEntry;
  sourcePriority: number;
  untrustedOutput?: boolean;
  /** 单次调用的墙钟上限；默认使用 `tools.defaultTimeoutMs`，`null` 表示该工具自行管理超时。 */
  timeoutMs?: number | null;
  available?(role: Role, context: ToolExecutionContext): boolean;
  approvalTargetExists?(input: unknown, context: ToolExecutionContext): boolean;
  /** 按本轮配置将自身提升至审批档位。只能提高不能降低，合并规则见 `execute`。 */
  approvalFor?(input: I, context: ToolExecutionContext): ApprovalPolicy | null;
  execute(input: I, context: ToolExecutionContext): Promise<object> | object;
}

/**
 * 准入被拒的分类（写入 `tool.denied` 的 `reason`，`docs/10 §2` 列出同一份枚举）。
 * `approval` 不由 `admit()` 产生 —— 审批发生在准入之后，由 `execute()` 自行记录。
 */
export type ToolDenyReason =
  | "unknown_tool"
  | "disabled_after_errors"
  | "disabled_by_operator"
  | "role"
  | "subagent"
  | "unavailable"
  | "allowlist"
  | "skill_narrowed"
  | "rate"
  | "approval";

/** `hint` 面向模型：被拒时它需要知道原因才能组织回复，而不是仅给出一句未获批准。 */
export interface ApprovalVerdict {
  approved: boolean;
  hint?: string;
}

export interface ApprovalBroker {
  request(
    tool: RegisteredTool,
    input: unknown,
    context: ToolExecutionContext,
    risk: ApprovalRisk,
  ): Promise<boolean | ApprovalVerdict>;
}

/**
 * `tools.catalog.*` 的形状（docs/07 §5）。此处独立声明而不 import 配置类型 —— 注册表不依赖
 * `Config`，`ToolLimits` 始终是一份由运行时提供若干数值的窄契约。
 *
 * 每一项均为 optional，且整段缺失即一律不折叠：全仓约十处手工构造 `ToolRegistry` 的测试
 * （如 `tests/mcp.runtime.test.ts` 的 limits）都不提供该段，默认行为必须与改动前一致。
 */
export interface ToolCatalogLimits {
  deferExternal?: boolean;
  defer?: readonly string[];
  resident?: readonly string[];
  residentDescriptions?: boolean;
  maxExpandedPerTurn?: number;
}
/**
 * 折叠组的摘要素材。`names` 是完整清单（已位于截断后的集合内），`total = names.length` ——
 * 每组超过 12 个只列前 10 个并标注总数属于提示层排版，由渲染方依据这两项自行决定，注册表不预先
 * 裁剪名字：在此裁剪会使检索的 `group` 通道无法列全该组。
 */
export interface DeferredToolGroup {
  key: string;
  names: readonly string[];
  total: number;
}
/**
 * 目录的折叠视图。`resident ∪ deferred` 恰好等于 `active()`（对同一次 `#eligible()` 的结果二分，
 * 不遗漏不重复）—— 提示词的两段、`prepareStep` 的集合、检索的域全部由这一份派生，才不会出现
 * 摘要中报出 toolSet 中不存在的名字。
 */
export interface ToolCatalogView {
  resident: RegisteredTool[];
  deferred: RegisteredTool[];
  groups: DeferredToolGroup[];
  truncated: { total: number; visible: number } | null;
}

interface ToolLimits {
  maxRegistered: number;
  maxCallsPerTurn: number;
  maxConsecutiveErrors: number;
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  catalog?: ToolCatalogLimits;
}

/** 注册期之后才出现的工具来源。`builtin` / `agent` 属编译期，不经 `registerExternal`。 */
export type ExternalToolSource = "plugin" | "mcp" | "custom";
/**
 * 目录溢出（`tools.maxRegistered`）时的截断优先级：内建 100 > agent 90 > load_skill 80 >
 * plugin 60 > mcp 40 > custom 30。自撰写工具排在最后 —— 模型可一次创建二十个，让它优先挤掉
 * 运维显式配置的 MCP 是错误的方向。
 */
const EXTERNAL_SOURCE_PRIORITY: Record<ExternalToolSource, number> = {
  plugin: 60,
  mcp: 40,
  custom: 30,
};

/**
 * 附着在工具输出中的图片（`web_fetch` 抓取的图、MCP 的截图）。
 *
 * 必须在序列化之前摘除。一张 base64 图片有数百 KB，留在 JSON 中会造成两重损坏：
 * ① 它自身触及 `tools.maxOutputBytes`（64KB）被 `elideMiddleBytes` 从中间截断，而截断的
 * base64 会被 provider 整体拒收；② 即使未被截断，它也会挤占模型真正需要读取的内容的预算。
 * 摘除后由 `toolModelOutput` 转为 provider 的多模态 tool-result 形状（`agent/runtime.ts`）。
 */
export interface ToolMedia {
  mediaType: string;
  data: string;
}
/**
 * 外部工具（MCP / plugin）返回图片的去向。实现为 `media/web-assets.ts` 的 `captureImage`
 * —— 与 `web_fetch` 同一路径，因此存储位置、归一化方式、vision 不可用时的说明都只有一份。
 */
export interface ToolMediaSink {
  capture(
    context: ToolExecutionContext,
    input: { label: string; mediaType: string; body: Buffer },
  ): Promise<
    | { ok: true; assetId: string; mediaType: string; data: string }
    | { ok: false; error: string; hint: string }
  >;
}
export function splitToolMedia(output: object): {
  media: ToolMedia[];
  rest: Record<string, unknown>;
} {
  const { media, ...rest } = output as Record<string, unknown> & {
    media?: unknown;
  };
  const values = Array.isArray(media)
    ? media.filter(
        (entry): entry is ToolMedia =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as ToolMedia).mediaType === "string" &&
          typeof (entry as ToolMedia).data === "string",
      )
    : [];
  // 无任何一条符合形状时原样返回：`media` 可能只是某个工具自身的普通字段。
  return values.length
    ? { media: values, rest }
    : { media: [], rest: output as Record<string, unknown> };
}

const FALLBACK_TOOL_TIMEOUT_MS = 60_000;
class ToolTimeout extends Error {
  constructor(readonly ms: number) {
    super("tool_timeout");
  }
}
/**
 * 超时之后只能停止等待：无法真正取消任意工具的执行（沙箱有自身的 kill，MCP 有自身的 timeout，
 * 插件则完全没有）。丢弃该 promise 让本轮继续执行 —— `Promise.race` 已为其挂载处理器，
 * 延迟到达的 reject 不会变成 unhandledRejection 导致进程崩溃。
 */
async function withTimeout<T>(work: Promise<T> | T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeout(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface TurnToolState {
  calls: number;
  failures: Record<string, number>;
  disabled: Set<string>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #turns = new Map<string, TurnToolState>();
  readonly #limits: () => ToolLimits;
  readonly #rulesSource: () => readonly unknown[];
  #rulesCache: { source: readonly unknown[]; rules: ApprovalRules } | null =
    null;
  /** 运维在 WebUI 中设置的覆盖（启停、minRole、审批、超时）。用 getter 读取，保证热更新后立即生效。 */
  #overrides: () => Readonly<Record<string, ToolOverride>> = () => ({});
  /** limits 与 approvalRules 同样接受 getter：两者在 doc 11 中均标注热更新，取快照即被冻结
   *  （新增的高危命令规则将需重启才生效，docs/20 · W-CFG-02）。 */
  constructor(
    private readonly log: LogSink,
    private readonly approval: ApprovalBroker,
    limits: ToolLimits | (() => ToolLimits),
    approvalRules: readonly unknown[] | (() => readonly unknown[]) = [],
    private readonly hooks?: {
      hook(name: string, ...arguments_: unknown[]): Promise<unknown[]>;
    },
    /**
     * 仅用于记录 `turns.tool_calls`。`TurnRepository.incrementToolCall` 一直没有调用方，
     * 全库该列恒为 0 —— WebUI 轮次列表与 `turn.finished` 事件中的工具调用数始终不准确。
     * 可选：测试与子 agent 的注册表均无需提供。
     */
    private readonly turns?: { incrementToolCall(id: string): void },
  ) {
    this.#limits = typeof limits === "function" ? limits : () => limits;
    this.#rulesSource =
      typeof approvalRules === "function" ? approvalRules : () => approvalRules;
  }

  /** 仅当规则数组的对象身份变化时才重建：`configStore.replace` 每次返回新数组，热重载因此自动生效。 */
  #approvalRules(): ApprovalRules {
    const source = this.#rulesSource();
    if (!this.#rulesCache || this.#rulesCache.source !== source)
      this.#rulesCache = { source, rules: new ApprovalRules(source) };
    return this.#rulesCache.rules;
  }

  bindOverrides(overrides: () => Readonly<Record<string, ToolOverride>>): void {
    this.#overrides = overrides;
  }

  /** 未绑定时不生效：外部工具的图片照常走 JSON，而 `#absorbExternalMedia` 整体为 no-op。 */
  bindMedia(sink: ToolMediaSink): void {
    this.#media = sink;
  }
  #media: ToolMediaSink | null = null;

  /**
   * MCP 的图片结果转为 `media` 加一句文本标记。
   *
   * 不做这一步的话它会原样进入 `#normalizeOutput`：`JSON.stringify` → 触及
   * `tools.maxOutputBytes`（64KB）被从中间截断 → 经 `untrusted()` 包装为文本。即一张截图变成
   * 一段被截断的 base64，作为不可信文本交给模型 —— 既无法查看图片，又耗尽整个工具输出预算。
   * 浏览器类 MCP（obscura 的 `browser_screenshot`、playwright 等）返回的正是这一形状。
   *
   * 失败同样要如实写入结果：静默丢弃图片会使模型认为该工具故障并再次调用。
   */
  async #absorbExternalMedia(
    name: string,
    output: object,
    context: ToolExecutionContext,
  ): Promise<object> {
    const sink = this.#media;
    const content = (output as { content?: unknown }).content;
    if (!sink || !Array.isArray(content)) return output;
    const absorbed: ToolMedia[] = [];
    const rewritten: unknown[] = [];
    for (const entry of content) {
      const part = entry as {
        type?: unknown;
        data?: unknown;
        mimeType?: unknown;
      } | null;
      if (
        part?.type !== "image" ||
        typeof part.data !== "string" ||
        !part.data
      ) {
        rewritten.push(entry);
        continue;
      }
      const mediaType =
        typeof part.mimeType === "string" && part.mimeType
          ? part.mimeType
          : "image/png";
      const captured = await sink.capture(context, {
        label: name,
        mediaType,
        body: Buffer.from(part.data, "base64"),
      });
      if (!captured.ok) {
        rewritten.push({
          type: "text",
          text: `[图片未能放入上下文：${captured.error}]${captured.hint}`,
        });
        continue;
      }
      absorbed.push({ mediaType: captured.mediaType, data: captured.data });
      rewritten.push({
        type: "text",
        text: `[图片已放入本轮上下文（${captured.mediaType}），可直接查看]`,
      });
    }
    return absorbed.length
      ? { ...output, content: rewritten, media: absorbed }
      : output;
  }

  disabledByOperator(name: string): boolean {
    return this.#overrides()[name]?.enabled === false;
  }

  /**
   * 本次生效的策略等于注册期策略叠加运维覆盖。读取 minRole / approval 一律经此处，直接读取
   * `tool.policy` 即绕过覆盖层 —— 而这两个字段各有两处消费点（目录过滤与准入复查、
   * 审批基准与 `approvalFor` 提档），遗漏任何一处的表现都是界面已收紧而运行时未生效。
   */
  effectivePolicy(tool: RegisteredTool): ToolPolicyEntry {
    return effectiveToolPolicy(tool.policy, this.#overrides()[tool.name]);
  }

  register<I>(tool: RegisteredTool<I>): void {
    if (this.#tools.has(tool.name))
      throw new Error(`tool already registered: ${tool.name}`);
    this.#tools.set(tool.name, tool as RegisteredTool);
  }
  /**
   * `available` 与 `timeoutMs` 对自定义工具是必需项，而非附加便利：
   *
   * - 运维覆盖可修改 `effectivePolicy().minRole`，但无法绕过 `available()`（docs/09 §3.7）。自定义
   *   工具不得低于 `bash` 角色门槛这一下限因此只能写在 `available()` 中 —— 写在注册的
   *   `minRole` 上时，一次覆盖即可将其开放给 `limited`。
   * - 不设置 `timeoutMs: null` 时它使用 `tools.defaultTimeoutMs`（60s），而 `Sandbox.run` 按
   *   `tools.exec.maxTimeoutMs`（300s）才终止进程 —— 一个 120s 的脚本会对模型报超时而进程继续运行。
   */
  registerExternal(input: {
    name: string;
    description: string;
    inputSchema: z.ZodType<unknown>;
    minRole: Role;
    approval?: ApprovalPolicy;
    scope?: ToolScope;
    source: ExternalToolSource;
    available?: (role: Role, context: ToolExecutionContext) => boolean;
    timeoutMs?: number | null;
    execute: (
      input: unknown,
      context: ToolExecutionContext,
    ) => Promise<unknown> | unknown;
  }): boolean {
    const existing = this.#tools.get(input.name);
    if (existing && existing.policy.source !== input.source) {
      this.log.event({
        level: "warn",
        kind: "tool.external_conflict",
        summary: `External tool conflict: ${input.name}`,
        data: { source: input.source, existing: existing.policy.source },
      });
      return false;
    }
    this.#tools.set(input.name, {
      name: input.name,
      description: input.description,
      inputSchema: input.inputSchema,
      policy: {
        minRole: input.minRole,
        approval: input.approval ?? "conditional",
        scope: input.scope ?? "global",
        source: input.source,
      },
      sourcePriority: EXTERNAL_SOURCE_PRIORITY[input.source],
      untrustedOutput: true,
      ...(input.available ? { available: input.available } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      execute: async (value, context) => {
        const output = await input.execute(value, context);
        return await this.#absorbExternalMedia(
          input.name,
          output && typeof output === "object"
            ? (output as object)
            : { value: output },
          context,
        );
      },
    });
    return true;
  }

  unregisterBySource(source: ExternalToolSource): void {
    for (const [name, tool] of this.#tools)
      if (tool.policy.source === source) this.#tools.delete(name);
  }

  /**
   * `active()` 的过滤链本体，由 `activeView()` / `activeNamesForStep()` 共用。
   *
   * 整条过滤链、排序与 `slice` 的行为不得变更：`admit()` 与其逐条对齐（`AC-TOOL-022`、
   * docs/20 · W-TOOL-01），抽取出来只是为了让折叠视图无需复制整条链 —— 复制一份即产生
   * 两套会漂移的准入判据。
   *
   * warn 不记录在此处，而记录在 `active()`。折叠视图与 `active()` 都经过这条链，若在此写日志，
   * 同一轮会按调用次数重复记录 `tool.registry_truncated`；而 `toolSetFor` 中的那次 `active()`
   * （`runtime.ts` 开轮时的全量取数）仍保证每轮至少留下一条运维视角的凭据，提示层另有
   * RUNTIME 块中面向模型的截断告知。
   */
  #eligible(
    role: Role,
    context: ToolExecutionContext,
    allow?: string[],
  ): {
    tools: RegisteredTool[];
    truncated: { total: number; visible: number } | null;
  } {
    const state = this.#state(context.turn.turnId);
    const tools = [...this.#tools.values()]
      .filter(
        (tool) =>
          roleRank(role) >= roleRank(this.effectivePolicy(tool).minRole),
      )
      .filter((tool) => !this.disabledByOperator(tool.name))
      .filter((tool) => !state.disabled.has(tool.name))
      .filter((tool) => !allow || allow.includes(tool.name))
      .filter(
        (tool) =>
          !(context.agentKind === "sub" && tool.name === "memory_write"),
      )
      .filter((tool) => tool.available?.(role, context) !== false)
      .map((tool) =>
        tool.inputSchemaFor
          ? { ...tool, inputSchema: tool.inputSchemaFor(context) }
          : tool,
      )
      .sort(
        (a, b) =>
          b.sourcePriority - a.sourcePriority || a.name.localeCompare(b.name),
      );
    const max = this.#limits().maxRegistered;
    return {
      tools: tools.slice(0, max),
      truncated:
        tools.length > max ? { total: tools.length, visible: max } : null,
    };
  }

  active(
    role: Role,
    context: ToolExecutionContext,
    allow?: string[],
  ): RegisteredTool[] {
    const { tools, truncated } = this.#eligible(role, context, allow);
    if (truncated)
      this.log.event({
        level: "warn",
        kind: "tool.registry_truncated",
        summary: `Registered tool limit ${truncated.visible}`,
        traceId: context.turn.turnId,
        data: truncated,
      });
    return tools;
  }

  /**
   * 该工具在本次查询中是否应折叠（docs/07 §5）。
   *
   * 在查询期计算，不在 `RegisteredTool` 上标记。标记会被 MCP `reconcile`（重连一次即替换一批
   * tool 对象）与配置热更新（`tools.catalog.*` 标注热更新）污染，污染的表现是摘要与正文中都存在，
   * 或反过来两处都不存在 —— 均需等待下次重启才能恢复。经 `#limits()` getter 读取则天然跟随
   * 热更新。
   *
   * 判据顺序本身即契约：
   * ① 整段缺失或 `deferExternal !== true` → 一律不折叠（改动前的行为）；② 豁免表（展开入口）；
   * ③ `resident` glob 白名单优先级最高（运维显式指定常驻的，`defer` 再指定也无法覆盖）；
   * ④ 内建 / agent 默认常驻，只有被 `defer` glob 命中才折叠；⑤ 其余（plugin / mcp / custom）折叠。
   *
   * 紧随 ① 之后的两条是 docs/05 §3.12 不变量 3 的后半部分：运维在工具页移除展开入口时，
   * 整个目录回退为常驻。判定在此处而非提示层，是因为可见折叠摘要却无法展开这种状态，只有在折叠
   * 判据、目录文本、`prepareStep` 三处同时回退时才不会出现，而三处均由这一个判据派生。
   *
   * 移除展开入口有两种写法，工具页将它们并列于同一行（docs/09 §3.7：启停、minRole、审批策略、
   * 单次超时四项可写）：`enabled=false`，以及将 `minRole` 提升至本会话的有效角色之上。后者此前
   * 漏判 —— `#eligible()` 的 minRole 闸会滤除 `search_tools`，而折叠判据当时只检查 `enabled`，
   * 导致 trusted 会话可见折叠摘要却无法调用 `search_tools`，连 `repairToolCall` 的自愈也一并
   * 失效（其闸 ③ 正是 `search_tools` 本步无法发出）。判据取 `TOOL_POLICY` 加覆盖层而非注册表中
   * 的那一份：`main.ts` 的启动断言保证它必定已注册，且这样写在手工构造注册表的测试中同样成立。
   */
  #deferredFor(tool: RegisteredTool, role?: Role): boolean {
    const catalog = this.#limits().catalog;
    if (!catalog || catalog.deferExternal !== true) return false;
    if (this.disabledByOperator("search_tools")) return false;
    if (
      role !== undefined &&
      roleRank(role) <
        roleRank(
          effectiveToolPolicy(
            TOOL_POLICY.search_tools,
            this.#overrides().search_tools,
          ).minRole,
        )
    )
      return false;
    if (DEFER_EXEMPT.includes(tool.name as ToolName)) return false;
    if (catalog.resident?.some((pattern) => minimatch(tool.name, pattern)))
      return false;
    const source = tool.policy.source;
    if (source === "builtin" || source === "agent")
      return (
        catalog.defer?.some((pattern) => minimatch(tool.name, pattern)) === true
      );
    return true;
  }

  /**
   * 折叠组的 key 由既有命名空间派生，不新增注册字段（docs/05 §3.9 的前缀方案已列全该命名体系）：
   * 每多一个字段，MCP / plugin / custom 三条注册路径就多一处必须记得填写的位置。
   */
  #groupKey(tool: RegisteredTool): string {
    // `mcp__<server>__<tool>` 由 `mcp/manager.ts` 拼接。server 名允许包含下划线，因此按第一个
    // `__` 分割 —— 与拼接方约定一致，无法识别时退回整族一组，而不是构造一个虚假的 server 名。
    if (tool.policy.source === "mcp") {
      const server = /^mcp__(.+?)__/.exec(tool.name)?.[1];
      return server ? `mcp:${server}` : "mcp";
    }
    return tool.policy.source === "plugin"
      ? "plugin"
      : tool.policy.source === "custom"
        ? "custom"
        : "builtin";
  }

  /**
   * 目录的折叠视图。提示词的常驻段、折叠摘要段、截断告知行全部由这一次取数派生
   * （此前 `assembleMainPrompt` 中 `activeNames()` 与 `catalog()` 各计算一遍 `active()`）。
   *
   * 分区在截断之后进行：被 `maxRegistered` 裁剪的名字不进入摘要，否则模型按摘要中的名字检索，
   * 展开得到的是开轮时冻结的 toolSet 中不存在的键 —— AI SDK 侧（`filterActiveTools` 为纯交集）
   * 会将其静默丢弃而非报错，后果是检索返回 `status:'expanded'` 而模型据此调用却撞上
   * `NoSuchToolError`：一个无法解释的错误结果，比一次明确报错更难排查。
   */
  activeView(
    role: Role,
    context: ToolExecutionContext,
    allow?: string[],
  ): ToolCatalogView {
    const { tools, truncated } = this.#eligible(role, context, allow);
    const resident: RegisteredTool[] = [];
    const deferred: RegisteredTool[] = [];
    for (const tool of tools)
      (this.#deferredFor(tool, role) ? deferred : resident).push(tool);
    // 组的顺序即首次出现顺序，也就是 `sourcePriority desc, name asc`（plugin 60 > mcp 40 >
    // custom 30）。稳定顺序本身有价值：摘要行属易变段，无谓的重排等于每步修改提示词。
    const grouped = new Map<string, string[]>();
    for (const tool of deferred) {
      const key = this.#groupKey(tool);
      const names = grouped.get(key);
      if (names) names.push(tool.name);
      else grouped.set(key, [tool.name]);
    }
    return {
      resident,
      deferred,
      groups: [...grouped].map(([key, names]) => ({
        key,
        names,
        total: names.length,
      })),
      truncated,
    };
  }

  /**
   * `prepareStep` 的唯一集合来源：常驻 ∪（本轮已展开 ∩ 折叠集）。
   *
   * 直接过滤 `#eligible()` 的有序数组，而非拼接 `activeView()` 的两个分区 —— 拼接结果为
   * `resident ++ deferred`，与 `active()` 的 `sourcePriority desc, name asc` 不是同一顺序。
   *
   * ⚠ 这不影响 provider 的 tools 数组顺序（那一份由 `filterActiveTools` 按开轮冻结的 toolSet
   * 的键序生成，与此处返回的数组顺序无关，`docs/04 §2.1` 的缓存成本不落在本函数上）。目的仅是
   * 保证一个名字集合只有一种表示：断言、日志、请求体三处一致，阅读 diff 时可看出哪一步真正变化。
   */
  activeNamesForStep(
    role: Role,
    context: ToolExecutionContext,
    expanded?: ReadonlySet<string>,
    allow?: string[],
  ): string[] {
    return this.#eligible(role, context, allow)
      .tools.filter(
        (tool) =>
          !this.#deferredFor(tool, role) || expanded?.has(tool.name) === true,
      )
      .map((tool) => tool.name);
  }

  /**
   * 当前角色下是否存在可折叠的工具 —— `search_tools` 的 `available()` 判定它，折叠集为空时整个
   * 元工具不进入目录（纯内建部署的提示词逐字节不变）。
   *
   * ⚠ 不得改为经 `activeView()` 实现。那条路径为 `activeView()` → `#eligible()` →
   * `tool.available?.()` → 回到 `search_tools.available()` → 再次 `activeView()`：构成无限
   * 递归，表现为开轮时栈溢出。因此此处只遍历 `#tools` 自行判定三项（折叠判据、角色门槛、
   * 运维禁用），不调用任何 `available()`。
   *
   * 代价是它比真实折叠集更宽：某个折叠工具因自身 `available()` 判定为不可用时，此处仍计入它。
   * 最坏表现是 `search_tools` 进入目录但检索结果为空，而反向情形（误判为空、模型再也看不到
   * 折叠摘要对应的工具）才是真正难以解释的一档。
   */
  hasDeferrable(role: Role): boolean {
    for (const tool of this.#tools.values()) {
      if (!this.#deferredFor(tool, role) || this.disabledByOperator(tool.name))
        continue;
      if (roleRank(role) >= roleRank(this.effectivePolicy(tool).minRole))
        return true;
    }
    return false;
  }

  activeNames(
    role: Role,
    context: ToolExecutionContext,
    allow?: string[],
  ): string[] {
    return this.active(role, context, allow).map((entry) => entry.name);
  }
  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /**
   * 准入判定：`execute()` 在运行工具之前需通过的一系列闸门，抽取为一个只读判定（不写本轮状态、
   * 不记日志、不调用工具、不发起审批）。抽取的理由是可穷举地测试给定角色与上下文时本次调用是否
   * 应被放行 —— 闸门本身是正确的（`active()` 的过滤集合必须在此逐条复查，docs/20 · W-TOOL-01），
   * 问题在于它们此前与执行编排耦合在同一方法中，而这恰是最需要穷举测试的部分
   * （docs/27 · D-03）。`execute()` 因此只剩 admit → approve → run → normalize 四步。
   *
   * `warn` 标识本次拒绝额外值得记录一条运维视角日志：运维已禁用的工具被模型直接调用是排障线索。
   *
   * `reason` 是机器可读的拒绝分类，由 `execute()` 写入 `tool.denied`。它不能在此处记录 ——
   * 本方法刻意保持只读（以便穷举测试给定角色与上下文时是否应放行，docs/27 · D-03）；
   * 而不记录的代价实测为 45 次调用只有 40 条 `tool.call`，超出部分无任何日志（docs/28 · L-LOG-01）。
   */
  admit(
    name: string,
    context: ToolExecutionContext,
  ):
    | { ok: true; tool: RegisteredTool }
    | {
        ok: false;
        error: string;
        hint?: string;
        warn?: boolean;
        reason: ToolDenyReason;
      } {
    const state = this.#state(context.turn.turnId);
    const tool = this.#tools.get(name);
    if (!tool)
      return { ok: false, error: "tool_unavailable", reason: "unknown_tool" };
    // 本轮因连续失败而被停用与该工具根本不存在，对模型是两回事：前者应引导它更换方法，
    // 后者应引导它停止猜测工具名。合并为一句 tool_unavailable 时，模型通常会原地重试至步数耗尽。
    if (state.disabled.has(name))
      return {
        ok: false,
        error: "tool_disabled_after_errors",
        reason: "disabled_after_errors",
        hint: `本轮连续失败 ${this.#limits().maxConsecutiveErrors} 次后已停用；请更换方法或如实告知用户。`,
      };
    // 在目录过滤之外再拦截一次：模型可能沿用上一步的工具名，运维的禁用必须是硬边界。
    if (this.disabledByOperator(name))
      return {
        ok: false,
        error: "tool_disabled_by_operator",
        reason: "disabled_by_operator",
        warn: true,
      };
    if (
      roleRank(context.turn.effectiveRole) <
      roleRank(this.effectivePolicy(tool).minRole)
    )
      return { ok: false, error: "权限不足", reason: "role" };
    // active() 的过滤集合必须在此逐条复查，否则目录中不存在就成为唯一边界，而模型完全可以凭
    // 上一步的工具名直接调用。当前每个相关工具恰好各自 fail-closed，但那属于巧合而非设计
    // （docs/20 · W-TOOL-01；docs/05 §220 单一数据源）。
    if (context.agentKind === "sub" && name === "memory_write")
      return {
        ok: false,
        error: "tool_unavailable_for_subagent",
        reason: "subagent",
      };
    if (tool.available?.(context.turn.effectiveRole, context) === false)
      return { ok: false, error: "tool_unavailable", reason: "unavailable" };
    if (context.allow && !context.allow.has(name))
      return { ok: false, error: "tool_not_in_allowlist", reason: "allowlist" };
    if (
      context.turn.skillAllowedTools?.size &&
      !SKILL_NARROWING_EXEMPT.includes(name as ToolName) &&
      !context.turn.skillAllowedTools.has(name)
    )
      return {
        ok: false,
        error: "tool_not_in_allowlist",
        reason: "skill_narrowed",
      };
    if (state.calls >= this.#limits().maxCallsPerTurn)
      return { ok: false, error: "tool_call_limit_exceeded", reason: "rate" };
    return { ok: true, tool };
  }

  /** 每次拒绝记录一条 `tool.denied`。`error` 面向模型，`reason` 是供日志与排障使用的分类。 */
  #denied(
    name: string,
    context: ToolExecutionContext,
    reason: ToolDenyReason,
    error: string,
  ): void {
    this.log.event({
      level: "warn",
      kind: "tool.denied",
      summary: `${name}: ${reason}`,
      traceId: context.turn.turnId,
      ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
      chatId: context.turn.chatId,
      userId: context.turn.initiatorUserId,
      key: context.turn.key,
      data: { tool: name, reason, role: context.turn.effectiveRole, error },
    });
  }

  /**
   * 审批档位合并。`approvalFor` 使工具可按本轮配置将自身提升至审批档位
   * （`memory.pubWriteRequiresApproval` 即以此方式接入）。它只能提高不能降低 —— 否则工具可将
   * 自身从注册期确定的档位中移除。
   *
   * 运维覆盖设置的是基准档位，同样只参与本次取最严操作：将 `memory_write` 的基准改为 `never` 后，
   * `approvalFor` 仍会提档（docs/09 §3.7）。
   */
  #approvalDecision(
    tool: RegisteredTool,
    input: unknown,
    context: ToolExecutionContext,
  ): { needed: boolean; risk: ApprovalRisk } {
    const escalated = tool.approvalFor?.(input, context);
    const base = this.effectivePolicy(tool).approval;
    const effective =
      escalated === "always" || base === "always"
        ? "always"
        : escalated === "conditional" || base === "conditional"
          ? "conditional"
          : base;
    if (effective === "always") return { needed: true, risk: "high" };
    if (effective === "conditional")
      return this.#approvalRules().evaluate(tool, input, context);
    return { needed: false, risk: "low" };
  }

  async execute(
    name: string,
    rawInput: unknown,
    context: ToolExecutionContext,
  ): Promise<object> {
    const admitted = this.admit(name, context);
    if (!admitted.ok) {
      // 两条日志并非重复：`tool.denied` 是准入闸的统一流水（每次拒绝一行，带分类），
      // `tool.disabled` 是运维在界面上禁用的工具被模型直接调用这一情形的运维视角凭据。
      this.#denied(name, context, admitted.reason, admitted.error);
      if (admitted.warn)
        this.log.event({
          level: "warn",
          kind: "tool.disabled",
          summary: `Blocked disabled tool ${name}`,
          traceId: context.turn.turnId,
          data: { tool: name },
        });
      return {
        ok: false,
        error: admitted.error,
        ...(admitted.hint ? { hint: admitted.hint } : {}),
      };
    }
    const tool = admitted.tool;
    const state = this.#state(context.turn.turnId);
    const parsed = (
      tool.inputSchemaFor?.(context) ?? tool.inputSchema
    ).safeParse(rawInput);
    // 参数不合法计为一次失败。`maxConsecutiveErrors` 是防止模型原地重试至步数耗尽的唯一硬边界，
    // 而它此前只统计 execute 的失败 —— 参数错误与审批被拒这两种最常见的失败完全不计入，
    // 导致同一个错误调用可无限重复（实测 6 次全部被接受）。
    if (!parsed.success) {
      this.#failed(state, name, context);
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      // 与 `runtime.ts` 中的 `tool.error` 使用同一 kind：从模型视角这是同一件事（参数写错），
      // 只是这一份属于 AI SDK 放行、被 `inputSchemaFor` 收窄后的 schema 拦截的情形（docs/28 · L-LOG-03）。
      this.log.event({
        level: "warn",
        kind: "tool.error",
        summary: `${name}: invalid_input`,
        traceId: context.turn.turnId,
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        chatId: context.turn.chatId,
        userId: context.turn.initiatorUserId,
        key: context.turn.key,
        data: {
          tool: name,
          errorKind: "invalid_input",
          message: detail.slice(0, 500),
        },
      });
      return { ok: false, error: "invalid_input", hint: detail };
    }
    // 审批段与钩子同样位于 try 内。它们此前在 try 之外，导致 `approval.request` 的
    // `INSERT INTO approvals` 一旦失败（库满、被锁、已 close），异常会穿过 `execute()` 抛给
    // AI SDK —— 绕开本方法对其余所有失败都保证的统一 `{ok:false,error,hint}` 形状，
    // 且 `#failed` 不计数，`tools.maxConsecutiveErrors` 这一防止模型原地重试至步数耗尽的
    // 唯一硬边界不会推进。`#approvalDecision` 中的 RE2 编译与 `onToolCall` 钩子同理。
    // span 因此需提前声明：在创建 span 之前抛出时，catch 中的 `span?.end` 才不会再次抛出。
    let span: LogSpan | null = null;
    try {
      const decision = this.#approvalDecision(tool, parsed.data, context);
      if (decision.needed) {
        const verdict = await this.approval.request(
          tool,
          parsed.data,
          context,
          decision.risk,
        );
        const approved =
          typeof verdict === "boolean" ? verdict : verdict.approved;
        const hint = typeof verdict === "boolean" ? undefined : verdict.hint;
        // 被拒同样计为一次失败：owner 连续拒绝两次后模型应更换做法，而不是把同一个高危调用
        // 改动措辞后再次提交 —— 每一次都会向 owner 推送一条审批通知。
        if (!approved) {
          this.#failed(state, name, context);
          this.#denied(name, context, "approval", "未获批准");
          return { ok: false, error: "未获批准", ...(hint ? { hint } : {}) };
        }
      }
      state.calls += 1;
      // 记录在此处而非 `admit()` 之后：被拒的参数与被拒的审批都不计为已调用工具，
      // 计入的话轮次统计会高于模型实际执行的操作。子 agent 的调用同样计入本轮
      // （`context.turn.turnId` 对父子相同），与 `model_calls` 的口径一致。
      this.turns?.incrementToolCall(context.turn.turnId);
      await this.hooks?.hook("onToolCall", {
        name,
        input: parsed.data,
        context,
      });
      span = this.log.span({
        level: "info",
        kind: "tool.call",
        summary: name,
        traceId: context.turn.turnId,
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        chatId: context.turn.chatId,
        userId: context.turn.initiatorUserId,
        key: context.turn.key,
        // `AC-LOG-003` 要求展开任一 `tool.call` 都能看出是否经过审批，而此前该载荷只有 `{input}`。
        // 执行到此处时被拒的分支早已 return，因此 `granted` 恒为真 —— 显式写出是为了让这一行本身
        // 表达完整，而不要求读者先理解控制流。是否使用沙箱由挂在该 span 之下的 `sandbox.run`
        // 子行回答（`parentSpanId` 构成的链，docs/10 §1）：沙箱是三条工具路径共用的底层，
        // 将其事实复制一份到此处会产生两个真相来源。
        data: {
          input: parsed.data,
          approval: decision.needed
            ? { required: true, risk: decision.risk, granted: true }
            : { required: false },
        },
      });
      // 挂起的工具调用会阻塞整轮：AI SDK 的 toolMs 只是向 execute() 传递一个信号，工具不识别它即
      // 等同于没有超时。此处改为硬 race —— 到期即向模型返回失败，让它更换做法，而不是让用户面对
      // 沉默直至 `turnTimeoutMs`（logs/2026-08-17 中有 7 轮只有 turn.start 没有 turn.end）。
      // `timeoutMs === null` 的分支必须排在最前：bash / python / spawn_agent / spawn_harness /
      // ask_parent 各有自身的硬期限，运维在工具页为它们叠加一层外层 race 会在其自身超时之前
      // 终止调用（工具页对这几项置灰，此处是不依赖界面的兜底）。
      const budget =
        tool.timeoutMs === null
          ? null
          : (this.#overrides()[name]?.timeoutMs ??
            tool.timeoutMs ??
            this.#limits().defaultTimeoutMs ??
            FALLBACK_TOOL_TIMEOUT_MS);
      // 浅拷贝一份，不修改共享的 context：该层之下的 span（子 agent 的 `agent.run`、
      // `ask_parent` 的 `agent.ask`、`send_message` 的 `tg.send`）都需挂在本次调用之下，
      // 而同一步内并行的多个 `spawn_agent` 共用同一个 context 对象 —— 原地修改会互相覆盖（docs/10 §1）。
      const called = tool.execute(parsed.data, {
        ...context,
        parentSpanId: span.id,
      });
      const rawOutput =
        budget === null ? await called : await withTimeout(called, budget);
      const output = this.#normalizeOutput(
        name,
        rawOutput,
        tool.untrustedOutput === true,
      );
      await this.hooks?.hook("onToolResult", {
        name,
        input: parsed.data,
        output,
        context,
      });
      if ("ok" in output && output.ok === false)
        this.#failed(state, name, context);
      else state.failures[name] = 0;
      span.end({ output });
      return output;
    } catch (error) {
      this.#failed(state, name, context);
      span?.end(undefined, error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "tool_error",
        ...(error instanceof ToolTimeout
          ? {
              hint: `${error.ms}ms 内未返回，本次调用已放弃；请更换参数或方法，不要原样重试。`,
            }
          : {}),
      };
    }
  }
  releaseTurn(turnId: string): void {
    this.#turns.delete(turnId);
  }

  /** 连续失败达到上限即在本轮停用，并记录一条 warn：排障时需能看出模型并非未尝试，而是被拦截。 */
  #failed(
    state: TurnToolState,
    name: string,
    context: ToolExecutionContext,
  ): void {
    state.failures[name] = (state.failures[name] ?? 0) + 1;
    if (
      state.failures[name]! < this.#limits().maxConsecutiveErrors ||
      state.disabled.has(name)
    )
      return;
    state.disabled.add(name);
    this.log.event({
      level: "warn",
      kind: "tool.disabled_after_errors",
      summary: `Disabled ${name} after ${state.failures[name]} failures`,
      traceId: context.turn.turnId,
      key: context.turn.key,
      data: { tool: name, failures: state.failures[name] },
    });
  }

  /**
   * 工具页所需的表格：每个已注册工具的默认策略、当前生效策略，以及哪些项被放宽。
   *
   * 由注册表产出该数据，而非让服务端基于 `TOOL_POLICY` 重新计算：合并逻辑只有一份才不会出现
   * 面板显示的权限与运行时判定不一致。同时 MCP / plugin 注册的工具也进入该表 —— 此前的
   * `GET /api/tools` 只枚举 `TOOL_POLICY`，那些工具在面板上完全不存在，而
   * `disabledByOperator` 一直是识别它们的。
   */
  describe(): Array<{
    name: string;
    description: string;
    defaults: ToolPolicyEntry;
    effective: ToolPolicyEntry;
    enabled: boolean;
    timeoutMs: number | null;
    defaultTimeoutMs: number | null;
    selfManagedTimeout: boolean;
    deferred: boolean;
    relaxed: Array<"minRole" | "approval">;
  }> {
    const overrides = this.#overrides();
    return [...this.#tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => {
        const override = overrides[tool.name];
        const selfManaged = tool.timeoutMs === null;
        const declared = selfManaged
          ? null
          : (tool.timeoutMs ??
            this.#limits().defaultTimeoutMs ??
            FALLBACK_TOOL_TIMEOUT_MS);
        return {
          name: tool.name,
          description: tool.description,
          defaults: tool.policy,
          effective: this.effectivePolicy(tool),
          enabled: override?.enabled !== false,
          timeoutMs: selfManaged ? null : (override?.timeoutMs ?? declared),
          // 按当前 `tools.catalog.*` 静态判定：该表没有角色也没有轮次上下文，因此它回答的是
          // 该工具在本机配置下是否属于折叠族，而非它在某一轮中是否被折叠。
          defaultTimeoutMs: declared,
          selfManagedTimeout: selfManaged,
          deferred: this.#deferredFor(tool),
          relaxed: relaxedFields(tool.policy, override),
        };
      });
  }

  #normalizeOutput(name: string, output: object, wrap: boolean): object {
    const max = this.#limits().maxOutputBytes ?? 65_536;
    const { media, rest } = splitToolMedia(output);
    const serialized = JSON.stringify(rest);
    // 按字符边界切分（docs/27 · T-04）：直接 `subarray().toString('utf8')` 会截断末尾的多字节
    // 字符，模型看到的是一串 U+FFFD。
    const { value, truncated } = elideMiddleBytes(
      serialized,
      max,
      (omitted) => `\n…省略 ${omitted} bytes…\n`,
    );
    const carry = media.length ? { media } : {};
    if (!wrap && !truncated)
      return media.length ? { ...rest, ...carry } : output;
    return {
      ok: !("ok" in rest) || rest.ok !== false,
      content: wrap ? untrusted(`tool:${name}`, value) : value,
      truncated,
      ...carry,
    };
  }
  #state(turnId: string): TurnToolState {
    let state = this.#turns.get(turnId);
    if (!state) {
      state = { calls: 0, failures: {}, disabled: new Set() };
      this.#turns.set(turnId, state);
    }
    return state;
  }
}

export function builtinPolicy(name: keyof typeof TOOL_POLICY): ToolPolicyEntry {
  return TOOL_POLICY[name];
}
