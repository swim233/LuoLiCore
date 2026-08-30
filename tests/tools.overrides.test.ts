import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, newToolScope, relaxedFields, effectiveToolPolicy } from '@luoli/core';
import type { ApprovalBroker, LogSink, ToolOverride, ToolPolicyEntry } from '@luoli/core';
import type { Role, RuntimeTurnContext } from '@luoli/shared';

/**
 * 工具策略覆盖层（docs/09 §3.7，`tools.overrides.<name>`）。
 *
 * 这块的危险不在「覆盖生效没有」，而在**覆盖只在两处判定里的一处生效**：`active()` 决定模型看得见
 * 什么，`admit()` 决定真调过来时放不放行。只改一处的表现是「目录里看得见但调不动」，或者反过来
 * 「目录里没有、模型凭上一步的工具名硬调过来却通了」—— 后者正是 docs/20 · W-TOOL-01 那条教训。
 * 所以每条角色断言都同时打这两处。
 */

const broker: ApprovalBroker = { request: async () => true };
const approvalCalls: string[] = [];
const countingBroker: ApprovalBroker = { request: async (tool) => { approvalCalls.push(tool.name); return true; } };
const log = { span: () => ({ id: 'span', end: () => undefined }), event: () => undefined } as unknown as LogSink;
const limits = { maxRegistered: 20, maxCallsPerTurn: 20, maxConsecutiveErrors: 3, defaultTimeoutMs: 80 };
const policy = { minRole: 'trusted', approval: 'never', scope: 'global', source: 'builtin' } satisfies ToolPolicyEntry;

function turnFor(role: Role): RuntimeTurnContext {
  return { turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: role, isPrivate: true, baseCommitId: null,
    snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config: {} };
}
// `agentKind` 取 lw 而不是 main：这份文件注册的是自造工具名（`thing` / `gated` / …），它们不在
// `MAIN_AGENT_TOOLS` 白名单里，`toolCallableBy('main', …)` 会在角色闸之后立刻拒掉全部用例 ——
// 那是「谁能调这一族」的正交闸，混进来会把覆盖层自己的判据整个遮住（覆盖到底生效没有就再也
// 断不出来了）。worker 侧的判据是 `!MAIN_ONLY_TOOLS.has(name)`，自造名一律放行，正好只留下
// 覆盖层这一道。
const contextFor = (role: Role) => ({ turn: turnFor(role), workspace: '.', agentKind: 'lw' as const, ...newToolScope() });

function registryWith(overrides: Record<string, ToolOverride>, approval: ApprovalBroker = broker): ToolRegistry {
  const registry = new ToolRegistry(log, approval, limits);
  registry.bindOverrides(() => overrides);
  return registry;
}

describe('工具策略覆盖层', () => {
  it('minRole 覆盖在 active() 与 admit() 两处同时生效', () => {
    const overrides: Record<string, ToolOverride> = {};
    const registry = registryWith(overrides);
    registry.register({ name: 'thing', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, execute: () => ({ ok: true }) });

    // 默认 trusted：limited 看不见也调不动，trusted 两处都通。
    expect(registry.activeNames('limited', contextFor('limited'))).not.toContain('thing');
    expect(registry.admit('thing', contextFor('limited')).ok).toBe(false);
    expect(registry.activeNames('trusted', contextFor('trusted'))).toContain('thing');
    expect(registry.admit('thing', contextFor('trusted')).ok).toBe(true);

    // 收紧到 owner：trusted 两处都被挡。
    overrides.thing = { minRole: 'owner' };
    expect(registry.activeNames('trusted', contextFor('trusted'))).not.toContain('thing');
    const admitted = registry.admit('thing', contextFor('trusted'));
    expect(admitted.ok).toBe(false);
    expect(admitted.ok === false && admitted.error).toBe('权限不足');

    // 放宽到 limited：两处同时放行。
    overrides.thing = { minRole: 'limited' };
    expect(registry.activeNames('limited', contextFor('limited'))).toContain('thing');
    expect(registry.admit('thing', contextFor('limited')).ok).toBe(true);
  });

  // 覆盖动的是角色判定，不是 `available()`。`spawn_harness` 靠 available() 硬判 owner + 私聊，
  // 把 minRole 调到 limited 也开不出来 —— 这是文档里承诺的性质，不能随合并逻辑一起松掉。
  it('minRole 覆盖绕不过 available()', () => {
    const overrides: Record<string, ToolOverride> = { gated: { minRole: 'limited' } };
    const registry = registryWith(overrides);
    registry.register({ name: 'gated', description: '', inputSchema: z.object({}), policy, sourcePriority: 1,
      available: (role) => role === 'owner', execute: () => ({ ok: true }) });
    expect(registry.activeNames('limited', contextFor('limited'))).not.toContain('gated');
    const admitted = registry.admit('gated', contextFor('limited'));
    expect(admitted.ok).toBe(false);
    expect(admitted.ok === false && admitted.error).toBe('tool_unavailable');
    expect(registry.admit('gated', contextFor('owner')).ok).toBe(true);
  });

  it('审批基准可以被抬高', async () => {
    approvalCalls.length = 0;
    const registry = registryWith({ quiet: { approval: 'always' } }, countingBroker);
    registry.register({ name: 'quiet', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, execute: () => ({ ok: true }) });
    await registry.execute('quiet', {}, contextFor('owner'));
    expect(approvalCalls).toEqual(['quiet']);
  });

  // 覆盖设的是**基准档位**。`approvalFor` 是工具按本轮配置把自己提档进审批的通道
  // （`memory.pubWriteRequiresApproval` 就是这么接的），它只能升不能降 —— 否则运维在面板上
  // 点一下 never，就把一条工具自己认定必须要人点头的路径给关了。
  it('approvalFor 的提档不会被 never 覆盖降回去', async () => {
    approvalCalls.length = 0;
    const registry = registryWith({ escalating: { approval: 'never' } }, countingBroker);
    registry.register({ name: 'escalating', description: '', inputSchema: z.object({}), policy: { ...policy, approval: 'conditional' }, sourcePriority: 1,
      approvalFor: () => 'always', execute: () => ({ ok: true }) });
    await registry.execute('escalating', {}, contextFor('owner'));
    expect(approvalCalls).toEqual(['escalating']);
  });

  it('审批基准降到 never 后，没有 approvalFor 的工具不再走审批', async () => {
    approvalCalls.length = 0;
    const registry = registryWith({ loud: { approval: 'never' } }, countingBroker);
    registry.register({ name: 'loud', description: '', inputSchema: z.object({}), policy: { ...policy, approval: 'always' }, sourcePriority: 1, execute: () => ({ ok: true }) });
    await registry.execute('loud', {}, contextFor('owner'));
    expect(approvalCalls).toEqual([]);
  });

  it('timeoutMs 覆盖对声明了超时的工具生效', async () => {
    const registry = registryWith({ slow: { timeoutMs: 400 } });
    registry.register({ name: 'slow', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: 30,
      execute: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return { ok: true, done: true }; } });
    // 没有覆盖时 30ms 就砍断了；覆盖到 400ms 之后这次调用跑得完。
    expect(await registry.execute('slow', {}, contextFor('owner'))).toEqual({ ok: true, done: true });
  });

  // `timeoutMs: null` 的工具（bash / python / spawn_worker / spawn_harness / ask_parent）各有自己的
  // 硬期限。从工具页给它们套一层外层 race 会在它们自己的超时之前把调用砍掉，所以这里不认覆盖。
  it('timeoutMs 覆盖对自管超时的工具无效', async () => {
    const registry = registryWith({ owns: { timeoutMs: 20 } });
    registry.register({ name: 'owns', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: null,
      execute: async () => { await new Promise((resolve) => setTimeout(resolve, 120)); return { ok: true, done: true }; } });
    expect(await registry.execute('owns', {}, contextFor('owner'))).toEqual({ ok: true, done: true });
  });

  it('停用仍然是硬边界，且与策略覆盖共存', () => {
    const registry = registryWith({ thing: { enabled: false, minRole: 'limited' } });
    registry.register({ name: 'thing', description: '', inputSchema: z.object({}), policy, sourcePriority: 1, execute: () => ({ ok: true }) });
    expect(registry.activeNames('owner', contextFor('owner'))).not.toContain('thing');
    const admitted = registry.admit('thing', contextFor('owner'));
    expect(admitted.ok).toBe(false);
    expect(admitted.ok === false && admitted.error).toBe('tool_disabled_by_operator');
  });

  it('describe() 报出默认值、生效值与放宽了哪几项', () => {
    const registry = registryWith({ thing: { minRole: 'limited', approval: 'always' } });
    registry.register({ name: 'thing', description: 'd', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: 5000, execute: () => ({ ok: true }) });
    registry.register({ name: 'owns', description: 'd', inputSchema: z.object({}), policy, sourcePriority: 1, timeoutMs: null, execute: () => ({ ok: true }) });
    const [owns, thing] = registry.describe();
    expect(thing!.defaults.minRole).toBe('trusted');
    expect(thing!.effective.minRole).toBe('limited');
    expect(thing!.effective.approval).toBe('always');
    // 只有 minRole 更松；审批是抬高了，不算放宽。
    expect(thing!.relaxed).toEqual(['minRole']);
    expect(thing!.timeoutMs).toBe(5000);
    expect(owns!.selfManagedTimeout).toBe(true);
    expect(owns!.timeoutMs).toBeNull();
  });

  it('relaxedFields 只认真正的放宽', () => {
    expect(relaxedFields(policy, undefined)).toEqual([]);
    expect(relaxedFields(policy, { minRole: 'owner', approval: 'always' })).toEqual([]);
    expect(relaxedFields(policy, { minRole: 'trusted' })).toEqual([]);
    expect(relaxedFields(policy, { minRole: 'limited' })).toEqual(['minRole']);
    expect(relaxedFields({ ...policy, approval: 'always' }, { approval: 'conditional' })).toEqual(['approval']);
    // 超时与启停不算放宽：一个是资源旋钮，一个是这个面板一直就有的能力。
    expect(relaxedFields(policy, { timeoutMs: 1, enabled: false })).toEqual([]);
  });

  it('effectiveToolPolicy 缺字段时沿用代码那份', () => {
    expect(effectiveToolPolicy(policy, undefined)).toEqual(policy);
    expect(effectiveToolPolicy(policy, { enabled: false })).toEqual(policy);
    expect(effectiveToolPolicy(policy, { minRole: 'owner' })).toEqual({ ...policy, minRole: 'owner' });
    // scope / source 永远来自代码：覆盖层里根本没有这两个字段。
    expect(effectiveToolPolicy(policy, { minRole: 'owner' }).scope).toBe('global');
  });
});
