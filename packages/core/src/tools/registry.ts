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
   * 子 agent 专属的那几样，主 agent 的上下文里恒为 `undefined`。工具侧此前对子 agent 一无所知
   * （别名、名字、张数都是 `runSubAgent` 的局部变量），而图片路径这三样都要用（`docs/04 §5.2`）。
   */
  subAgent?: {
    /** 它自己的模型别名 —— 图片能不能进上下文按**它**问，问主轮别名等于问了个无关的模型。 */
    alias: string;
    /** 它的名字。父轮那条文字痕迹要写清是谁取的（「你派出的 researcher 取过一张图」）。 */
    name: string;
    /** 本次 run 已经注入过几张图。父轮 delta 里没有它们，`maxImagesPerTurn` 只能按 run 自己数。 */
    images: () => number;
    /** 「本 run 注入过图」置位 —— vision 切换要落在**看到这张图**的那个 agent 上。 */
    onMediaInjected: () => void;
  };
  allow?: ReadonlySet<string>;
  /**
   * 这次工具调用该挂在哪个 span 之下（`docs/10 §1`）。主 agent 由 `onStepStart` 写进这一项
   * （那一步的 `model.call` span），子 agent 写的是自己那条 `agent.run`。
   *
   * `execute()` 之后它被**浅拷贝**换成本次 `tool.call` 的 span id 再交给 `tool.execute` ——
   * 改共享对象的话，同一步里并排的多个 `spawn_agent` 会互相顶掉父边。
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
  /** 单次调用的墙钟上限；缺省用 `tools.defaultTimeoutMs`，`null` 表示这个工具自己管超时。 */
  timeoutMs?: number | null;
  available?(role: Role, context: ToolExecutionContext): boolean;
  approvalTargetExists?(input: unknown, context: ToolExecutionContext): boolean;
  /** 按本轮配置把自己抬进审批。只能抬高不能放低，见 `execute` 里的合并规则。 */
  approvalFor?(input: I, context: ToolExecutionContext): ApprovalPolicy | null;
  execute(input: I, context: ToolExecutionContext): Promise<object> | object;
}

/**
 * 准入被拒的档位（落在 `tool.denied` 的 `reason` 上，`docs/10 §2` 列了同一份穷举）。
 * `approval` 不是 `admit()` 给的 —— 审批发生在准入之后，由 `execute()` 自己记。
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

/** `hint` 是给模型看的：被拒时它需要知道「为什么」才能用自己的话回复，而不是干巴巴一句「未获批准」。 */
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
 * `tools.catalog.*` 的形状（docs/07 §5）。**这里独立声明而不 import 配置类型** —— 注册表不认
 * `Config`，`ToolLimits` 一直是「运行时给我这几个数」的窄契约。
 *
 * 每一项都 optional，且**整段缺席 = 一律不折叠**：全仓约十处手工构造 `ToolRegistry` 的测试
 * （`tests/mcp.runtime.test.ts` 那份 limits 等）都不给这一段，缺省必须是改动前的行为。
 */
export interface ToolCatalogLimits {
  deferExternal?: boolean;
  defer?: readonly string[];
  resident?: readonly string[];
  residentDescriptions?: boolean;
  maxExpandedPerTurn?: number;
}
/**
 * 折叠组的摘要素材。`names` 是**完整**清单（已在截断后的集合内），`total = names.length` ——
 * 「每组超 12 个只列前 10 + 等 N 个」是提示层的排版，由渲染方按这两项自己决定，注册表不预先砍掉
 * 名字：砍在这里的话检索的 `group` 通道就再也列不全那一组了。
 */
export interface DeferredToolGroup {
  key: string;
  names: readonly string[];
  total: number;
}
/**
 * 目录的折叠视图。`resident ∪ deferred` **恰好等于** `active()`（同一次 `#eligible()` 的产物二分，
 * 不漏不重）—— 提示词的两段、`prepareStep` 的集合、检索的域全部从这一份派生，才不会出现
 * 「摘要里报了一个 toolSet 里没有的名字」。
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

/** 注册期之后才出现的工具来源。`builtin` / `agent` 是编译期的，不走 `registerExternal`。 */
export type ExternalToolSource = "plugin" | "mcp" | "custom";
/**
 * 目录溢出（`tools.maxRegistered`）时的截断优先级：内建 100 > agent 90 > load_skill 80 >
 * plugin 60 > mcp 40 > custom 30。自撰写的排最后 —— 模型可以一口气造二十个，让它先挤掉
 * 运维显式配的 MCP 是错的方向。
 */
const EXTERNAL_SOURCE_PRIORITY: Record<ExternalToolSource, number> = {
  plugin: 60,
  mcp: 40,
  custom: 30,
};

/**
 * 工具输出里骑着的图片（`web_fetch` 抓回来的图、MCP 的截图）。
 *
 * **序列化之前就要摘出去。** 一张 base64 图有几百 KB，留在 JSON 里是双重损坏：
 * ① 它自己撞上 `tools.maxOutputBytes`（64KB）被 `elideMiddleBytes` 从中间截半，而截半的
 * base64 会被 provider 整个拒收；② 就算不截，它也会把模型真正要读的那几行挤出预算。
 * 摘出来之后由 `toolModelOutput` 交给 provider 的多模态 tool-result 形状（`agent/runtime.ts`）。
 */
export interface ToolMedia {
  mediaType: string;
  data: string;
}
/**
 * 外部工具（MCP / plugin）交回的图片往哪去。实现是 `media/web-assets.ts` 的 `captureImage`
 * —— 与 `web_fetch` 同一条路径，所以「存哪、怎么归一化、vision 不可用时怎么如实说」只有一份。
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
  // 一条都不合形状时**原样交回**：`media` 有可能只是某个工具自己的普通字段。
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
 * 超时之后只能「不再等」：没有办法真正取消一个任意工具的执行（沙箱有自己的 kill，MCP 有自己的
 * timeout，插件什么都没有）。丢掉这个 promise 让本轮继续往下走 —— `Promise.race` 已经给它挂了
 * 处理器，晚到的拒绝不会变成 unhandledRejection 打崩进程。
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
  /** 运维在 WebUI 上按下的那份覆盖（启停 + minRole/审批/超时）。用 getter 读取，保证配置热更新后立即生效。 */
  #overrides: () => Readonly<Record<string, ToolOverride>> = () => ({});
  /** limits 与 approvalRules 同样接受 getter：两者在 doc 11 都标着热更新，吃快照就是冻住
   *  （新增的高危命令规则要重启才生效，docs/20 · W-CFG-02）。 */
  constructor(
    private readonly log: LogSink,
    private readonly approval: ApprovalBroker,
    limits: ToolLimits | (() => ToolLimits),
    approvalRules: readonly unknown[] | (() => readonly unknown[]) = [],
    private readonly hooks?: {
      hook(name: string, ...arguments_: unknown[]): Promise<unknown[]>;
    },
    /**
     * 只用来记 `turns.tool_calls`。`TurnRepository.incrementToolCall` 从头就没有调用者，
     * 全库这一列恒为 0 —— WebUI 轮次列表与 `turn.finished` 事件里的工具调用数一直是假的。
     * 可选：测试与子 agent 的注册表都不必给。
     */
    private readonly turns?: { incrementToolCall(id: string): void },
  ) {
    this.#limits = typeof limits === "function" ? limits : () => limits;
    this.#rulesSource =
      typeof approvalRules === "function" ? approvalRules : () => approvalRules;
  }

  /** 规则数组换了对象身份才重建：`configStore.replace` 每次都给出新数组，热重载因此自动生效。 */
  #approvalRules(): ApprovalRules {
    const source = this.#rulesSource();
    if (!this.#rulesCache || this.#rulesCache.source !== source)
      this.#rulesCache = { source, rules: new ApprovalRules(source) };
    return this.#rulesCache.rules;
  }

  bindOverrides(overrides: () => Readonly<Record<string, ToolOverride>>): void {
    this.#overrides = overrides;
  }

  /** 不绑就没有：外部工具的图片照旧走 JSON，而 `#absorbExternalMedia` 整个是 no-op。 */
  bindMedia(sink: ToolMediaSink): void {
    this.#media = sink;
  }
  #media: ToolMediaSink | null = null;

  /**
   * MCP 的图片结果 → `media` + 一句文本标记。
   *
   * 不做这一步的话它会照原样走进 `#normalizeOutput`：`JSON.stringify` → 撞上
   * `tools.maxOutputBytes`（64KB）从中间截半 → `untrusted()` 包成文本。也就是一张截图变成
   * 一坨截半的 base64 当不可信文本交给模型 —— 既看不见图，又把整个工具输出预算烧光。
   * 浏览器类 MCP（obscura 的 `browser_screenshot`、playwright 那些）返回的正是这个形状。
   *
   * 失败也要如实写进结果：静静地把图丢掉的话，模型只会以为这个工具坏了然后再调一次。
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
          text: `[图片没能放进上下文：${captured.error}]${captured.hint}`,
        });
        continue;
      }
      absorbed.push({ mediaType: captured.mediaType, data: captured.data });
      rewritten.push({
        type: "text",
        text: `[图片已放进本轮上下文（${captured.mediaType}），直接看即可]`,
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
   * 本次生效的策略 = 注册期那份 + 运维覆盖。**读 minRole / approval 一律走这里**，直接读
   * `tool.policy` 就是绕过覆盖层 —— 而这两个字段各有两处消费点（目录过滤与准入复查、
   * 审批基准与 `approvalFor` 抬档），漏掉任何一处的表现都是「界面上关严了，运行时没有」。
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
   * `available` 与 `timeoutMs` 对自定义工具是必需的，不是顺手加的糖：
   *
   * - 运维覆盖能改 `effectivePolicy().minRole`，但绕不过 `available()`（docs/09 §3.7）。自定义工具
   *   那道「不得低于 `bash` 的角色门槛」的地板因此只能写在 `available()` 里 —— 写在注册的
   *   `minRole` 上，一次覆盖就把它放给 `limited` 了。
   * - 不给 `timeoutMs: null` 的话它吃 `tools.defaultTimeoutMs`（60s），而 `Sandbox.run` 按
   *   `tools.exec.maxTimeoutMs`（300s）才 kill —— 一个 120s 的脚本会「对模型报超时、进程接着跑」。
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
   * `active()` 的过滤链本体，`activeView()` / `activeNamesForStep()` 共用。
   *
   * **整条过滤链、排序、`slice` 的行为一个字都不能变**：`admit()` 与它逐条对齐（`AC-TOOL-022`、
   * docs/20 · W-TOOL-01），抽出来只是为了让折叠视图不必把整条链抄第二遍 —— 抄第二遍就是
   * 两份会漂移的准入判据。
   *
   * **warn 不落在这里，落在 `active()`。** 折叠视图与 `active()` 都走这条链，日志写在这里的话
   * 同一轮会按调用次数重复记 `tool.registry_truncated`；而 `toolSetFor` 那一次 `active()`
   * （`runtime.ts` 开轮时的全量取数）仍然保证每轮至少落一条运维视角的凭据，提示层则另有
   * RUNTIME 块里那行给模型看的截断告知。
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
   * 这一个工具在**本次查询**里该不该折叠（docs/07 §5）。
   *
   * **查询期算，不在 `RegisteredTool` 上打标。** 打标的那份会被 MCP `reconcile`（重连一次就换了
   * 一批 tool 对象）与配置热更新（`tools.catalog.*` 标着热更新）弄脏，而弄脏的表现是「摘要里
   * 有、正文里也有」或者反过来「两处都没有」—— 都得等下次重启才好。走 `#limits()` getter
   * 天然跟着热更新走。
   *
   * 判据顺序本身是契约：
   * ① 整段缺席或 `deferExternal !== true` → 一律不折叠（改动前的行为）；② 豁免表（梯子）；
   * ③ `resident` glob 白名单**最高优先**（运维显式点名常驻的，`defer` 再点也压不过）；
   * ④ 内建 / agent 默认常驻，只有被 `defer` glob 点名才折叠；⑤ 其余（plugin / mcp / custom）折叠。
   *
   * 夹在 ① 之后那两条是 docs/05 §3.12 不变量 3 的后半：运维在工具页**把梯子收走**时
   * **整个目录回退常驻**。判在这里而不是提示层，是因为「看得见折叠摘要却没法展开」这种形态只有
   * 在折叠判据、目录文本、`prepareStep` 三处同时回退才不会出现，而三处都从这一个判据派生。
   *
   * 「收走」有**两种**写法，工具页把它们并排放在同一行上（docs/09 §3.7：启停、minRole、审批策略、
   * 单次超时四项可写）：`enabled=false`，以及**把 `minRole` 抬到本会话的有效角色之上**。后者此前
   * 漏判 —— `#eligible()` 那道 minRole 闸会把 `search_tools` 滤掉，而折叠判据当时只问 `enabled`，
   * 于是一个 trusted 会话看得见折叠摘要、调不动 `search_tools`，连 `repairToolCall` 的自愈也一起
   * 失效（它的闸 ③ 正是「`search_tools` 本步发不出去」）。判据取 `TOOL_POLICY` + 覆盖层而不是
   * 注册表里那一份：`main.ts` 的启动断言保证它一定注册着，而这样写在手搓注册表的测试里也成立。
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
   * 折叠组的 key 从**既有命名空间**派生，不新增注册字段（docs/05 §3.9 那套前缀已经把这套命名
   * 列全了）：多一个字段就多一处 MCP / plugin / custom 三条注册路都要记得填的地方。
   */
  #groupKey(tool: RegisteredTool): string {
    // `mcp__<server>__<tool>` 是 `mcp/manager.ts` 拼的。server 名允许下划线，所以按**第一个**
    // `__` 断开 —— 与拼接方同一个约定，认不出来时退回整族一组而不是编一个假的 server 名。
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
   * 目录的折叠视图。提示词的常驻段、折叠摘要段、截断告知行全部从这**一次**取数派生
   * （此前 `assembleMainPrompt` 里 `activeNames()` + `catalog()` 各算一遍 `active()`）。
   *
   * 分区在**截断之后**做：被 `maxRegistered` 砍掉的名字不进摘要，否则模型按摘要里的名字检索，
   * 展开出来的是一个开轮冻结的 toolSet 里根本没有的键 —— AI SDK 那边（`filterActiveTools` 是纯
   * 交集）会把它**静默丢掉**而不是报错，于是坏处是「检索回了 `status:'expanded'`，模型照着调却
   * 撞 `NoSuchToolError`」：一条说不清的假话，比一次报错难查。
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
    // 组的顺序 = 首次出现的顺序，也就是 `sourcePriority desc, name asc`（plugin 60 > mcp 40 >
    // custom 30）。稳定的顺序本身有价值：摘要行属易变段，无谓的重排每步都在改提示词。
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
   * `prepareStep` 的**唯一**集合来源：常驻 ∪（本轮已展开 ∩ 折叠集）。
   *
   * 直接过滤 `#eligible()` 的有序数组，而不是把 `activeView()` 的两个分区拼回去 —— 拼回来的那份
   * 是 `resident ++ deferred`，与 `active()` 的 `sourcePriority desc, name asc` 不是同一个序。
   *
   * ⚠ **这不影响 provider 的 tools 数组顺序**（那一份由 `filterActiveTools` 按开轮冻结的 toolSet
   * 的键序生成，与这里返回的数组序无关，`docs/04 §2.1` 那笔缓存账不落在这个函数上）。要的只是
   * 「一个名字集合只有一种写法」：断言、日志、请求体三处对得上，读 diff 时看得出来哪一步真的变了。
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
   * 本角色下**有没有**东西可折叠 —— `search_tools` 的 `available()` 判它，折叠集为空时整个
   * 元工具不进目录（纯内建部署的提示词逐字节不变）。
   *
   * ⚠ **绝不能改成走 `activeView()`。** 那条路是 `activeView()` → `#eligible()` →
   * `tool.available?.()` → 回到 `search_tools.available()` → 又一次 `activeView()`：一个无限
   * 递归环，表现是开轮直接栈溢出。所以这里只遍历 `#tools` 自己判三件事（折叠判据、角色门槛、
   * 运维禁用），**一次 `available()` 都不调**。
   *
   * 代价是它比真实折叠集**宽**：某个折叠工具因自己的 `available()` 缺席时，这里仍算它在。
   * 表现上限是「`search_tools` 进了目录但检索结果为空」，而反过来（漏判成空、模型再也看不到
   * 折叠摘要背后的东西）才是真正说不清的那一档。
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
   * 准入判定：`execute()` 在跑工具之前要过的那一串闸，抽成一个**只读**判定（不写本轮状态、
   * 不记日志、不调工具、不发审批）。抽出来的理由是可穷举地测「给定 (角色, 上下文) 这一次调用
   * 该不该被放行」—— 闸门本身是对的（`active()` 的过滤集合必须在这里逐条复查，docs/20 ·
   * W-TOOL-01），问题是它们此前和执行编排焊在同一个方法里，而这正是最需要穷举的部分
   * （docs/27 · D-03）。`execute()` 因此只剩 admit → approve → run → normalize 四步。
   *
   * `warn` 标的是「这一次拒绝额外值得一条运维视角的日志」：运维禁用的工具被模型硬调过来是排障线索。
   *
   * `reason` 是**机器可读的拒绝档位**，由 `execute()` 记进 `tool.denied`。它不能在这里记 ——
   * 这个方法刻意只读（可穷举地测「给定 (角色, 上下文) 这一次该不该放行」，docs/27 · D-03）；
   * 而不记的代价实测是「45 次调用恰好 40 条 `tool.call`，超出的零日志」（docs/28 · L-LOG-01）。
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
    // 「本轮已经连续失败到被停用」和「这个工具根本不存在」对模型是两回事：前者要让它换个办法，
    // 后者要让它别再猜工具名。混成一句 tool_unavailable 时模型通常继续原地重试到步数耗尽。
    if (state.disabled.has(name))
      return {
        ok: false,
        error: "tool_disabled_after_errors",
        reason: "disabled_after_errors",
        hint: `本轮连续失败 ${this.#limits().maxConsecutiveErrors} 次后已停用，换个办法或如实告诉用户。`,
      };
    // 目录过滤之外再挡一次：模型可能沿用上一步的工具名，运维的禁用必须是硬边界。
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
    // active() 的过滤集合必须在这里逐条复查，否则「目录里没有」就成了唯一的边界，而模型完全可以
    // 凭上一步的工具名直接调过来。目前每个相关工具恰好各自 fail-closed，但那是巧合不是设计
    // （docs/20 · W-TOOL-01；docs/05 §220「单一数据源」）。
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

  /** 一次拒绝落一条 `tool.denied`。`error` 是给模型看的那句，`reason` 是给日志与排障用的档位。 */
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
   * 审批档位合并。`approvalFor` 让工具按**本轮配置**把自己抬进审批（`memory.pubWriteRequiresApproval`
   * 就是这么接的）。它只能抬高，不能放低 —— 否则一个工具就能把自己从注册期定死的档位里摘出去。
   *
   * 运维覆盖设的是**基准档**，同样只参与这次取最严：把 `memory_write` 的基准改成 `never`，
   * `approvalFor` 该抬还是抬（docs/09 §3.7）。
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
      // 两条日志不是重复：`tool.denied` 是准入闸的统一流水（每一次拒绝一行，带档位），
      // `tool.disabled` 是「运维在界面上关掉的东西被模型硬调过来」这一档的运维视角凭据。
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
    // 参数不合法算一次失败。`maxConsecutiveErrors` 是「模型别原地重试到步数耗尽」的**唯一**硬
    // 边界，而它此前只数 execute 的失败 —— 参数写错和审批被拒这两种最常见的失败一次都不计，
    // 于是同一个错误的调用可以无限次重来（实测 6 次全部照收）。
    if (!parsed.success) {
      this.#failed(state, name, context);
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      // 与 `runtime.ts` 那条 `tool.error` 同一个 kind：从模型的角度这是同一件事（参数写错了），
      // 只是这一份是 AI SDK 放过、被 `inputSchemaFor` 收窄后的 schema 拦下的那一档（docs/28 · L-LOG-03）。
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
    // **审批段与钩子也在 try 里面。** 它们此前在外面，于是 `approval.request` 的
    // `INSERT INTO approvals` 一旦失败（库满/被锁/已 close），异常就穿过 `execute()` 抛进
    // AI SDK —— 绕开了这个方法对其他所有失败都保证的统一 `{ok:false,error,hint}` 形状，
    // 而且 `#failed` 不计数，`tools.maxConsecutiveErrors` 那道「模型别原地重试到步数耗尽」
    // 的唯一硬边界不推进。`#approvalDecision` 里的 RE2 编译、`onToolCall` 钩子同理。
    // span 因此要提前声明：抛在建 span 之前时 catch 里 `span?.end` 才不会再抛一次。
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
        // 被拒同样计一次失败：owner 连着拒两次之后模型该换个做法，而不是把同一个高危调用
        // 改个字再递上来 —— 每一次都是一条推给 owner 的审批通知。
        if (!approved) {
          this.#failed(state, name, context);
          this.#denied(name, context, "approval", "未获批准");
          return { ok: false, error: "未获批准", ...(hint ? { hint } : {}) };
        }
      }
      state.calls += 1;
      // 记在这里而不是 `admit()` 之后：被拒的参数、被拒的审批都不算「调用过工具」，
      // 数进去的话轮次统计会比模型真正做过的事多出一截。子 agent 的调用也算在本轮账上
      // （`context.turn.turnId` 对父子是同一个），与 `model_calls` 的口径一致。
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
        data: { input: parsed.data },
      });
      // 挂住的工具调用会挂住整轮：AI SDK 的 toolMs 只是把一个信号递给 execute()，工具不认它就等于
      // 没有超时。这里改成硬 race —— 到点就把失败交回模型，让它换个做法，而不是让用户对着沉默
      // 一直等到 `turnTimeoutMs`（logs/2026-08-17 有 7 轮只有 turn.start 没有 turn.end）。
      // `timeoutMs === null` 的分支必须在最前面：bash / python / spawn_agent / spawn_harness /
      // ask_parent 各有自己的硬期限，运维从工具页给它们套一层外层 race 会在它们自己的超时之前
      // 把调用砍掉（工具页对这几个置灰，这里是不信界面的那道兜底）。
      const budget =
        tool.timeoutMs === null
          ? null
          : (this.#overrides()[name]?.timeoutMs ??
            tool.timeoutMs ??
            this.#limits().defaultTimeoutMs ??
            FALLBACK_TOOL_TIMEOUT_MS);
      // **浅拷贝一份**，不改共享的 context：这一层往下的 span（子 agent 的 `agent.run`、
      // `ask_parent` 的 `agent.ask`、`send_message` 的 `tg.send`）都要挂在**本次**调用之下，
      // 而同一步里并排的多个 `spawn_agent` 共用同一个 context 对象 —— 原地改就会互相顶掉（docs/10 §1）。
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
              hint: `${error.ms}ms 内没有返回，本次调用已放弃；换个参数或换个办法，别原样重试。`,
            }
          : {}),
      };
    }
  }
  releaseTurn(turnId: string): void {
    this.#turns.delete(turnId);
  }

  /** 连续失败到上限就在本轮停用，并留一条 warn：排障时要看得见「模型不是没试，是被拦下了」。 */
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
   * 工具页要的那张表：每个**已注册**工具的默认策略、当前生效策略、以及哪几项被放宽了。
   *
   * 由注册表来出这份数据而不是让服务端拿 `TOOL_POLICY` 自己再算一遍：合并逻辑只有一份才不会
   * 出现「面板显示的权限和运行时判的不是一回事」。顺带 MCP / plugin 注册进来的工具也进了这张表
   * —— 之前的 `GET /api/tools` 只枚举 `TOOL_POLICY`，那些工具在面板上根本不存在，而
   * `disabledByOperator` 一直是认它们的。
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
          // 按当前 `tools.catalog.*` **静态**判：这张表没有角色也没有轮次上下文，所以它答的是
          // 「这个工具在这台机器的配置下属于折叠族吗」，不是「某一轮里它被折叠了吗」。
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
    // 按字符边界切（docs/27 · T-04）：裸 `subarray().toString('utf8')` 会把末尾那个多字节字符
    // 切成半个，模型看到的是一串 U+FFFD。
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
