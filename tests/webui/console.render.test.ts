import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { toasts } from '../../packages/webui/src/ui/toast';
import { confirmBox, dismissConfirm, runConfirmed } from '../../packages/webui/src/ui/confirm';

/**
 * 控制台的渲染防线。
 *
 * 上一轮把 `ConsoleView.vue` 拆成 15 个子视图：`pnpm build` 通过、`pnpm test` 全部通过、`/login`
 * 可打开，而 14 个控制台页面全是空白（docs/24 · R-UI-01）。成因是子 SFC 的 `setup` 返回了一个
 * 只有 `get` 陷阱的 Proxy，而 Vue 解析模板绑定走的是 `hasOwn(setupState, key)`，一个 `_ctx.xxx`
 * 都解析不出来。这三项通过合起来也无法证明控制台可用，因为没有任何测试真正渲染过它一次。
 *
 * 本文件补上那一次渲染：逐个切换到 14 个导航项，断言内容区存在实际文本，且整个过程中
 * 没有 Vue 警告（Property X was accessed during render but is not defined 正是那次故障的
 * 唯一可见症状）。断言的是能否渲染出内容，而非具体文案，后者会让这条防线因一句文案改动而失败。
 */

const NAV_KEYS = ['dashboard', 'chats', 'messages', 'prompts', 'providers', 'principals', 'tools',
  'extensions', 'workers', 'logs', 'usage', 'quota', 'tasks', 'settings'] as const;
/** 设置页的四个二级 tab（docs/09 §3.13）。与导航项同理：遗漏一个分支，该 tab 从此无人渲染。 */
const SETTINGS_TABS = ['common', 'all', 'maintenance', 'advanced'] as const;
/** 工具页按操作目的拆分。缺少任一分区时，长页重构会把审批或沙箱入口静默藏掉。 */
const TOOL_TABS = ['catalog', 'approval', 'runtime'] as const;
/** 扩展页的四个分段（docs/09 §3.8）。同上：新增一段就要同步加入这里。 */
const EXTENSION_TABS = ['skills', 'mcp', 'plugins', 'tools'] as const;

/** 每个端点返回一份形状匹配的空数据。这里刻意不 mock 组件内部：要验证的正是真实模板与真实
 *  setup 在收到正常响应时能否渲染出来。 */
const RESPONSES: Record<string, unknown> = {
  '/api/auth/me': { role: 'owner', csrf: 'csrf-token', expiresAt: Date.now() + 3_600_000 },
  '/api/dashboard': { turns: { total: 3, running: 0, failed: 1, cost: 0.42 }, messages: { total: 12 }, providers: { total: 2, enabled: 1 },
    trend: Array.from({ length: 7 }, (_value, index) => ({ day: `2026-08-${11 + index}`, messages: index, turns: index, costUsd: index * 0.01 })) },
  '/api/health/detail': { ok: true, version: 'test', uptimeMs: 90_000, db: { ok: true, bytes: 4096, walBytes: 0, workspaceBytes: 1024 },
    providers: [], mcp: [], sandbox: { allowed: true, mode: 'docker' }, inFlightTurns: 0 },
  '/api/logs': [
    { id: 1, ts: Date.now() - 5_000, level: 'warn', kind: 'sandbox.weak_isolation', summary: 'sandbox.persistent.network=bridge：持久容器可直连公网与宿主', trace_id: 'turn_aaaaaaaaaaaa', span_id: null, parent_span_id: null, chat_id: null, user_id: null, key: null, duration_ms: null, data_bytes: 120 },
    { id: 2, ts: Date.now() - 6_000, level: 'warn', kind: 'plugin.hot_reload_unreliable', summary: '当前运行时下 plugin 热重载不可靠', trace_id: 'turn_bbbbbbbbbbbb', span_id: null, parent_span_id: null, chat_id: null, user_id: null, key: null, duration_ms: null, data_bytes: 80 },
  ],
  '/api/quota': { quota: { enabled: true, requirePricing: true, minReserveUsd: 0.02, global: { daily: 5, monthly: 100 }, perChat: { daily: 1, monthly: null },
    perUser: { daily: 0.5, monthly: null, byRole: {} }, perTurn: { maxCostUsd: 0.5, maxSteps: 12 },
    rateLimit: { turnsPerUserPerHour: 30, turnsPerChatPerHour: 100, concurrentPerUser: 2 }, onExceeded: { reply: true, message: '额度用完了' } },
    timezone: 'UTC', buckets: { day: '2026-08-17', month: '2026-08' },
    counters: [{ scope: 'global', subject: 'global', window: 'day', bucket: '2026-08-17', costUsd: 1.2, reservedUsd: 0, turns: 3, updatedAt: Date.now(), current: true, limit: 5, limitApprox: false, role: null, label: null, username: null }],
    unpriced: [], unpricedTotal: 0, unimplemented: [] },
  '/api/config': { general: { name: '洛璃', timezone: 'UTC' }, trigger: { private: true, mention: true, reply: true, command: true, channels: false, wakewords: ['洛璃'], wakewordMinLength: 2, requireTextAfterMention: false, ignoreEditedAsTrigger: true },
    output: { mode: 'stream', replyDelayMs: 0, streamBufferMs: 900, streamIntervalMs: 1500, streamMinDeltaChars: 24, maxMessageChars: 3900 }, webui: { passwordHash: '«redacted»' } },
  '/api/config/schema': { schema: { definitions: { LuoLiConfig: { properties: {} } } }, hotReloadable: [], unimplemented: [], envPinned: [], enumNotes: {} },
  // 主体三行：一个用户、一个私聊会话（`chat:` 前缀、正数 id、chat_type=private）、一个超级群。
  // 私聊那一行对应 docs/21 · G-UI-01 的形态，它此前在这一页上一律显示为群聊。
  '/api/principals': [
    { id: 'user:555', kind: 'user', tgId: '555', role: 'owner', displayName: '主人', username: 'owner', chatType: null },
    { id: 'chat:555', kind: 'chat', tgId: '555', role: 'owner', displayName: '主人', username: 'owner', chatType: 'private' },
    { id: 'chat:-100777', kind: 'chat', tgId: '-100777', role: 'trusted', displayName: '绒布球聚集地', username: null, chatType: 'supergroup' },
  ],
  // 真实形状是 `{config, allowHostFsForOwner, plan}`：扁平结构会让 `syncSandbox` 中的
  // `payload.config.bypassRoles` 读取到 undefined，整张表单静默停留在出厂默认值。
  '/api/sandbox': { config: { mode: 'docker', bypassRoles: ['owner'], persistent: { enabled: false } }, allowHostFsForOwner: false,
    plan: { allowed: true, mode: 'docker' } },
  // 扁平字段是生效值，`defaults` 是代码中的默认值；缺少 defaults 时，工具页弹窗的代码默认绑定会读到 undefined。
  // `sides` 三态各出现一次：只有主 agent（派发口）、只有 worker（主 agent 不再碰工具）、两侧共享。
  // 缺了它，工具表那一列的模板与过滤器就从未被渲染过。
  '/api/tools': { bash: { minRole: 'trusted', approval: 'conditional', scope: 'global', source: 'builtin', enabled: true,
    timeoutMs: null, selfManagedTimeout: true, deferred: false, sides: ['worker'], defaults: { minRole: 'trusted', approval: 'conditional', timeoutMs: null }, relaxed: [] },
    spawn_worker: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'agent', enabled: true,
      timeoutMs: null, selfManagedTimeout: true, deferred: false, sides: ['main'], defaults: { minRole: 'limited', approval: 'never', timeoutMs: null }, relaxed: [] },
    memory_read: { minRole: 'limited', approval: 'never', scope: 'private', source: 'builtin', enabled: true,
      timeoutMs: 5_000, selfManagedTimeout: false, deferred: false, sides: ['main', 'worker'], defaults: { minRole: 'limited', approval: 'never', timeoutMs: 5_000 }, relaxed: [] },
    web_fetch: { minRole: 'owner', approval: 'never', scope: 'global', source: 'builtin', enabled: true,
      timeoutMs: 45_000, selfManagedTimeout: false, deferred: true, sides: ['worker'], defaults: { minRole: 'limited', approval: 'never', timeoutMs: 60_000 }, relaxed: [] } },
  '/api/turns': { items: [], total: 0, page: 1, size: 20 },
  // 归档检索的命中行。此前一律返回 `{items: []}`，导致这一页的三个行内动作（查看轮次、查看原始载荷、
  // 软删除）从未被渲染过。
  '/api/messages': { total: 1, page: 1, size: 50, items: [
    { id: 9001, chatId: '-1001', direction: 'in', fromName: '主人', fromUsername: 'owner', kind: 'text',
      text: '看看这条到底发来了什么', tgDate: Date.now() - 60_000, turnId: 'turn_aaaaaaaaaaaa', attachments: [] }] },
  // `raw_json` 只在单条详情中下发（列表一页 50 条各带一份 update）。这里是入库脱敏之后的版本，
  // 键名含 api_key 的字段在入库时即已替换为 «redacted»。
  '/api/messages/9001': { id: 9001, chatId: '-1001', tgMessageId: 4242, kind: 'text', tgDate: Date.now() - 60_000,
    text: '看看这条到底发来了什么',
    rawJson: JSON.stringify({ message_id: 4242, entities: [{ type: 'bold', offset: 0, length: 2 }], api_key: '«redacted»' }) },
  // 任务与审批都是分页信封。审批那份的 `pending` 是服务端全表计数，而非本页统计所得：
  // 左侧导航角标读取它，翻页时不应变化（`AC-WEB-049`）。这里刻意让 `pending` 大于本页的 pending 行数，
  // 按当前页统计的写法会立即不匹配。
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
  // Worker 运行记录：三档各一行。返回 `{items:[]}` 的写法会让这一页的行模板（类型徽标、
  // 外部自报那一格、耗时）从未被渲染过 —— 与模型行、容器行此前的情形相同。
  '/api/worker-runs': { total: 3, page: 1, size: 20, items: [
    { id: 'run-h1', turnId: 'turn_aaaaaaaaaaaa', parentRunId: null, depth: 1, workerKind: 'harness', agentName: 'harness:claude',
      modelAlias: 'external', effectiveRole: 'owner', state: 'running', steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
      costUsd: 0, externalCostUsd: null, taskLine: '改一下那个仓库的 parser', resultSummary: null, error: null,
      startedAt: Date.now() - 1_200_000, finishedAt: null },
    { id: 'run-a1', turnId: 'turn_bbbbbbbbbbbb', parentRunId: null, depth: 1, workerKind: 'acp', agentName: 'acp:omp',
      modelAlias: 'external', effectiveRole: 'owner', state: 'done', steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
      costUsd: 0, externalCostUsd: 1.25, taskLine: '重构 parser', resultSummary: '改完了', error: null,
      startedAt: Date.now() - 600_000, finishedAt: Date.now() - 300_000 },
    { id: 'run-l1', turnId: 'turn_bbbbbbbbbbbb', parentRunId: null, depth: 1, workerKind: 'lw', agentName: 'worker',
      modelAlias: 'low', effectiveRole: 'trusted', state: 'done', steps: 3, toolCalls: 4, inputTokens: 900, outputTokens: 120,
      costUsd: 0.0123, externalCostUsd: null, taskLine: '查一下今天的更新', resultSummary: '查完了', error: null,
      startedAt: Date.now() - 120_000, finishedAt: Date.now() - 60_000 },
  ] },
  '/api/usage/report': { groupBy: 'day', from: 0, to: Date.now(), rows: [] },
  // 唤醒词可用性是数组端点，但路径形态不像列表，因此显式列出。
  '/api/config/wakewords/check': [{ pattern: '洛璃', kind: 'contains', ok: true, reason: null }],
  // fail-closed 的拒绝：`gcFiles` 的 `refused` 唯一触发条件是数据库与目录来自两套部署。
  '/api/maintenance/gc-files': { files: 0, fileBytes: 0, agentResults: 0, agentResultBytes: 0,
    refused: ['attachments 里一条带路径的行都没有，而 ./data/files 下有文件 —— 这通常意味着库与目录来自两套部署。拒绝清理。'] },
  // 模型行：一行目录标记为支持看图、运维手动标记为不支持看图的中转模型。此前 `/api/models` 一律返回 `[]`，
  // 导致模型表的行模板（能力徽标、定价出处、手标徽标）从未被渲染过。
  '/api/models': [{ id: 'm1', provider_id: 'p1', model_id: 'grok-4.5', display_name: 'Grok 4.5', context_window: 500_000, max_output: 16_384,
    capabilities_json: JSON.stringify({ vision: false, tools: true, reasoningControl: 'effort', reasoningEfforts: ['low', 'high'],
      modalities: { input: ['text', 'image'], output: ['text'] },
      catalog: { source: 'models.dev', match: 'official', providerId: 'xai', modelId: 'grok-4.5', normalized: false, priceRange: null, priceSource: 'official', fetchedAt: 1_787_000_000_000 },
      manual: { vision: false } }),
    price_in: 3, price_out: 15, price_cache_read: null, price_cache_write: null, enabled: 1, sort: 0 }],
  // 别名路由同时放一段可用模型与一段已删除模型，列表需要保留顺序并明确标出失效段。
  '/api/aliases': [{ alias: 'main', model_ids_json: JSON.stringify(['m1', 'gone']), settings_json: JSON.stringify({ temperature: .4, reasoning: 'high' }), description: '生产主链' }],
  // 持久容器：一个已钉住、一个正常。行模板中的几个派生值（剩余时间、无 setsid 的提示、
  // 上次使用时间）只有存在数据行时才会渲染，返回 `[]` 时这一块等同未实现。
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
      // 静默那一档：上一次已执行但未投递。它必须与 failed / skipped 区分开，否则任务持续失败
      // 的状态在界面上不会有任何体现。`at` 下发的是 UTC 瞬时值，回填表单需经过 `toWallClock`。
      { id: 'j2', key: 'chat:c2', chatId: 'c2', threadId: null, createdBy: '1', name: '中午查一次更新', mode: 'agent', state: 'active',
        chatLabel: '隆福饭搭子', creatorLabel: '主人', at: new Date(Date.now() + 7_200_000).toISOString(), timezone: 'Asia/Shanghai',
        payload: '有更新就说，没有就静默', runCount: 9, silent: true, silentStreak: 9,
        nextRun: new Date(Date.now() + 7_200_000).toISOString(), lastRunAt: Date.now() - 7_200_000, lastState: 'silent',
        createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 7_200_000 }] },
  // ── 扩展页的四类。四个端点此前一律返回 `[]`（走 `listLike` 兜底），导致四类的行模板
  //    从未被渲染过，与模型行、容器行、定时任务行此前的情形相同。每一类各放一行
  //    正常状态与一行待处理状态，因为这一页的主要用途是处理后者。
  '/api/skills': [
    // 随包分发的四份说明文档之一：只允许启停，修改正文或删除返回 403 `skill_reserved`。
    { name: 'writing-tools', description: '用 define_tool 给自己写一个可复用的工具时读这份。', min_role: 'owner',
      enabled: 1, source: 'bundled', load_error: null, updated_at: Date.now() - 86_400_000 },
    // 已安装且从未启用过即为未审阅。这一档必须与停用区分开（docs/07 §6.4）。
    { name: 'music-download-cli-linux', description: 'Search and download music from QQ / Kuwo / NetEase.', min_role: 'trusted',
      enabled: 0, source: 'package', load_error: null, updated_at: Date.now() - 3_600_000 },
    // 解析失败的 stub：`SkillLoader` 仍会 persist，界面上要能看出它是损坏的。
    { name: 'broken-skill', description: '', min_role: 'owner', enabled: 0, source: 'local',
      load_error: 'skill name must equal directory name', updated_at: Date.now() - 600_000 },
  ],
  // `provides_json` 是 plugin 侧提供的工具数量，端点一直在下发，界面此前未读取。
  '/api/plugins': [{ name: 'weather', path: './plugins/weather', version: '1.2.0', min_role: 'trusted', enabled: 1,
    config_json: '{}', provides_json: JSON.stringify({ tools: ['weather_now'], hooks: ['onTurnStart'], commands: ['/weather'] }),
    load_error: null, updated_at: Date.now() - 7_200_000 }],
  // 两台 server：一台已连接（带 connected_at 与 20 个工具名），一台等待登录。
  // `needs_auth` 是本轮新增的状态，`MCP_STATE_LABELS` 缺少一条它就会原样显示为英文。
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
  // 模型自行编写的脚本：`reviewedAt === null` 且处于停用状态，表示等待人工阅读正文后再启用。
  '/api/custom-tools': [{ name: 'tally_votes', description: '统计群里投票消息的票数', runtime: 'python',
    body: 'import json, sys\nprint(json.dumps({"ok": True}))\n', paramsJson: JSON.stringify({ type: 'object', properties: {} }),
    minRole: 'owner', scope: 'chat', ownerChatId: '-1001', timeoutMs: 60_000, enabled: 0, createdBy: '5568996608',
    reviewedAt: null, lastError: null, updatedAt: Date.now() - 1_800_000 }],
};

/** 未显式列出的端点：按路径形态推断一个空值。数组端点返回 `[]`，其余返回 `{}`。 */
function responseFor(url: string): unknown {
  const path = url.split('?')[0]!;
  if (path in RESPONSES) return RESPONSES[path];
  // `/api/turns/active` 同样返回数组：它稍后落到 DataGrid 的 `rows`，返回 `{}` 的表现是一条
  // Invalid prop: type check failed for prop "rows"，而这正是本装置要拦截的症状类型。
  const listLike = ['/api/principals', '/api/providers', '/api/logs', '/api/chats', '/api/usage', '/api/skills', '/api/plugins',
    '/api/mcp', '/api/custom-tools', '/api/prompts', '/api/models', '/api/aliases', '/api/turns/active'];
  return listLike.includes(path) ? [] : {};
}

/** 已建立的那几条 SSE 连接。重连补拉那条用例需要手动触发 `onerror` / `onopen`。 */
interface FakeEventSource { onopen?: () => void; onerror?: () => void; emit(type: string, data?: unknown): void }
const eventSources: FakeEventSource[] = [];

function stubFetch(): void {
  eventSources.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // SSE 连接在 happy-dom 中没有 EventSource 语义，返回一条空流即可，实时刷新不在本文件的验证范围内。
    if (url.includes('/api/events')) return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ ok: true, data: responseFor(url) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  vi.stubGlobal('EventSource', class {
    listeners = new Map<string, (event: unknown) => void>();
    constructor() { eventSources.push(this as unknown as FakeEventSource); }
    close(): void { /* noop */ }
    addEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, fn); }
    emit(type: string, data: unknown = {}): void { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
  });
}

async function settle(wrapper: VueWrapper): Promise<void> {
  // 三轮 microtask 加 nextTick：`load()` 内是一串 await，一次 nextTick 不足。
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
    // 侧栏本身位于 ConsoleView 自身的模板中，上次故障时它是唯一仍正常显示的部分，因此不能只断言它。
    expect(wrapper.text()).toContain('总览');
    for (const key of NAV_KEYS) {
      (wrapper.vm as unknown as { active: string }).active = key;
      await settle(wrapper);
      const main = wrapper.find('.console-main').exists() ? wrapper.find('.console-main') : wrapper.find('main');
      const body = main.text().replace(wrapper.find('.sidebar').exists() ? wrapper.find('.sidebar').text() : '', '').trim();
      // 内容区文本长度为 0 是上次那 14 个空白页的确切症状（docs/24 §2 的实测输出）。
      expect(body.length, `${key} 页的内容区是空的`).toBeGreaterThan(20);
    }
    // Property "xxx" was accessed during render but is not defined on instance 正是那次故障的
    // 唯一可见症状：模板能渲染出 DOM，但每一个绑定都是 undefined。
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
      // 前三个 tab 使用 v-show（未保存的草稿不能因切换 tab 丢失），因此 DOM 中始终存在四个中的三个：
      // 断言当前这个可见，而不是断言只有它存在。
      expect(panel.attributes('style') ?? '', `${tab} 这个 tab 切过去之后仍然是隐藏的`).not.toContain('display: none');
      expect(panel.text().trim().length, `${tab} 这个 tab 的内容是空的`).toBeGreaterThan(20);
    }
    const rendering = warnings.filter((line) => line.includes('[Vue warn]'));
    expect(rendering, `渲染期间产生了 Vue 警告：\n${rendering.join('\n')}`).toEqual([]);
    spy.mockRestore();
    wrapper.unmount();
  });

  /**
   * 主体页的类型标签（docs/21 · G-UI-01）。`principals.kind` 只有 `user` / `chat`，而 `chat` 表示
   * 一个 Telegram 会话而非群。这一页此前直接把 kind 当作标签，导致私聊一律显示为群聊，而同一份
   * 数据在会话页上是正确的（那边读 `chat_type`）。
   *
   * 私聊如今只占 `user:` 一行，子导航随之只剩三档（全部 / 用户 / 群与频道），`chat` 一律归入
   * 群与频道；`chat_type` 那条标签判据保留，旧库里的 `chat:<用户 id>` 残留行仍要标成私聊。
   */
  it('主体页按 chat_type 区分私聊与群，筛选页签分成用户与群两类', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { active: string; principalKind: string; visiblePrincipals: Array<{ id: string }> };
    vm.active = 'principals';
    await settle(wrapper);
    const rows = wrapper.findAll('tbody tr').map((row) => row.text());
    expect(rows.find((text) => text.includes('绒布球聚集地')), '群那一行没渲染出来').toContain('超级群');
    // 私聊那一行：不应出现群聊字样，其 tgId 为正数、chat_type 为 private。
    const privateRow = rows.find((text) => text.includes('私聊'));
    expect(privateRow, '私聊会话那一行没有按 chat_type 标出来').toBeDefined();
    expect(privateRow).not.toContain('群');
    // 三个页签把三行分成 3 / 1 / 2：残留的 `chat:555` 归入群与频道那一档。
    for (const [kind, ids] of [['all', ['user:555', 'chat:555', 'chat:-100777']], ['user', ['user:555']], ['group', ['chat:555', 'chat:-100777']]] as const) {
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
   * `gc-files` 的 fail-closed 拒绝不能渲染成绿色的完成状态。`severity` 与标题此前写死，拒绝理由挤在
   * 一行 JSON 的 `refused` 字段末尾、8 秒后自动消失，而它唯一的触发条件是数据库与目录来自两套
   * 部署，正是运维应立即停止操作的情形（docs/28 · L-WEB-03；docs/25 §10 记录的误删 76 个附件与
   * 90 份子 agent 全文正是由它防住的）。
   */
  it('维护动作返回 refused 时是 warn 且不自动消失', async () => {
    dismissConfirm();
    toasts.splice(0, toasts.length);
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    // 确认走 `ui/confirm.ts` 而非 `window.confirm`（后者在 happy-dom 中未实现，
    // 这条用例此前依靠 `vi.stubGlobal('confirm', …)` 支撑，正是 `M-WEB-01` 的体现）。
    (wrapper.vm as unknown as { runMaintenance(action: string, label: string): void }).runMaintenance('gc-files', '清理孤儿文件');
    expect(confirmBox.value.open).toBe(true);
    await runConfirmed();
    await settle(wrapper);
    const toast = toasts.at(-1)!;
    expect(toast.severity).toBe('warn');
    expect(toast.summary).toBe('清理孤儿文件 已拒绝');
    // 仅当 life <= 0 时不自动消失（`pushToast` 的语义）：8 秒后消失等于隐藏这条拒绝。
    expect(toast.life).toBeLessThanOrEqual(0);
    expect(toast.detail).toContain('两套部署');
    // 对照组：不带 refused 的动作仍显示为绿色完成状态。
    (wrapper.vm as unknown as { runMaintenance(action: string, label: string): void }).runMaintenance('vacuum', 'VACUUM');
    await runConfirmed();
    await settle(wrapper);
    expect(toasts.at(-1)).toMatchObject({ severity: 'success', summary: 'VACUUM 完成' });
    wrapper.unmount();
  });

  /**
   * Trace 视图必须呈现为树。此前它是 `marginLeft: node.parent_span_id ? '24px' : '0'`，只有一级缩进，
   * 在 `parent_span_id` 全库为 NULL 的时期看不出问题（13 个节点全是 `0px`），父边真正连通之后
   * 一级缩进会把 `agent.run` 之下的三层压成同一层（docs/28 · L-LOG-04）。
   * `.vue` 模板不进入 `tsc --noEmit`（`ConsoleView.vue` 开头的注释已说明该问题曾造成事故），
   * 因此判据只能由这里固定。
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
    // 悬挂父节点：一次查询只取 500 行，子 span 的父节点完全可能不在本页内。按现有深度收尾，不抛错。
    expect(vm.traceDepths([{ span_id: 'x', parent_span_id: 'not-in-this-page' }])).toEqual([0]);
    // 环：两个 span 互相指向，或指向自身。整条按 depth 0 渲染，不产生死循环。
    expect(vm.traceDepths([{ span_id: 'p', parent_span_id: 'q' }, { span_id: 'q', parent_span_id: 'p' }])).toEqual([0, 0]);
    expect(vm.traceDepths([{ span_id: 'self', parent_span_id: 'self' }])).toEqual([0]);
    // 同样接受 camelCase：对话详情端点（`/api/turns/:id/detail`）给出的是 `parentSpanId`。
    expect(vm.traceDepths([{ spanId: 'r', parentSpanId: null }, { spanId: 's', parentSpanId: 'r' }])).toEqual([0, 1]);
    wrapper.unmount();
  });

  /**
   * 标记模型看图能力的入口（docs/21 §10 · `G-API-17`）。三个判据只能在这里固定：`.vue` 模板不进入
   * `tsc --noEmit`，而三态下拉发出的 patch 结构是这个控件唯一有效的判据；
   * `follow` 必须发送 `{vision:null}`（取消标记）而不是省略该键，否则标错之后无法在界面上撤销。
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
    // 生效值写在顶层，因此目录给出的看图标签也随之消失，徽标与运行时读取的是同一字段。
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
    // 取消标记：键必须存在且值为 null。`toMatchObject` 不区分 undefined 与 null，因此直接比对整块。
    expect((await patchBody('follow')).capabilities).toEqual({ vision: null });
    wrapper.unmount();
  });

  /**
   * 模型表三个数值列的渲染（docs/09 §3.5）。缩写、单位底衬与右对齐全部只存在于 `.vue` 模板与
   * `GridColumn.align` 上，而模板不进入 `tsc --noEmit`：拼错列名 slot 会静默退回原值渲染。
   */
  it('模型表的数值列：窗口缩写、底衬等宽、三列右对齐', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    (wrapper.vm as unknown as { active: string }).active = 'providers';
    await settle(wrapper);
    expect(wrapper.findAll('.data-grid th.align-right').map((node) => node.text())).toEqual(['上下文窗口', '输入价格', '输出价格']);
    const chips = wrapper.findAll('.metric-chip');
    expect(chips.map((node) => node.text())).toEqual(['500 k', '3 $', '15 $']);
    // 底衬宽度是同列最长那条的字符数，逐列各算各的：`500 k` 五格、`3 $` 三格、`15 $` 四格。
    expect(chips.map((node) => node.attributes('style'))).toEqual(['min-width: 5ch;', 'min-width: 3ch;', 'min-width: 4ch;']);
    wrapper.unmount();
  });

  it('别名路由使用列表并按纵向轨道保留 fallback 顺序', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    (wrapper.vm as unknown as { active: string }).active = 'providers';
    await settle(wrapper);
    const list = wrapper.find('.alias-route-list');
    expect(list.exists()).toBe(true);
    expect(list.element.tagName).toBe('UL');
    expect(list.findAll('.alias-route-item')).toHaveLength(6);
    const main = list.find('[data-alias="main"]');
    expect(main.findAll('.alias-chain-step').map((node) => node.text())).toEqual(['1', '2']);
    expect(main.findAll('.alias-chain-model').map((node) => node.text())).toEqual(['p1 / grok-4.5', 'gone']);
    expect(main.find('.alias-chain-item.missing').text()).toContain('模型记录已删除');
    expect(main.find('.alias-route-settings').text()).toContain('温度 0.4 · 推理档位 high');
    expect(list.find('[data-alias="high"] .alias-route-empty').text()).toContain('main → high → low');
    expect(list.find('table').exists()).toBe(false);
    wrapper.unmount();
  });

  /**
   * 扩展页的四个分段（docs/09 §3.8）。与设置页那四个 tab 同理：遗漏一个分支，该分段从此
   * 无人渲染。这一页是从 `ConsoleView.vue` 整段抽出的（`ExtensionsPage.vue`），
   * 而上一次抽取子视图时三项检查全部通过、14 个页面却全为空白（docs/24 · R-UI-01），因此这里断言的是
   * 四个分段各自确实渲染出了内容，而非组件能否被 import。
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
      // 四个分段都使用 `v-show`：切换分段不应丢失未保存的内容，因此 DOM 中始终存在四个。
      expect(panel.attributes('style') ?? '', `${key} 分段切过去之后仍然是隐藏的`).not.toContain('display: none');
      expect(panel.text().trim().length, `${key} 分段的内容是空的`).toBeGreaterThan(20);
    }
    const rendering = warnings.filter((line) => line.includes('[Vue warn]'));
    expect(rendering, `渲染期间产生了 Vue 警告：\n${rendering.join('\n')}`).toEqual([]);
    spy.mockRestore();
    wrapper.unmount();
  });

  /**
   * 需要登录必须作为独立一档，且该行要提供一个可点击的入口。此前 `state` 只有
   * up/pending/down/disabled，一台需要登录的 server 显示为无法连接加一句
   * `Error POSTing to endpoint: <原始响应体>`，从中读不出应采取的操作。
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
    expect(needsAuth.text()).not.toContain('连接失败');
    expect(needsAuth.findAll('button').map((button) => button.text()), 'needs_auth 那一行没有〔登录〕入口')
      .toContain('登录');
    // 已连接那台：不应出现登录按钮，而工具数量要可展开查看。
    const connected = rows.find((row) => row.text().includes('agent-browser'))!;
    expect(connected.text()).toContain('已连接');
    expect(connected.findAll('button').map((button) => button.text())).not.toContain('登录');
    expect(connected.text()).toContain('20 个');
    wrapper.unmount();
  });

  /**
   * 未审阅的行需要有独立的视觉形态，而不只是更换标签文字：`.pending-review` 的虚线与琥珀色边条
   * 才是待处理状态的视觉判据。断言 class 而非文案，后者改动一句即会失败。
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
    // 随包分发的那份只允许启停：不应提供删除按钮（服务端会返回 403，放一个必然报错的按钮更难排查）。
    expect(bundled.findAll('button').map((button) => button.attributes('aria-label') ?? button.text())).not.toContain('删除');

    (page.vm as unknown as { tab: string }).tab = 'tools';
    await settle(wrapper);
    const tool = wrapper.find('[data-ext-tab="tools"] .ext-row');
    expect(tool.classes()).toContain('pending-review');
    expect(tool.text()).toContain('未审阅');
    wrapper.unmount();
  });

  /**
   * 待处理计数，是这一页实际的收件箱。它必须涵盖三类待人工处理的对象：
   * 未审阅的包、未复审的脚本、需要登录的 server。
   */
  it('待你处理把未审阅、要登录、加载失败三类都数进去', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    (wrapper.vm as unknown as { active: string }).active = 'extensions';
    await settle(wrapper);
    const inbox = wrapper.find('.ext-inbox');
    expect(inbox.exists()).toBe(true);
    expect(inbox.text()).toContain('已安装的 Skill 待人工复核');
    expect(inbox.text()).toContain('模型编写的脚本待人工复核');
    expect(inbox.text()).toContain('要登录');
    // fixture 里有一个 load_error 的 skill。
    expect(inbox.text()).toContain('加载或连接失败');
    wrapper.unmount();
  });

  /**
   * 任务页是从 `ConsoleView.vue` 整段抽出的（`TasksPage.vue` 与三张卡片），与扩展页那次
   * 同理：上一回抽取子视图时三项检查全部通过、14 个页面却全为空白（docs/24 · R-UI-01）。
   * 因此这里断言的是三张卡片各自确实渲染出了自己的数据行，而非组件能否被 import。
   * 顺序同样固定：任务 → 定时任务 → 审批（`.card-stack` 竖向排列）。
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
    // `.dashboard-grid` 是总览页的布局骨架（2fr 1fr），任务页不应复用它。
    expect(wrapper.findAll('.page-surface .dashboard-grid').length).toBe(0);
    expect(stack.findAll(':scope > article').map((card) => card.find('h3').text())).toEqual(['任务', '定时任务', '审批']);
    for (const [name, needle] of [['TasksCard', '查一下今天的更新'], ['SchedulesCard', '每日早报'], ['ApprovalsCard', 'bash']] as const) {
      const card = wrapper.findComponent({ name });
      expect(card.exists(), `${name} 没挂上`).toBe(true);
      expect(card.text(), `${name} 一行都没渲染`).toContain(needle);
    }
    expect(stack.findAll('.work-table').map((grid) => grid.classes().find((name) => name.startsWith('work-table-')))).toEqual([
      'work-table-tasks', 'work-table-schedules', 'work-table-approvals',
    ]);
    // 窄屏用 `data-label` 把每个单元格改排成键值行。列名只存在于 thead 时，移动端会再次只剩裸值。
    expect(stack.find('.work-table-schedules tbody tr').findAll('td').map((cell) => cell.attributes('data-label'))).toEqual([
      '任务', '会话', '模式', '触发', '下一次', '上一次', '状态', '操作',
    ]);
    // 静默那一档：`SCHEDULE_RUN_STATES` 缺少一条它就会原样显示为英文的 `silent`。
    expect(wrapper.findComponent({ name: 'SchedulesCard' }).text()).toContain('静默');
    const rendering = warnings.filter((line) => line.includes('[Vue warn]'));
    expect(rendering, `渲染期间产生了 Vue 警告：\n${rendering.join('\n')}`).toEqual([]);
    spy.mockRestore();
    wrapper.unmount();
  });

  /**
   * 导航角标读取的是 `GET /api/approvals` 信封中的全表 `pending`，而非当前页统计的
   * pending 行数。`AC-WEB-049` 要求无需切换到任务页即可看到还有多少条待处理，
   * 而分页改造中唯一会静默造成功能退化的位置正是这里。
   */
  it('待审批角标取信封里的全表 pending，不是当前页数出来的', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { active: string; pendingApprovals: number };
    // `load()` 是一条六段的 await 链，角标位于靠后的一段，`settle()` 的 6 轮只够执行完第一个
    // `Promise.all`。全部是 microtask、不涉及计时器，因此多执行几轮是确定性的，而非依赖时序。
    for (let round = 0; round < 20 && vm.pendingApprovals === 0; round += 1) await settle(wrapper);
    // fixture：当前页只有 1 条 pending，而全表 pending 为 3。按当前页统计会得到 1。
    expect(vm.pendingApprovals).toBe(3);
    expect(wrapper.find('.sidebar .nav-badge').text()).toBe('3');
    // 首屏即可见，无需切换到任务页。
    expect(vm.active).toBe('dashboard');
    // 获取角标的那次请求只需一行数据：全表计数在信封上，无需拉取 200 行。
    const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls
      .map(([url]) => String(url)).filter((url) => url.startsWith('/api/approvals'));
    expect(calls.some((url) => url.includes('size=1')), `角标没走单行请求：${calls.join(' , ')}`).toBe(true);
    wrapper.unmount();
  });

  /**
   * Worker 运行记录页是从 `ConsoleView.vue` 整段抽出的（`WorkerRunsPage.vue` 与两张卡），
   * 与扩展页、任务页那两次同理：上一回抽取子视图时三项检查全部通过、14 个页面却全为空白
   * （docs/24 · R-UI-01）。因此这里断言两张卡各自确实渲染出了内容，而非组件能否被 import。
   */
  it('Worker 页两张卡竖排、顺序固定，三档 worker 与外部自报那一格都渲染出来', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    (wrapper.vm as unknown as { active: string }).active = 'workers';
    await settle(wrapper);
    expect(wrapper.findComponent({ name: 'WorkerRunsPage' }).exists(), 'Worker 页组件没挂上').toBe(true);
    const stack = wrapper.find('.card-stack');
    expect(stack.exists(), '两张卡不在 .card-stack 里').toBe(true);
    expect(stack.findAll(':scope > article').map((card) => card.find('h3').text())).toEqual(['运行记录', '试跑']);
    const card = wrapper.findComponent({ name: 'WorkerRunsCard' });
    expect(card.text(), '一行都没渲染').toContain('改一下那个仓库的 parser');
    // 三档徽标各出现一次：少一档就会原样显示英文，读不出三者的花费口径差别。
    for (const kind of ['lw', 'harness', 'acp']) expect(card.text(), `${kind} 这一档没渲染`).toContain(kind);
    // 外部自报那一格与「花费」分开，且旁边写明它不进聚合 —— 合并显示就是邀请人把两者相加。
    expect(card.text()).toContain('$1.2500');
    expect(card.text()).toContain('不进任何聚合');
    // 没有取消入口，而这件事必须写在页面上（worker 跑在父轮的 abort 信号下）。
    expect(card.findAll('button').map((button) => button.text())).not.toContain('取消');
    expect(card.text()).toContain('这里没有取消');
    const rendering = warnings.filter((line) => line.includes('[Vue warn]'));
    expect(rendering, `渲染期间产生了 Vue 警告：\n${rendering.join('\n')}`).toEqual([]);
    spy.mockRestore();
    wrapper.unmount();
  });

  it('最近错误把事件名与摘要放进同一信息组，长标识不会侵入摘要', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    for (let round = 0; round < 12 && wrapper.findAll('.log-list > .log-row').length === 0; round += 1) await settle(wrapper);
    const rows = wrapper.findAll('.log-list > .log-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const copy = row.find('.log-row-copy');
      expect(copy.exists()).toBe(true);
      expect(copy.find('code').text().length).toBeGreaterThan(0);
      expect(copy.find('span').text().length).toBeGreaterThan(0);
      expect(row.find('time[datetime]').exists()).toBe(true);
    }
    wrapper.unmount();
  });

  /**
   * 工具目录的可达侧与常驻 / 折叠均来自运行时，只读展示。分叉由 `toolCallableBy()` 决定，
   * 折叠由 `tools.catalog.*` 决定；任一项做成行内开关都会产生第二份真相。
   */
  it('工具策略列表显示可达侧与模型可见性，可分别筛选', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { active: string; sideFilter: string; toolVisibilityFilter: string; visibleToolRows: Array<{ name: string }> };
    vm.active = 'tools';
    await settle(wrapper);
    const page = wrapper.find('.tool-page');
    expect(page.find('.tool-policy-list').exists()).toBe(true);
    expect(page.findAll('.tool-policy-row')).toHaveLength(4);
    for (const label of ['仅主 agent', '仅 worker', '两侧'])
      expect(page.text(), `可达侧少了「${label}」这一档`).toContain(label);
    for (const label of ['常驻', '折叠']) expect(page.text()).toContain(label);
    expect(page.text()).toContain('tools.overrides');
    for (const [filter, names] of [['main', ['spawn_worker']], ['worker', ['bash', 'web_fetch']], ['both', ['memory_read']]] as const) {
      vm.sideFilter = filter;
      await settle(wrapper);
      expect(vm.visibleToolRows.map((row) => row.name).sort(), `${filter} 筛出来的行不对`).toEqual([...names].sort());
    }
    vm.sideFilter = '';
    vm.toolVisibilityFilter = 'deferred';
    await settle(wrapper);
    expect(vm.visibleToolRows.map((row) => row.name)).toEqual(['web_fetch']);
    wrapper.unmount();
  });

  it('工具页三个任务分区均有内容', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    const vm = wrapper.vm as unknown as { active: string; toolTab: string; TOOL_TABS: ReadonlyArray<readonly [string, string, string]> };
    vm.active = 'tools';
    await settle(wrapper);
    expect(vm.TOOL_TABS.map(([key]) => key)).toEqual([...TOOL_TABS]);
    for (const key of TOOL_TABS) {
      vm.toolTab = key;
      await settle(wrapper);
      const panel = wrapper.find(`[data-tool-tab="${key}"]`);
      expect(panel.exists(), `${key} 分区不存在`).toBe(true);
      expect(panel.text().trim().length, `${key} 分区无内容`).toBeGreaterThan(20);
    }
    wrapper.unmount();
  });

  it('导航项与页面分支一一对应：多一个少一个都会红', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    await settle(wrapper);
    // `navigation` 是模板的数据源，NAV_KEYS 是本文件的断言清单。两者一旦漂移就会出现
    // 从此无人渲染的页面，新增导航项时必须同步加入这里。
    const keys = (wrapper.vm as unknown as { navigation: ReadonlyArray<readonly [string, string, string]> }).navigation.map(([key]) => key);
    expect(keys).toEqual([...NAV_KEYS]);
    wrapper.unmount();
  });

  /**
   * `AC-WEB-023`（反馈统一为右上角同一种 Toast）与 `AC-WEB-055`（两套主题下均无操作系统绘制的控件）
   * 都受阻于同一件事：`ConsoleView.vue` 中此前仍有 12 处裸 `window.confirm()`，而已抽出的
   * `TasksCard` / `SchedulesCard` / `ExtensionsPage` 早已统一走 `ui/confirm.ts`
   * （`D-02` 拆分页面未完成的残留，docs/29 · `M-WEB-01`）。裸调用由操作系统绘制、
   * 同步阻塞，且在 happy-dom 中未实现，需要 `vi.stubGlobal` 才能测试本身即是信号。
   */
  it('ConsoleView 不再用原生对话框：confirm / alert / prompt 一个都不剩', () => {
    const source = readFileSync('packages/webui/src/views/ConsoleView.vue', 'utf8');
    // `askConfirm(` 中的 C 为大写，不会被下面几个模式误匹配。
    for (const native of [/(^|[^a-zA-Z.])confirm\s*\(/, /(^|[^a-zA-Z.])alert\s*\(/, /window\s*\.\s*(confirm|alert|prompt)\s*\(/]) {
      const hit = source.split('\n').find((line) => native.test(line));
      expect(hit, `还留着原生对话框：${hit}`).toBeUndefined();
    }
    expect(source).toContain("from '../ui/confirm'");
  });

  /**
   * 沙箱卡片上有三个开关可以整体解除隔离，而此前只有 `mode=none` 设了闸，另外两个
   * （`bypassRoles` 加入 owner 之外的角色、`allowHostFsForOwner`）拨动后点保存即生效；
   * `allowHostFsForOwner` 甚至在这一页上没有对应控件（docs/29 · M-WEB-10）。
   * 断言的是闸是否存在、是否说明了代价，而非具体文案。
   */
  it('沙箱页三种拆边界的改动都要过同一道确认，逐条写明代价', async () => {
    dismissConfirm();
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    const vm = wrapper.vm as unknown as { active: string; hostFsForOwner: boolean; sandboxForm: { mode: string; bypassRoles: string[] };
      saveSandbox: () => Promise<void> };
    vm.active = 'tools';
    await settle(wrapper);
    // 控件本身必须存在于这一页，此前只能通过设置 → 全部配置访问到它。
    expect(wrapper.text()).toContain('allowHostFsForOwner');

    // 未解除任何隔离时不应拦截：多余的确认框会让用户养成直接确认的习惯。
    await vm.saveSandbox();
    expect(confirmBox.value.open).toBe(false);

    vm.sandboxForm.mode = 'none';
    vm.sandboxForm.bypassRoles = ['owner', 'trusted'];
    vm.hostFsForOwner = true;
    await settle(wrapper);
    await vm.saveSandbox();
    expect(confirmBox.value.open).toBe(true);
    for (const cost of ['mode = none', 'trusted', 'allowHostFsForOwner'])
      expect(confirmBox.value.detail, `确认框没说 ${cost} 的代价`).toContain(cost);
    dismissConfirm();
    wrapper.unmount();
  });

  /**
   * `AC-WEB-011` 的第三条判据要求 `raw_json` 可查看。`messages.raw_json` 自 `0001_init.sql`
   * 起就在写入，而在此之前全仓没有任何一处读取它，`get_message` 也没有，界面上更无法访问
   * （docs/29 · `M-WEB-06`）。运维排查 Telegram 实际下发内容（例如 entities 解析错误的
   * 消息，正文中看不出任何异常）此前没有任何入口。
   */
  it('检索结果行能打开这条消息的原始载荷，并说明它是脱敏后的那份', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    const vm = wrapper.vm as unknown as { active: string; query: string; rawDialog: boolean; searchArchive: () => Promise<void> };
    vm.active = 'messages';
    await settle(wrapper);
    vm.query = '发来了什么';
    await vm.searchArchive();
    await settle(wrapper);

    const entry = wrapper.find('[aria-label="查看该消息的原始载荷"]');
    expect(entry.exists(), '检索结果行上没有看原始载荷的入口').toBe(true);
    await entry.trigger('click');
    await settle(wrapper);
    expect(vm.rawDialog).toBe(true);
    // UiModal 被 Teleport 到 body，`wrapper.text()` 读取不到它。
    const shown = document.body.textContent ?? '';
    expect(shown, '载荷没有按 JSON 缩进渲染出来').toContain('"message_id": 4242');
    expect(shown, 'entities 正是要看的那一类，没渲染出来').toContain('entities');
    // 界面上必须标明这是脱敏后的版本：依据被改写过的载荷排查，比没有载荷更容易导致误判。
    expect(shown).toContain('«redacted»');
    expect(shown).toContain('脱敏');
    wrapper.unmount();
  });

  /** 已请求的 URL（去除查询串）。断言的是是否发起补拉，而非具体参数。 */
  const fetchedPaths = (): string[] =>
    (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => String(call[0]).split('?')[0]!);
  /** 等待 400ms 的合并窗口，再执行完 loader 的那一串 await。 */
  async function waitRefresh(wrapper: VueWrapper): Promise<void> {
    await new Promise((resolve) => { setTimeout(resolve, 520); });
    await settle(wrapper);
  }
  /** SSE 连接在 `onMounted` 的那串 await 执行完之后才建立，`settle` 的六轮不一定足够；提前
   *  取到的会是上一条用例遗留的连接，而该连接的监听器指向一个已卸载的组件。 */
  async function sseChannel(wrapper: VueWrapper): Promise<FakeEventSource> {
    for (let round = 0; round < 30 && eventSources.length === 0; round += 1) await settle(wrapper);
    const source = eventSources.at(-1);
    if (!source) throw new Error('SSE 管子没建起来');
    return source;
  }

  /**
   * `AC-WEB-007` 的后半部分，即数据补齐。浏览器原生 `EventSource` 会自动重连（前半部分一直成立），
   * 但断线期间发生的事件不会重放，而此前 `onopen` 只把左下角的 pill 恢复为系统在线：
   * S8 实测断开 20 秒后重连，总览的归档消息数停留在旧值超过 15 秒，直到下一条无关事件恰好到达
   * 才更新（docs/29 · `M-WEB-02`）。pill 显示在线而数字过期比直接断开更糟：断开时界面至少
   * 明示了数据不新鲜。
   */
  it('SSE 重连后补拉当前页看得见的那几组，首次连上不补', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    eventSources.length = 0;
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    const source = await sseChannel(wrapper);

    // 首次连接不应补拉：`load()` 刚请求完那一串端点，重复请求没有意义。
    const beforeFirst = fetchedPaths().length;
    source.onopen?.();
    await waitRefresh(wrapper);
    expect(fetchedPaths().length, '首次 onopen 就补拉了一遍').toBe(beforeFirst);

    source.onerror?.();
    source.onopen?.();
    const beforeReconnect = fetchedPaths().length;
    await waitRefresh(wrapper);
    const backfilled = fetchedPaths().slice(beforeReconnect);
    // 总览这一页看得见的三组：dashboard / logs / activeTurns。
    for (const path of ['/api/dashboard', '/api/health/detail', '/api/logs', '/api/turns/active'])
      expect(backfilled, `重连后没补 ${path}`).toContain(path);
    wrapper.unmount();
  });

  /**
   * 补拉走的是 `scheduleRefresh` 那套可见性过滤，因此不可见的组会被直接跳过，而
   * `REFRESH_VISIBILITY` 上方所述切换过去时 watch(active) 会补拉一次此前只对
   * `loadActiveTurns` 等五个具体 loader 成立，对这十二组均不成立。缺少这一半，
   * 重连补拉只能覆盖运维当时正在查看的那一页。
   */
  it('看不见而被跳过的组记成陈的，切到看得见它的页面时补掉', async () => {
    const { default: ConsoleView } = await import('../../packages/webui/src/views/ConsoleView.vue');
    eventSources.length = 0;
    const wrapper = mount(ConsoleView, { attachTo: document.body });
    const vm = wrapper.vm as unknown as { active: string };
    const source = await sseChannel(wrapper);

    // 停留在总览时收到一条用量事件：`usage` 组只在用量页可见，本次被跳过（`dashboard` 组正常刷新）。
    const before = fetchedPaths().length;
    source.emit('usage');
    await waitRefresh(wrapper);
    expect(fetchedPaths().slice(before)).toContain('/api/dashboard');
    expect(fetchedPaths().slice(before), '不可见的组不该当场刷').not.toContain('/api/usage');

    vm.active = 'usage';
    await settle(wrapper);
    await waitRefresh(wrapper);
    expect(fetchedPaths().slice(before), '切到用量页没有把错过的那一次补上').toContain('/api/usage');
    wrapper.unmount();
  });
});
