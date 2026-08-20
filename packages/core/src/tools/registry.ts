import { z } from 'zod';
import type { Role, RuntimeTurnContext } from '@luoli/shared';
import { elideMiddleBytes, roleRank, untrusted } from '@luoli/shared';
import type { ToolPolicyEntry, ToolName, ToolOverride } from './policy.js';
import { SKILL_NARROWING_EXEMPT, TOOL_POLICY, effectiveToolPolicy, relaxedFields } from './policy.js';
import type { LogSink, LogSpan } from '../log/sink.js';
import { ApprovalRules, type ApprovalRisk } from '../approval/rules.js';
export type { ApprovalRisk } from '../approval/rules.js';
import type { ApprovalPolicy, ToolScope } from './policy.js';

export interface ToolExecutionContext {
  turn: RuntimeTurnContext;
  workspace: string;
  agentKind: 'main' | 'sub';
  agentRunId?: string;
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
export type ToolDenyReason = 'unknown_tool' | 'disabled_after_errors' | 'disabled_by_operator' | 'role'
  | 'subagent' | 'unavailable' | 'allowlist' | 'skill_narrowed' | 'rate' | 'approval';

/** `hint` 是给模型看的：被拒时它需要知道「为什么」才能用自己的话回复，而不是干巴巴一句「未获批准」。 */
export interface ApprovalVerdict {
  approved: boolean;
  hint?: string;
}

export interface ApprovalBroker {
  request(tool: RegisteredTool, input: unknown, context: ToolExecutionContext, risk: ApprovalRisk): Promise<boolean | ApprovalVerdict>;
}

interface ToolLimits {
  maxRegistered: number;
  maxCallsPerTurn: number;
  maxConsecutiveErrors: number;
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
}

/** 注册期之后才出现的工具来源。`builtin` / `agent` 是编译期的，不走 `registerExternal`。 */
export type ExternalToolSource = 'plugin' | 'mcp' | 'custom';
/**
 * 目录溢出（`tools.maxRegistered`）时的截断优先级：内建 100 > agent 90 > load_skill 80 >
 * plugin 60 > mcp 40 > custom 30。自撰写的排最后 —— 模型可以一口气造二十个，让它先挤掉
 * 运维显式配的 MCP 是错的方向。
 */
const EXTERNAL_SOURCE_PRIORITY: Record<ExternalToolSource, number> = { plugin: 60, mcp: 40, custom: 30 };

/**
 * 工具输出里骑着的图片（`web_fetch` 抓回来的图、MCP 的截图）。
 *
 * **序列化之前就要摘出去。** 一张 base64 图有几百 KB，留在 JSON 里是双重损坏：
 * ① 它自己撞上 `tools.maxOutputBytes`（64KB）被 `elideMiddleBytes` 从中间截半，而截半的
 * base64 会被 provider 整个拒收；② 就算不截，它也会把模型真正要读的那几行挤出预算。
 * 摘出来之后由 `toolModelOutput` 交给 provider 的多模态 tool-result 形状（`agent/runtime.ts`）。
 */
export interface ToolMedia { mediaType: string; data: string }
/**
 * 外部工具（MCP / plugin）交回的图片往哪去。实现是 `media/web-assets.ts` 的 `captureImage`
 * —— 与 `web_fetch` 同一条路径，所以「存哪、怎么归一化、vision 不可用时怎么如实说」只有一份。
 */
export interface ToolMediaSink {
  capture(context: ToolExecutionContext, input: { label: string; mediaType: string; body: Buffer }):
  Promise<{ ok: true; assetId: string; mediaType: string; data: string } | { ok: false; error: string; hint: string }>;
}
export function splitToolMedia(output: object): { media: ToolMedia[]; rest: Record<string, unknown> } {
  const { media, ...rest } = output as Record<string, unknown> & { media?: unknown };
  const values = Array.isArray(media) ? media.filter((entry): entry is ToolMedia => Boolean(entry) && typeof entry === 'object'
    && typeof (entry as ToolMedia).mediaType === 'string' && typeof (entry as ToolMedia).data === 'string') : [];
  // 一条都不合形状时**原样交回**：`media` 有可能只是某个工具自己的普通字段。
  return values.length ? { media: values, rest } : { media: [], rest: output as Record<string, unknown> };
}

const FALLBACK_TOOL_TIMEOUT_MS = 60_000;
class ToolTimeout extends Error {
  constructor(readonly ms: number) { super('tool_timeout'); }
}
/**
 * 超时之后只能「不再等」：没有办法真正取消一个任意工具的执行（沙箱有自己的 kill，MCP 有自己的
 * timeout，插件什么都没有）。丢掉这个 promise 让本轮继续往下走 —— `Promise.race` 已经给它挂了
 * 处理器，晚到的拒绝不会变成 unhandledRejection 打崩进程。
 */
async function withTimeout<T>(work: Promise<T> | T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolTimeout(ms)), ms); })]);
  } finally { clearTimeout(timer); }
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
  #rulesCache: { source: readonly unknown[]; rules: ApprovalRules } | null = null;
  /** 运维在 WebUI 上按下的那份覆盖（启停 + minRole/审批/超时）。用 getter 读取，保证配置热更新后立即生效。 */
  #overrides: () => Readonly<Record<string, ToolOverride>> = () => ({});
  /** limits 与 approvalRules 同样接受 getter：两者在 doc 11 都标着热更新，吃快照就是冻住
   *  （新增的高危命令规则要重启才生效，docs/20 · W-CFG-02）。 */
  constructor(private readonly log: LogSink, private readonly approval: ApprovalBroker, limits: ToolLimits | (() => ToolLimits), approvalRules: readonly unknown[] | (() => readonly unknown[]) = [], private readonly hooks?: { hook(name: string, ...arguments_: unknown[]): Promise<unknown[]> },
    /**
     * 只用来记 `turns.tool_calls`。`TurnRepository.incrementToolCall` 从头就没有调用者，
     * 全库这一列恒为 0 —— WebUI 轮次列表与 `turn.finished` 事件里的工具调用数一直是假的。
     * 可选：测试与子 agent 的注册表都不必给。
     */
    private readonly turns?: { incrementToolCall(id: string): void }) {
    this.#limits = typeof limits === 'function' ? limits : () => limits;
    this.#rulesSource = typeof approvalRules === 'function' ? approvalRules : () => approvalRules;
  }

  /** 规则数组换了对象身份才重建：`configStore.replace` 每次都给出新数组，热重载因此自动生效。 */
  #approvalRules(): ApprovalRules {
    const source = this.#rulesSource();
    if (!this.#rulesCache || this.#rulesCache.source !== source) this.#rulesCache = { source, rules: new ApprovalRules(source) };
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
  async #absorbExternalMedia(name: string, output: object, context: ToolExecutionContext): Promise<object> {
    const sink = this.#media;
    const content = (output as { content?: unknown }).content;
    if (!sink || !Array.isArray(content)) return output;
    const absorbed: ToolMedia[] = [];
    const rewritten: unknown[] = [];
    for (const entry of content) {
      const part = entry as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
      if (part?.type !== 'image' || typeof part.data !== 'string' || !part.data) { rewritten.push(entry); continue; }
      const mediaType = typeof part.mimeType === 'string' && part.mimeType ? part.mimeType : 'image/png';
      const captured = await sink.capture(context, { label: name, mediaType, body: Buffer.from(part.data, 'base64') });
      if (!captured.ok) { rewritten.push({ type: 'text', text: `[图片没能放进上下文：${captured.error}]${captured.hint}` }); continue; }
      absorbed.push({ mediaType: captured.mediaType, data: captured.data });
      rewritten.push({ type: 'text', text: `[图片已放进本轮上下文（${captured.mediaType}），直接看即可]` });
    }
    return absorbed.length ? { ...output, content: rewritten, media: absorbed } : output;
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
    if (this.#tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
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
  registerExternal(input: { name: string; description: string; inputSchema: z.ZodType<unknown>; minRole: Role; approval?: ApprovalPolicy; scope?: ToolScope; source: ExternalToolSource;
    available?: (role: Role, context: ToolExecutionContext) => boolean; timeoutMs?: number | null;
    execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown> | unknown }): boolean {
    const existing = this.#tools.get(input.name);
    if (existing && existing.policy.source !== input.source) {
      this.log.event({ level: 'warn', kind: 'tool.external_conflict', summary: `External tool conflict: ${input.name}`, data: { source: input.source, existing: existing.policy.source } });
      return false;
    }
    this.#tools.set(input.name, { name: input.name, description: input.description, inputSchema: input.inputSchema,
      policy: { minRole: input.minRole, approval: input.approval ?? 'conditional', scope: input.scope ?? 'global', source: input.source },
      sourcePriority: EXTERNAL_SOURCE_PRIORITY[input.source], untrustedOutput: true,
      ...(input.available ? { available: input.available } : {}), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      execute: async (value, context) => {
        const output = await input.execute(value, context);
        return await this.#absorbExternalMedia(input.name, output && typeof output === 'object' ? output as object : { value: output }, context);
      } });
    return true;
  }

  unregisterBySource(source: ExternalToolSource): void {
    for (const [name, tool] of this.#tools) if (tool.policy.source === source) this.#tools.delete(name);
  }

  active(role: Role, context: ToolExecutionContext, allow?: string[]): RegisteredTool[] {
    const state = this.#state(context.turn.turnId);
    const tools = [...this.#tools.values()]
      .filter((tool) => roleRank(role) >= roleRank(this.effectivePolicy(tool).minRole))
      .filter((tool) => !this.disabledByOperator(tool.name))
      .filter((tool) => !state.disabled.has(tool.name))
      .filter((tool) => !allow || allow.includes(tool.name))
      .filter((tool) => !(context.agentKind === 'sub' && tool.name === 'memory_write'))
      .filter((tool) => tool.available?.(role, context) !== false)
      .map((tool) => tool.inputSchemaFor ? { ...tool, inputSchema: tool.inputSchemaFor(context) } : tool)
      .sort((a, b) => b.sourcePriority - a.sourcePriority || a.name.localeCompare(b.name));
    if (tools.length > this.#limits().maxRegistered) this.log.event({ level: 'warn', kind: 'tool.registry_truncated', summary: `Registered tool limit ${this.#limits().maxRegistered}`, traceId: context.turn.turnId, data: { total: tools.length, visible: this.#limits().maxRegistered } });
    return tools.slice(0, this.#limits().maxRegistered);
  }

  activeNames(role: Role, context: ToolExecutionContext, allow?: string[]): string[] {
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
  admit(name: string, context: ToolExecutionContext): { ok: true; tool: RegisteredTool } | { ok: false; error: string; hint?: string; warn?: boolean; reason: ToolDenyReason } {
    const state = this.#state(context.turn.turnId);
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, error: 'tool_unavailable', reason: 'unknown_tool' };
    // 「本轮已经连续失败到被停用」和「这个工具根本不存在」对模型是两回事：前者要让它换个办法，
    // 后者要让它别再猜工具名。混成一句 tool_unavailable 时模型通常继续原地重试到步数耗尽。
    if (state.disabled.has(name)) return { ok: false, error: 'tool_disabled_after_errors', reason: 'disabled_after_errors', hint: `本轮连续失败 ${this.#limits().maxConsecutiveErrors} 次后已停用，换个办法或如实告诉用户。` };
    // 目录过滤之外再挡一次：模型可能沿用上一步的工具名，运维的禁用必须是硬边界。
    if (this.disabledByOperator(name)) return { ok: false, error: 'tool_disabled_by_operator', reason: 'disabled_by_operator', warn: true };
    if (roleRank(context.turn.effectiveRole) < roleRank(this.effectivePolicy(tool).minRole)) return { ok: false, error: '权限不足', reason: 'role' };
    // active() 的过滤集合必须在这里逐条复查，否则「目录里没有」就成了唯一的边界，而模型完全可以
    // 凭上一步的工具名直接调过来。目前每个相关工具恰好各自 fail-closed，但那是巧合不是设计
    // （docs/20 · W-TOOL-01；docs/05 §220「单一数据源」）。
    if (context.agentKind === 'sub' && name === 'memory_write') return { ok: false, error: 'tool_unavailable_for_subagent', reason: 'subagent' };
    if (tool.available?.(context.turn.effectiveRole, context) === false) return { ok: false, error: 'tool_unavailable', reason: 'unavailable' };
    if (context.allow && !context.allow.has(name)) return { ok: false, error: 'tool_not_in_allowlist', reason: 'allowlist' };
    if (context.turn.skillAllowedTools?.size && !SKILL_NARROWING_EXEMPT.includes(name as ToolName) && !context.turn.skillAllowedTools.has(name)) return { ok: false, error: 'tool_not_in_allowlist', reason: 'skill_narrowed' };
    if (state.calls >= this.#limits().maxCallsPerTurn) return { ok: false, error: 'tool_call_limit_exceeded', reason: 'rate' };
    return { ok: true, tool };
  }

  /** 一次拒绝落一条 `tool.denied`。`error` 是给模型看的那句，`reason` 是给日志与排障用的档位。 */
  #denied(name: string, context: ToolExecutionContext, reason: ToolDenyReason, error: string): void {
    this.log.event({ level: 'warn', kind: 'tool.denied', summary: `${name}: ${reason}`, traceId: context.turn.turnId,
      ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
      chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key,
      data: { tool: name, reason, role: context.turn.effectiveRole, error } });
  }

  /**
   * 审批档位合并。`approvalFor` 让工具按**本轮配置**把自己抬进审批（`memory.pubWriteRequiresApproval`
   * 就是这么接的）。它只能抬高，不能放低 —— 否则一个工具就能把自己从注册期定死的档位里摘出去。
   *
   * 运维覆盖设的是**基准档**，同样只参与这次取最严：把 `memory_write` 的基准改成 `never`，
   * `approvalFor` 该抬还是抬（docs/09 §3.7）。
   */
  #approvalDecision(tool: RegisteredTool, input: unknown, context: ToolExecutionContext): { needed: boolean; risk: ApprovalRisk } {
    const escalated = tool.approvalFor?.(input, context);
    const base = this.effectivePolicy(tool).approval;
    const effective = escalated === 'always' || base === 'always' ? 'always'
      : escalated === 'conditional' || base === 'conditional' ? 'conditional' : base;
    if (effective === 'always') return { needed: true, risk: 'high' };
    if (effective === 'conditional') return this.#approvalRules().evaluate(tool, input, context);
    return { needed: false, risk: 'low' };
  }

  async execute(name: string, rawInput: unknown, context: ToolExecutionContext): Promise<object> {
    const admitted = this.admit(name, context);
    if (!admitted.ok) {
      // 两条日志不是重复：`tool.denied` 是准入闸的统一流水（每一次拒绝一行，带档位），
      // `tool.disabled` 是「运维在界面上关掉的东西被模型硬调过来」这一档的运维视角凭据。
      this.#denied(name, context, admitted.reason, admitted.error);
      if (admitted.warn) this.log.event({ level: 'warn', kind: 'tool.disabled', summary: `Blocked disabled tool ${name}`, traceId: context.turn.turnId, data: { tool: name } });
      return { ok: false, error: admitted.error, ...(admitted.hint ? { hint: admitted.hint } : {}) };
    }
    const tool = admitted.tool;
    const state = this.#state(context.turn.turnId);
    const parsed = (tool.inputSchemaFor?.(context) ?? tool.inputSchema).safeParse(rawInput);
    // 参数不合法算一次失败。`maxConsecutiveErrors` 是「模型别原地重试到步数耗尽」的**唯一**硬
    // 边界，而它此前只数 execute 的失败 —— 参数写错和审批被拒这两种最常见的失败一次都不计，
    // 于是同一个错误的调用可以无限次重来（实测 6 次全部照收）。
    if (!parsed.success) {
      this.#failed(state, name, context);
      const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      // 与 `runtime.ts` 那条 `tool.error` 同一个 kind：从模型的角度这是同一件事（参数写错了），
      // 只是这一份是 AI SDK 放过、被 `inputSchemaFor` 收窄后的 schema 拦下的那一档（docs/28 · L-LOG-03）。
      this.log.event({ level: 'warn', kind: 'tool.error', summary: `${name}: invalid_input`, traceId: context.turn.turnId,
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key,
        data: { tool: name, errorKind: 'invalid_input', message: detail.slice(0, 500) } });
      return { ok: false, error: 'invalid_input', hint: detail };
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
        const verdict = await this.approval.request(tool, parsed.data, context, decision.risk);
        const approved = typeof verdict === 'boolean' ? verdict : verdict.approved;
        const hint = typeof verdict === 'boolean' ? undefined : verdict.hint;
        // 被拒同样计一次失败：owner 连着拒两次之后模型该换个做法，而不是把同一个高危调用
        // 改个字再递上来 —— 每一次都是一条推给 owner 的审批通知。
        if (!approved) { this.#failed(state, name, context); this.#denied(name, context, 'approval', '未获批准'); return { ok: false, error: '未获批准', ...(hint ? { hint } : {}) }; }
      }
      state.calls += 1;
      // 记在这里而不是 `admit()` 之后：被拒的参数、被拒的审批都不算「调用过工具」，
      // 数进去的话轮次统计会比模型真正做过的事多出一截。子 agent 的调用也算在本轮账上
      // （`context.turn.turnId` 对父子是同一个），与 `model_calls` 的口径一致。
      this.turns?.incrementToolCall(context.turn.turnId);
      await this.hooks?.hook('onToolCall', { name, input: parsed.data, context });
      span = this.log.span({ level: 'info', kind: 'tool.call', summary: name, traceId: context.turn.turnId,
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key, data: { input: parsed.data } });
      // 挂住的工具调用会挂住整轮：AI SDK 的 toolMs 只是把一个信号递给 execute()，工具不认它就等于
      // 没有超时。这里改成硬 race —— 到点就把失败交回模型，让它换个做法，而不是让用户对着沉默
      // 一直等到 `turnTimeoutMs`（logs/2026-08-17 有 7 轮只有 turn.start 没有 turn.end）。
      // `timeoutMs === null` 的分支必须在最前面：bash / python / spawn_agent / spawn_harness /
      // ask_parent 各有自己的硬期限，运维从工具页给它们套一层外层 race 会在它们自己的超时之前
      // 把调用砍掉（工具页对这几个置灰，这里是不信界面的那道兜底）。
      const budget = tool.timeoutMs === null ? null
        : this.#overrides()[name]?.timeoutMs ?? tool.timeoutMs ?? this.#limits().defaultTimeoutMs ?? FALLBACK_TOOL_TIMEOUT_MS;
      // **浅拷贝一份**，不改共享的 context：这一层往下的 span（子 agent 的 `agent.run`、
      // `ask_parent` 的 `agent.ask`、`send_message` 的 `tg.send`）都要挂在**本次**调用之下，
      // 而同一步里并排的多个 `spawn_agent` 共用同一个 context 对象 —— 原地改就会互相顶掉（docs/10 §1）。
      const called = tool.execute(parsed.data, { ...context, parentSpanId: span.id });
      const rawOutput = budget === null ? await called : await withTimeout(called, budget);
      const output = this.#normalizeOutput(name, rawOutput, tool.untrustedOutput === true);
      await this.hooks?.hook('onToolResult', { name, input: parsed.data, output, context });
      if ('ok' in output && output.ok === false) this.#failed(state, name, context);
      else state.failures[name] = 0;
      span.end({ output });
      return output;
    } catch (error) {
      this.#failed(state, name, context);
      span?.end(undefined, error);
      return { ok: false, error: error instanceof Error ? error.message : 'tool_error',
        ...(error instanceof ToolTimeout ? { hint: `${error.ms}ms 内没有返回，本次调用已放弃；换个参数或换个办法，别原样重试。` } : {}) };
    }
  }
  releaseTurn(turnId: string): void { this.#turns.delete(turnId); }

  /** 连续失败到上限就在本轮停用，并留一条 warn：排障时要看得见「模型不是没试，是被拦下了」。 */
  #failed(state: TurnToolState, name: string, context: ToolExecutionContext): void {
    state.failures[name] = (state.failures[name] ?? 0) + 1;
    if (state.failures[name]! < this.#limits().maxConsecutiveErrors || state.disabled.has(name)) return;
    state.disabled.add(name);
    this.log.event({ level: 'warn', kind: 'tool.disabled_after_errors', summary: `Disabled ${name} after ${state.failures[name]} failures`, traceId: context.turn.turnId, key: context.turn.key, data: { tool: name, failures: state.failures[name] } });
  }

  catalog(role: Role, context: ToolExecutionContext): Array<{ name: string; description: string; policy: ToolPolicyEntry }> {
    return this.active(role, context).map(({ name, description, policy }) => ({ name, description, policy }));
  }

  /**
   * 工具页要的那张表：每个**已注册**工具的默认策略、当前生效策略、以及哪几项被放宽了。
   *
   * 由注册表来出这份数据而不是让服务端拿 `TOOL_POLICY` 自己再算一遍：合并逻辑只有一份才不会
   * 出现「面板显示的权限和运行时判的不是一回事」。顺带 MCP / plugin 注册进来的工具也进了这张表
   * —— 之前的 `GET /api/tools` 只枚举 `TOOL_POLICY`，那些工具在面板上根本不存在，而
   * `disabledByOperator` 一直是认它们的。
   */
  describe(): Array<{ name: string; description: string; defaults: ToolPolicyEntry; effective: ToolPolicyEntry;
    enabled: boolean; timeoutMs: number | null; defaultTimeoutMs: number | null; selfManagedTimeout: boolean; relaxed: Array<'minRole' | 'approval'> }> {
    const overrides = this.#overrides();
    return [...this.#tools.values()].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => {
      const override = overrides[tool.name];
      const selfManaged = tool.timeoutMs === null;
      const declared = selfManaged ? null : tool.timeoutMs ?? this.#limits().defaultTimeoutMs ?? FALLBACK_TOOL_TIMEOUT_MS;
      return { name: tool.name, description: tool.description, defaults: tool.policy, effective: this.effectivePolicy(tool),
        enabled: override?.enabled !== false, timeoutMs: selfManaged ? null : override?.timeoutMs ?? declared,
        defaultTimeoutMs: declared, selfManagedTimeout: selfManaged, relaxed: relaxedFields(tool.policy, override) };
    });
  }

  #normalizeOutput(name: string, output: object, wrap: boolean): object {
    const max = this.#limits().maxOutputBytes ?? 65_536;
    const { media, rest } = splitToolMedia(output);
    const serialized = JSON.stringify(rest);
    // 按字符边界切（docs/27 · T-04）：裸 `subarray().toString('utf8')` 会把末尾那个多字节字符
    // 切成半个，模型看到的是一串 U+FFFD。
    const { value, truncated } = elideMiddleBytes(serialized, max, (omitted) => `\n…省略 ${omitted} bytes…\n`);
    const carry = media.length ? { media } : {};
    if (!wrap && !truncated) return media.length ? { ...rest, ...carry } : output;
    return { ok: !('ok' in rest) || rest.ok !== false, content: wrap ? untrusted(`tool:${name}`, value) : value, truncated, ...carry };
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
