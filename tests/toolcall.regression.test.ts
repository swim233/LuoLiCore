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

  /**
   * 读出侧自愈：**没有配对结果的 tool-call 现补一条**。
   *
   * provider 见到这种形状会拒收整个请求（中转站的表现是 200 + 0 步 → AI SDK 在 flush 里用
   * `NoOutputGeneratedError` reject `result.text`），而 parts 是持久化的 —— 不在读出侧兜，
   * 该会话在 `/new` 之前每轮都失败。实测 logs/2026-08-18 两次进程崩溃：起因是一个
   * `tool-error` 部件没被追进 delta，ordinal 508 那条孤儿至今还在库里。
   * 写入侧的 `assertPairedToolCalls` 只管「不再产生新的」，已经落库的只能在这里救。
   */
  it('没有配对结果的 tool-call 在读出侧被补上一条 error-text 结果', () => {
    const turn = { snapshot: { messages: [
      { role: 'assistant', parts: [{ type: 'tool-call', toolCallId: 'orphan-1', toolName: 'get_message', input: { messageId: 0 } }] },
      { role: 'assistant', parts: [{ type: 'text', text: '看看这个' }] },
    ], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 2 }, delta: [] } as unknown as RuntimeTurnContext;
    const reported: string[][] = [];
    const messages = contextMessages(turn, undefined, { onOrphanToolCalls: (ids) => reported.push(ids) });
    expect(reported).toEqual([['orphan-1']]);
    // 补出来的那条紧跟在孤儿后面，整份 prompt 过得了 ModelMessage 校验。
    expect(messages).toHaveLength(3);
    expect(messages[1]!.role).toBe('tool');
    for (const message of messages) expect(modelMessageSchema.safeParse(message).success).toBe(true);
    const part = (messages[1]!.content as Array<Record<string, unknown>>)[0]!;
    expect(part).toMatchObject({ type: 'tool-result', toolCallId: 'orphan-1', toolName: 'get_message' });
    // 不伪造成功，只如实说结果没了（照 `hydrateAttachment` 的占位先例）。
    expect(part.output).toEqual({ type: 'error-text', value: '[工具结果缺失：这次调用的结果没有被记录下来]' });
  });

  it('配对齐全时一条都不补，也不报', () => {
    const turn = { snapshot: { messages: [
      { role: 'assistant', parts: [{ type: 'tool-call', toolCallId: 'c-1', toolName: 'search_messages', input: { query: 'x' } }] },
      { role: 'tool', parts: [{ type: 'tool-result', toolCallId: 'c-1', toolName: 'search_messages', output: { type: 'json', value: { ok: true } } }] },
    ], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 2 }, delta: [] } as unknown as RuntimeTurnContext;
    let reported = 0;
    expect(contextMessages(turn, undefined, { onOrphanToolCalls: () => { reported += 1; } })).toHaveLength(2);
    expect(reported).toBe(0);
  });

  // 补出来的那条会把下标顶开一位：Anthropic 的移动缓存断点必须跟着走，否则打在孤儿的补丁上
  // （或者干脆越界），整段前缀缓存作废。
  it('补出来的结果不会把移动缓存断点打错位置', () => {
    const turn = { snapshot: { messages: [
      { role: 'assistant', parts: [{ type: 'tool-call', toolCallId: 'orphan-1', toolName: 'x', input: {} }] },
      { role: 'assistant', parts: [{ type: 'text', text: '上一轮回答' }] },
    ], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 2 },
    delta: [{ role: 'user', parts: [{ type: 'text', text: '本轮' }] }] } as unknown as RuntimeTurnContext;
    const messages = contextMessages(turn, undefined, { cacheBreakpoint: true });
    const marked = messages.filter((message) => JSON.stringify((message as { providerOptions?: unknown }).providerOptions ?? {}).includes('cacheControl'));
    expect(marked).toHaveLength(1);
    expect((marked[0]!.content as Array<{ text?: string }>)[0]!.text).toBe('上一轮回答');
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
    expect(archiveQuery('名字|我是|叫|谁')).toEqual({ like: '%名字%', dropped: ['我是', '叫', '谁'] });
    expect(archiveQuery('洛璃早上好')).toEqual({ fts: '"洛璃早上好"', dropped: [] });
    expect(archiveQuery('hello world')).toEqual({ fts: '"hello" OR "world"', dropped: [] });
    expect(archiveQuery('"unclosed')).toEqual({ fts: '"unclosed"', dropped: [] });
    expect(archiveQuery('洛璃')).toEqual({ like: '%洛璃%', dropped: [] });
  });

  /**
   * 混合查询里 <3 码点的词被整体丢弃 —— **丢弃本身是对的**（trigram 索引匹配不了它们，
   * `MATCH` 恒 0 命中），错的是不说：`search_messages("名字 李小明")` 只按 `李小明` 检索过，
   * 而模型据此判定「没有这回事」（docs/28 · L-DB-01）。
   */
  it('混合查询丢掉的短词进 dropped，判别式仍然是 fts / like', () => {
    const mixed = archiveQuery('名字 李小明');
    expect(mixed).toEqual({ fts: '"李小明"', dropped: ['名字'] });
    // 加字段不能破坏三个调用点共用的 `'like' in parsed`。
    expect('like' in mixed).toBe(false);
    expect('like' in archiveQuery('名字')).toBe(true);
    // 单独查那个短词时它就是全场最长的词，会走 LIKE 兜底 —— 这正是 note 让模型去做的事。
    expect(archiveQuery('名字')).toEqual({ like: '%名字%', dropped: [] });
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
    // 混合查询：长词命中，短词一条都不参与（trigram 上它 MATCH 不出东西）——「丢弃是正确降级」
    // 这一半在这里被钉住，`dropped` 那一半负责让调用方能说出来（docs/28 · L-DB-01）。
    expect(scoped.search('名字 洛璃早上好', 10).map((row) => row.text)).toEqual(['洛璃早上好哦']);
    expect(archiveQuery('名字 洛璃早上好').dropped).toEqual(['名字']);
    // 而单独查它走 LIKE，是有命中的 —— 所以那句「单独查一次」不是空话。
    expect(scoped.search('名字', 10).map((row) => row.text)).toEqual(['我的名字是阿离']);
    closeDatabase(db);
  });
});
