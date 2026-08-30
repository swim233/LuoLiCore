import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAIN_AGENT_TOOLS, ToolRegistry, builtinPolicy, configSchema, newToolScope, registerCatalogTools } from '@luoli/core';
import type { AgentKind, ApprovalBroker, ApprovalPolicy, LogEvent, LogSink, ToolExecutionContext, ToolOverride } from '@luoli/core';
import type { Role } from '@luoli/shared';

/**
 * 工具目录按需暴露（`docs/05 §3.12` 五条不变量、`docs/07 §5` 折叠判据四档）的 registry 层。
 *
 * 本模块的风险与 `tools.overrides.test.ts` 同形但方向相反：覆盖层的风险是仅在两处判定中的一处生效，
 * 折叠的风险是多处各自计算得出不同结果。提示词的常驻段、折叠摘要段、`prepareStep` 的可见集与
 * `search_tools` 的检索域必须全部由同一次 `#eligible()` 派生。因此分区断言一律以 `active()` 为
 * 基准对齐，而非各自统计数量：统计数量的测试在两份判据漂移时仍会通过。
 *
 * `contextFor` 的 `agentKind` 默认取 `lw` 而非 `main`：工具整体下沉给 worker 之后，折叠与
 * `search_tools` 都在 worker 那一侧，本文件绝大多数用例跑的是折叠链路。主 agent 侧只剩对话与派发，
 * 它手里一个折叠工具都没有 —— 那一侧的判据集中在末尾「主 agent / worker 的硬闸」一节。
 *
 * 全程不启用数据库、不经过模型。折叠只影响可见性，权限判定完全未变（不变量 1），能在这一层判定完成的
 * 就不应启动完整轮次；而经模型的路径根本到不了 `execute()`（见 `AC-TOOL-048` 那组用例的注释）。
 */

const events: LogEvent[] = [];
const log = { span: () => ({ id: 'span', end: () => undefined }), event: (event: LogEvent) => { events.push(event); } } as unknown as LogSink;
const okBroker: ApprovalBroker = { request: async () => true };
const schema = z.object({ text: z.string().optional() });
const noop = (): object => ({ ok: true });

interface SearchResult {
  ok: boolean; error?: string; hint?: string; omitted?: number;
  matches?: Array<{ name: string; description: string; group: string; status: string }>;
}

/**
 * `catalog` 传 `undefined` 表示 limits 中整段不提供（全仓十余处手工构造 `ToolRegistry` 的测试即
 * 此形态，缺省必须等同于改动前的行为）；传 `{}` 表示使用一份 schema 默认值。
 *
 * 而配置中的那份始终存在：`search_tools` 从 `turn.config` 读取 `maxExpandedPerTurn`，registry 的
 * limits 与 turn 的 config 必须由同一次 `configSchema.parse` 派生；两处不一致时护栏的分子与
 * 分母来自不同来源，而这种错误在单条用例中表现完全正常。
 */
function harness(input: { catalog?: Record<string, unknown>; maxRegistered?: number; overrides?: Record<string, ToolOverride>; approval?: ApprovalBroker } = {}) {
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, tools: { catalog: input.catalog ?? {} } });
  const limits = { maxRegistered: input.maxRegistered ?? 80, maxCallsPerTurn: 60, maxConsecutiveErrors: 8,
    ...(input.catalog === undefined ? {} : { catalog: config.tools.catalog }) };
  const registry = new ToolRegistry(log, input.approval ?? okBroker, limits);
  const overrides = input.overrides;
  if (overrides) registry.bindOverrides(() => overrides);
  /**
   * 一次调用 = 一个 agent run。渐进披露的三个集合走 `newToolScope()`，因此每次调用各持一份
   * 引用：worker 展开的工具写不进主轮，两个 worker 之间也互不可见（`docs/05 §3.12` 不变量 4）。
   * 用例里一律 `const context = contextFor(...)` 存一次再反复用 —— 连着调两次拿到的是两个 run，
   * 前一个写进去的 `expandedTools` 在后一个身上读不到，那是本设计要买到的东西。
   *
   * `extra` 落在 context 层而非 turn 层：`skillAllowedTools` / `expandedTools` 已从
   * `RuntimeTurnContext` 挪走，给初值即等同于「这个 run 开始前就载过 skill」。
   */
  const contextFor = (role: Role, extra: Partial<ToolExecutionContext> = {}, agentKind: AgentKind = 'lw'): ToolExecutionContext => ({
    turn: { turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: role, isPrivate: true, baseCommitId: null,
      snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config },
    workspace: '.', agentKind, ...newToolScope(), ...extra });
  return { registry, config, contextFor };
}

function builtin(registry: ToolRegistry, name: Parameters<typeof builtinPolicy>[0], sourcePriority: number, description = 'd'): void {
  registry.register({ name, description, inputSchema: schema, policy: builtinPolicy(name), sourcePriority, execute: noop });
}
function external(registry: ToolRegistry, name: string, source: 'mcp' | 'plugin' | 'custom',
  extra: { description?: string; minRole?: Role; approval?: ApprovalPolicy } = {}): void {
  registry.registerExternal({ name, description: extra.description ?? 'd', inputSchema: schema, minRole: extra.minRole ?? 'limited', source, execute: noop,
    ...(extra.approval ? { approval: extra.approval } : {}) });
}
/**
 * 内建 100、agent 90、load_skill 80 与 `EXTERNAL_SOURCE_PRIORITY` 一致，排序才能反映真实部署。
 *
 * agent 那一档取 `report_progress` 而非派发族：`spawn_worker` 在 `MAIN_ONLY_TOOLS` 里，
 * 在 worker 侧的目录中根本不出现，拿它当「优先级 90 的样本」会让整组 resident 断言错位。
 */
function mixed(registry: ToolRegistry): void {
  builtin(registry, 'read_file', 100, '读一个文件');
  builtin(registry, 'bash', 100, '跑一段 shell');
  builtin(registry, 'report_progress', 90, '向上报一句进度');
  builtin(registry, 'load_skill', 80, '载入 skill 正文');
  external(registry, 'plug_thing', 'plugin', { description: '插件自带的东西' });
  external(registry, 'mcp__alpha__one', 'mcp', { description: '回显一段文字' });
  external(registry, 'mcp__alpha__two', 'mcp', { description: '把文字转成大写' });
  external(registry, 'mcp__beta__one', 'mcp', { description: '查询天气' });
  external(registry, 'custom_thing', 'custom', { description: '模型自己写的' });
  registerCatalogTools(registry, { log });
}
const search = async (registry: ToolRegistry, context: ToolExecutionContext, input: Record<string, unknown>): Promise<SearchResult> =>
  await registry.execute('search_tools', input, context) as SearchResult;
const found = (result: SearchResult): string[] => (result.matches ?? []).map((match) => match.name).sort();
/** 顺序断言使用子序列而非相等：`activeNamesForStep` 必须是 `active()` 那个有序数组的过滤结果，
 *  把两个分区重新拼接会重排 provider 的 tools 数组，导致每步都改动请求体第 0 段（`docs/04 §2.1`）。 */
function subsequence(small: readonly string[], big: readonly string[]): boolean {
  let index = 0;
  for (const name of big) if (name === small[index]) index += 1;
  return index === small.length;
}

describe('工具目录按需暴露 · 分区与判据', () => {
  it('resident ∪ deferred 恰好等于 active()，交集为空（不变量 1 的分区那一半）', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner');
    const view = registry.activeView('owner', context);
    const resident = view.resident.map((tool) => tool.name);
    const deferred = view.deferred.map((tool) => tool.name);
    expect([...resident, ...deferred].sort()).toEqual([...registry.activeNames('owner', context)].sort());
    expect(resident.filter((name) => deferred.includes(name))).toEqual([]);
    expect(resident).toEqual(['bash', 'read_file', 'report_progress', 'load_skill', 'search_tools']);
    expect(deferred).toEqual(['plug_thing', 'mcp__alpha__one', 'mcp__alpha__two', 'mcp__beta__one', 'custom_thing']);
  });

  it('limits 里整段 catalog 缺席 ⇒ 一律不折叠', () => {
    const { registry, contextFor } = harness();
    mixed(registry);
    const view = registry.activeView('owner', contextFor('owner'));
    expect(view.deferred).toEqual([]);
    expect(view.groups).toEqual([]);
    expect(registry.hasDeferrable('owner')).toBe(false);
  });

  it('deferExternal=false ⇒ 一律不折叠', () => {
    const { registry, contextFor } = harness({ catalog: { deferExternal: false, defer: ['bash'] } });
    mixed(registry);
    const view = registry.activeView('owner', contextFor('owner'));
    // `defer` 指定 `bash` 也不生效：判据第一档位于最前，后续档位不再执行。
    expect(view.deferred).toEqual([]);
    expect(registry.hasDeferrable('owner')).toBe(false);
  });

  it('豁免表：defer 点名 search_tools / load_skill 静默不生效（AC-TOOL-049 ①、不变量 2）', () => {
    const { registry, contextFor } = harness({ catalog: { defer: ['search_tools', 'load_skill', '*'] } });
    mixed(registry);
    const view = registry.activeView('owner', contextFor('owner'));
    // `*` 折叠了其余全部，而检索通道的两级仍然常驻：折叠检索通道后将无路径可取回工具。
    expect(view.resident.map((tool) => tool.name)).toEqual(['load_skill', 'search_tools']);
    expect(view.deferred.map((tool) => tool.name)).not.toContain('search_tools');
    expect(view.deferred.map((tool) => tool.name)).not.toContain('load_skill');
  });

  it('resident glob 压过 defer（判据第三档最高优先）', () => {
    const { registry, contextFor } = harness({ catalog: { defer: ['mcp__*', 'bash'], resident: ['mcp__alpha__*', 'bash'] } });
    mixed(registry);
    const view = registry.activeView('owner', contextFor('owner'));
    const resident = view.resident.map((tool) => tool.name);
    expect(resident).toContain('bash');
    expect(resident).toContain('mcp__alpha__one');
    expect(resident).toContain('mcp__alpha__two');
    // plugin 与 custom 不在 `resident` 中时按第五档默认折叠，白名单只恢复其显式列出的那几个。
    expect(view.deferred.map((tool) => tool.name)).toEqual(['plug_thing', 'mcp__beta__one', 'custom_thing']);
  });

  it('内建 / agent 默认常驻，只有被 defer 点名才折叠', () => {
    const plain = harness({ catalog: {} });
    mixed(plain.registry);
    expect(plain.registry.activeView('owner', plain.contextFor('owner')).resident.map((tool) => tool.name))
      .toEqual(expect.arrayContaining(['bash', 'read_file', 'report_progress']));
    // glob 要真的落在内建 / agent 族上，否则这条断言恒真：`report_*` 命中的正是那件 agent 族工具。
    const named = harness({ catalog: { defer: ['bash', 'report_*'] } });
    mixed(named.registry);
    const deferred = named.registry.activeView('owner', named.contextFor('owner')).deferred.map((tool) => tool.name);
    expect(deferred).toContain('bash');
    expect(deferred).toContain('report_progress');
    expect(deferred).not.toContain('read_file');
  });

  /**
   * 组 key 由既有命名空间派生。`mcp__<server>__<tool>` 按第一个 `__` 切分，与
   * `mcp/manager.ts` 中拼接名称的约定一致：server 名允许包含下划线，因此 `mcp__a_b__t` 的组为
   * `mcp:a_b`（非贪婪的 `(.+?)__` 需匹配到真正的双下划线）；而 `mcp__a__b__t` 的组为 `mcp:a`。
   * server a 上有一个名为 b__t 的工具与 server a__b 在名称层面本就无法区分，
   * 遵循拼接方的约定比推断一个不存在的 server 名更安全。无法识别前缀时退回整族一组 `mcp`。
   *
   * agent 来源同样归入 `builtin` 组：`docs/07 §5` 的组 key 清单中没有 `agent` 这一档，而两者在
   * 判据第四档中本就走同一路径（默认常驻，被 defer 显式指定才折叠）。
   */
  it('#groupKey 从既有命名空间派生，含 server 名带下划线的情形', () => {
    const { registry, contextFor } = harness({ catalog: { defer: ['bash', 'report_progress'] } });
    builtin(registry, 'bash', 100);
    builtin(registry, 'report_progress', 90);
    external(registry, 'mcp__a_b__t', 'mcp');
    external(registry, 'mcp__a__b__t', 'mcp');
    external(registry, 'weird_no_prefix', 'mcp');
    external(registry, 'plug_thing', 'plugin');
    external(registry, 'custom_thing', 'custom');
    const groups = registry.activeView('owner', contextFor('owner')).groups;
    expect(groups.map((group) => group.key).sort()).toEqual(['builtin', 'custom', 'mcp', 'mcp:a', 'mcp:a_b', 'plugin']);
    const of = (key: string): readonly string[] => groups.find((group) => group.key === key)!.names;
    expect(of('builtin')).toEqual(['bash', 'report_progress']);
    expect(of('mcp:a_b')).toEqual(['mcp__a_b__t']);
    expect(of('mcp:a')).toEqual(['mcp__a__b__t']);
    expect(of('mcp')).toEqual(['weird_no_prefix']);
    expect(of('plugin')).toEqual(['plug_thing']);
    expect(of('custom')).toEqual(['custom_thing']);
    expect(groups.map((group) => group.total)).toEqual(groups.map((group) => group.names.length));
  });

  it('组的顺序 = 首次出现顺序（sourcePriority desc, name asc）', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    // 优先级为 plugin 60、mcp 40、custom 30。摘要行属于提示词易变段，无意义的重排等于每步改动一次提示词。
    expect(registry.activeView('owner', contextFor('owner')).groups.map((group) => group.key))
      .toEqual(['plugin', 'mcp:alpha', 'mcp:beta', 'custom']);
  });

  it('折叠组摘要不含被 maxRegistered 截掉的名字（AC-TOOL-020 第三件事）', () => {
    const { registry, contextFor } = harness({ catalog: {}, maxRegistered: 6 });
    mixed(registry);
    const context = contextFor('owner');
    const view = registry.activeView('owner', context);
    expect(view.truncated).toEqual({ total: 10, visible: 6 });
    const active = registry.activeNames('owner', context);
    expect(active).toHaveLength(6);
    // 分区在截断之后执行：摘要中报出开轮冻结的 toolSet 里不存在的名字时，模型展开它会触发
    // AI SDK 层的运行时报错，而模型无从得知哪些工具被截断。
    for (const group of view.groups) for (const name of group.names) expect(active).toContain(name);
    expect(view.groups).toEqual([{ key: 'plugin', names: ['plug_thing'], total: 1 }]);
  });

  it('hasDeferrable 决定 search_tools 进不进目录（AC-TOOL-049 ②的注册表那一半）', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    builtin(registry, 'read_file', 100);
    builtin(registry, 'bash', 100);
    builtin(registry, 'load_skill', 80);
    registerCatalogTools(registry, { log });
    // 纯内建部署下折叠集恒为空，整个元工具不进入目录，提示词逐字节不变。
    expect(registry.hasDeferrable('owner')).toBe(false);
    expect(registry.activeNames('owner', contextFor('owner'))).not.toContain('search_tools');
    external(registry, 'mcp__alpha__one', 'mcp');
    expect(registry.hasDeferrable('owner')).toBe(true);
    expect(registry.activeNames('owner', contextFor('owner'))).toContain('search_tools');
  });

  /**
   * `hasDeferrable` 有意不经过 `activeView()`：那条路径为 `activeView()` → `#eligible()` →
   * `tool.available?.()` → `search_tools.available()` → 再次 `activeView()`，构成真实的无限
   * 递归，表现为开轮时直接栈溢出。它只遍历 `#tools` 自行判定三件事，不调用任何 `available()`。
   */
  it('search_tools 已注册时取数不递归爆栈', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner');
    expect(() => registry.activeView('owner', context)).not.toThrow();
    expect(() => registry.activeNames('owner', context)).not.toThrow();
    expect(() => registry.activeNamesForStep('owner', context, new Set(['mcp__alpha__one']))).not.toThrow();
    expect(() => registry.hasDeferrable('owner')).not.toThrow();
  });

  it('运维禁用 search_tools ⇒ 整目录回退常驻（AC-TOOL-049 ③、不变量 3 后半）', () => {
    const { registry, contextFor } = harness({ catalog: {}, overrides: { search_tools: { enabled: false } } });
    mixed(registry);
    const context = contextFor('owner');
    const view = registry.activeView('owner', context);
    expect(view.deferred).toEqual([]);
    expect(view.groups).toEqual([]);
    expect(registry.hasDeferrable('owner')).toBe(false);
    // 不允许出现可见到折叠摘要却无法展开的情形：三处都由同一判据派生，因此按步可见集必须等于全集。
    expect(registry.activeNamesForStep('owner', context)).toEqual(registry.activeNames('owner', context));
    expect(registry.describe().every((entry) => entry.deferred === false)).toBe(true);
  });

  /**
   * 不变量 3 的另一种移除检索通道的写法：工具页把 `enabled`、`minRole`、审批与超时四项放在同一行
   * （docs/09 §3.7），把 `search_tools` 的 `minRole` 提升到 owner 与关闭它效果相同，对
   * trusted 会话而言检索通道同样不存在。此前只判定了 `enabled`，因此 trusted 档位恰好落入被明确禁止的
   * 形态：折叠摘要正常渲染、`search_tools` 被 `#eligible()` 的 minRole 闸过滤，连 `repairToolCall`
   * 的自愈也一并失效（它的闸 ③ 正是本步无法下发 `search_tools`）。
   *
   * owner 档位必须保持折叠：提升 minRole 是限定为 owner 使用，而非关闭折叠。
   */
  it('运维把 search_tools 的 minRole 抬到 owner ⇒ 够不到它的角色整目录回退常驻', () => {
    const { registry, contextFor } = harness({ catalog: {}, overrides: { search_tools: { enabled: true, minRole: 'owner' } } });
    mixed(registry);
    const trusted = contextFor('trusted');
    expect(registry.activeNames('trusted', trusted)).not.toContain('search_tools');
    expect(registry.activeView('trusted', trusted).deferred).toEqual([]);
    expect(registry.activeView('trusted', trusted).groups).toEqual([]);
    expect(registry.hasDeferrable('trusted')).toBe(false);
    expect(registry.activeNamesForStep('trusted', trusted)).toEqual(registry.activeNames('trusted', trusted));
    // owner 可以访问检索通道，因此对它折叠仍然成立：回退按角色生效，而非全局生效。
    const owner = contextFor('owner');
    expect(registry.activeNames('owner', owner)).toContain('search_tools');
    expect(registry.activeView('owner', owner).deferred.map((tool) => tool.name)).toContain('mcp__alpha__one');
    expect(registry.hasDeferrable('owner')).toBe(true);
  });
});

describe('工具目录按需暴露 · activeNamesForStep', () => {
  it('未给 expanded 时只有常驻，给了之后并进来且保持 active() 的排序', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner');
    const resident = ['bash', 'read_file', 'report_progress', 'load_skill', 'search_tools'];
    expect(registry.activeNamesForStep('owner', context)).toEqual(resident);
    const step = registry.activeNamesForStep('owner', context, new Set(['mcp__alpha__two']));
    expect(step).toEqual([...resident, 'mcp__alpha__two']);
    expect(subsequence(step, registry.activeNames('owner', context))).toBe(true);
  });

  it('allow 进一步收窄，且收窄压过展开（docs/07 §2.2 先扩张后收窄）', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner');
    expect(registry.activeNamesForStep('owner', context, new Set(['mcp__alpha__two']), ['bash', 'mcp__alpha__two']))
      .toEqual(['bash', 'mcp__alpha__two']);
    // 已展开的工具被收窄拦截时本步不可见。该条失效的表现是 skill 的 allowed-tools 不起作用。
    expect(registry.activeNamesForStep('owner', context, new Set(['mcp__alpha__two']), ['bash'])).toEqual(['bash']);
  });
});

describe('工具目录按需暴露 · search_tools', () => {
  it('三通道取并集而不是交集', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner');
    expect(found(await search(registry, context, { query: '文字' }))).toEqual(['mcp__alpha__one', 'mcp__alpha__two']);
    expect(found(await search(registry, context, { names: ['mcp__beta__one'] }))).toEqual(['mcp__beta__one']);
    // 提供两个通道不应使结果减少：每个通道都是一种检索方式。
    expect(found(await search(registry, context, { query: '文字', names: ['mcp__beta__one'] })))
      .toEqual(['mcp__alpha__one', 'mcp__alpha__two', 'mcp__beta__one']);
  });

  it('query 含 *?[ 时按 glob 匹配名字，group 通道列整组', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner');
    expect(found(await search(registry, context, { query: 'mcp__alpha__*' }))).toEqual(['mcp__alpha__one', 'mcp__alpha__two']);
    expect(found(await search(registry, context, { group: 'mcp:beta' }))).toEqual(['mcp__beta__one']);
    expect(found(await search(registry, context, { query: 'mcp__alpha__*', group: 'mcp:beta' })))
      .toEqual(['mcp__alpha__one', 'mcp__alpha__two', 'mcp__beta__one']);
    // 不存在的组返回空集而非整份目录：写错一个组名不应等同于重复输出整个目录。
    const nope = await search(registry, context, { group: 'mcp:nope' });
    expect(nope.ok).toBe(true);
    expect(found(nope)).toEqual([]);
  });

  it('limit 默认 8、上限 20，omitted = matched - shown', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    for (let index = 1; index <= 12; index += 1) external(registry, `mcp__many__t${String(index).padStart(2, '0')}`, 'mcp');
    registerCatalogTools(registry, { log });
    const context = contextFor('owner');
    const fallback = await search(registry, context, { query: 'mcp__many__*' });
    expect(fallback.matches).toHaveLength(8);
    expect(fallback.omitted).toBe(4);
    expect((await search(registry, context, { query: 'mcp__many__*', limit: 3 })).omitted).toBe(9);
    // 上限固定在 schema 中：一次展开二十个已经失去按需展开的意义。
    expect(await search(registry, context, { query: 'mcp__many__*', limit: 21 })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('检索域从 activeView() 派生 ⇒ limited 搜不到 owner 工具的名字与描述', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    external(registry, 'mcp__alpha__secret', 'mcp', { description: '独一无二的口令 hunter2', minRole: 'owner' });
    external(registry, 'mcp__alpha__open', 'mcp', { description: '谁都能用' });
    registerCatalogTools(registry, { log });
    const context = contextFor('limited');
    // 断言 `ok` 而不仅断言空集：一次被拒绝的调用同样不返回名字，那样本用例不具备说明力。
    const blind = await search(registry, context, { query: 'hunter2' });
    expect(blind.ok).toBe(true);
    expect(found(blind)).toEqual([]);
    const pointed = await search(registry, context, { names: ['mcp__alpha__secret'] });
    expect(pointed.ok).toBe(true);
    expect(found(pointed)).toEqual([]);
    expect(found(await search(registry, context, { group: 'mcp:alpha' }))).toEqual(['mcp__alpha__open']);
    expect(found(await search(registry, contextFor('owner'), { query: 'hunter2' }))).toEqual(['mcp__alpha__secret']);
  });

  it('description 压成单行并截到 240', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    external(registry, 'mcp__alpha__wordy', 'mcp', { description: `第一行\n第二行\u0007控制\t制表${'あ'.repeat(400)}` });
    registerCatalogTools(registry, { log });
    const match = (await search(registry, contextFor('owner'), { names: ['mcp__alpha__wordy'] })).matches![0]!;
    // tool result 会永久留在上下文中（`context_messages` 只追加），写入一份 4KB 的 MCP 描述等于
    // 让这段会话每轮都为它付一次 token；完整 schema 下一步由 provider 的 tools 数组权威送达。
    expect(match.description.length).toBeLessThanOrEqual(240);
    expect(match.description).not.toContain('\n');
    expect(match.description).not.toContain('\u0007');
    expect(match.description.startsWith('第一行 第二行 控制 制表')).toBe(true);
  });

  it('status 三档：expanded / already_active / narrowed', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner');
    const first = await search(registry, context, { names: ['mcp__alpha__one'] });
    expect(first.matches![0]!.status).toBe('expanded');
    expect(first.matches![0]!.group).toBe('mcp:alpha');
    // 同一轮再次检索：已展开的报 already_active，不再占用额度。
    expect((await search(registry, context, { names: ['mcp__alpha__one'] })).matches![0]!.status).toBe('already_active');
    // 常驻工具报 already_active 而非留空 group：结构统一，模型无需推测缺失字段的含义。
    const resident = (await search(registry, context, { names: ['bash'] })).matches![0]!;
    expect(resident.status).toBe('already_active');
    expect(resident.group).toBe('resident');
    const narrowedContext = contextFor('owner', { skillAllowedTools: new Set(['bash']) });
    expect((await search(registry, narrowedContext, { names: ['mcp__alpha__two'] })).matches![0]!.status).toBe('narrowed');
  });

  /**
   * 展开集按 agent run 各持一份，这是把它从 `RuntimeTurnContext` 挪到 `ToolExecutionContext`
   * 唯一买到的东西 —— 缺这条断言，挪位置这件事就没有判据在守。
   *
   * 挂在 turn 上时两个 run 共享同一个引用：worker A 展开的 MCP 工具会出现在 worker B 与主轮的
   * `prepareStep` 里，而 B 从未检索过它，模型于是拿到一份自己没要过、也解释不了的工具清单；
   * `maxExpandedPerTurn` 的额度也被两边合着花。
   */
  it('两个 run 各持一份展开集，互不写入对方', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const first = contextFor('owner');
    const second = contextFor('owner');
    expect((await search(registry, first, { names: ['mcp__alpha__one'] })).matches![0]!.status).toBe('expanded');
    expect([...first.expandedTools]).toEqual(['mcp__alpha__one']);
    expect([...second.expandedTools]).toEqual([]);
    // 另一个 run 检索同一个工具照样报 expanded：它此前一无所知，额度也各算各的。
    expect((await search(registry, second, { names: ['mcp__alpha__one'] })).matches![0]!.status).toBe('expanded');
    expect([...first.expandedTools]).toEqual(['mcp__alpha__one']);
    // 收窄同理：一个 run 载入带 allowed-tools 的 skill 收不到另一个 run 头上。
    const narrowed = contextFor('owner', { skillAllowedTools: new Set(['bash']) });
    expect(registry.admit('mcp__alpha__one', narrowed).ok).toBe(false);
    expect(registry.admit('mcp__alpha__one', first).ok).toBe(true);
  });

  /**
   * 被收窄拦截的同样记入 `expandedTools`，只是仍然不可调用。缺这一笔即构成死循环的一半：
   * 另一半在 `agent/runtime.ts` 的 `repairToolCall`，它依据原名是否在 `expandedTools` 中判断本次
   * 强行调用是否值得改写为一次检索；折叠且被收窄的工具若永远进不了该集合，就会形成
   * 调用 X → NoSuchToolError → 改写为检索 → narrowed → 再调用 X 的循环，直至耗尽步数上限。
   */
  it('收窄挡住的工具照样记进 expandedTools', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner', { skillAllowedTools: new Set(['bash']) });
    expect((await search(registry, context, { names: ['mcp__alpha__two'] })).matches![0]!.status).toBe('narrowed');
    expect([...context.expandedTools]).toEqual(['mcp__alpha__two']);
    // 记入后仍然不可调用：`admit()` 的 skill_narrowed 与检索中的判据逐字一致。
    const admitted = registry.admit('mcp__alpha__two', context);
    expect(admitted.ok).toBe(false);
    expect(admitted.ok === false && admitted.error).toBe('tool_not_in_allowlist');
  });

  it('maxExpandedPerTurn 超了返回 expansion_limit，且这一次不写 expandedTools', async () => {
    const { registry, contextFor } = harness({ catalog: { maxExpandedPerTurn: 1 } });
    mixed(registry);
    const context = contextFor('owner');
    expect((await search(registry, context, { names: ['mcp__alpha__one'] })).matches![0]!.status).toBe('expanded');
    const denied = await search(registry, context, { names: ['mcp__alpha__two'] });
    expect(denied).toMatchObject({ ok: false, error: 'expansion_limit' });
    expect(denied.hint).toContain('names');
    // 护栏在写入之前判定：若置于写入之后额度将失效，而每一次展开都会改动请求体第 0 段。
    expect([...context.expandedTools]).toEqual(['mcp__alpha__one']);
  });

  /**
   * `AC-TOOL-052` 那道闸，方向已翻转：折叠的是外部工具（MCP / plugin / custom），而工具整体
   * 下沉给了 worker —— 主 agent 的 `MAIN_AGENT_TOOLS` 里一个折叠工具都没有，给它一个检索入口
   * 只能检索出一份它调不动的清单。
   *
   * 旧理由（子 agent 与主轮共享同一个 turn 对象，允许它调用即向父轮的 `expandedTools` 写入状态）
   * 已经不存在：那三个集合挪到了 `ToolExecutionContext`，每个 run 各持一份。
   */
  it('agentKind=main 时 search_tools 两处都不可用，lw 侧才有（AC-TOOL-052 那道闸）', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const main = contextFor('owner', {}, 'main');
    expect(registry.activeNames('owner', main)).not.toContain('search_tools');
    const admitted = registry.admit('search_tools', main);
    expect(admitted.ok).toBe(false);
    // 先命中的是 `toolCallableBy()` 那道闸而非 `available()`：`search_tools` 不在
    // `MAIN_AGENT_TOOLS` 里，`admit()` 的判据顺序把它拦在 `available()` 之前。照旧断
    // `tool_unavailable` 会在两道闸调换时仍然通过。
    expect(admitted.ok === false && admitted.error).toBe('tool_requires_worker');
    expect(admitted.ok === false && admitted.reason).toBe('main_agent');
    expect(registry.activeNames('owner', contextFor('owner'))).toContain('search_tools');
    expect(registry.admit('search_tools', contextFor('owner')).ok).toBe(true);
  });

  it('落一条 tool.expanded info 日志', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    events.length = 0;
    await search(registry, contextFor('owner'), { query: 'mcp__alpha__*' });
    const expanded = events.filter((event) => event.kind === 'tool.expanded');
    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.level).toBe('info');
    expect((expanded[0]!.data as { expanded: string[] }).expanded).toEqual(['mcp__alpha__one', 'mcp__alpha__two']);
  });

  it('三个通道都不给时 .refine 拦下来（走 registry 的 safeParse）', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const result = await search(registry, contextFor('owner'), {});
    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(result.hint).toContain('至少提供一个');
  });
});

/**
 * `AC-TOOL-048`：折叠不参与准入。
 *
 * ⚠ 这里有意不编写经模型的端到端断言。`generateText` 会先按本步 `activeTools` 过滤 toolSet 再
 * 执行 `parseToolCall`，因此同一次调用在解析阶段即触发 `NoSuchToolError`，根本到不了
 * `ToolRegistry.execute()`。那属于 AI SDK 的可达性收缩，而非本系统的一道闸
 * （`docs/05 §3.12` 不变量 1 与 §4 末尾已把权限边界与 SDK 的可达性收缩分为两层表述）。
 * 把它当作边界来测试时，一次 SDK 大版本更新即会让该断言失去意义。
 */
describe('工具目录按需暴露 · 折叠不参与准入（AC-TOOL-048）', () => {
  const asked: string[] = [];
  const countingBroker: ApprovalBroker = { request: async (tool) => { asked.push(tool.name); return true; } };

  it('折叠状态下直接 execute()：照常 admit → 审批 → 执行', async () => {
    asked.length = 0;
    const { registry, contextFor } = harness({ catalog: {}, approval: countingBroker });
    mixed(registry);
    external(registry, 'mcp__alpha__risky', 'mcp', { approval: 'always' });
    const context = contextFor('owner');
    // 先确认它确实处于折叠态且不在本步可见集中，否则本用例不具备验证意义。
    expect(registry.activeView('owner', context).deferred.map((tool) => tool.name)).toContain('mcp__alpha__risky');
    expect(registry.activeNamesForStep('owner', context)).not.toContain('mcp__alpha__risky');
    expect(await registry.execute('mcp__alpha__risky', {}, context)).toMatchObject({ ok: true });
    expect(asked).toEqual(['mcp__alpha__risky']);
  });

  it('admit() 的判据集合里不出现折叠判据', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner');
    for (const tool of registry.activeView('owner', context).deferred) expect(registry.admit(tool.name, context).ok).toBe(true);
  });

  it('折叠与运维禁用正交：关掉之后仍是两道硬拦', async () => {
    const overrides: Record<string, ToolOverride> = {};
    const { registry, contextFor } = harness({ catalog: {}, overrides });
    mixed(registry);
    const context = contextFor('owner');
    expect(registry.admit('mcp__alpha__one', context).ok).toBe(true);
    overrides['mcp__alpha__one'] = { enabled: false };
    expect(registry.activeNames('owner', context)).not.toContain('mcp__alpha__one');
    expect(registry.activeView('owner', context).groups.flatMap((group) => group.names)).not.toContain('mcp__alpha__one');
    expect(await registry.execute('mcp__alpha__one', {}, context)).toMatchObject({ ok: false, error: 'tool_disabled_by_operator' });
  });
});

/**
 * 折叠不是权限边界，`toolCallableBy()` 才是（`docs/05 §4`）。同一份判据喂 `#eligible()`（目录）
 * 与 `admit()`（准入复查）两处，`execute()` 走 `admit()` 因而是同一道。
 *
 * 三层各断一次，而**执行层那两条才是判据**：只断目录、只断 admit 等于把 `docs/20 · W-TOOL-01`
 * 那条教训重犯一遍 —— 模型完全可以沿用上一步的工具名直接调过来，目录里没有拦不住它。
 * 因此执行层用留痕桩工具：返回值说拒绝、而工具体已经跑过，是这类改动最典型的坏法。
 */
describe('工具目录按需暴露 · 主 agent / worker 的硬闸', () => {
  /** 两侧各有代表：MAIN_ONLY 五件、两侧共享的只读两件、worker 侧作业四件，外加一个会被折叠的 MCP 工具。 */
  function bothSides(registry: ToolRegistry): void {
    builtin(registry, 'send_message', 100, '发一条消息');
    builtin(registry, 'memory_write', 100, '写一条记忆');
    builtin(registry, 'schedule_create', 100, '排一个定时任务');
    builtin(registry, 'set_model', 90, '换掉本轮的模型');
    builtin(registry, 'spawn_worker', 90, '把任务派给 worker');
    builtin(registry, 'memory_read', 100, '读一条记忆');
    builtin(registry, 'context_stats', 100, '看一眼上下文水位');
    builtin(registry, 'bash', 100, '跑一段 shell');
    builtin(registry, 'read_file', 100, '读一个文件');
    builtin(registry, 'web_search', 100, '搜一下网');
    builtin(registry, 'report_progress', 90, '向上报一句进度');
    external(registry, 'mcp__alpha__one', 'mcp', { description: '回显一段文字' });
    registerCatalogTools(registry, { log });
  }
  /** 留痕桩：`execute` 进过一次就往数组里记一笔。只断返回值的用例挡不住「先跑再改结果」那种写法。 */
  function tracing(registry: ToolRegistry, name: Parameters<typeof builtinPolicy>[0], trace: string[]): void {
    registry.register({ name, description: 'd', inputSchema: schema, policy: builtinPolicy(name), sourcePriority: 100,
      execute: () => { trace.push(name); return { ok: true }; } });
  }

  it('目录层：main 的 activeNames() 恰好等于 MAIN_AGENT_TOOLS ∩ 已注册', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    bothSides(registry);
    // 与 `MAIN_AGENT_TOOLS` 求交集而不是手抄一份名单：手抄的名单在 policy 改一次之后就成了恒真断言。
    const registered = new Set(registry.names());
    const expected = [...MAIN_AGENT_TOOLS].filter((name) => registered.has(name)).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect([...registry.activeNames('owner', contextFor('owner', {}, 'main'))].sort()).toEqual(expected);
  });

  it('目录层反向：lw 拿得到作业工具与折叠的 MCP 工具，拿不到 MAIN_ONLY 那族', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    bothSides(registry);
    const worker = contextFor('owner');
    const names = registry.activeNames('owner', worker);
    expect(names).toEqual(expect.arrayContaining(['bash', 'read_file', 'web_search', 'report_progress', 'search_tools']));
    // `activeNames()` 走的是 `active()` 而非 `activeNamesForStep()`：折叠只改本步可见集，
    // 开轮冻结的那份仍然含它 —— 否则模型检索出来的名字会不在 toolSet 里。
    expect(names).toContain('mcp__alpha__one');
    expect(registry.activeView('owner', worker).deferred.map((tool) => tool.name)).toEqual(['mcp__alpha__one']);
    expect(registry.activeNamesForStep('owner', worker)).not.toContain('mcp__alpha__one');
    for (const name of ['send_message', 'memory_write', 'schedule_create', 'set_model', 'spawn_worker'])
      expect(names).not.toContain(name);
  });

  it('准入层：main 侧 admit 一件 worker 工具回 tool_requires_worker', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    bothSides(registry);
    const denied = registry.admit('bash', contextFor('owner', {}, 'main'));
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.error).toBe('tool_requires_worker');
    expect(denied.ok === false && denied.reason).toBe('main_agent');
    // hint 面向模型：只说「不可用」它会原地重试，说清出路才走得下去。
    expect(denied.ok === false && denied.hint).toContain('spawn_worker');
  });

  it('执行层：两个方向都拒，且工具体一次都没进', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    const trace: string[] = [];
    tracing(registry, 'send_message', trace);
    tracing(registry, 'bash', trace);
    expect(await registry.execute('send_message', {}, contextFor('owner')))
      .toMatchObject({ ok: false, error: 'tool_unavailable_for_worker' });
    expect(await registry.execute('bash', {}, contextFor('owner', {}, 'main')))
      .toMatchObject({ ok: false, error: 'tool_requires_worker' });
    expect(trace).toEqual([]);
    // 反方向各跑通一次，否则空数组只是同义反复（两件工具本来就跑不起来也会得到空数组）。
    expect(await registry.execute('send_message', {}, contextFor('owner', {}, 'main'))).toMatchObject({ ok: true });
    expect(await registry.execute('bash', {}, contextFor('owner'))).toMatchObject({ ok: true });
    expect(trace).toEqual(['send_message', 'bash']);
  });

  it('执行层：worker 侧对 MAIN_ONLY 一族一律拒', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    const trace: string[] = [];
    const names = ['memory_write', 'send_message', 'set_model'] as const;
    for (const name of names) tracing(registry, name, trace);
    const worker = contextFor('owner');
    for (const name of names)
      expect(await registry.execute(name, {}, worker)).toMatchObject({ ok: false, error: 'tool_unavailable_for_worker' });
    expect(trace).toEqual([]);
  });
});

describe('工具目录按需暴露 · describe()', () => {
  it('deferred 按当前 tools.catalog.* 静态判（没有角色也没有轮次上下文）', () => {
    const { registry } = harness({ catalog: { defer: ['bash'] } });
    mixed(registry);
    const rows = new Map(registry.describe().map((entry) => [entry.name, entry.deferred]));
    expect(rows.get('mcp__alpha__one')).toBe(true);
    expect(rows.get('plug_thing')).toBe(true);
    expect(rows.get('custom_thing')).toBe(true);
    expect(rows.get('bash')).toBe(true);
    expect(rows.get('read_file')).toBe(false);
    expect(rows.get('search_tools')).toBe(false);
    expect(rows.get('load_skill')).toBe(false);
    // 静态判定的含义：该表回答的是某工具在本机配置下是否属于折叠族，而 owner-only 的
    // 折叠工具对 limited 而言根本不在其 active() 中，两者是不同的问题。
    const plain = harness();
    mixed(plain.registry);
    expect(plain.registry.describe().every((entry) => entry.deferred === false)).toBe(true);
  });
});
