import { z } from 'zod';
import type { Role, RuntimeTurnContext } from '@luoli/shared';
import { elideMiddleBytes, roleRank, untrusted } from '@luoli/shared';
import type { ToolPolicyEntry, ToolName, ToolOverride } from './policy.js';
import { SKILL_NARROWING_EXEMPT, TOOL_POLICY, effectiveToolPolicy, relaxedFields } from './policy.js';
import type { LogSink } from '../log/sink.js';
import { ApprovalRules, type ApprovalRisk } from '../approval/rules.js';
export type { ApprovalRisk } from '../approval/rules.js';
import type { ApprovalPolicy, ToolScope } from './policy.js';

export interface ToolExecutionContext {
  turn: RuntimeTurnContext;
  workspace: string;
  agentKind: 'main' | 'sub';
  agentRunId?: string;
  allow?: ReadonlySet<string>;
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
      execute: async (value, context) => { const output = await input.execute(value, context); return output && typeof output === 'object' ? output as object : { value: output }; } });
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
   * `warn` 标的是「这一次拒绝值得留一条日志」：运维禁用的工具被模型硬调过来是排障线索。
   */
  admit(name: string, context: ToolExecutionContext): { ok: true; tool: RegisteredTool } | { ok: false; error: string; hint?: string; warn?: boolean } {
    const state = this.#state(context.turn.turnId);
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, error: 'tool_unavailable' };
    // 「本轮已经连续失败到被停用」和「这个工具根本不存在」对模型是两回事：前者要让它换个办法，
    // 后者要让它别再猜工具名。混成一句 tool_unavailable 时模型通常继续原地重试到步数耗尽。
    if (state.disabled.has(name)) return { ok: false, error: 'tool_disabled_after_errors', hint: `本轮连续失败 ${this.#limits().maxConsecutiveErrors} 次后已停用，换个办法或如实告诉用户。` };
    // 目录过滤之外再挡一次：模型可能沿用上一步的工具名，运维的禁用必须是硬边界。
    if (this.disabledByOperator(name)) return { ok: false, error: 'tool_disabled_by_operator', warn: true };
    if (roleRank(context.turn.effectiveRole) < roleRank(this.effectivePolicy(tool).minRole)) return { ok: false, error: '权限不足' };
    // active() 的过滤集合必须在这里逐条复查，否则「目录里没有」就成了唯一的边界，而模型完全可以
    // 凭上一步的工具名直接调过来。目前每个相关工具恰好各自 fail-closed，但那是巧合不是设计
    // （docs/20 · W-TOOL-01；docs/05 §220「单一数据源」）。
    if (context.agentKind === 'sub' && name === 'memory_write') return { ok: false, error: 'tool_unavailable_for_subagent' };
    if (tool.available?.(context.turn.effectiveRole, context) === false) return { ok: false, error: 'tool_unavailable' };
    if (context.allow && !context.allow.has(name)) return { ok: false, error: 'tool_not_in_allowlist' };
    if (context.turn.skillAllowedTools?.size && !SKILL_NARROWING_EXEMPT.includes(name as ToolName) && !context.turn.skillAllowedTools.has(name)) return { ok: false, error: 'tool_not_in_allowlist' };
    if (state.calls >= this.#limits().maxCallsPerTurn) return { ok: false, error: 'tool_call_limit_exceeded' };
    return { ok: true, tool };
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
      if (admitted.warn) this.log.event({ level: 'warn', kind: 'tool.disabled', summary: `Blocked disabled tool ${name}`, traceId: context.turn.turnId, data: { tool: name } });
      return { ok: false, error: admitted.error, ...(admitted.hint ? { hint: admitted.hint } : {}) };
    }
    const tool = admitted.tool;
    const state = this.#state(context.turn.turnId);
    const parsed = (tool.inputSchemaFor?.(context) ?? tool.inputSchema).safeParse(rawInput);
    // 参数不合法算一次失败。`maxConsecutiveErrors` 是「模型别原地重试到步数耗尽」的**唯一**硬
    // 边界，而它此前只数 execute 的失败 —— 参数写错和审批被拒这两种最常见的失败一次都不计，
    // 于是同一个错误的调用可以无限次重来（实测 6 次全部照收）。
    if (!parsed.success) { this.#failed(state, name, context); return { ok: false, error: 'invalid_input', hint: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') }; }
    const decision = this.#approvalDecision(tool, parsed.data, context);
    if (decision.needed) {
      const verdict = await this.approval.request(tool, parsed.data, context, decision.risk);
      const approved = typeof verdict === 'boolean' ? verdict : verdict.approved;
      const hint = typeof verdict === 'boolean' ? undefined : verdict.hint;
      // 被拒同样计一次失败：owner 连着拒两次之后模型该换个做法，而不是把同一个高危调用
      // 改个字再递上来 —— 每一次都是一条推给 owner 的审批通知。
      if (!approved) { this.#failed(state, name, context); return { ok: false, error: '未获批准', ...(hint ? { hint } : {}) }; }
    }
    state.calls += 1;
    // 记在这里而不是 `admit()` 之后：被拒的参数、被拒的审批都不算「调用过工具」，
    // 数进去的话轮次统计会比模型真正做过的事多出一截。子 agent 的调用也算在本轮账上
    // （`context.turn.turnId` 对父子是同一个），与 `model_calls` 的口径一致。
    this.turns?.incrementToolCall(context.turn.turnId);
    await this.hooks?.hook('onToolCall', { name, input: parsed.data, context });
    const span = this.log.span({ level: 'info', kind: 'tool.call', summary: name, traceId: context.turn.turnId, chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key, data: { input: parsed.data } });
    // 挂住的工具调用会挂住整轮：AI SDK 的 toolMs 只是把一个信号递给 execute()，工具不认它就等于
    // 没有超时。这里改成硬 race —— 到点就把失败交回模型，让它换个做法，而不是让用户对着沉默
    // 一直等到 `turnTimeoutMs`（logs/2026-08-17 有 7 轮只有 turn.start 没有 turn.end）。
    // `timeoutMs === null` 的分支必须在最前面：bash / python / spawn_agent / spawn_harness /
    // ask_parent 各有自己的硬期限，运维从工具页给它们套一层外层 race 会在它们自己的超时之前
    // 把调用砍掉（工具页对这几个置灰，这里是不信界面的那道兜底）。
    const budget = tool.timeoutMs === null ? null
      : this.#overrides()[name]?.timeoutMs ?? tool.timeoutMs ?? this.#limits().defaultTimeoutMs ?? FALLBACK_TOOL_TIMEOUT_MS;
    try {
      const called = tool.execute(parsed.data, context);
      const rawOutput = budget === null ? await called : await withTimeout(called, budget);
      const output = this.#normalizeOutput(name, rawOutput, tool.untrustedOutput === true);
      await this.hooks?.hook('onToolResult', { name, input: parsed.data, output, context });
      if ('ok' in output && output.ok === false) this.#failed(state, name, context);
      else state.failures[name] = 0;
      span.end({ output });
      return output;
    } catch (error) {
      this.#failed(state, name, context);
      span.end(undefined, error);
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
    const serialized = JSON.stringify(output);
    // 按字符边界切（docs/27 · T-04）：裸 `subarray().toString('utf8')` 会把末尾那个多字节字符
    // 切成半个，模型看到的是一串 U+FFFD。
    const { value, truncated } = elideMiddleBytes(serialized, max, (omitted) => `\n…省略 ${omitted} bytes…\n`);
    if (!wrap && !truncated) return output;
    return { ok: !('ok' in output) || output.ok !== false, content: wrap ? untrusted(`tool:${name}`, value) : value, truncated };
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
