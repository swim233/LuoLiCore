import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CustomToolRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { CustomToolManager, Sandbox, ToolRegistry, configSchema, type Config, type LogSink } from '@luoli/core';

const log = { event: () => undefined, publish: () => undefined, span: () => ({ id: 's', end: () => undefined }) } as unknown as LogSink;
const recordingLog = (events: Array<{ kind: string }>): LogSink =>
  ({ event: (entry: { kind: string }) => events.push(entry), publish: () => undefined, span: () => ({ id: 's', end: () => undefined }) } as unknown as LogSink);

/**
 * `sandbox.mode: 'docker'` —— owner 命中 `bypassRoles` 走宿主直跑（正是需求方拍板的形态，
 * 自定义工具与 bash 一视同仁，docs/14 T19），trusted 的工具照旧进目录。**这里的用例只以 owner
 * 身份真的执行**，所以不依赖机器上有 docker；换成 `none` 反而不行 —— 那会让 trusted 的
 * `plan()` 直接被拒，「trusted 拿得到 custom_floored」那条断言就成了假绿。
 */
function harness(name: string, overrides: Record<string, unknown> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const workspace = resolve(`./data/${name}-workspace`);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  let config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, sandbox: { mode: 'docker' },
    tools: { selfExtend: { enabled: true, customTools: { enabled: true, ...(overrides.customTools ?? {}) } }, ...(overrides.tools ?? {}) } }) as Config;
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 },
    [], undefined);
  registry.bindOverrides(() => config.tools.overrides);
  const sandbox = new Sandbox(() => ({ mode: config.sandbox.mode, bypassRoles: config.sandbox.bypassRoles, dockerBin: 'docker',
    image: 'x', network: 'none', memoryMb: 256, cpus: 1, pidsLimit: 64, readOnlyRoot: false, tmpfsMb: 16,
    workspaceDir: workspace, hostWorkspaceDir: '', defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, maxOutputBytes: 65_536 }));
  const repo = new CustomToolRepository(db);
  const events: Array<{ kind: string }> = [];
  const manager = new CustomToolManager(repo, () => config.tools.selfExtend, sandbox, recordingLog(events), () => config.tools.exec.maxTimeoutMs);
  manager.bindRegistry(registry);
  const turn = { turnId: 't1', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'owner' as 'owner' | 'trusted' | 'limited',
    isPrivate: true, baseCommitId: null, config, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [], abortSignal: new AbortController().signal };
  const contextFor = (patch: Partial<typeof turn> = {}) => ({ turn: { ...turn, ...patch }, workspace, agentKind: 'main' }) as never;
  return { db, repo, manager, registry, events, context: contextFor(), contextFor, turn, workspace,
    reconfigure: (patch: Record<string, unknown>) => { config = configSchema.parse(patch) as Config; } };
}

/** 定义 + 启用 + 重扫，三步是分开的 —— 「落库即禁用」正是这套东西的主闸。 */
function define(h: ReturnType<typeof harness>, input: Record<string, unknown>, enable = true): void {
  const result = h.manager.define(input as never, h.context) as { ok: boolean; name?: string };
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (enable) { h.repo.setEnabled(String(result.name).replace('custom_', ''), true); h.manager.reconcile(); }
}

describe('self-authored custom tools', () => {
  it('never lets a parameter reach the shell', async () => {
    const h = harness('custom-injection');
    // 正文两条通道各读一次：环境变量与参数文件。两条都不该让 `$(id)` 被求值。
    define(h, { name: 'echo', description: 'echo back', runtime: 'bash',
      params: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      body: 'printf "env=%s\\n" "$LUOLI_ARG_X"; printf "file=%s\\n" "$(cat "$1")"' });
    const result = await h.registry.execute('custom_echo', { x: '$(id)' }, h.context) as { value?: string };
    const text = JSON.stringify(result);
    expect(text).toContain('env=$(id)');
    expect(text).not.toMatch(/uid=\d+/);
    closeDatabase(h.db);
  });

  it('keeps the bash role floor even when an operator relaxes the override', () => {
    const h = harness('custom-floor');
    define(h, { name: 'floored', description: 'x', runtime: 'bash', body: 'true', minRole: 'trusted' });
    expect(h.registry.activeNames('trusted', h.context)).toContain('custom_floored');
    // 运维把它放宽到 limited：`effectivePolicy()` 认这条覆盖，但 `available()` 里的地板不认 ——
    // 一个自定义工具就是一段 shell，放给 limited 等于绕过 `TOOL_POLICY.bash.minRole`（docs/09 §3.7
    // 立的第一条不变量：覆盖绕不过 available()）。目录与准入两侧都要挡。
    h.reconfigure({ access: { bootstrapOwnerId: '1' }, sandbox: { mode: 'docker' },
      tools: { selfExtend: { enabled: true, customTools: { enabled: true } }, overrides: { custom_floored: { minRole: 'limited' } } } });
    const limited = h.contextFor({ effectiveRole: 'limited' });
    expect(h.registry.activeNames('limited', limited)).not.toContain('custom_floored');
    expect(h.registry.admit('custom_floored', limited)).toMatchObject({ ok: false });
    closeDatabase(h.db);
  });

  it('confines a chat-scoped tool to the chat that wrote it', () => {
    const h = harness('custom-scope');
    define(h, { name: 'scoped', description: 'x', runtime: 'bash', body: 'true' });
    expect(h.registry.activeNames('owner', h.context)).toContain('custom_scoped');
    const elsewhere = h.contextFor({ chatId: '-100999', key: 'chat:-100999' });
    expect(h.registry.activeNames('owner', elsewhere)).not.toContain('custom_scoped');
    expect(h.registry.admit('custom_scoped', elsewhere)).toMatchObject({ ok: false, error: 'tool_unavailable' });
    closeDatabase(h.db);
  });

  it('refuses to run a definition that changed after it was registered', async () => {
    const h = harness('custom-redefine');
    define(h, { name: 'drifted', description: 'x', runtime: 'bash', body: 'echo one' });
    // 注册发生在开轮，执行发生在若干步之后：中途改掉正文时模型看到的是旧 schema、要跑的是新正文。
    h.repo.upsert({ name: 'drifted', description: 'x', paramsJson: '{"type":"object","properties":{}}', runtime: 'bash',
      body: 'echo two', minRole: 'owner', scope: 'chat', ownerChatId: '1', timeoutMs: null, createdBy: '2', createdTurn: null });
    h.repo.setEnabled('drifted', true);
    // 自定义工具的输出一律经 `untrusted()` 包裹（脚本的 stdout 可能是它刚抓回来的网页），
    // 所以错误码在 `content` 里，顶层只剩 `ok:false` —— 熔断器认的正是那个 `ok`。
    const refused = await h.registry.execute('custom_drifted', {}, h.context) as { ok: boolean; content: string };
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('custom_tool_redefined');
    closeDatabase(h.db);
  });

  it('lands disabled unless autoEnable is on, and a body change resets it', () => {
    const h = harness('custom-gate');
    define(h, { name: 'gated', description: 'x', runtime: 'bash', body: 'true' }, false);
    expect(h.repo.get('gated')?.enabled).toBe(0);
    expect(h.registry.activeNames('owner', h.context)).not.toContain('custom_gated');
    h.repo.setEnabled('gated', true);
    h.manager.reconcile();
    expect(h.registry.activeNames('owner', h.context)).toContain('custom_gated');
    // 改正文 = 重新复审。没有这条，「先定义无害的、拿到启用、再改成恶意的」直接走通。
    h.manager.define({ name: 'gated', description: 'x', runtime: 'bash', body: 'echo changed' } as never, h.context);
    expect(h.repo.get('gated')).toMatchObject({ enabled: 0, reviewedAt: null });
    expect(h.registry.activeNames('owner', h.context)).not.toContain('custom_gated');

    const auto = harness('custom-autoenable', { customTools: { autoEnable: true } });
    define(auto, { name: 'instant', description: 'x', runtime: 'bash', body: 'true' }, false);
    expect(auto.repo.get('instant')?.enabled).toBe(1);
    expect(auto.registry.activeNames('owner', auto.context)).toContain('custom_instant');
    closeDatabase(auto.db);
    closeDatabase(h.db);
  });

  it('validates names, prefixes, collisions and the tool budget at define time', () => {
    const h = harness('custom-validate', { customTools: { maxTools: 2 } });
    expect(h.manager.define({ name: 'Bad Name', description: 'x', runtime: 'bash', body: 'true' } as never, h.context))
      .toMatchObject({ ok: false, error: 'invalid_tool_name' });
    expect(h.manager.define({ name: 'noparams', description: 'x', runtime: 'bash', body: 'true', params: { type: 'array' } } as never, h.context))
      .toMatchObject({ ok: false, error: 'invalid_params' });
    // 模型给的名字带不带 `custom_` 前缀都落到同一个工具上，不会造出 `custom_custom_x`。
    define(h, { name: 'custom_prefixed', description: 'x', runtime: 'bash', body: 'true' });
    expect(h.repo.get('prefixed')).not.toBeNull();
    expect(h.registry.has('custom_prefixed')).toBe(true);
    // 与别的来源重名要在**定义期**就说清楚：`registerExternal` 只会 warn 一行然后返回 false，
    // 而模型看到的会是「定义成功了但工具从来没出现过」。
    h.registry.registerExternal({ name: 'custom_taken', description: 'mcp one', inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
      minRole: 'trusted', source: 'mcp', execute: () => ({ ok: true }) });
    expect(h.manager.define({ name: 'taken', description: 'x', runtime: 'bash', body: 'true' } as never, h.context))
      .toMatchObject({ ok: false, error: 'name_taken' });
    define(h, { name: 'second', description: 'x', runtime: 'bash', body: 'true' });
    // 上限在定义期报错，而不是等 `active()` 那条没人看的截断 warn。
    expect(h.manager.define({ name: 'third', description: 'x', runtime: 'bash', body: 'true' } as never, h.context))
      .toMatchObject({ ok: false, error: 'custom_tool_limit' });
    closeDatabase(h.db);
  });

  it('does not re-reconcile forever after a tool fails to register', () => {
    const h = harness('custom-fingerprint');
    define(h, { name: 'clash', description: 'x', runtime: 'bash', body: 'true' });
    // 让它注册失败：另一个来源占了这个名字，`registerExternal` 拒绝跨来源覆盖。
    h.registry.unregisterBySource('custom');
    h.registry.registerExternal({ name: 'custom_clash', description: 'mcp one', inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
      minRole: 'trusted', source: 'mcp', execute: () => ({ ok: true }) });
    h.manager.reconcile();
    const afterFirst = h.events.filter((entry) => entry.kind === 'tool.custom_invalid').length;
    expect(afterFirst).toBe(1);
    // 循环里的 `markError` 会推高 `updated_at`。指纹要是在循环**之前**记的，那它一记下来就是过时的
    // —— 此后每一轮的 `syncIfChanged()` 都判成「变了」，重扫、再写一次 markError、再记一个过时指纹，
    // 一个注册失败的工具就能让这件事每轮发生一次，永远收敛不了。
    h.manager.syncIfChanged();
    h.manager.syncIfChanged();
    expect(h.events.filter((entry) => entry.kind === 'tool.custom_invalid')).toHaveLength(afterFirst);
    closeDatabase(h.db);
  });

  it('tells the model apart: disabled mid-turn vs redefined vs removed', async () => {
    const h = harness('custom-midturn');
    define(h, { name: 'toggled', description: 'x', runtime: 'bash', body: 'true' });
    // 三种情形不能挤成同一个信号：报「定义变了」的话模型会去 list_tools、看见定义原封不动、
    // 然后原样重试。
    h.repo.setEnabled('toggled', false);
    const disabled = await h.registry.execute('custom_toggled', {}, h.context) as { ok: boolean; content: string };
    expect(disabled.ok).toBe(false);
    expect(disabled.content).toContain('custom_tool_disabled');
    h.repo.remove('toggled');
    const removed = await h.registry.execute('custom_toggled', {}, h.context) as { ok: boolean; content: string };
    expect(removed.content).toContain('custom_tool_removed');
    closeDatabase(h.db);
  });

  it('counts parameter nesting, not JSON-Schema keyword nesting', () => {
    const h = harness('custom-depth');
    const nest = (levels: number): Record<string, unknown> => levels === 0
      ? { type: 'string' }
      : { type: 'object', properties: { child: nest(levels - 1) } };
    // 一份平铺的 schema 曾经就被数成 2 层，于是上限 4 实际只放行一层嵌套，而报错信息还写着
    // 「最多 4 层」—— 模型照着那句话重试，再被拒一次。
    expect(h.manager.define({ name: 'shallow', description: 'x', runtime: 'bash', body: 'true', params: nest(2) } as never, h.context))
      .toMatchObject({ ok: true });
    expect(h.manager.define({ name: 'deep', description: 'x', runtime: 'bash', body: 'true', params: nest(4) } as never, h.context))
      .toMatchObject({ ok: false, error: 'params_too_deep' });
    closeDatabase(h.db);
  });

  it('drops the whole family when the master switch goes off', () => {
    const h = harness('custom-master');
    define(h, { name: 'gone', description: 'x', runtime: 'bash', body: 'true' });
    expect(h.registry.activeNames('owner', h.context)).toContain('custom_gone');
    h.reconfigure({ access: { bootstrapOwnerId: '1' }, sandbox: { mode: 'docker' }, tools: { selfExtend: { enabled: false } } });
    h.manager.syncIfChanged();
    expect(h.registry.has('custom_gone')).toBe(false);
    closeDatabase(h.db);
  });
});
