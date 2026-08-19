import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase, OperationsRepository } from '@luoli/db';
import { LogSink, McpManager, ToolRegistry, configSchema } from '@luoli/core';
import type { ToolExecutionContext } from '@luoli/core';

const PROBE = resolve('tests/fixtures/mcp-server-probe.mjs');
/** 子进程自己记的 pid —— 用例靠它数 spawn 次数、kill 指定的那一个、以及判「关停有没有真的等到它死」。 */
function spawnedPids(log: string): number[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number) : [];
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
}

/** 每个用例自己的库、自己的 spawn 日志。`hang` 的那台永远握不上手，用来撑开窗口；**顺序有意义**，
 *  串行 discover 的旧实现是逐台开窗口的。 */
function harness(slug: string, specs: Array<{ name: string; hang?: boolean }>, connectTimeoutMs?: number) {
  const database = `./data/mcp-${slug}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
  const spawnLog = resolve(`data/mcp-${slug}-spawns.log`);
  rmSync(spawnLog, { force: true });
  const db = openDatabase(database); migrateDatabase(db);
  const log = new LogSink(new OperationsRepository(db), './data/mcp-runtime-logs');
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 80, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
  const servers = specs.map((spec) => ({ name: spec.name, transport: 'stdio', command: process.execPath, args: [PROBE], enabled: true,
    env: { MCP_SPAWN_LOG: spawnLog, ...(spec.hang ? { MCP_HANG: '1' } : {}) } }));
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, mcp: { enabled: true, ...(connectTimeoutMs ? { connectTimeoutMs } : {}), servers } }).mcp;
  return { db, spawnLog, registry, manager: new McpManager(db, config, log, registry) };
}

describe('MCP runtime', () => {
  it('discovers and invokes allowlisted tools through stdio SDK transport', async () => {
    const database = './data/mcp-runtime.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    const db = openDatabase(database); migrateDatabase(db);
    const log = new LogSink(new OperationsRepository(db), './data/mcp-runtime-logs');
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, mcp: { enabled: true, servers: [{ name: 'fixture', transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-server.mjs')], enabled: true, toolAllow: ['echo'] }] } });
    const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 80, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
    const manager = new McpManager(db, config.mcp, log, registry);
    await manager.reconcile();
    const tools = manager.toolEntries();
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__fixture__echo']);
    expect(registry.names()).toEqual(['mcp__fixture__echo']);
    const context: ToolExecutionContext = { turn: { turnId: 't', key: 'k', chatId: 'c', threadId: null, initiatorUserId: 'u', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config: {} }, workspace: '.', agentKind: 'main' };
    expect(registry.activeNames('limited', context)).toEqual([]);
    expect(registry.activeNames('trusted', context)).toEqual(['mcp__fixture__echo']);
    expect(await tools[0]!.call({ text: 'hello' })).toMatchObject({ content: [{ type: 'text', text: 'hello' }] });
    expect(db.prepare("SELECT state FROM mcp_servers WHERE name='fixture'").pluck().get()).toBe('up');
    // 入参 schema 必须真的接上：换成 z.record(z.unknown()) 之后模型只能靠工具名猜参数，
    // 猜错了 execute() 的 safeParse 也不拦，错误参数直接送到 MCP server（docs/20 · W-MCP-01）。
    expect(await registry.execute('mcp__fixture__echo', { wrong: 1 }, context)).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await registry.execute('mcp__fixture__echo', { text: 'hello' }, context)).toMatchObject({ ok: true });
    await manager.close(); closeDatabase(db);
  });

  // 从配置里移除或停用的 server 必须断开：只 unregister 工具的话 stdio 子进程会一直挂着，
  // 而下一次 reconcile 又会把它当成「已连接」复用（docs/20 · W-MCP-01 / W-CFG-02）。
  it('reads servers from a getter and disconnects the ones that disappear', async () => {
    const database = './data/mcp-reconcile.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    const db = openDatabase(database); migrateDatabase(db);
    const log = new LogSink(new OperationsRepository(db), './data/mcp-runtime-logs');
    const server = { name: 'fixture', transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-server.mjs')], enabled: true };
    let live = configSchema.parse({ access: { bootstrapOwnerId: '1' }, mcp: { enabled: true, servers: [server] } }).mcp;
    const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 80, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
    const manager = new McpManager(db, () => live, log, registry);
    await manager.reconcile();
    expect(registry.names()).toEqual(['mcp__fixture__echo']);
    live = configSchema.parse({ access: { bootstrapOwnerId: '1' }, mcp: { enabled: true, servers: [{ ...server, enabled: false }] } }).mcp;
    await manager.reconcile();
    expect(registry.names()).toEqual([]);
    expect(db.prepare("SELECT state FROM mcp_servers WHERE name='fixture'").pluck().get()).toBe('disabled');
    await manager.close(); closeDatabase(db);
  });

  /**
   * `#clients` 只比连接参数指纹的话，子进程死后那条缓存永远命中：`discover()` 拿死 client 调
   * `listTools()` 必抛，catch 只写 `state='down'`，于是 `mcp-health` cron 与
   * `/api/mcp/:name/reconnect` 是同一条死路 —— 一个新子进程都不会起（docs/28 · L-EXT-02）。
   */
  it('kill 掉 stdio 子进程之后，下一次 reconcile 真的重连', async () => {
    const { db, spawnLog, registry, manager } = harness('liveness', [{ name: 'probe' }]);
    await manager.reconcile();
    expect(registry.names()).toEqual(['mcp__probe__echo']);
    const [first] = spawnedPids(spawnLog);
    process.kill(first!, 'SIGKILL');
    await waitUntil(() => !alive(first!));
    await sleep(50); // 让 transport 的 onclose（子进程 'close' 事件）派发到位
    await manager.reconcile();
    expect(spawnedPids(spawnLog)).toHaveLength(2);
    expect(db.prepare("SELECT state FROM mcp_servers WHERE name='probe'").pluck().get()).toBe('up');
    expect(registry.names()).toEqual(['mcp__probe__echo']);
    await manager.close(); closeDatabase(db);
  });

  /**
   * 一次 `mcp.servers` 写入会触发两条重叠的 reconcile（端点自己 await 一条 + `config.changed`
   * 的订阅者一条），两条都在 `connect()` 里看到空位、各 spawn 一个子进程，而 `#clients` 只留住
   * 后来的那个 —— 泄漏的那个 refed handle 让进程退不出去（docs/28 · L-EXT-03）。
   */
  it('并发的 reconcile 只 spawn 一个子进程', async () => {
    const { db, spawnLog, registry, manager } = harness('serialize', [{ name: 'probe' }]);
    await Promise.all([manager.reconcile(), manager.reconcile(), manager.reconcile()]);
    expect(spawnedPids(spawnLog)).toHaveLength(1);
    expect(registry.names()).toEqual(['mcp__probe__echo']);
    await manager.close(); closeDatabase(db);
  });

  /** 握手超时的那台从没进过 `#clients`：`close()` 只遍历 `#clients` 的话，它的子进程留到进程
   *  结束都还在，而 `shutdown()` 只设 `process.exitCode` —— event loop 不空就是不退（docs/28 · L-EXT-03）。 */
  it('close() 收掉不在 #clients 里的那些 transport', async () => {
    const { db, spawnLog, manager } = harness('orphan', [{ name: 'probe' }, { name: 'stuck', hang: true }], 600);
    await manager.reconcile();
    expect(db.prepare("SELECT state FROM mcp_servers WHERE name='stuck'").pluck().get()).toBe('down');
    const pids = spawnedPids(spawnLog);
    expect(pids).toHaveLength(2);
    await manager.close();
    expect(pids.filter((pid) => alive(pid))).toEqual([]);
    closeDatabase(db);
  });

  /** 先 `unregisterBySource('mcp')` 再逐台串行 await 的话，每台最长 `connectTimeoutMs` 的那段
   *  窗口里模型的工具目录一个 MCP 工具都没有，而 `mcp.healthCheckCron` 默认 5 分钟开一次
   *  （docs/28 · L-EXT-05）。 */
  it('reconcile 期间已注册的 MCP 工具不消失', async () => {
    const { db, registry, manager } = harness('window', [{ name: 'stuck', hang: true }, { name: 'probe' }], 900);
    await manager.reconcile();
    expect(registry.names()).toEqual(['mcp__probe__echo']);
    const second = manager.reconcile();
    await sleep(300); // 仍卡在 stuck 的握手里
    expect(registry.names()).toEqual(['mcp__probe__echo']);
    await second;
    expect(registry.names()).toEqual(['mcp__probe__echo']);
    await manager.close(); closeDatabase(db);
  });
});
