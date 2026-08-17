import { z } from 'zod';
import type { Role, RuntimeTurnContext } from '@luoli/shared';
import { roleRank, untrusted } from '@luoli/shared';
import type { ToolPolicyEntry, ToolName } from './policy.js';
import { SKILL_NARROWING_EXEMPT, TOOL_POLICY } from './policy.js';
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
  /** 运维在 WebUI 上关掉的工具。用 getter 读取，保证配置热更新后立即生效。 */
  #overrides: () => Readonly<Record<string, { enabled?: boolean }>> = () => ({});
  /** limits 与 approvalRules 同样接受 getter：两者在 doc 11 都标着热更新，吃快照就是冻住
   *  （新增的高危命令规则要重启才生效，docs/20 · W-CFG-02）。 */
  constructor(private readonly log: LogSink, private readonly approval: ApprovalBroker, limits: ToolLimits | (() => ToolLimits), approvalRules: readonly unknown[] | (() => readonly unknown[]) = [], private readonly hooks?: { hook(name: string, ...arguments_: unknown[]): Promise<unknown[]> }) {
    this.#limits = typeof limits === 'function' ? limits : () => limits;
    this.#rulesSource = typeof approvalRules === 'function' ? approvalRules : () => approvalRules;
  }

  /** 规则数组换了对象身份才重建：`configStore.replace` 每次都给出新数组，热重载因此自动生效。 */
  #approvalRules(): ApprovalRules {
    const source = this.#rulesSource();
    if (!this.#rulesCache || this.#rulesCache.source !== source) this.#rulesCache = { source, rules: new ApprovalRules(source) };
    return this.#rulesCache.rules;
  }

  bindOverrides(overrides: () => Readonly<Record<string, { enabled?: boolean }>>): void {
    this.#overrides = overrides;
  }

  disabledByOperator(name: string): boolean {
    return this.#overrides()[name]?.enabled === false;
  }

  register<I>(tool: RegisteredTool<I>): void {
    if (this.#tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.#tools.set(tool.name, tool as RegisteredTool);
  }
  registerExternal(input: { name: string; description: string; inputSchema: z.ZodType<unknown>; minRole: Role; approval?: ApprovalPolicy; scope?: ToolScope; source: 'plugin' | 'mcp'; execute: (input: unknown) => Promise<unknown> | unknown }): boolean {
    const existing = this.#tools.get(input.name);
    if (existing && existing.policy.source !== input.source) {
      this.log.event({ level: 'warn', kind: 'tool.external_conflict', summary: `External tool conflict: ${input.name}`, data: { source: input.source, existing: existing.policy.source } });
      return false;
    }
    this.#tools.set(input.name, { name: input.name, description: input.description, inputSchema: input.inputSchema,
      policy: { minRole: input.minRole, approval: input.approval ?? 'conditional', scope: input.scope ?? 'global', source: input.source },
      sourcePriority: input.source === 'plugin' ? 60 : 40, untrustedOutput: true,
      execute: async (value) => { const output = await input.execute(value); return output && typeof output === 'object' ? output as object : { value: output }; } });
    return true;
  }

  unregisterBySource(source: 'plugin' | 'mcp'): void {
    for (const [name, tool] of this.#tools) if (tool.policy.source === source) this.#tools.delete(name);
  }

  active(role: Role, context: ToolExecutionContext, allow?: string[]): RegisteredTool[] {
    const state = this.#state(context.turn.turnId);
    const tools = [...this.#tools.values()]
      .filter((tool) => roleRank(role) >= roleRank(tool.policy.minRole))
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

  async execute(name: string, rawInput: unknown, context: ToolExecutionContext): Promise<object> {
    const state = this.#state(context.turn.turnId);
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, error: 'tool_unavailable' };
    // 「本轮已经连续失败到被停用」和「这个工具根本不存在」对模型是两回事：前者要让它换个办法，
    // 后者要让它别再猜工具名。混成一句 tool_unavailable 时模型通常继续原地重试到步数耗尽。
    if (state.disabled.has(name)) return { ok: false, error: 'tool_disabled_after_errors', hint: `本轮连续失败 ${this.#limits().maxConsecutiveErrors} 次后已停用，换个办法或如实告诉用户。` };
    // 目录过滤之外再挡一次：模型可能沿用上一步的工具名，运维的禁用必须是硬边界。
    if (this.disabledByOperator(name)) { this.log.event({ level: 'warn', kind: 'tool.disabled', summary: `Blocked disabled tool ${name}`, traceId: context.turn.turnId, data: { tool: name } }); return { ok: false, error: 'tool_disabled_by_operator' }; }
    if (roleRank(context.turn.effectiveRole) < roleRank(tool.policy.minRole)) return { ok: false, error: '权限不足' };
    // active() 的过滤集合必须在这里逐条复查，否则「目录里没有」就成了唯一的边界，而模型完全可以
    // 凭上一步的工具名直接调过来。目前每个相关工具恰好各自 fail-closed，但那是巧合不是设计
    // （docs/20 · W-TOOL-01；docs/05 §220「单一数据源」）。
    if (context.agentKind === 'sub' && name === 'memory_write') return { ok: false, error: 'tool_unavailable_for_subagent' };
    if (tool.available?.(context.turn.effectiveRole, context) === false) return { ok: false, error: 'tool_unavailable' };
    if (context.allow && !context.allow.has(name)) return { ok: false, error: 'tool_not_in_allowlist' };
    if (context.turn.skillAllowedTools?.size && !SKILL_NARROWING_EXEMPT.includes(name as ToolName) && !context.turn.skillAllowedTools.has(name)) return { ok: false, error: 'tool_not_in_allowlist' };
    if (state.calls >= this.#limits().maxCallsPerTurn) return { ok: false, error: 'tool_call_limit_exceeded' };
    const parsed = (tool.inputSchemaFor?.(context) ?? tool.inputSchema).safeParse(rawInput);
    // 参数不合法算一次失败。`maxConsecutiveErrors` 是「模型别原地重试到步数耗尽」的**唯一**硬
    // 边界，而它此前只数 execute 的失败 —— 参数写错和审批被拒这两种最常见的失败一次都不计，
    // 于是同一个错误的调用可以无限次重来（实测 6 次全部照收）。
    if (!parsed.success) { this.#failed(state, name, context); return { ok: false, error: 'invalid_input', hint: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') }; }
    // `approvalFor` 让工具按**本轮配置**把自己抬进审批（`memory.pubWriteRequiresApproval` 就是
    // 这么接的）。它只能抬高，不能放低 —— 否则一个工具就能把自己从注册期定死的审批档位里摘出去。
    const escalated = tool.approvalFor?.(parsed.data, context);
    const effective = escalated === 'always' || tool.policy.approval === 'always' ? 'always'
      : escalated === 'conditional' || tool.policy.approval === 'conditional' ? 'conditional' : tool.policy.approval;
    const decision = effective === 'always'
      ? { needed: true, risk: 'high' as const }
      : effective === 'conditional'
        ? this.#approvalRules().evaluate(tool, parsed.data, context)
        : { needed: false, risk: 'low' as const };
    if (decision.needed) {
      const verdict = await this.approval.request(tool, parsed.data, context, decision.risk);
      const approved = typeof verdict === 'boolean' ? verdict : verdict.approved;
      const hint = typeof verdict === 'boolean' ? undefined : verdict.hint;
      // 被拒同样计一次失败：owner 连着拒两次之后模型该换个做法，而不是把同一个高危调用
      // 改个字再递上来 —— 每一次都是一条推给 owner 的审批通知。
      if (!approved) { this.#failed(state, name, context); return { ok: false, error: '未获批准', ...(hint ? { hint } : {}) }; }
    }
    state.calls += 1;
    await this.hooks?.hook('onToolCall', { name, input: parsed.data, context });
    const span = this.log.span({ level: 'info', kind: 'tool.call', summary: name, traceId: context.turn.turnId, chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key, data: { input: parsed.data } });
    // 挂住的工具调用会挂住整轮：AI SDK 的 toolMs 只是把一个信号递给 execute()，工具不认它就等于
    // 没有超时。这里改成硬 race —— 到点就把失败交回模型，让它换个做法，而不是让用户对着沉默
    // 一直等到 `turnTimeoutMs`（logs/2026-08-17 有 7 轮只有 turn.start 没有 turn.end）。
    const budget = tool.timeoutMs === null ? null : tool.timeoutMs ?? this.#limits().defaultTimeoutMs ?? FALLBACK_TOOL_TIMEOUT_MS;
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

  #normalizeOutput(name: string, output: object, wrap: boolean): object {
    const max = this.#limits().maxOutputBytes ?? 65_536;
    const serialized = JSON.stringify(output);
    let value = serialized;
    let truncated = false;
    if (Buffer.byteLength(serialized) > max) {
      const buffer = Buffer.from(serialized);
      const half = Math.floor(max / 2);
      value = `${buffer.subarray(0, half).toString('utf8')}\n…省略 ${buffer.length - max} bytes…\n${buffer.subarray(-half).toString('utf8')}`;
      truncated = true;
    }
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
