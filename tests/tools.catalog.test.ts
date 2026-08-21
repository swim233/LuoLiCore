import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, builtinPolicy, configSchema, registerCatalogTools } from '@luoli/core';
import type { ApprovalBroker, ApprovalPolicy, LogEvent, LogSink, ToolExecutionContext, ToolOverride } from '@luoli/core';
import type { Role, RuntimeTurnContext } from '@luoli/shared';

/**
 * 工具目录按需暴露（`docs/05 §3.12` 五条不变量、`docs/07 §5` 折叠判据四档）的 registry 层。
 *
 * 这块的危险与 `tools.overrides.test.ts` 那份同形但方向相反：覆盖层怕「只在两处判定的一处生效」，
 * 折叠怕「几处各算一遍算得不一样」—— 提示词的常驻段、折叠摘要段、`prepareStep` 的可见集、
 * `search_tools` 的检索域全部必须从同一次 `#eligible()` 派生。所以分区断言一律拿 `active()` 当
 * 基准对齐，而不是各自数个数：数个数的测试在两份判据漂移时照样全绿。
 *
 * 全程不开 DB、不经模型。折叠只是**可见性**，权限判定一个字未改（不变量 1），能在这一层判完的
 * 就不该拉起一整轮；而经模型的那条路压根到不了 `execute()`（见 `AC-TOOL-048` 那组用例的注释）。
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
 * `catalog` 给 `undefined` = **limits 里整段不给**（全仓十来处手工构造 `ToolRegistry` 的测试就是
 * 这个形状，缺省必须等于改动前的行为）；给 `{}` = 一份 schema 默认值。
 *
 * 而**配置里那份恒存在**：`search_tools` 从 `turn.config` 读 `maxExpandedPerTurn`，registry 的
 * limits 与 turn 的 config 必须由同一次 `configSchema.parse` 派生 —— 两处对不上时护栏的分子和
 * 分母不是一回事，而这种错在单条用例里看起来完全正常。
 */
function harness(input: { catalog?: Record<string, unknown>; maxRegistered?: number; overrides?: Record<string, ToolOverride>; approval?: ApprovalBroker } = {}) {
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, tools: { catalog: input.catalog ?? {} } });
  const limits = { maxRegistered: input.maxRegistered ?? 80, maxCallsPerTurn: 60, maxConsecutiveErrors: 8,
    ...(input.catalog === undefined ? {} : { catalog: config.tools.catalog }) };
  const registry = new ToolRegistry(log, input.approval ?? okBroker, limits);
  const overrides = input.overrides;
  if (overrides) registry.bindOverrides(() => overrides);
  const contextFor = (role: Role, extra: Partial<RuntimeTurnContext> = {}, agentKind: 'main' | 'sub' = 'main'): ToolExecutionContext => ({
    turn: { turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: role, isPrivate: true, baseCommitId: null,
      snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config, ...extra },
    workspace: '.', agentKind });
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
/** 内建 100 / agent 90 / load_skill 80 与 `EXTERNAL_SOURCE_PRIORITY` 一致，排序才反映真实部署。 */
function mixed(registry: ToolRegistry): void {
  builtin(registry, 'read_file', 100, '读一个文件');
  builtin(registry, 'bash', 100, '跑一段 shell');
  builtin(registry, 'spawn_agent', 90, '派一个子 agent');
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
/** 顺序断言用子序列而不是相等：`activeNamesForStep` 必须是 `active()` 那个有序数组的过滤结果，
 *  把两个分区拼回去会重排 provider 的 tools 数组 —— 每步改一次请求体第 0 段（`docs/04 §2.1`）。 */
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
    expect(resident).toEqual(['bash', 'read_file', 'spawn_agent', 'load_skill', 'search_tools']);
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
    // `defer` 点了 `bash` 也不生效：判据第一档在最前面，后面几档压根不跑。
    expect(view.deferred).toEqual([]);
    expect(registry.hasDeferrable('owner')).toBe(false);
  });

  it('豁免表：defer 点名 search_tools / load_skill 静默不生效（AC-TOOL-049 ①、不变量 2）', () => {
    const { registry, contextFor } = harness({ catalog: { defer: ['search_tools', 'load_skill', '*'] } });
    mixed(registry);
    const view = registry.activeView('owner', contextFor('owner'));
    // `*` 把别的全折叠了，梯子那两级照旧常驻 —— 折叠了检索通道就再没有路径能把工具取回来。
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
    // plugin / custom 不在 `resident` 里就照第五档默认折叠 —— 白名单捞回来的只有它点到的那几个。
    expect(view.deferred.map((tool) => tool.name)).toEqual(['plug_thing', 'mcp__beta__one', 'custom_thing']);
  });

  it('内建 / agent 默认常驻，只有被 defer 点名才折叠', () => {
    const plain = harness({ catalog: {} });
    mixed(plain.registry);
    expect(plain.registry.activeView('owner', plain.contextFor('owner')).resident.map((tool) => tool.name))
      .toEqual(expect.arrayContaining(['bash', 'read_file', 'spawn_agent']));
    const named = harness({ catalog: { defer: ['bash', 'spawn_*'] } });
    mixed(named.registry);
    const deferred = named.registry.activeView('owner', named.contextFor('owner')).deferred.map((tool) => tool.name);
    expect(deferred).toContain('bash');
    expect(deferred).toContain('spawn_agent');
    expect(deferred).not.toContain('read_file');
  });

  /**
   * 组 key 从既有命名空间派生。`mcp__<server>__<tool>` 按**第一个** `__` 断开，与
   * `mcp/manager.ts` 那边拼名字的是同一个约定：server 名允许下划线，所以 `mcp__a_b__t` 的组是
   * `mcp:a_b`（非贪婪 `(.+?)__` 要一直吃到真正的双下划线）；而 `mcp__a__b__t` 的组是 `mcp:a`
   * —— 「a 这台 server 上有个叫 b__t 的工具」和「a__b 这台 server」在名字层面本来就分不开，
   * 认拼接方的约定比编一个假 server 名安全。认不出前缀时退回整族一组 `mcp`。
   *
   * agent 来源也落进 `builtin` 组：`docs/07 §5` 那份组 key 清单里没有 `agent` 这一档，而两者在
   * 判据第四档里本来就同一条路（默认常驻、被 defer 点名才折叠）。
   */
  it('#groupKey 从既有命名空间派生，含 server 名带下划线的情形', () => {
    const { registry, contextFor } = harness({ catalog: { defer: ['bash', 'spawn_agent'] } });
    builtin(registry, 'bash', 100);
    builtin(registry, 'spawn_agent', 90);
    external(registry, 'mcp__a_b__t', 'mcp');
    external(registry, 'mcp__a__b__t', 'mcp');
    external(registry, 'weird_no_prefix', 'mcp');
    external(registry, 'plug_thing', 'plugin');
    external(registry, 'custom_thing', 'custom');
    const groups = registry.activeView('owner', contextFor('owner')).groups;
    expect(groups.map((group) => group.key).sort()).toEqual(['builtin', 'custom', 'mcp', 'mcp:a', 'mcp:a_b', 'plugin']);
    const of = (key: string): readonly string[] => groups.find((group) => group.key === key)!.names;
    expect(of('builtin')).toEqual(['bash', 'spawn_agent']);
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
    // plugin 60 > mcp 40 > custom 30。摘要行属提示词易变段，无谓的重排等于每步改一次提示词。
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
    // 分区在截断**之后**做：摘要里报一个开轮冻结的 toolSet 里没有的名字，模型去展开它就是
    // 一次 AI SDK 层的运行时报错，而模型完全不知道自己被砍掉了什么。
    for (const group of view.groups) for (const name of group.names) expect(active).toContain(name);
    expect(view.groups).toEqual([{ key: 'plugin', names: ['plug_thing'], total: 1 }]);
  });

  it('hasDeferrable 决定 search_tools 进不进目录（AC-TOOL-049 ②的注册表那一半）', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    builtin(registry, 'read_file', 100);
    builtin(registry, 'bash', 100);
    builtin(registry, 'load_skill', 80);
    registerCatalogTools(registry, { log });
    // 纯内建部署：折叠集恒为空 ⇒ 整个元工具不进目录，提示词逐字节不变。
    expect(registry.hasDeferrable('owner')).toBe(false);
    expect(registry.activeNames('owner', contextFor('owner'))).not.toContain('search_tools');
    external(registry, 'mcp__alpha__one', 'mcp');
    expect(registry.hasDeferrable('owner')).toBe(true);
    expect(registry.activeNames('owner', contextFor('owner'))).toContain('search_tools');
  });

  /**
   * `hasDeferrable` 刻意不走 `activeView()`：那条路是 `activeView()` → `#eligible()` →
   * `tool.available?.()` → `search_tools.available()` → 又一次 `activeView()`，一个真实的无限
   * 递归环，表现是开轮直接栈溢出。它只遍历 `#tools` 自己判三件事，一次 `available()` 都不调。
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
    // 不许出现「看得见折叠摘要却没法展开」：三处都从同一个判据派生，所以按步可见集必须等于全集。
    expect(registry.activeNamesForStep('owner', context)).toEqual(registry.activeNames('owner', context));
    expect(registry.describe().every((entry) => entry.deferred === false)).toBe(true);
  });

  /**
   * 不变量 3 的**另一种收梯子的写法**：工具页把 `enabled` / `minRole` / 审批 / 超时四项放在同一行上
   * （docs/09 §3.7），把 `search_tools` 的 `minRole` 抬到 owner 与把它关掉是同一件事 —— 对一个
   * trusted 会话来说梯子一样不存在。此前只判了 `enabled`，于是 trusted 那一档正好落在被明文禁止的
   * 形态上：折叠摘要照渲染、`search_tools` 被 `#eligible()` 的 minRole 闸滤掉、连 `repairToolCall`
   * 的自愈也一起失效（它的闸 ③ 正是「`search_tools` 本步发不出去」）。
   *
   * owner 那一档必须**照旧折叠**：抬 minRole 是收给 owner 用，不是关掉折叠。
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
    // owner 够得到梯子，所以对它折叠照旧成立 —— 回退是按角色的，不是全局的。
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
    const resident = ['bash', 'read_file', 'spawn_agent', 'load_skill', 'search_tools'];
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
    // 展开过的工具被收窄挡住 ⇒ 本步不可见。这一条塌掉的表现是 skill 的 allowed-tools 形同虚设。
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
    // 给了两个通道不该让结果更少：每一个都是「找到它」的一种办法。
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
    // 不存在的组回空集而不是整份目录 —— 编错一个组名不该等于「把目录再抄一遍」。
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
    // 上限焊在 schema 里：一次展开二十个已经把「按需」的意义用完了。
    expect(await search(registry, context, { query: 'mcp__many__*', limit: 21 })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('检索域从 activeView() 派生 ⇒ limited 搜不到 owner 工具的名字与描述', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    external(registry, 'mcp__alpha__secret', 'mcp', { description: '独一无二的口令 hunter2', minRole: 'owner' });
    external(registry, 'mcp__alpha__open', 'mcp', { description: '谁都能用' });
    registerCatalogTools(registry, { log });
    const context = contextFor('limited');
    // 断 `ok` 而不只断空集：一次被拒的调用同样给不出名字，那样这条用例什么都没证明。
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
    // tool result 永久留在上下文里（`context_messages` 只追加），抄一份 4KB 的 MCP 描述进来等于
    // 给这一整段会话每轮都记一次账；完整 schema 下一步由 provider 的 tools 数组权威送达。
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
    // 同一轮再搜一次：已展开过的报 already_active，不再占一格额度。
    expect((await search(registry, context, { names: ['mcp__alpha__one'] })).matches![0]!.status).toBe('already_active');
    // 常驻工具报 already_active 而不是留空 group：形状统一，模型不用猜缺字段的含义。
    const resident = (await search(registry, context, { names: ['bash'] })).matches![0]!;
    expect(resident.status).toBe('already_active');
    expect(resident.group).toBe('resident');
    const narrowedContext = contextFor('owner', { skillAllowedTools: new Set(['bash']) });
    expect((await search(registry, narrowedContext, { names: ['mcp__alpha__two'] })).matches![0]!.status).toBe('narrowed');
  });

  /**
   * 被收窄挡住的**照样记进 `expandedTools`**，只是仍然调不动。少了这一笔就是一个死循环的一半：
   * 另一半在 `agent/runtime.ts` 的 `repairToolCall`，它靠「原名不在 `expandedTools` 里」判这次
   * 硬调值不值得改写成一次检索 —— 折叠且被收窄的工具如果永远进不了这个集合，就会走成
   * 「调 X → NoSuchToolError → 改写成检索 → narrowed → 再调 X → …」一路烧到步数上限。
   */
  it('收窄挡住的工具照样记进 expandedTools', async () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const context = contextFor('owner', { skillAllowedTools: new Set(['bash']) });
    expect((await search(registry, context, { names: ['mcp__alpha__two'] })).matches![0]!.status).toBe('narrowed');
    expect([...context.turn.expandedTools!]).toEqual(['mcp__alpha__two']);
    // 记上了照旧调不动：`admit()` 的 skill_narrowed 与检索里那份判据逐字对齐。
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
    // 护栏在**写之前**判：漏在写之后的话额度形同虚设，而每一次展开都把请求体第 0 段改一遍。
    expect([...context.turn.expandedTools!]).toEqual(['mcp__alpha__one']);
  });

  it('agentKind=sub 时 search_tools 两处都不可用（AC-TOOL-052 那道闸）', () => {
    const { registry, contextFor } = harness({ catalog: {} });
    mixed(registry);
    const sub = contextFor('owner', {}, 'sub');
    expect(registry.activeNames('owner', sub)).not.toContain('search_tools');
    const admitted = registry.admit('search_tools', sub);
    expect(admitted.ok).toBe(false);
    expect(admitted.ok === false && admitted.error).toBe('tool_unavailable');
    // 子 agent 与主轮共享同一个 turn 对象，让它调就是往父轮的 expandedTools 里写状态。
    expect(registry.activeNames('owner', contextFor('owner'))).toContain('search_tools');
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
    expect(result.hint).toContain('至少给一个');
  });
});

/**
 * `AC-TOOL-048`：折叠**不参与准入**。
 *
 * ⚠ 这里刻意不写经模型的端到端断言。`generateText` 先按本步 `activeTools` 把 toolSet 过一遍再
 * `parseToolCall`，于是同一次调用在解析阶段就撞 `NoSuchToolError`，压根到不了
 * `ToolRegistry.execute()` —— 那是 AI SDK 的**可达性收缩**，不是本系统的一道闸
 * （`docs/05 §3.12` 不变量 1 与 §4 末尾把「权限边界」与「SDK 的可达性收缩」分成两层写了）。
 * 拿它当边界测，换一次 SDK 大版本这条断言就变成一句假话。
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
    // 先确认它真的处在折叠态、且不在本步可见集里 —— 否则这条用例什么都没测到。
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
    // 静态判的含义：这张表答的是「这个工具在这台机器的配置下属于折叠族吗」，而 owner-only 的
    // 折叠工具对 limited 来说压根不在它那份 active() 里 —— 两个问题不是一回事。
    const plain = harness();
    mixed(plain.registry);
    expect(plain.registry.describe().every((entry) => entry.deferred === false)).toBe(true);
  });
});
