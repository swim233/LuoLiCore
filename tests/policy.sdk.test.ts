import { describe, expect, it } from 'vitest';
import {
  MAIN_AGENT_TOOLS,
  MAIN_ONLY_TOOLS,
  SDK_AGENT_TOOLS,
  TOOL_POLICY,
  ToolRegistry,
  configSchema,
  newToolScope,
  registerBuiltins,
  registerCatalogTools,
  toolCallableBy,
} from '@luoli/core';
import type {
  AgentKind,
  ApprovalBroker,
  LogEvent,
  LogSink,
  TelegramToolBridge,
  ToolExecutionContext,
} from '@luoli/core';
import type { Role, RuntimeTurnContext } from '@luoli/shared';
import { code, codeIndex, source } from './support/source.js';

/**
 * `AgentKind = 'sdk'`（`docs/12-sdk.md` T3.4，`docs/05 §3.13`）：第三方经 `/sdk/v1` 接入的顶层入口，
 * 白名单固定三件记忆工具，强制点是 `#eligible()`（目录）与 `admit()`（准入）两处，判据只有一份
 * （`toolCallableBy()`）。
 *
 * `role` 统一取 `owner`：隔离 agentKind 轴与角色轴（同 `tests/tools.catalog.test.ts`
 * 「main 的 activeNames() 恰好等于 MAIN_AGENT_TOOLS ∩ 已注册」那条先例）—— owner 通过每一道
 * `minRole` 闸（含 `memory_list` 的 owner 门槛），若结果仍收窄到三件，收窄只可能来自 agentKind。
 *
 * 全程走真实的 `registerBuiltins` / `registerCatalogTools`，不手写一份工具影子清单：
 * `toolCallableBy()` 的过滤在 `#eligible()` 中排在 `tool.available?.()` 之前（`registry.ts` 的
 * `#eligible()` 先按 `toolCallableBy` 收窄、再逐条查 `available()`），所以 sdk 视角下只有三件工具
 * 的 `available()` 会被真正调用，`sandbox` 之类的依赖给最小桩即可，不需要完整装配。
 */
const events: LogEvent[] = [];
const log = {
  span: () => ({ id: 'span', end: () => undefined }),
  event: (event: LogEvent) => { events.push(event); },
} as unknown as LogSink;
const okBroker: ApprovalBroker = { request: async () => true };

function harness(input: { telegram?: TelegramToolBridge; withExternal?: boolean } = {}) {
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' } });
  // `catalog` 必须传给 registry 的 limits（而不仅仅存在于 `config` 里）：`#deferredFor()` 读的是
  // `#limits().catalog`，缺席时直接短路返回「不折叠」，`registerExternal` 的探针工具就会一直常驻。
  const registry = new ToolRegistry(log, okBroker,
    { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 8, catalog: config.tools.catalog });
  registerBuiltins(registry, {
    log,
    // `bash`/`python` 在 sdk 视角下不会走到这里（toolCallableBy 先滤掉），桩仅为 lw/main 侧的
    // 对照断言与「折叠集非空」场景服务。
    sandbox: { plan: () => ({ allowed: true }) },
    schedule: { deliverable: () => true },
    telegram: input.telegram ?? null,
  } as never);
  registerCatalogTools(registry, { log });
  if (input.withExternal)
    registry.registerExternal({
      name: 'mcp__alpha__one', description: '折叠集探针', minRole: 'limited', source: 'mcp',
      inputSchema: { parse: (value: unknown) => value } as never, execute: () => ({ ok: true }),
    });
  const contextFor = (
    role: Role,
    agentKind: AgentKind,
    turnExtra: Partial<RuntimeTurnContext> = {},
  ): ToolExecutionContext => ({
    turn: {
      turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2',
      effectiveRole: role, isPrivate: true, baseCommitId: null,
      snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
      delta: [], abortSignal: new AbortController().signal, config,
      ...turnExtra,
    },
    workspace: '.', agentKind, ...newToolScope(),
  });
  return { registry, config, contextFor };
}

describe('AgentKind sdk · 工具目录只含记忆三件（验收 1）', () => {
  it('owner 角色下 activeNames() 恰为 memory_list/memory_read/memory_write', () => {
    const { registry, contextFor } = harness();
    const names = [...registry.activeNames('owner', contextFor('owner', 'sdk'))].sort();
    expect(names).toEqual(['memory_list', 'memory_read', 'memory_write']);
    expect(new Set(names)).toEqual(SDK_AGENT_TOOLS);
  });

  it('对照：同一份注册表下 lw 侧远不止三件，证明收窄确实来自 agentKind 而非空注册表', () => {
    const { registry, contextFor } = harness();
    const names = registry.activeNames('owner', contextFor('owner', 'lw'));
    expect(names.length).toBeGreaterThan(SDK_AGENT_TOOLS.size);
    // `web_search` 不在期望里：它的 `available()` 另外要求配置 `webSearch.provider`/`apiKey`，
    // 本用例的桩依赖没给，与 agentKind 轴无关，选它当样本会把两条判据锁在一次断言里。
    expect(names).toEqual(expect.arrayContaining(['bash', 'read_file', 'search_messages']));
  });
});

describe('AgentKind sdk · spawn_worker 在 admit() 被拒（验收 2）', () => {
  it('错误码 tool_unavailable_for_sdk，reason=sdk，且执行体一次都没跑', async () => {
    const { registry, contextFor } = harness();
    const ctx = contextFor('owner', 'sdk');
    const denied = registry.admit('spawn_worker', ctx);
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.error).toBe('tool_unavailable_for_sdk');
    expect(denied.ok === false && denied.reason).toBe('sdk');
    const executed = await registry.execute('spawn_worker', { task: 'x', alias: 'low' }, ctx);
    expect(executed).toMatchObject({ ok: false, error: 'tool_unavailable_for_sdk' });
  });

  it('派发族与 schedule_* 全部落在同一道闸上（不是只挡了 spawn_worker 一个名字）', () => {
    const { registry, contextFor } = harness();
    const ctx = contextFor('owner', 'sdk');
    for (const name of ['spawn_worker', 'spawn_harness', 'spawn_acp', 'read_worker_result',
      'schedule_create', 'schedule_update', 'schedule_list', 'schedule_cancel']) {
      const denied = registry.admit(name, ctx);
      expect(denied.ok, `${name} 不应对 sdk 放行`).toBe(false);
      expect(denied.ok === false && denied.reason, `${name}`).toBe('sdk');
    }
  });
});

describe('AgentKind sdk · Telegram 输出五件（验收 3）', () => {
  it('无 bridge 时 main 侧目录也不含这五件——既有 available() 闸未受影响', () => {
    const { registry, contextFor } = harness();
    const names = registry.activeNames('owner', contextFor('owner', 'main'));
    for (const name of ['send_message', 'send_photo', 'send_file', 'react', 'pin_message'])
      expect(names).not.toContain(name);
  });

  it('即使配了 bridge，sdk 会话仍在 toolCallableBy 上被拦——两道闸独立生效', () => {
    const bridge: TelegramToolBridge = {
      sendMessage: async () => ({ ok: true, messageIds: [1] }),
      sendPhoto: async () => ({ ok: true }),
      sendFile: async () => ({ ok: true }),
      react: async () => ({ ok: true }),
      pin: async () => ({ ok: true }),
    };
    const { registry, contextFor } = harness({ telegram: bridge });
    const sdkNames = registry.activeNames('owner', contextFor('owner', 'sdk'));
    for (const name of ['send_message', 'send_photo', 'send_file', 'react', 'pin_message']) {
      expect(sdkNames).not.toContain(name);
      const denied = registry.admit(name, contextFor('owner', 'sdk'));
      expect(denied.ok, name).toBe(false);
      expect(denied.ok === false && denied.reason, name).toBe('sdk');
    }
    // 对照：bridge 存在时 main 侧确实拿得到——证明上面的拒绝来自 agentKind，不是 bridge 缺失。
    expect(registry.activeNames('owner', contextFor('owner', 'main')))
      .toEqual(expect.arrayContaining(['send_message', 'send_photo', 'send_file', 'react', 'pin_message']));
  });

  it('五件的 available() 判据源码里恰好是同一份 Boolean(dependencies.telegram)', () => {
    const text = source('packages/core/src/tools/builtins.ts');
    const gate = code('available: () => Boolean(dependencies.telegram)');
    expect(text.split(gate).length - 1).toBe(5);
  });
});

describe('AgentKind sdk · stay_silent 不可达（验收 4）', () => {
  it('不在白名单里', () => {
    expect(SDK_AGENT_TOOLS.has('stay_silent' as never)).toBe(false);
    expect(toolCallableBy('sdk', 'stay_silent')).toBe(false);
  });

  it('即便 silenceable=true，available() 的 agentKind 闸对 sdk 恒假；admit() 先在白名单上拒', () => {
    const { registry, contextFor } = harness();
    // 先在 main 侧拿到真实注册的工具对象：sdk 侧走不到 available()（白名单先拒），
    // 要单独复核这道闸就必须借 main 侧的成功路径取出同一个 `tool.available`。
    const mainCtx = contextFor('owner', 'main', { silenceable: true });
    const admitted = registry.admit('stay_silent', mainCtx);
    expect(admitted.ok).toBe(true);
    const sdkCtx = contextFor('owner', 'sdk', { silenceable: true });
    expect(admitted.ok === true && admitted.tool.available?.('owner', sdkCtx)).toBe(false);
    // admit() 走 sdk 侧：白名单先拒，压根不会执行到上面这条 available()。
    const denied = registry.admit('stay_silent', sdkCtx);
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.reason).toBe('sdk');
  });
});

describe('AgentKind sdk · search_tools 不可达（验收 5）', () => {
  it('折叠集非空时 lw 拿得到、sdk 拿不到——catalog-meta.ts 的判据只放行 lw', () => {
    const { registry, contextFor } = harness({ withExternal: true });
    expect(registry.hasDeferrable('owner')).toBe(true);
    expect(registry.activeNames('owner', contextFor('owner', 'lw'))).toContain('search_tools');
    expect(registry.activeNames('owner', contextFor('owner', 'sdk'))).not.toContain('search_tools');
    const denied = registry.admit('search_tools', contextFor('owner', 'sdk'));
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.reason).toBe('sdk');
  });
});

describe('toolCallableBy(sdk, ·) 真值表与判据唯一性', () => {
  it('对全部 TOOL_POLICY 键的判定与 SDK_AGENT_TOOLS 一致', () => {
    const wrong: string[] = [];
    for (const name of Object.keys(TOOL_POLICY)) {
      const expected = SDK_AGENT_TOOLS.has(name as never);
      if (toolCallableBy('sdk', name) !== expected) wrong.push(name);
    }
    expect(wrong, 'toolCallableBy(sdk, ·) 与 SDK_AGENT_TOOLS 对不上的工具名').toEqual([]);
  });

  it('三档互不相同：sdk 白名单与 MAIN_AGENT_TOOLS、MAIN_ONLY_TOOLS 均不是同一份集合', () => {
    // sdk 只保留记忆三件，main 还有派发/输出/定时任务等一整族；两者不应相等。
    expect(SDK_AGENT_TOOLS).not.toEqual(MAIN_AGENT_TOOLS);
    // memory_write 同时在 MAIN_ONLY_TOOLS（main 独占）与 SDK_AGENT_TOOLS 里——
    // 两份判据分别独立收 memory_write，不是「sdk 复用了 MAIN_ONLY_TOOLS 的反面」。
    expect(MAIN_ONLY_TOOLS.has('memory_write')).toBe(true);
    expect(SDK_AGENT_TOOLS.has('memory_write')).toBe(true);
    // 若 sdk 真的按 `!MAIN_ONLY_TOOLS.has(name)`（lw 那套黑名单算法）取数，bash 会被放出来——
    // 这里锁死它没有被放出来，防止未来有人把 sdk 分支改成复用 lw 的算法。
    expect(MAIN_ONLY_TOOLS.has('bash')).toBe(false);
    expect(SDK_AGENT_TOOLS.has('bash' as never)).toBe(false);
  });

  it('policy.ts 中判 sdk 的那一支只出现一次，SDK_AGENT_TOOLS 只声明一次（判据只有一份）', () => {
    const text = source('packages/core/src/tools/policy.ts');
    // 按来源可配之后这一支读的是传入的集合，缺省仍回落 SDK_AGENT_TOOLS——判据仍然只有这一处。
    const branch = code('return (sdkTools ?? SDK_AGENT_TOOLS).has(name) &&');
    expect(text.split(branch).length - 1, 'toolCallableBy() 里判 sdk 的那一支应恰好出现一次').toBe(1);
    const declaration = code('export const SDK_AGENT_TOOLS: ReadonlySet<ToolName> = new Set([');
    expect(text.split(declaration).length - 1, 'SDK_AGENT_TOOLS 不应散落成第二份声明').toBe(1);
    // 顺序：常量声明必须在 toolCallableBy() 引用它之前，否则是运行时的 TDZ 错误而非类型错误。
    expect(codeIndex(text, declaration)).toBeGreaterThanOrEqual(0);
    expect(codeIndex(text, declaration)).toBeLessThan(codeIndex(text, branch));
  });

  it('不传 sdkTools 时与 SDK_AGENT_TOOLS 逐条一致（存量调用点行为不变）', () => {
    const wrong: string[] = [];
    for (const name of Object.keys(TOOL_POLICY)) {
      const expected = SDK_AGENT_TOOLS.has(name as never);
      if (toolCallableBy('sdk', name, undefined) !== expected) wrong.push(name);
    }
    expect(wrong, '缺省参数下与常量白名单对不上的工具名').toEqual([]);
  });
});
