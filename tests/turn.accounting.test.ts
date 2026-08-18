import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LogSink, ToolRegistry } from '@luoli/core';
import { OperationsRepository, TurnRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { z } from 'zod';

/**
 * 回归：`turns.steps` 从头就没有写入方，`TurnRepository.incrementToolCall` 从头就没有调用者 ——
 * 全库 `select count(*) from turns where steps>0 or tool_calls>0` 是 0，而 `model_calls` 正常累加。
 * WebUI 轮次列表与 `turn.finished` 事件里这两个数一直是假的，排查多步轮次只能去翻 blob。
 */
function open(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state) VALUES ('turn','chat:1','1','1','owner','running')`).run();
  return { db, path };
}

describe('turn accounting', () => {
  it('records the main agent step count monotonically', () => {
    const { db } = open('turn-accounting-steps');
    const turns = new TurnRepository(db);
    for (const step of [1, 2, 3]) turns.countStep('turn', step);
    expect((db.prepare('SELECT steps FROM turns WHERE id=?').get('turn') as { steps: number }).steps).toBe(3);
    // 收尾补跑会再走一次 `onStepEnd`，它的 stepNumber 从 0 重新起 —— MAX 之外的写法会把 3 改回 1。
    turns.countStep('turn', 1);
    expect((db.prepare('SELECT steps FROM turns WHERE id=?').get('turn') as { steps: number }).steps).toBe(3);
    closeDatabase(db);
  });

  it('counts executed tool calls but not rejected ones', async () => {
    const { db } = open('turn-accounting-tools');
    const turns = new TurnRepository(db);
    const log = new LogSink(new OperationsRepository(db), './data/turn-accounting-logs');
    const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 5 }, [], undefined, turns);
    registry.register({ name: 'echo', description: 'echo', inputSchema: z.object({ value: z.string() }),
      policy: { minRole: 'limited', approval: 'never', scope: 'workspace', source: 'builtin' }, sourcePriority: 1, execute: (input) => ({ ok: true, value: input.value }) });
    const context = { turn: { turnId: 'turn', chatId: '1', initiatorUserId: '1', key: 'chat:1', effectiveRole: 'owner', config: {} }, workspace: '/tmp', agentKind: 'main' } as never;
    const count = (): number => (db.prepare('SELECT tool_calls AS calls FROM turns WHERE id=?').get('turn') as { calls: number }).calls;

    await registry.execute('echo', { value: 'hi' }, context);
    expect(count()).toBe(1);
    // 参数不合法在 `admit` 之后、执行之前就返回，不算「调用过工具」—— 数进去的话轮次统计会比
    // 模型真正做过的事多出一截。
    await registry.execute('echo', { value: 42 }, context);
    expect(count()).toBe(1);
    // 工具压根不存在同理。
    await registry.execute('nope', {}, context);
    expect(count()).toBe(1);
    await registry.execute('echo', { value: 'again' }, context);
    expect(count()).toBe(2);
    closeDatabase(db);
  });
});
