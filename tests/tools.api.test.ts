import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, TOOL_POLICY, ToolRegistry, configSchema, toolCallableBy } from '@luoli/core';
import type { ToolOverride } from '@luoli/core';
import { createServer } from '@luoli/server';

/**
 * `PATCH /api/tools/:name` 的写入契约（docs/09 §3.7）。
 *
 * 这个端点此前只收 `{enabled}`，现在还收 minRole / approval / timeoutMs。三条最容易写错的地方
 * 各有一条用例：**放宽必须先 409 且一个字都不落库**、**部分 PATCH 不能抹掉同一条 JSON 里其余的
 * 覆盖**、**显式 null 是恢复默认而不是写一个 null 进去**。
 */
/**
 * `tools` 收的是**工厂**而不是现成的注册表：`ToolRegistry` 要 `LogSink`，而 `LogSink` 要这里才
 * 打开的那个库 —— 直接收实例的话调用方得自己再开一个库。缺省仍不装配注册表（静态兜底那条路）。
 */
function harness(name: string, overrides: Record<string, ToolOverride> = {}, registryFor?: (log: LogSink) => ToolRegistry) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' }, tools: { overrides } });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations); const archive = new ArchiveRepository(db);
  const tools = registryFor?.(log);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined,
    ...(tools ? { tools } : {}) });
  const session = operations.createSession(1);
  return { app, db, headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' } };
}

const stored = (db: ReturnType<typeof openDatabase>, tool: string): ToolOverride | null => {
  const row = db.prepare('SELECT value_json AS value FROM config_kv WHERE key=?').pluck().get(`tools.overrides.${tool}`) as string | undefined;
  return row ? JSON.parse(row) as ToolOverride : null;
};
const patch = (app: ReturnType<typeof harness>['app'], headers: Record<string, string>, tool: string, body: unknown) =>
  app.request(`/api/tools/${tool}`, { method: 'PATCH', headers, body: JSON.stringify(body) });

describe('PATCH /api/tools/:name', () => {
  it('未知工具 404，非法取值 400，且都不落库', async () => {
    const { app, db, headers } = harness('tools-api-reject');
    expect((await patch(app, headers, 'not_a_tool', { enabled: false })).status).toBe(404);
    expect((await patch(app, headers, 'bash', { enabled: 'no' })).status).toBe(400);
    expect((await patch(app, headers, 'bash', { minRole: 'god' })).status).toBe(400);
    expect((await patch(app, headers, 'bash', { approval: 'sometimes' })).status).toBe(400);
    expect((await patch(app, headers, 'bash', { timeoutMs: 0 })).status).toBe(400);
    expect((await patch(app, headers, 'bash', { timeoutMs: 1.5 })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) FROM config_kv').pluck().get()).toBe(0);
    closeDatabase(db);
  });

  it('收紧直接存，放宽先 409 且一个字都不落库，确认后才写入', async () => {
    const { app, db, headers } = harness('tools-api-relax');
    // delete_file 的代码默认是 trusted + always。
    expect(TOOL_POLICY.delete_file).toMatchObject({ minRole: 'trusted', approval: 'always' });

    // 收紧：minRole 调高，不需要确认。
    expect((await patch(app, headers, 'delete_file', { minRole: 'owner' })).status).toBe(200);
    expect(stored(db, 'delete_file')).toMatchObject({ minRole: 'owner' });

    // 放宽：审批降档 → 409，且库里那一行没被动过。
    const refused = await patch(app, headers, 'delete_file', { approval: 'never' });
    expect(refused.status).toBe(409);
    const body = await refused.json() as { error: { code: string; details: Array<{ path: string; from: string; to: string }> } };
    expect(body.error.code).toBe('relax_requires_confirmation');
    expect(body.error.details).toEqual([{ path: 'approval', from: 'always', to: 'never' }]);
    expect(stored(db, 'delete_file')).toMatchObject({ minRole: 'owner' });
    expect(stored(db, 'delete_file')?.approval).toBeUndefined();

    // 带确认才写入。
    const confirmed = await patch(app, headers, 'delete_file', { approval: 'never', confirmRelax: true });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json() as { data: { relaxed: string[] } }).data.relaxed).toEqual(['approval']);
    expect(stored(db, 'delete_file')).toMatchObject({ minRole: 'owner', approval: 'never' });
    closeDatabase(db);
  });

  it('minRole 调低同样要确认，报出的 from/to 是代码默认 → 目标值', async () => {
    const { app, db, headers } = harness('tools-api-role');
    const refused = await patch(app, headers, 'delete_file', { minRole: 'limited' });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: { details: unknown } }).error.details).toEqual([{ path: 'minRole', from: 'trusted', to: 'limited' }]);
    expect(stored(db, 'delete_file')).toBeNull();
    closeDatabase(db);
  });

  it('部分 PATCH 不会抹掉同一条 JSON 里其余的覆盖', async () => {
    const { app, db, headers } = harness('tools-api-merge');
    expect((await patch(app, headers, 'web_fetch', { minRole: 'owner' })).status).toBe(200);
    expect((await patch(app, headers, 'web_fetch', { timeoutMs: 45_000 })).status).toBe(200);
    // 第二次只带了 timeoutMs —— minRole 必须还在。配置重载是异步的，所以基准取的是库里那一行。
    expect(stored(db, 'web_fetch')).toMatchObject({ minRole: 'owner', timeoutMs: 45_000 });
    expect((await patch(app, headers, 'web_fetch', { enabled: false })).status).toBe(200);
    expect(stored(db, 'web_fetch')).toMatchObject({ minRole: 'owner', timeoutMs: 45_000, enabled: false });
    closeDatabase(db);
  });

  it('显式 null 是恢复默认：字段从覆盖里消失，而不是写一个 null 进去', async () => {
    const { app, db, headers } = harness('tools-api-reset');
    expect((await patch(app, headers, 'web_fetch', { minRole: 'owner', timeoutMs: 45_000 })).status).toBe(200);
    expect((await patch(app, headers, 'web_fetch', { minRole: null })).status).toBe(200);
    const after = stored(db, 'web_fetch')!;
    expect(Object.hasOwn(after, 'minRole')).toBe(false);
    expect(after).toMatchObject({ timeoutMs: 45_000 });
    // 写回去的那条 JSON 仍然过 schema —— 落库前它就是这么校验的。
    expect(configSchema.parse({ tools: { overrides: { web_fetch: after } } }).tools.overrides.web_fetch).toMatchObject({ timeoutMs: 45_000 });
    closeDatabase(db);
  });
});

describe('GET /api/tools', () => {
  // 这个部署没有装配 `ToolRegistry`，走的是「TOOL_POLICY + 覆盖层」那条退回分支 —— 工具页
  // 读的就是它，所以生效值必须在这条分支上也算对。覆盖直接给进配置快照而不是先 PATCH 一次：
  // `config.changed` 之后的重载是异步的（`main.ts`），拿写入去驱动读取会把两件事混在一起测。
  it('扁平字段是生效值，defaults 是代码那份，relaxed 列出更松的项', async () => {
    const { app, db, headers } = harness('tools-api-get', { delete_file: { minRole: 'limited' }, bash: { enabled: false } });
    const response = await app.request('/api/tools', { headers: { cookie: headers.cookie } });
    const data = (await response.json() as { data: Record<string, { minRole: string; approval: string; scope: string; enabled: boolean; defaults: { minRole: string; approval: string }; relaxed: string[] }> }).data;
    expect(data.delete_file!.minRole).toBe('limited');
    expect(data.delete_file!.defaults.minRole).toBe('trusted');
    expect(data.delete_file!.relaxed).toEqual(['minRole']);
    // 覆盖里没有 approval / scope，这两项照旧来自代码。
    expect(data.delete_file!.approval).toBe(TOOL_POLICY.delete_file.approval);
    expect(data.delete_file!.scope).toBe(TOOL_POLICY.delete_file.scope);
    expect(data.bash!.minRole).toBe(TOOL_POLICY.bash.minRole);
    expect(data.bash!.enabled).toBe(false);
    expect(data.bash!.relaxed).toEqual([]);
    closeDatabase(db);
  });

  /**
   * `sides` 与运行时判据同源。**这一条断言的是「同源」而不是某个具体名单** —— 写死一份期望名单
   * 就等于在测试里造第二份真相，而这一列存在的全部理由正是不许有第二份（docs/09 §3.7）。
   *
   * 判据现算，所以静态兜底这条路上它照样是真的：它只看工具名，与有没有注册表无关。
   */
  it('每一行的 sides 就是 toolCallableBy() 现算出来的那两问，不是另抄一份名单', async () => {
    const { app, db, headers } = harness('tools-api-sides');
    const response = await app.request('/api/tools', { headers: { cookie: headers.cookie } });
    const data = (await response.json() as { data: Record<string, { sides: string[] }> }).data;
    for (const name of Object.keys(TOOL_POLICY)) {
      const expected = [
        ...(toolCallableBy('main', name) ? ['main'] : []),
        ...(toolCallableBy('lw', name) ? ['worker'] : []),
      ];
      expect(data[name]!.sides, name).toEqual(expected);
    }
    // 三态都要真的出现过，否则上面那圈在名单退化成恒等时也会绿。
    const keys = Object.values(data).map((row) => row.sides.join('+'));
    for (const shape of ['main', 'worker', 'main+worker'])
      expect(keys, `没有一个工具落在「${shape}」这一档`).toContain(shape);
    // 三档各点一个名：`spawn_worker` 是主 agent 独占的派发口（worker 是叶子），`read_file` 只在
    // worker 那侧（主 agent 不再碰工具），`memory_read` 是刻意两侧共享的只读查询。
    expect(data.spawn_worker!.sides).toEqual(['main']);
    expect(data.read_file!.sides).toEqual(['worker']);
    expect(data.memory_read!.sides).toEqual(['main', 'worker']);
    closeDatabase(db);
  });

  /**
   * 这条路判不出折叠（判据要 `#limits()` 与实际注册进来的那批工具），于是每行**都**报 `false`
   * 而不是省掉这个字段：形状统一，前端不必分两种响应处理（docs/05 §3.12）。
   */
  it('静态兜底分支里每一行都带 deferred:false', async () => {
    const { app, db, headers } = harness('tools-api-get-static');
    const response = await app.request('/api/tools', { headers: { cookie: headers.cookie } });
    const data = (await response.json() as { data: Record<string, { deferred: boolean }> }).data;
    expect(Object.keys(data).length).toBe(Object.keys(TOOL_POLICY).length);
    expect(Object.entries(data).filter(([, row]) => row.deferred !== false)).toEqual([]);
    closeDatabase(db);
  });
});

describe('GET /api/tools · 装配了注册表的那条分支', () => {
  const registryFor = (deferExternal: () => boolean) => (log: LogSink): ToolRegistry => {
    // limits 走 getter：`tools.catalog` 标着热更新，翻开关不该等重启（docs/11、docs/20 · W-CFG-02）。
    const registry = new ToolRegistry(log, { request: async () => true },
      () => ({ maxRegistered: 80, maxCallsPerTurn: 40, maxConsecutiveErrors: 3, catalog: { deferExternal: deferExternal() } }));
    registry.register({ name: 'read_file', description: '读文件', inputSchema: z.object({}), sourcePriority: 100,
      policy: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'builtin' }, execute: () => ({ ok: true }) });
    registry.registerExternal({ name: 'mcp__fixture__echo', description: 'echo text', inputSchema: z.object({}),
      minRole: 'trusted', source: 'mcp', execute: () => ({ ok: true }) });
    return registry;
  };

  /**
   * `describe()` 的 `deferred` 是**静态**判：没有角色也没有轮次上下文，它答的是「这个工具在这台
   * 机器的配置下属于折叠族吗」，不是「某一轮里它被折叠了吗」。它也**不是**启停开关的另一种说法
   * —— 折叠工具照旧可执行，只是模型默认看不见 schema（docs/05 §3.12）。
   */
  it('外部来源标 deferred:true，内建不标；deferExternal 关掉时两行都是 false', async () => {
    let deferExternal = true;
    const { app, db, headers } = harness('tools-api-deferred', {}, registryFor(() => deferExternal));
    const read = async (): Promise<Record<string, { deferred: boolean; enabled: boolean }>> =>
      (await (await app.request('/api/tools', { headers: { cookie: headers.cookie } })).json() as { data: Record<string, { deferred: boolean; enabled: boolean }> }).data;
    const folded = await read();
    expect(folded.mcp__fixture__echo).toMatchObject({ deferred: true, enabled: true });
    expect(folded.read_file).toMatchObject({ deferred: false, enabled: true });
    deferExternal = false;
    const flat = await read();
    expect(flat.mcp__fixture__echo!.deferred).toBe(false);
    expect(flat.read_file!.deferred).toBe(false);
    closeDatabase(db);
  });
});
