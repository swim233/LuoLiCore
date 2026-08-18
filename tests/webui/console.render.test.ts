import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';

/**
 * 控制台的**渲染**防线。
 *
 * 上一轮把 `ConsoleView.vue` 拆成 15 个子视图：`pnpm build` 通过、`pnpm test` 全绿、`/login`
 * 打得开 —— 而 14 个控制台页面全是空白（docs/24 · R-UI-01）。成因是子 SFC 的 `setup` 返回了一个
 * 只有 `get` 陷阱的 Proxy，而 Vue 解析模板绑定走的是 `hasOwn(setupState, key)`，一个 `_ctx.xxx`
 * 都解析不出来。**三条绿灯加起来也证明不了控制台还活着**，因为没有任何测试真的渲染过它一次。
 *
 * 这个文件就是补那一次渲染：逐个切到 14 个导航项，断言内容区**有实际文本**、并且整个过程里
 * 没有 Vue 的警告（「Property X was accessed during render but is not defined」正是那次事故的
 * 唯一可见症状）。断言的是「渲染得出来」，不是具体文案 —— 后者会让这条防线变成改一句话就红。
 */

const NAV_KEYS = ['dashboard', 'chats', 'messages', 'prompts', 'providers', 'principals', 'tools',
  'extensions', 'agents', 'logs', 'usage', 'quota', 'tasks', 'settings'] as const;
/** 设置页的四个二级 tab（docs/09 §3.13）。跟导航项同一个道理：漏一个分支，那个 tab 从此没人渲染过。 */
const SETTINGS_TABS = ['common', 'all', 'maintenance', 'advanced'] as const;

/** 每个端点回一份形状对得上的空数据。这里刻意**不 mock 组件内部**：要测的就是真实模板 + 真实
 *  setup 在拿到正常响应时能不能渲染出来。 */
const RESPONSES: Record<string, unknown> = {
  '/api/auth/me': { role: 'owner', csrf: 'csrf-token', expiresAt: Date.now() + 3_600_000 },
  '/api/dashboard': { turns: { total: 3, running: 0, failed: 1, cost: 0.42 }, messages: { total: 12 }, providers: { total: 2, enabled: 1 },
    trend: Array.from({ length: 7 }, (_value, index) => ({ day: `2026-08-${11 + index}`, messages: index, turns: index, costUsd: index * 0.01 })) },
  '/api/health/detail': { ok: true, version: 'test', uptimeMs: 90_000, db: { ok: true, bytes: 4096, walBytes: 0, workspaceBytes: 1024 },
    providers: [], mcp: [], sandbox: { allowed: true, mode: 'docker' }, inFlightTurns: 0 },
  '/api/quota': { quota: { enabled: true, requirePricing: true, minReserveUsd: 0.02, global: { daily: 5, monthly: 100 }, perChat: { daily: 1, monthly: null },
    perUser: { daily: 0.5, monthly: null, byRole: {} }, perTurn: { maxCostUsd: 0.5, maxSteps: 12 },
    rateLimit: { turnsPerUserPerHour: 30, turnsPerChatPerHour: 100, concurrentPerUser: 2 }, onExceeded: { reply: true, message: '额度用完了' } },
    timezone: 'UTC', buckets: { day: '2026-08-17', month: '2026-08' },
    counters: [{ scope: 'global', subject: 'global', window: 'day', bucket: '2026-08-17', costUsd: 1.2, reservedUsd: 0, turns: 3, updatedAt: Date.now(), current: true, limit: 5, limitApprox: false, role: null, label: null, username: null }],
    unpriced: [], unpricedTotal: 0, unimplemented: [] },
  '/api/config': { general: { name: '洛璃', timezone: 'UTC' }, trigger: { private: true, mention: true, reply: true, command: true, channels: false, wakewords: ['洛璃'], wakewordMinLength: 2, requireTextAfterMention: false, ignoreEditedAsTrigger: true },
    output: { mode: 'stream', replyDelayMs: 0, streamBufferMs: 900, streamIntervalMs: 1500, streamMinDeltaChars: 24, maxMessageChars: 3900 }, webui: { passwordHash: '«redacted»' } },
  '/api/config/schema': { schema: { definitions: { LuoLiConfig: { properties: {} } } }, hotReloadable: [], unimplemented: [], envPinned: [] },
  '/api/sandbox': { mode: 'docker', bypassRoles: ['owner'], plan: { allowed: true, mode: 'docker' } },
  // 扁平字段是生效值，`defaults` 是代码里那份 —— 少了 defaults，工具页弹窗的「代码默认」绑定读到 undefined。
  '/api/tools': { bash: { minRole: 'trusted', approval: 'conditional', scope: 'global', source: 'builtin', enabled: true,
    timeoutMs: null, selfManagedTimeout: true, defaults: { minRole: 'trusted', approval: 'conditional', timeoutMs: null }, relaxed: [] },
    web_fetch: { minRole: 'owner', approval: 'never', scope: 'global', source: 'builtin', enabled: true,
      timeoutMs: 45_000, selfManagedTimeout: false, defaults: { minRole: 'limited', approval: 'never', timeoutMs: 60_000 }, relaxed: [] } },
  '/api/turns': { items: [], total: 0, page: 1, size: 20 },
  '/api/messages': { items: [], total: 0, page: 1, size: 50 },
  '/api/usage/report': { groupBy: 'day', from: 0, to: Date.now(), rows: [] },
  // 唤醒词可用性是个数组端点，但路径不长得像列表 —— 显式列出来。
  '/api/config/wakewords/check': [{ pattern: '洛璃', kind: 'contains', ok: true, reason: null }],
  '/api/schedules': { available: true, enabled: true, timezone: 'UTC', settings: { maxPerChat: 20, minIntervalMinutes: 5, maxPayloadChars: 2000 },
    jobs: [{ id: 'j1', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '1', name: '每日早报', mode: 'agent', state: 'active',
      chatLabel: '阿离', creatorLabel: '阿离', cron: '0 8 * * *', timezone: 'UTC', payload: '汇总昨天群里聊了什么', runCount: 2,
      nextRun: new Date(Date.now() + 3_600_000).toISOString(), lastRunAt: Date.now() - 3_600_000, lastState: 'committed',
      createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 3_600_000 }] },
};

/** 没显式列出的端点：按路径形状猜一个空值。数组端点回 `[]`，其余回 `{}`。 */
function responseFor(url: string): unknown {
  const path = url.split('?')[0]!;
  if (path in RESPONSES) return RESPONSES[path];
  const listLike = ['/api/principals', '/api/providers', '/api/logs', '/api/chats', '/api/usage', '/api/skills', '/api/plugins',
    '/api/mcp', '/api/custom-tools', '/api/agents', '/api/approvals', '/api/tasks', '/api/prompts', '/api/models', '/api/aliases'];
  return listLike.includes(path) ? [] : {};
}

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // SSE 那根管子在 happy-dom 里没有 EventSource 语义，返回一条空流即可 —— 实时刷新不是这里要测的。
    if (url.includes('/api/events')) return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ ok: true, data: responseFor(url) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  vi.stubGlobal('EventSource', class {
    constructor() { /* 只要构造得出来，onopen/onmessage 永不触发也不影响首屏 */ }
    close(): void { /* noop */ }
    addEventListener(): void { /* noop */ }
  });
}

async function settle(wrapper: VueWrapper): Promise<void> {
  // 三轮 microtask + nextTick：`load()` 里是一串 await，一次 nextTick 不够。
  for (let round = 0; round < 6; round += 1) { await Promise.resolve(); await wrapper.vm.$nextTick(); }
}

describe('ConsoleView 渲染', () => {
  beforeEach(() => { stubFetch(); });

  it('14 个导航页逐个切过去都有内容，且不产生 Vue 警告', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    // 侧栏本身在 ConsoleView 自己的模板里 —— 上次事故中它是**唯一**还在的东西，所以不能只断言它。
    expect(wrapper.text()).toContain('总览');
    for (const key of NAV_KEYS) {
      (wrapper.vm as unknown as { active: string }).active = key;
      await settle(wrapper);
      const main = wrapper.find('.console-main').exists() ? wrapper.find('.console-main') : wrapper.find('main');
      const body = main.text().replace(wrapper.find('.sidebar').exists() ? wrapper.find('.sidebar').text() : '', '').trim();
      // 「内容区文本长度 0」是上次那 14 个空白页的确切症状（docs/24 §2 的实测输出）。
      expect(body.length, `${key} 页的内容区是空的`).toBeGreaterThan(20);
    }
    // 「Property "xxx" was accessed during render but is not defined on instance」正是那次事故的
    // 唯一可见症状：模板渲染得出 DOM，但每一个绑定都是 undefined。
    const rendering = [...warnings, ...errors].filter((line) => line.includes('[Vue warn]'));
    expect(rendering, `渲染期间产生了 Vue 警告：\n${rendering.join('\n')}`).toEqual([]);
    spy.mockRestore();
    errorSpy.mockRestore();
    wrapper.unmount();
  });

  it('设置页的四个二级 tab 逐个切过去都有内容，且不产生 Vue 警告', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { active: string; settingsTab: string };
    vm.active = 'settings';
    await settle(wrapper);
    for (const tab of SETTINGS_TABS) {
      vm.settingsTab = tab;
      await settle(wrapper);
      const panel = wrapper.find(`[data-settings-tab="${tab}"]`);
      expect(panel.exists(), `设置页缺少 ${tab} 这个 tab 的分支`).toBe(true);
      // 前三个 tab 是 v-show（未保存的草稿不能因为切 tab 就没了），所以 DOM 里始终有四个之中的三个：
      // 断言「当前这个可见」而不是「只有它存在」。
      expect(panel.attributes('style') ?? '', `${tab} 这个 tab 切过去之后仍然是隐藏的`).not.toContain('display: none');
      expect(panel.text().trim().length, `${tab} 这个 tab 的内容是空的`).toBeGreaterThan(20);
    }
    const rendering = warnings.filter((line) => line.includes('[Vue warn]'));
    expect(rendering, `渲染期间产生了 Vue 警告：\n${rendering.join('\n')}`).toEqual([]);
    spy.mockRestore();
    wrapper.unmount();
  });

  it('设置页 tab 定义与模板分支一一对应', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { active: string; SETTINGS_TABS: ReadonlyArray<readonly [string, string]> };
    expect(vm.SETTINGS_TABS.map(([key]) => key)).toEqual([...SETTINGS_TABS]);
    wrapper.unmount();
  });

  it('导航项与页面分支一一对应：多一个少一个都会红', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    // `navigation` 是模板的数据源；NAV_KEYS 是这个文件的断言清单。两者漂移过一次就会有页面
    // 从此没人渲染过 —— 加导航项时必须同时加进这里。
    const keys = (wrapper.vm as unknown as { navigation: ReadonlyArray<readonly [string, string, string]> }).navigation.map(([key]) => key);
    expect(keys).toEqual([...NAV_KEYS]);
    wrapper.unmount();
  });
});
