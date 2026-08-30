import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, newToolScope } from '@luoli/core';
import type { ApprovalBroker, LogSink } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

const broker: ApprovalBroker = { request: async () => true };
const events: Array<{ kind: string; summary: string; data?: unknown }> = [];
const log = { span: () => ({ id: 'span', end: () => undefined }), event: (event: { kind: string; summary: string; data?: unknown }) => events.push(event) } as unknown as LogSink;
const denials = (): Array<{ tool: string; reason: string }> => events.filter((event) => event.kind === 'tool.denied')
  .map((event) => event.data as { tool: string; reason: string });
const turn = { turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'owner', isPrivate: true, baseCommitId: null,
  snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config: {} } satisfies RuntimeTurnContext;
// 这一族测的是工具执行本身，所以视角取 `lw`：主 agent 只调得到 `MAIN_AGENT_TOOLS`
// 那十几个名字，用它跑一个自造的 `hangs` 只会先撞上 `tool_requires_worker`。
const context = { turn, workspace: '.', agentKind: 'lw' as const, ...newToolScope() };
const policy = { minRole: 'limited' as const, approval: 'never' as const, scope: 'global' as const, source: 'builtin' as const };
const limits = { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 2, defaultTimeoutMs: 80 };

// 一个不返回的工具会挂住整轮：AI SDK 的 toolMs 只是把一个 AbortSignal 递给 execute()，工具不认它
// 就等于没有超时。日志里那些「只有 turn.start 没有 turn.end」的轮次就是这么来的 —— 用户对着沉默
// 等到 concurrency.turnTimeoutMs（10 分钟）为止，而模型连一次失败结果都没收到。
describe('tool call timeout', () => {
  it('hands the model a failure instead of waiting forever, and survives the abandoned call rejecting later', async () => {
    const registry = new ToolRegistry(log, broker, limits);
    let settle: ((value: object) => void) | null = null;
    let fail: ((error: Error) => void) | null = null;
    registry.register({ name: 'hangs', description: '', inputSchema: z.object({}), policy, sourcePriority: 1,
      execute: () => new Promise<object>((resolve, reject) => { settle = resolve; fail = reject; }) });
    const started = Date.now();
    const output = await registry.execute('hangs', {}, context) as { ok: boolean; error: string; hint?: string };
    expect(output.ok).toBe(false);
    expect(output.error).toBe('tool_timeout');
    expect(output.hint).toContain('80ms');
    expect(Date.now() - started).toBeLessThan(3000);
    // 放弃等待不等于取消执行（任意工具都取消不了）。晚到的拒绝必须已经被接住，
    // 否则一次工具超时就是一个 unhandledRejection —— 那会直接打崩进程。
    fail!(new Error('late'));
    settle!({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('leaves tools that own their deadline alone', async () => {
    const registry = new ToolRegistry(log, broker, limits);
    registry.register({ name: 'slow', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: null,
      execute: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return { ok: true, done: true }; } });
    expect(await registry.execute('slow', {}, context)).toEqual({ ok: true, done: true });
  });

  it('honours a per-tool budget that is longer than the default', async () => {
    const registry = new ToolRegistry(log, broker, limits);
    registry.register({ name: 'upload', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: 400,
      execute: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return { ok: true, sent: 1 }; } });
    expect(await registry.execute('upload', {}, context)).toEqual({ ok: true, sent: 1 });
  });

  // 「本轮已经连续失败到被停用」和「这个工具根本不存在」对模型是两回事：混成一句 tool_unavailable
  // 时模型通常继续原地重试到步数耗尽，也没法如实告诉用户为什么做不到。
  it('tells the model why a tool went away after repeated failures', async () => {
    events.length = 0;
    const registry = new ToolRegistry(log, broker, limits);
    registry.register({ name: 'flaky', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: 50,
      execute: () => ({ ok: false, error: 'upstream_down' }) });
    expect(await registry.execute('flaky', {}, context)).toEqual({ ok: false, error: 'upstream_down' });
    expect(await registry.execute('flaky', {}, context)).toEqual({ ok: false, error: 'upstream_down' });
    const blocked = await registry.execute('flaky', {}, context) as { error: string; hint: string };
    expect(blocked.error).toBe('tool_disabled_after_errors');
    expect(blocked.hint).toContain('2');
    expect(events.filter((event) => event.kind === 'tool.disabled_after_errors')).toHaveLength(1);
    expect(registry.activeNames('owner', context)).not.toContain('flaky');
  });

  it('resets the failure streak after a success', async () => {
    const registry = new ToolRegistry(log, broker, limits);
    let calls = 0;
    registry.register({ name: 'mixed', description: '', inputSchema: z.object({}), policy, sourcePriority: 1,
      execute: () => { calls += 1; return calls === 2 ? { ok: true } : { ok: false, error: 'blip' }; } });
    await registry.execute('mixed', {}, context);
    await registry.execute('mixed', {}, context);
    expect(await registry.execute('mixed', {}, context)).toEqual({ ok: false, error: 'blip' });
    // 失败-成功-失败 只是 1 连败：停用的门槛是**连续**失败，不是一轮里失败的总次数。
    expect(registry.activeNames('owner', context)).toContain('mixed');
    await registry.execute('mixed', {}, context);
    expect(registry.activeNames('owner', context)).not.toContain('mixed');
  });
});

/**
 * 准入闸的每一次拒绝都要落一条 `tool.denied`。
 *
 * `admit()` 刻意是**只读**判定（不写状态、不记日志），于是整批闸门此前全是静默的：实测 45 次
 * 工具调用恰好 40 条 `tool.call`，超出 `maxCallsPerTurn` 的那 5 次**零日志**，模型侧只收到一句
 * 不带 hint 的 `tool_call_limit_exceeded`；role 不够、allowlist、skill 收窄、subagent 限制同理
 * （docs/28 · L-LOG-01）。所以 `reason` 由 `admit()` 交出来、由 `execute()` 记。
 */
describe('tool.denied 覆盖准入闸的每一档', () => {
  const context2 = { turn: { ...turn, effectiveRole: 'limited' as const }, workspace: '.', agentKind: 'lw' as const, ...newToolScope() };

  it('role 不够、allowlist、两侧的 agentKind、超限、运维禁用各记一条，reason 分得开', async () => {
    events.length = 0;
    const registry = new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 1, maxConsecutiveErrors: 5 });
    registry.register({ name: 'ok_tool', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, execute: () => ({ ok: true }) });
    registry.register({ name: 'owner_only', description: '', inputSchema: z.object({}), policy: { ...policy, minRole: 'owner' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    registry.register({ name: 'memory_write', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, execute: () => ({ ok: true }) });
    registry.bindOverrides(() => ({ blocked_tool: { enabled: false } }));
    registry.register({ name: 'blocked_tool', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, execute: () => ({ ok: true }) });

    await registry.execute('nope', {}, context);
    await registry.execute('owner_only', {}, context2);
    await registry.execute('blocked_tool', {}, context);
    await registry.execute('memory_write', {}, context);
    // `ok_tool` 不在 `MAIN_AGENT_TOOLS` 里，主 agent 视角下过不了 `toolCallableBy` 那道闸。
    await registry.execute('ok_tool', {}, { ...context, agentKind: 'main' as const });
    await registry.execute('ok_tool', {}, { ...context, allow: new Set(['other']) });
    // 这一次真的跑起来，把 maxCallsPerTurn(1) 用掉；下一次就该撞上限。
    expect(await registry.execute('ok_tool', {}, context)).toEqual({ ok: true });
    expect(await registry.execute('ok_tool', {}, context)).toMatchObject({ error: 'tool_call_limit_exceeded' });

    expect(denials()).toEqual([
      { tool: 'nope', reason: 'unknown_tool', role: 'owner', error: 'tool_unavailable' },
      { tool: 'owner_only', reason: 'role', role: 'limited', error: '权限不足' },
      { tool: 'blocked_tool', reason: 'disabled_by_operator', role: 'owner', error: 'tool_disabled_by_operator' },
      { tool: 'memory_write', reason: 'worker', role: 'owner', error: 'tool_unavailable_for_worker' },
      { tool: 'ok_tool', reason: 'main_agent', role: 'owner', error: 'tool_requires_worker' },
      { tool: 'ok_tool', reason: 'allowlist', role: 'owner', error: 'tool_not_in_allowlist' },
      { tool: 'ok_tool', reason: 'rate', role: 'owner', error: 'tool_call_limit_exceeded' },
    ]);
    // 运维禁用那一档**同时**保留 `tool.disabled`：那一条是「界面上关掉的东西被模型硬调过来」的
    // 运维视角凭据，而 `tool.denied` 是统一的拒绝流水。
    expect(events.filter((event) => event.kind === 'tool.disabled')).toHaveLength(1);
  });

  it('skill 收窄与审批被拒各有自己的 reason', async () => {
    events.length = 0;
    const registry = new ToolRegistry(log, { request: async () => false }, limits, () => [{ tool: 'gated', when: 'always', risk: 'high' }] as never);
    registry.register({ name: 'gated', description: '', inputSchema: z.object({}), policy: { ...policy, approval: 'conditional' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    registry.register({ name: 'narrowed', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, execute: () => ({ ok: true }) });
    await registry.execute('gated', {}, context);
    // 收窄集挂在 `ToolExecutionContext`（per-run）上而不是 turn 上 —— 两个并行 worker 各持一份。
    await registry.execute('narrowed', {}, { ...context, skillAllowedTools: new Set(['other']) });
    expect(denials().map((entry) => entry.reason)).toEqual(['approval', 'skill_narrowed']);
  });

  it('参数非法记 tool.error 而不是 tool.denied —— 那是模型写错了，不是被拦下了', async () => {
    events.length = 0;
    const registry = new ToolRegistry(log, broker, limits);
    registry.register({ name: 'strict', description: '', inputSchema: z.object({ n: z.number() }), policy, sourcePriority: 1, execute: () => ({ ok: true }) });
    expect(await registry.execute('strict', { n: 'x' }, context)).toMatchObject({ error: 'invalid_input' });
    expect(denials()).toEqual([]);
    const errors = events.filter((event) => event.kind === 'tool.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data).toMatchObject({ tool: 'strict', errorKind: 'invalid_input' });
  });
});

/**
 * `execute()` 对模型的承诺是「一律交回 `{ok:false,error,hint}`」。审批段此前在那个 try
 * **之外**，于是 `approval.request` 里的 `INSERT INTO approvals` 一失败（库满/被锁/已 close），
 * 异常就穿过 `execute()` 抛进 AI SDK —— 形状不统一，而且 `#failed` 不计数，
 * `maxConsecutiveErrors` 那道「模型别原地重试到步数耗尽」的唯一硬边界不推进。
 */
describe('审批段的异常也要交回判决', () => {
  const conditional = { ...policy, approval: 'conditional' as const };

  it('broker 抛出时返回 {ok:false} 而不是抛，且计入连续失败', async () => {
    const broken: ApprovalBroker = { request: () => { throw new Error('SqliteError: database is locked'); } };
    const registry = new ToolRegistry(log, broken, limits, () => [{ tool: 'risky', when: 'always', risk: 'high' }] as never);
    registry.register({ name: 'risky', description: '', inputSchema: z.object({}), policy: conditional, sourcePriority: 1, execute: () => Promise.resolve({ ok: true }) });
    const first = await registry.execute('risky', {}, context) as { ok: boolean; error: string };
    expect(first.ok).toBe(false);
    expect(first.error).toContain('database is locked');
    // 第二次撞上 maxConsecutiveErrors(2)，工具本轮停用 —— 证明这次失败真的记进了账。
    await registry.execute('risky', {}, context);
    expect(events.some((event) => event.kind === 'tool.disabled_after_errors' && event.summary.includes('risky'))).toBe(true);
  });

  it('异步拒绝走同一条路', async () => {
    const broken: ApprovalBroker = { request: () => Promise.reject(new Error('approval_store_down')) };
    const registry = new ToolRegistry(log, broken, limits, () => [{ tool: 'risky2', when: 'always', risk: 'high' }] as never);
    registry.register({ name: 'risky2', description: '', inputSchema: z.object({}), policy: conditional, sourcePriority: 1, execute: () => Promise.resolve({ ok: true }) });
    const output = await registry.execute('risky2', {}, context) as { ok: boolean; error: string };
    expect(output.ok).toBe(false);
    expect(output.error).toContain('approval_store_down');
  });
});
