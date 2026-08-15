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
    const config = configSchema.parse({ access: { bootstrapOwnerId: 'owner' }, mcp: { enabled: true, servers: [{ name: 'fixture', transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-server.mjs')], enabled: true, toolAllow: ['echo'] }] } });
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
    await manager.close(); closeDatabase(db);
  });
});
