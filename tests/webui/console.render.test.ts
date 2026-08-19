import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { toasts } from '../../packages/webui/src/ui/toast';

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
  // fail-closed 的拒绝：`gcFiles` 的 `refused` 唯一触发条件是「库与目录来自两套部署」。
  '/api/maintenance/gc-files': { files: 0, fileBytes: 0, agentResults: 0, agentResultBytes: 0,
    refused: ['attachments 里一条带路径的行都没有，而 ./data/files 下有文件 —— 这通常意味着库与目录来自两套部署。拒绝清理。'] },
  // 模型行：一行「目录说能看图、运维标了看不了图」的中转模型。此前 `/api/models` 一律回 `[]`，
  // 于是模型表的行模板（能力徽标、定价出处、手标徽标）从来没被渲染过一次。
  '/api/models': [{ id: 'm1', provider_id: 'p1', model_id: 'grok-4.5', display_name: 'Grok 4.5', context_window: 500_000, max_output: 16_384,
    capabilities_json: JSON.stringify({ vision: false, tools: true, reasoningControl: 'effort', reasoningEfforts: ['low', 'high'],
      modalities: { input: ['text', 'image'], output: ['text'] },
      catalog: { source: 'models.dev', match: 'official', providerId: 'xai', modelId: 'grok-4.5', normalized: false, priceRange: null, priceSource: 'official', fetchedAt: 1_787_000_000_000 },
      manual: { vision: false } }),
    price_in: 3, price_out: 15, price_cache_read: null, price_cache_write: null, enabled: 1, sort: 0 }],
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
  // `/api/turns/active` 也回数组：它慢一步落到 DataGrid 的 `rows`，回 `{}` 的表现是一条
  // 「Invalid prop: type check failed for prop "rows"」，而那正是这套装置要挡的那类症状。
  const listLike = ['/api/principals', '/api/providers', '/api/logs', '/api/chats', '/api/usage', '/api/skills', '/api/plugins',
    '/api/mcp', '/api/custom-tools', '/api/agents', '/api/approvals', '/api/tasks', '/api/prompts', '/api/models', '/api/aliases', '/api/turns/active'];
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

  /**
   * `gc-files` 的 fail-closed 拒绝不能渲染成绿色「完成」。`severity` 与标题此前写死，拒绝理由挤在
   * 一行 JSON 的 `refused` 字段尾巴上、8 秒后自动消失 —— 而它唯一的触发条件是「库与目录来自两套
   * 部署」，正是运维最该立刻停手的那一种（docs/28 · L-WEB-03；docs/25 §10 记的误删 76 个附件 +
   * 90 份子 agent 全文就是它防住的）。
   */
  it('维护动作返回 refused 时是 warn 且不自动消失', async () => {
    vi.stubGlobal('confirm', () => true);
    toasts.splice(0, toasts.length);
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    await (wrapper.vm as unknown as { runMaintenance(action: string, label: string): Promise<void> }).runMaintenance('gc-files', '清理孤儿文件');
    await settle(wrapper);
    const toast = toasts.at(-1)!;
    expect(toast.severity).toBe('warn');
    expect(toast.summary).toBe('清理孤儿文件 已拒绝');
    // life <= 0 才不自动消失（`pushToast` 的语义）：8 秒后消失等于把这条拒绝藏起来。
    expect(toast.life).toBeLessThanOrEqual(0);
    expect(toast.detail).toContain('两套部署');
    // 对照组：不带 refused 的动作照旧是绿色「完成」。
    await (wrapper.vm as unknown as { runMaintenance(action: string, label: string): Promise<void> }).runMaintenance('vacuum', 'VACUUM');
    await settle(wrapper);
    expect(toasts.at(-1)).toMatchObject({ severity: 'success', summary: 'VACUUM 完成' });
    wrapper.unmount();
  });

  /**
   * Trace 视图**必须是树**。此前它是 `marginLeft: node.parent_span_id ? '24px' : '0'` —— 只有一级，
   * 在 `parent_span_id` 全库为 NULL 的年代看不出问题（13 个节点全是 `0px`），父边真的连上之后
   * 一级缩进会把 `agent.run` 下面那三层压成同一层（docs/28 · L-LOG-04）。
   * `.vue` 模板不进 `tsc --noEmit`（`ConsoleView.vue` 开头那段注释自陈过这件事害过人），
   * 所以判据只能靠这里焊住。
   */
  it('trace 缩进按 parentSpanId 链算真实 depth，环与悬挂父都按 depth 0 兜住', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { traceDepths(nodes: ReadonlyArray<Record<string, unknown>>): number[] };
    const chain = [
      { span_id: 'root', parent_span_id: null },
      { span_id: 'a', parent_span_id: 'root' },
      { span_id: 'b', parent_span_id: 'a' },
      { span_id: 'c', parent_span_id: 'b' },
      { span_id: null, parent_span_id: 'c' },
    ];
    expect(vm.traceDepths(chain)).toEqual([0, 1, 2, 3, 4]);
    // 悬挂父：一次查询只取 500 行，子 span 的父完全可能不在这一页里。按现有深度收尾，不炸。
    expect(vm.traceDepths([{ span_id: 'x', parent_span_id: 'not-in-this-page' }])).toEqual([0]);
    // 环：两个 span 互指、或指回自己。整条按 depth 0 渲染，绝不死循环。
    expect(vm.traceDepths([{ span_id: 'p', parent_span_id: 'q' }, { span_id: 'q', parent_span_id: 'p' }])).toEqual([0, 0]);
    expect(vm.traceDepths([{ span_id: 'self', parent_span_id: 'self' }])).toEqual([0]);
    // camelCase 也认：对话详情那份（`/api/turns/:id/detail`）给的是 `parentSpanId`。
    expect(vm.traceDepths([{ spanId: 'r', parentSpanId: null }, { spanId: 's', parentSpanId: 'r' }])).toEqual([0, 1]);
    wrapper.unmount();
  });

  /**
   * 标记模型看图能力那条入口（docs/21 §10 · `G-API-17`）。三个判据都只能在这里焊：`.vue` 模板不进
   * `tsc --noEmit`，而「三态下拉发出去的 patch 长什么样」是这条控件说话算数的全部 ——
   * `follow` 必须发 `{vision:null}`（取消标记）而不是省略这个键，否则标错了在界面上撤不回来。
   */
  it('模型行的看图能力标记：徽标、表单三态、发出去的 patch 形状', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { active: string; models: Array<Record<string, unknown>>;
      modelForm: { id: string; vision: string }; editModel(model?: Record<string, unknown>): void; saveModel(): Promise<void>;
      capabilityTags(meta: unknown): string[]; storedMeta(model: Record<string, unknown>): unknown };
    vm.active = 'providers';
    await settle(wrapper);
    expect(wrapper.text()).toContain('手标 · 看不了图');
    // 生效值写在顶层，所以目录给的「看图」标签也跟着消失 —— 徽标与运行时读的是同一个字段。
    const tags = vm.capabilityTags(vm.storedMeta(vm.models[0]!));
    expect(tags).not.toContain('看图');
    expect(tags).toContain('工具');
    vm.editModel(vm.models[0]);
    await settle(wrapper);
    expect(vm.modelForm.vision).toBe('off');

    const patchBody = async (mark: string): Promise<Record<string, unknown>> => {
      vm.modelForm.vision = mark;
      await vm.saveModel();
      const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
      const patch = calls.filter(([url, init]) => url.includes('/api/models/m1') && init?.method === 'PATCH').at(-1)!;
      return JSON.parse(String(patch[1].body)) as Record<string, unknown>;
    };
    expect(await patchBody('off')).toMatchObject({ capabilities: { vision: false } });
    expect(await patchBody('on')).toMatchObject({ capabilities: { vision: true } });
    // 取消标记：键要在、值是 null。`toMatchObject` 对 undefined 与 null 不区分，所以直接比对整块。
    expect((await patchBody('follow')).capabilities).toEqual({ vision: null });
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
