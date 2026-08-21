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
/** 扩展页的四个分段（docs/09 §3.8）。同上：加一段就要加进这里。 */
const EXTENSION_TABS = ['skills', 'mcp', 'plugins', 'tools'] as const;

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
  '/api/config/schema': { schema: { definitions: { LuoLiConfig: { properties: {} } } }, hotReloadable: [], unimplemented: [], envPinned: [], enumNotes: {} },
  // 主体三行：一个用户、一个私聊会话（`chat:` 前缀 + 正数 id + chat_type=private）、一个超级群。
  // 私聊那一行是 docs/21 · G-UI-01 的形态 —— 它此前在这一页上一律显示成「群聊」。
  '/api/principals': [
    { id: 'user:555', kind: 'user', tgId: '555', role: 'owner', displayName: '主人', username: 'owner', chatType: null },
    { id: 'chat:555', kind: 'chat', tgId: '555', role: 'owner', displayName: '主人', username: 'owner', chatType: 'private' },
    { id: 'chat:-100777', kind: 'chat', tgId: '-100777', role: 'trusted', displayName: '绒布球聚集地', username: null, chatType: 'supergroup' },
  ],
  '/api/sandbox': { mode: 'docker', bypassRoles: ['owner'], plan: { allowed: true, mode: 'docker' } },
  // 扁平字段是生效值，`defaults` 是代码里那份 —— 少了 defaults，工具页弹窗的「代码默认」绑定读到 undefined。
  '/api/tools': { bash: { minRole: 'trusted', approval: 'conditional', scope: 'global', source: 'builtin', enabled: true,
    timeoutMs: null, selfManagedTimeout: true, defaults: { minRole: 'trusted', approval: 'conditional', timeoutMs: null }, relaxed: [] },
    web_fetch: { minRole: 'owner', approval: 'never', scope: 'global', source: 'builtin', enabled: true,
      timeoutMs: 45_000, selfManagedTimeout: false, defaults: { minRole: 'limited', approval: 'never', timeoutMs: 60_000 }, relaxed: [] } },
  '/api/turns': { items: [], total: 0, page: 1, size: 20 },
  '/api/messages': { items: [], total: 0, page: 1, size: 50 },
  // 任务与审批都是分页信封。审批那份的 `pending` 是**服务端全表**计数（不是这一页里数出来的）：
  // 左侧导航角标读它，翻页时不该变（`AC-WEB-049`）。这里刻意让 `pending` 大于本页的 pending 行数，
  // 「从当前页数一遍」那种写法会立刻对不上。
  '/api/tasks': { total: 2, page: 1, size: 20, items: [
    { id: 't1', turn_id: 'turn_aaaaaaaaaaaa', agent_run_id: 'run1', chat_id: '-1001', user_id: '555', title: '查一下今天的更新',
      state: 'running', result_summary: null, created_at: Date.now() - 120_000, updated_at: Date.now() - 30_000, finished_at: null,
      chatLabel: '隆福饭搭子', userLabel: '主人' },
    { id: 't2', turn_id: 'turn_bbbbbbbbbbbb', agent_run_id: null, chat_id: '8899001', user_id: '555', title: '整理昨天的群聊',
      state: 'done', result_summary: '一共 12 条，主要在聊周末去哪。', created_at: Date.now() - 86_400_000,
      updated_at: Date.now() - 86_000_000, finished_at: Date.now() - 86_000_000, chatLabel: '阿离', userLabel: '主人' },
  ] },
  '/api/approvals': { total: 2, page: 1, size: 20, pending: 3, items: [
    { id: 'a1', turn_id: 'turn_aaaaaaaaaaaa', agent_run_id: null, span_id: null, chat_id: '-1001', requester_user_id: '555',
      tool_name: 'bash', input_json: '{"command":"rm -rf ./build"}', risk: 'high', state: 'pending',
      requested_at: Date.now() - 60_000, expires_at: Date.now() + 240_000, decided_by: null, decided_at: null, decision_channel: null },
    { id: 'a2', turn_id: 'turn_bbbbbbbbbbbb', agent_run_id: null, span_id: null, chat_id: '8899001', requester_user_id: '555',
      tool_name: 'write_file', input_json: '{"path":"./notes.md"}', risk: 'medium', state: 'approved',
      requested_at: Date.now() - 3_600_000, expires_at: Date.now() - 3_300_000, decided_by: 'owner', decided_at: Date.now() - 3_500_000, decision_channel: 'webui' },
  ] },
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
  // 持久容器：一个钉住的、一个正常的。行模板里那几个派生值（还剩多久、无 setsid 的提示、
  // 上次用的时间）只有真有行时才被渲染 —— 回 `[]` 的话这一块和没写一样。
  '/api/containers': { enabled: true, used: 2, max: 16, containers: [
    { chatId: '-1001', chatLabel: '隆福饭搭子', name: 'luoli-box-n1001', image: 'luoli-sandbox:latest', createdAt: Date.now() - 7_200_000,
      lastUsedAt: Date.now() - 600_000, expiresAt: Date.now() + 86_000_000, hardExpiresAt: null, pinned: false, execCount: 12, hasSetsid: true, lastError: null },
    { chatId: '8899001', chatLabel: '阿离', name: 'luoli-box-8899001', image: 'luoli-sandbox:latest', createdAt: Date.now() - 86_400_000,
      lastUsedAt: Date.now() - 60_000, expiresAt: Date.now() + 3_600_000, hardExpiresAt: Date.now() + 600_000_000, pinned: true, execCount: 3, hasSetsid: false, lastError: 'docker exec 上一次以 137 退出' }] },
  '/api/schedules': { available: true, enabled: true, timezone: 'UTC', settings: { maxPerChat: 20, minIntervalMinutes: 5, maxPayloadChars: 2000 },
    jobs: [{ id: 'j1', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '1', name: '每日早报', mode: 'agent', state: 'active',
      chatLabel: '阿离', creatorLabel: '阿离', cron: '0 8 * * *', timezone: 'UTC', payload: '汇总昨天群里聊了什么', runCount: 2,
      nextRun: new Date(Date.now() + 3_600_000).toISOString(), lastRunAt: Date.now() - 3_600_000, lastState: 'committed',
      createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 3_600_000 },
      // 静默那一档：上一次「跑了但没投递」。它必须与 failed / skipped 分得开，否则「这条任务
      // 其实一直在失败」看起来会非常安静。`at` 发的是 UTC 瞬时，回填表单要过 `toWallClock`。
      { id: 'j2', key: 'chat:c2', chatId: 'c2', threadId: null, createdBy: '1', name: '中午查一次更新', mode: 'agent', state: 'active',
        chatLabel: '隆福饭搭子', creatorLabel: '主人', at: new Date(Date.now() + 7_200_000).toISOString(), timezone: 'Asia/Shanghai',
        payload: '有更新就说，没有就静默', runCount: 9, silent: true, silentStreak: 9,
        nextRun: new Date(Date.now() + 7_200_000).toISOString(), lastRunAt: Date.now() - 7_200_000, lastState: 'silent',
        createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 7_200_000 }] },
  // ── 扩展页的四类。四个端点此前一律回 `[]`（走 `listLike` 那条兜底），于是**四类的行模板
  //    一次都没被渲染过** —— 和模型行、容器行、定时任务行当初的处境完全一样。每一类都放一行
  //    「正常的」和一行「在等人处理的」，因为这一页真正的活儿是后者。
  '/api/skills': [
    // 随包那四份说明书之一：只放行启停，改正文/删除回 403 `skill_reserved`。
    { name: 'writing-tools', description: '用 define_tool 给自己写一个可复用的工具时读这份。', min_role: 'owner',
      enabled: 1, source: 'bundled', load_error: null, updated_at: Date.now() - 86_400_000 },
    // 装包进来且从未被启用过 = 未审阅。这一档必须与「停用」分得开（docs/07 §6.4）。
    { name: 'music-download-cli-linux', description: 'Search and download music from QQ / Kuwo / NetEase.', min_role: 'trusted',
      enabled: 0, source: 'package', load_error: null, updated_at: Date.now() - 3_600_000 },
    // 解析失败的 stub：`SkillLoader` 照样 persist，界面上要看得见是坏的。
    { name: 'broken-skill', description: '', min_role: 'owner', enabled: 0, source: 'local',
      load_error: 'skill name must equal directory name', updated_at: Date.now() - 600_000 },
  ],
  // `provides_json` 是 plugin 侧的「N 个工具」—— 端点一直在发，界面一直没读。
  '/api/plugins': [{ name: 'weather', path: './plugins/weather', version: '1.2.0', min_role: 'trusted', enabled: 1,
    config_json: '{}', provides_json: JSON.stringify({ tools: ['weather_now'], hooks: ['onTurnStart'], commands: ['/weather'] }),
    load_error: null, updated_at: Date.now() - 7_200_000 }],
  // 两台 server：一台连上了（带 connected_at 与 20 个工具名），一台等着人去登录。
  // `needs_auth` 是本轮新增的状态，`MCP_STATE_LABELS` 少一条它就会原样显示成英文。
  '/api/mcp': [
    { name: 'agent-browser', transport: 'stdio', command: 'agent-browser', args: ['mcp'], env: {}, minRole: 'trusted',
      min_role: 'trusted', enabled: 1, toolAllow: [], toolDeny: [], timeoutMs: 60_000, state: 'up', last_error: null,
      connected_at: Date.now() - 900_000, updated_at: Date.now() - 900_000,
      tools: Array.from({ length: 20 }, (_value, index) => ({ name: `browser_action_${index}`, description: `第 ${index} 个动作` })),
      auth: { mode: 'none', authorizedAt: null, expiresAt: null, scope: null } },
    { name: 'notion', transport: 'http', url: 'https://mcp.example.com/notion', headers: {}, minRole: 'owner',
      min_role: 'owner', enabled: 1, toolAllow: [], toolDeny: [], timeoutMs: 30_000, state: 'needs_auth',
      last_error: '这台 server 要求登录。点〔登录〕走一遍授权。', connected_at: null, updated_at: Date.now() - 60_000,
      tools: [], auth: { mode: 'oauth', authorizedAt: null, expiresAt: null, scope: 'read write' } },
  ],
  // 模型自己写的脚本：`reviewedAt === null` 且停用 = 在等人读过正文再启用。
  '/api/custom-tools': [{ name: 'tally_votes', description: '统计群里投票消息的票数', runtime: 'python',
    body: 'import json, sys\nprint(json.dumps({"ok": True}))\n', paramsJson: JSON.stringify({ type: 'object', properties: {} }),
    minRole: 'owner', scope: 'chat', ownerChatId: '-1001', timeoutMs: 60_000, enabled: 0, createdBy: '5568996608',
    reviewedAt: null, lastError: null, updatedAt: Date.now() - 1_800_000 }],
};

/** 没显式列出的端点：按路径形状猜一个空值。数组端点回 `[]`，其余回 `{}`。 */
function responseFor(url: string): unknown {
  const path = url.split('?')[0]!;
  if (path in RESPONSES) return RESPONSES[path];
  // `/api/turns/active` 也回数组：它慢一步落到 DataGrid 的 `rows`，回 `{}` 的表现是一条
  // 「Invalid prop: type check failed for prop "rows"」，而那正是这套装置要挡的那类症状。
  const listLike = ['/api/principals', '/api/providers', '/api/logs', '/api/chats', '/api/usage', '/api/skills', '/api/plugins',
    '/api/mcp', '/api/custom-tools', '/api/agents', '/api/prompts', '/api/models', '/api/aliases', '/api/turns/active'];
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

  /**
   * 主体页的类型标签（docs/21 · G-UI-01）。`principals.kind` 只有 `user` / `chat`，而 `chat` 是
   * 「一个 Telegram 会话」**不是「群」**：每个私聊也有一行 `chat:<用户 id>`。这一页此前把 kind
   * 直接当标签用，于是私聊一律显示成「群聊」—— 而同一份数据在会话页上是对的（那边读 `chat_type`）。
   */
  it('主体页按 chat_type 区分私聊与群，筛选页签也跟着分', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { active: string; principalKind: string; visiblePrincipals: Array<{ id: string }> };
    vm.active = 'principals';
    await settle(wrapper);
    const rows = wrapper.findAll('tbody tr').map((row) => row.text());
    expect(rows.find((text) => text.includes('绒布球聚集地')), '群那一行没渲染出来').toContain('超级群');
    // 私聊那一行：不能出现「群聊」这个词，而它的 tgId 是正数、chat_type 是 private。
    const privateRow = rows.find((text) => text.includes('私聊'));
    expect(privateRow, '私聊会话那一行没有按 chat_type 标出来').toBeDefined();
    expect(privateRow).not.toContain('群');
    // 四个页签把三行分成 3 / 1 / 1 / 1。
    for (const [kind, ids] of [['all', ['user:555', 'chat:555', 'chat:-100777']], ['user', ['user:555']], ['private', ['chat:555']], ['group', ['chat:-100777']]] as const) {
      vm.principalKind = kind;
      await settle(wrapper);
      expect(vm.visiblePrincipals.map((entry) => entry.id), `${kind} 页签筛出来的行不对`).toEqual([...ids]);
    }
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

  /**
   * 扩展页的四个分段（docs/09 §3.8）。跟设置页那四个 tab 同一个道理：漏一个分支，那一段从此
   * 没人渲染过。这一页是从 `ConsoleView.vue` 里**整段抽出来**的（`ExtensionsPage.vue`），
   * 而上一次抽子视图时三条绿灯都亮着、14 个页面全空白（docs/24 · R-UI-01）—— 所以这里断言的是
   * 「四个分段各自真的渲染出了内容」，不是「组件 import 得进来」。
   */
  it('扩展页四个分段逐个切过去都有内容，且分段定义与模板分支一一对应', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    (wrapper.vm as unknown as { active: string }).active = 'extensions';
    await settle(wrapper);
    const page = wrapper.findComponent({ name: 'ExtensionsPage' });
    expect(page.exists(), '扩展页组件没挂上').toBe(true);
    const vm = page.vm as unknown as { EXTENSION_TABS: ReadonlyArray<readonly [string, string, string]>; tab: string };
    expect(vm.EXTENSION_TABS.map(([key]) => key)).toEqual([...EXTENSION_TABS]);
    for (const key of EXTENSION_TABS) {
      vm.tab = key;
      await settle(wrapper);
      const panel = wrapper.find(`[data-ext-tab="${key}"]`);
      expect(panel.exists(), `扩展页缺少 ${key} 这个分段的分支`).toBe(true);
      // 四个分段都是 `v-show`：切分段不该把没保存的东西弄丢，所以 DOM 里始终有四个。
      expect(panel.attributes('style') ?? '', `${key} 分段切过去之后仍然是隐藏的`).not.toContain('display: none');
      expect(panel.text().trim().length, `${key} 分段的内容是空的`).toBeGreaterThan(20);
    }
    const rendering = warnings.filter((line) => line.includes('[Vue warn]'));
    expect(rendering, `渲染期间产生了 Vue 警告：\n${rendering.join('\n')}`).toEqual([]);
    spy.mockRestore();
    wrapper.unmount();
  });

  /**
   * 「要登录」必须是独立一档，而且那一行要真的给出一个能点的入口。此前 `state` 只有
   * up/pending/down/disabled，一台要登录的 server 显示成「连不上」加一句
   * `Error POSTing to endpoint: <原始响应体>` —— 从里面读不出该做什么。
   */
  it('MCP 段：needs_auth 渲染成「要登录」并给出登录按钮，down 那台不给', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    (wrapper.vm as unknown as { active: string }).active = 'extensions';
    await settle(wrapper);
    const page = wrapper.findComponent({ name: 'ExtensionsPage' });
    (page.vm as unknown as { tab: string }).tab = 'mcp';
    await settle(wrapper);
    const rows = wrapper.findAll('.ext-table tbody tr');
    expect(rows.length, 'MCP 表一行都没渲染').toBe(2);
    const needsAuth = rows.find((row) => row.text().includes('notion'))!;
    expect(needsAuth.text()).toContain('要登录');
    expect(needsAuth.text()).not.toContain('连不上');
    expect(needsAuth.findAll('button').map((button) => button.text()), 'needs_auth 那一行没有〔登录〕入口')
      .toContain('登录');
    // 已连接那台：不该出现登录按钮，而工具条数要点得开。
    const connected = rows.find((row) => row.text().includes('agent-browser'))!;
    expect(connected.text()).toContain('已连接');
    expect(connected.findAll('button').map((button) => button.text())).not.toContain('登录');
    expect(connected.text()).toContain('20 个');
    wrapper.unmount();
  });

  /**
   * 未审阅的行要有**自己的形态**，不只是换一个标签的字：`.pending-review` 那条虚线 + 琥珀脊
   * 才是「这几行在等你」的视觉判据。查 class 而不查文案 —— 后者改一句话就红。
   */
  it('未审阅的 Skill 与自定义工具带 pending-review 形态，已启用的不带', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    (wrapper.vm as unknown as { active: string }).active = 'extensions';
    await settle(wrapper);
    const page = wrapper.findComponent({ name: 'ExtensionsPage' });
    const rows = wrapper.findAll('[data-ext-tab="skills"] .ext-row');
    const packaged = rows.find((row) => row.text().includes('music-download-cli-linux'))!;
    expect(packaged.classes(), '装进来且从未启用过的 skill 没有 pending-review 形态').toContain('pending-review');
    expect(packaged.classes(), '来源脊没有按 source 上色').toContain('from-package');
    const bundled = rows.find((row) => row.text().includes('writing-tools'))!;
    expect(bundled.classes()).toContain('from-bundled');
    expect(bundled.classes()).not.toContain('pending-review');
    // 随包那份只放行启停：不该给删除按钮（服务端会回 403，摆一个必然报错的按钮更难排查）。
    expect(bundled.findAll('button').map((button) => button.attributes('aria-label') ?? button.text())).not.toContain('删除');

    (page.vm as unknown as { tab: string }).tab = 'tools';
    await settle(wrapper);
    const tool = wrapper.find('[data-ext-tab="tools"] .ext-row');
    expect(tool.classes()).toContain('pending-review');
    expect(tool.text()).toContain('未审阅');
    wrapper.unmount();
  });

  /**
   * 待你处理那条 —— 这一页真正的收件箱。它必须把三类「在等人」的东西都数进去：
   * 未审阅的包、未复审的脚本、要登录的 server。
   */
  it('待你处理把未审阅、要登录、加载失败三类都数进去', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    (wrapper.vm as unknown as { active: string }).active = 'extensions';
    await settle(wrapper);
    const inbox = wrapper.find('.ext-inbox');
    expect(inbox.exists()).toBe(true);
    expect(inbox.text()).toContain('等人读过');
    expect(inbox.text()).toContain('等人复审');
    expect(inbox.text()).toContain('要登录');
    // fixture 里有一个 load_error 的 skill。
    expect(inbox.text()).toContain('加载或连接失败');
    wrapper.unmount();
  });

  /**
   * 任务页是从 `ConsoleView.vue` 里**整段抽出来**的（`TasksPage.vue` + 三张卡），跟扩展页那次
   * 同一个道理：上一回抽子视图时三条绿灯都亮着、14 个页面全空白（docs/24 · R-UI-01）。
   * 所以这里断言的是「三张卡各自真的渲染出了自己的行」，不是「组件 import 得进来」。
   * 顺序也焊住：任务 → 定时任务 → 审批（`.card-stack` 竖排）。
   */
  it('任务页三张卡竖排、顺序固定，且各自渲染出自己的行', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    (wrapper.vm as unknown as { active: string }).active = 'tasks';
    await settle(wrapper);
    expect(wrapper.findComponent({ name: 'TasksPage' }).exists(), '任务页组件没挂上').toBe(true);
    const stack = wrapper.find('.card-stack');
    expect(stack.exists(), '三张卡不在 .card-stack 里').toBe(true);
    // `.dashboard-grid` 是总览页的骨架（2fr 1fr），任务页不该再借用它。
    expect(wrapper.findAll('.page-surface .dashboard-grid').length).toBe(0);
    expect(stack.findAll(':scope > article').map((card) => card.find('h3').text())).toEqual(['任务', '定时任务', '审批']);
    for (const [name, needle] of [['TasksCard', '查一下今天的更新'], ['SchedulesCard', '每日早报'], ['ApprovalsCard', 'bash']] as const) {
      const card = wrapper.findComponent({ name });
      expect(card.exists(), `${name} 没挂上`).toBe(true);
      expect(card.text(), `${name} 一行都没渲染`).toContain(needle);
    }
    // 静默那一档：`SCHEDULE_RUN_STATES` 少一条它就原样显示成英文的 `silent`。
    expect(wrapper.findComponent({ name: 'SchedulesCard' }).text()).toContain('静默');
    const rendering = warnings.filter((line) => line.includes('[Vue warn]'));
    expect(rendering, `渲染期间产生了 Vue 警告：\n${rendering.join('\n')}`).toEqual([]);
    spy.mockRestore();
    wrapper.unmount();
  });

  /**
   * 导航角标读的是 `GET /api/approvals` 信封里的**全表** `pending`，不是当前页里数出来的
   * pending 行数。`AC-WEB-049` 要的是「不必切到任务页就看得见还有几个人在等」——
   * 分页改造里唯一一处会**静默造成功能退化**的地方就是这里。
   */
  it('待审批角标取信封里的全表 pending，不是当前页数出来的', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { active: string; pendingApprovals: number };
    // `load()` 是一条六段的 await 链，角标在靠后那一段 —— `settle()` 的 6 轮只够跑完头一个
    // `Promise.all`。全是 microtask，没有计时器，所以多转几轮是确定性的，不是在赌时间。
    for (let round = 0; round < 20 && vm.pendingApprovals === 0; round += 1) await settle(wrapper);
    // fixture：当前页只有 1 条 pending，而全表 pending 是 3。数当前页会得到 1。
    expect(vm.pendingApprovals).toBe(3);
    expect(wrapper.find('.sidebar .nav-badge').text()).toBe('3');
    // 首屏就有 —— 不用切到任务页。
    expect(vm.active).toBe('dashboard');
    // 拉角标的那一次请求只要一行：全表计数在信封上，不需要把 200 行拖回来。
    const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls
      .map(([url]) => String(url)).filter((url) => url.startsWith('/api/approvals'));
    expect(calls.some((url) => url.includes('size=1')), `角标没走单行请求：${calls.join(' , ')}`).toBe(true);
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
