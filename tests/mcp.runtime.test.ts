import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase, OperationsRepository } from '@luoli/db';
import { LogSink, McpManager, ToolRegistry, configSchema } from '@luoli/core';
import type { ToolExecutionContext } from '@luoli/core';

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
});
