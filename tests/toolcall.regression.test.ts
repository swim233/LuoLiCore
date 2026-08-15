import { rmSync } from 'node:fs';
import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, archiveQuery, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { contextMessages, normalizeToolOutput, toolResultPart } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/** contextMessages 只读 snapshot/delta 两个字段，其余字段给到能过类型即可。 */
function turnWith(parts: unknown[]): RuntimeTurnContext {
  return { snapshot: { messages: [{ role: 'user', parts: [{ type: 'text', text: '你知道我是谁嘛' }] }, { role: 'tool', parts }], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 2 }, delta: [] } as unknown as RuntimeTurnContext;
}
const call = { type: 'tool-call', toolCallId: 'c-1', toolName: 'search_messages', input: { query: 'x' } };

describe('tool-result 形状', () => {
  // 裸对象过不了 ModelMessage 校验 → 整个 prompt 被拒 → AI SDK 在流的 flush 里抛出无人接管的
  // NoOutputGeneratedError，直接带走进程。所以「调过一次工具的会话第二轮必崩」。
  it('落库的 tool-result 必须是 SDK 认的带类型 output', () => {
    const legacy = { type: 'tool-result', toolCallId: 'c-1', toolName: 'search_messages', output: { ok: false, error: 'fts5: syntax error near "|"' } };
    expect(modelMessageSchema.safeParse({ role: 'tool', content: [legacy] }).success).toBe(false);
    const fixed = toolResultPart('c-1', 'search_messages', { ok: false, error: 'fts5: syntax error near "|"' });
    expect(fixed.output).toEqual({ type: 'json', value: { ok: false, error: 'fts5: syntax error near "|"' } });
    expect(modelMessageSchema.safeParse({ role: 'tool', content: [fixed] }).success).toBe(true);
  });

  it('已经写进库的裸 output 在读出侧被补齐，老会话不必 /new', () => {
    const legacy = { type: 'tool-result', toolCallId: 'c-1', toolName: 'search_messages', output: { ok: true, messages: [] } };
    const [, toolMessage] = contextMessages(turnWith([legacy]));
    expect(modelMessageSchema.safeParse(toolMessage).success).toBe(true);
    const part = (toolMessage!.content as Array<Record<string, unknown>>)[0]!;
    // 判别字段一个都不能动（docs/02 不变量），只补 output。
    expect(part).toMatchObject({ type: 'tool-result', toolCallId: 'c-1', toolName: 'search_messages' });
    expect(part.output).toEqual({ type: 'json', value: { ok: true, messages: [] } });
  });

  it('已经是带类型形状的 output 原样保留，不会被套两层', () => {
    const elided = { type: 'tool-result', toolCallId: 'c-1', toolName: 'search_messages', output: { type: 'text', value: '[已省略工具结果]' } };
    expect(normalizeToolOutput(elided.output)).toEqual({ type: 'text', value: '[已省略工具结果]' });
    const [, toolMessage] = contextMessages(turnWith([elided]));
    expect((toolMessage!.content as Array<Record<string, unknown>>)[0]!.output).toEqual({ type: 'text', value: '[已省略工具结果]' });
  });

  it('tool-call 与 text 部件不受影响', () => {
    const [userMessage] = contextMessages(turnWith([call]));
    expect(userMessage!.content).toEqual([{ type: 'text', text: '你知道我是谁嘛' }]);
    const [, toolMessage] = contextMessages(turnWith([call]));
    expect((toolMessage!.content as unknown[])[0]).toEqual(call);
  });
});

describe('归档检索的 FTS5 查询串', () => {
  it('把模型写的运算符切成词，而不是塞进 MATCH 里报语法错', () => {
    expect(archiveQuery('名字|我是|叫|谁')).toEqual({ like: '%名字%' });
    expect(archiveQuery('洛璃早上好')).toEqual({ fts: '"洛璃早上好"' });
    expect(archiveQuery('hello world')).toEqual({ fts: '"hello" OR "world"' });
    expect(archiveQuery('"unclosed')).toEqual({ fts: '"unclosed"' });
    expect(archiveQuery('洛璃')).toEqual({ like: '%洛璃%' });
  });

  it('对真实的 FTS 表跑一遍，敌意查询不再抛 SQLite 错', () => {
    const path = './data/fts.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    const scoped = new ArchiveRepository(db).scope('chat-1', null);
    for (const [index, text] of ['我的名字是阿离', '洛璃早上好哦', 'hello world'].entries()) {
      scoped.append({ chatId: 'chat-1', messageThreadId: null, tgMessageId: 10 + index, direction: 'in', fromKind: 'user', fromUserId: '7',
        fromName: '阿离', fromUsername: null, kind: 'text', text, tgDate: 1_700_000_000_000 + index, raw: {}, triggered: true, triggerReason: 'private' });
    }
    for (const hostile of ['名字|我是|叫|谁', 'NEAR(a b)', '"unclosed', 'a* OR (b', '***', '^^^']) {
      expect(() => scoped.search(hostile, 10), hostile).not.toThrow();
      expect(() => new ArchiveRepository(db).adminSearchAll(hostile, 10), hostile).not.toThrow();
    }
    expect(scoped.search('名字|我是|叫|谁', 10).map((row) => row.text)).toEqual(['我的名字是阿离']);
    expect(scoped.search('洛璃早上好', 10).map((row) => row.text)).toEqual(['洛璃早上好哦']);
    closeDatabase(db);
  });
});
