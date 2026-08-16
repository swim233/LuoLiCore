import { z } from 'zod';
import type { Role, RuntimeTurnContext } from '@luoli/shared';
import { roleRank, untrusted } from '@luoli/shared';
import type { ToolPolicyEntry } from './policy.js';
import { TOOL_POLICY } from './policy.js';
import type { LogSink } from '../log/sink.js';
import { ApprovalRules, type ApprovalRisk } from '../approval/rules.js';
export type { ApprovalRisk } from '../approval/rules.js';
import type { ApprovalPolicy, ToolScope } from './policy.js';

export interface ToolExecutionContext {
  turn: RuntimeTurnContext;
  workspace: string;
  agentKind: 'main' | 'sub';
  agentRunId?: string;
}

export interface RegisteredTool<I = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  inputSchemaFor?(context: ToolExecutionContext): z.ZodType<I>;
  policy: ToolPolicyEntry;
  sourcePriority: number;
  untrustedOutput?: boolean;
  available?(role: Role, context: ToolExecutionContext): boolean;
  approvalTargetExists?(input: unknown, context: ToolExecutionContext): boolean;
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
  constructor(private readonly log: LogSink, private readonly approval: ApprovalBroker, limits: ToolLimits | (() => ToolLimits), approvalRules: readonly unknown[] | (() => readonly unknown[]) = []) {
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
    if (!tool || state.disabled.has(name)) return { ok: false, error: 'tool_unavailable' };
    // 目录过滤之外再挡一次：模型可能沿用上一步的工具名，运维的禁用必须是硬边界。
    if (this.disabledByOperator(name)) { this.log.event({ level: 'warn', kind: 'tool.disabled', summary: `Blocked disabled tool ${name}`, traceId: context.turn.turnId, data: { tool: name } }); return { ok: false, error: 'tool_disabled_by_operator' }; }
    if (roleRank(context.turn.effectiveRole) < roleRank(tool.policy.minRole)) return { ok: false, error: '权限不足' };
    // active() 的过滤集合必须在这里逐条复查，否则「目录里没有」就成了唯一的边界，而模型完全可以
    // 凭上一步的工具名直接调过来。目前每个相关工具恰好各自 fail-closed，但那是巧合不是设计
    // （docs/20 · W-TOOL-01；docs/05 §220「单一数据源」）。
    if (context.agentKind === 'sub' && name === 'memory_write') return { ok: false, error: 'tool_unavailable_for_subagent' };
    if (tool.available?.(context.turn.effectiveRole, context) === false) return { ok: false, error: 'tool_unavailable' };
    if (state.calls >= this.#limits().maxCallsPerTurn) return { ok: false, error: 'tool_call_limit_exceeded' };
    const parsed = (tool.inputSchemaFor?.(context) ?? tool.inputSchema).safeParse(rawInput);
    if (!parsed.success) return { ok: false, error: 'invalid_input', hint: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
    const decision = tool.policy.approval === 'always'
      ? { needed: true, risk: 'high' as const }
      : tool.policy.approval === 'conditional'
        ? this.#approvalRules().evaluate(tool, parsed.data, context)
        : { needed: false, risk: 'low' as const };
    if (decision.needed) {
      const verdict = await this.approval.request(tool, parsed.data, context, decision.risk);
      const approved = typeof verdict === 'boolean' ? verdict : verdict.approved;
      const hint = typeof verdict === 'boolean' ? undefined : verdict.hint;
      if (!approved) return { ok: false, error: '未获批准', ...(hint ? { hint } : {}) };
    }
    state.calls += 1;
    const span = this.log.span({ level: 'info', kind: 'tool.call', summary: name, traceId: context.turn.turnId, chatId: context.turn.chatId, userId: context.turn.initiatorUserId, key: context.turn.key, data: { input: parsed.data } });
    try {
      const rawOutput = await tool.execute(parsed.data, context);
      const output = this.#normalizeOutput(name, rawOutput, tool.untrustedOutput === true);
      if ('ok' in output && output.ok === false) {
        state.failures[name] = (state.failures[name] ?? 0) + 1;
        if (state.failures[name] >= this.#limits().maxConsecutiveErrors) state.disabled.add(name);
      } else {
        state.failures[name] = 0;
      }
      span.end({ output });
      return output;
    } catch (error) {
      state.failures[name] = (state.failures[name] ?? 0) + 1;
      if (state.failures[name] >= this.#limits().maxConsecutiveErrors) state.disabled.add(name);
      span.end(undefined, error);
      return { ok: false, error: error instanceof Error ? error.message : 'tool_error' };
    }
  }
  releaseTurn(turnId: string): void { this.#turns.delete(turnId); }

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
