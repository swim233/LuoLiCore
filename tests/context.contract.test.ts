import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolLoopAgent } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { ArchiveRepository, ContextRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, configSchema, contextMessages } from '@luoli/core';
import type { Config } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 跨边界契约：**引擎产出的上下文必须能被 AI SDK 收下**。
 *
 * 四轮以来上下文引擎的不变量越做越细，但那些不变量是我们自己定义的（part type 白名单、
 * tool-call 配对），而 role 只能是 user/assistant/tool 这条规则在 AI SDK 的 `standardizePrompt` 里
 * ——`assertValidShape` 对它一个字都没说，于是一次 `load_skill` 就能让该会话此后每轮都被
 * provider 拒收（docs/20 · W-CTX-01）。这里的每个场景都真的跨过「我们的代码 → 外部库」那一跳。
 */
function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  return { db, archive, engine: new ContextEngine(db, archive) };
}

const baseConfig = configSchema.parse({
  general: { timezone: 'UTC' },
  context: { scope: 'chat', background: { enabled: true, maxPerTurn: 20 }, rebase: { injectNotice: false }, limit: { tokens: 32_000, maxMessages: 200, minKeepTurns: 1 } },
});

function withConfig(patch: Partial<Config['context']>): Config {
  return configSchema.parse({ ...baseConfig, context: { ...baseConfig.context, ...patch } });
}

function append(archive: ArchiveRepository, id: number, text: string, triggered: boolean) {
  return archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: id, direction: 'in', fromKind: 'user',
    fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text, tgDate: Date.now(), raw: {}, triggered, triggerReason: triggered ? 'mention' : null });
}

async function openTurn(engine: ContextEngine, archive: ArchiveRepository, id: number, config: Config = baseConfig): Promise<RuntimeTurnContext> {
  return engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user', effectiveRole: 'trusted',
    isPrivate: false, trigger: append(archive, id, `turn ${id}`, true), abortSignal: new AbortController().signal, config });
}

const mock = new MockLanguageModelV4({
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }),
});

/** 唯一的断言点：AI SDK 收得下。它自己会跑 standardizePrompt，形状不对就抛 InvalidPromptError。 */
async function accepted(turn: RuntimeTurnContext): Promise<string> {
  const agent = new ToolLoopAgent({ model: mock, instructions: 'system prompt lives here' });
  const result = await agent.generate({ messages: contextMessages(turn) });
  return result.text;
}

describe('context → AI SDK contract', () => {
  it('accepts a plain text turn', async () => {
    const { db, archive, engine } = harness('contract-plain');
    await expect(accepted(await openTurn(engine, archive, 1))).resolves.toBe('ok');
    closeDatabase(db);
  });

  it('accepts a turn that already contains tool calls and results', async () => {
    const { db, archive, engine } = harness('contract-tools');
    const first = await openTurn(engine, archive, 1);
    engine.appendDelta(first, { id: 'call', role: 'assistant', origin: 'tool_call', parts: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'x' } }], pruneLevel: 2 });
    engine.appendDelta(first, { id: 'result', role: 'tool', origin: 'tool_result', parts: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'json', value: { ok: true } } }], pruneLevel: 1 });
    engine.appendDelta(first, { id: 'answer', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'done' }] });
    await engine.commitTurn(first);
    await expect(accepted(await openTurn(engine, archive, 2))).resolves.toBe('ok');
    closeDatabase(db);
  });

  // load_skill 把 skill 正文作为旁白写进 delta，而且会被提交进库、在之后每一轮重放。
  it('accepts a skill note appended mid-turn and replayed next turn', async () => {
    const { db, archive, engine } = harness('contract-skill');
    const first = await openTurn(engine, archive, 1);
    engine.appendDelta(first, { id: 'note', role: 'user', origin: 'note', parts: [{ type: 'text', text: '（skill 正文）' }], textPreview: 'Skill x', pruneLevel: 2 });
    engine.appendDelta(first, { id: 'answer', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'done' }] });
    await expect(accepted(first)).resolves.toBe('ok');
    await engine.commitTurn(first);
    const second = await openTurn(engine, archive, 2);
    expect(second.snapshot.messages.some((message) => message.origin === 'note')).toBe(true);
    await expect(accepted(second)).resolves.toBe('ok');
    closeDatabase(db);
  });

  // 群聊积压超过 maxPerTurn 时引擎会插一条「省略了 N 条」的旁白。它以前是 role:'system'，
  // 当轮就被 provider 拒收，而失败 → abortTurn → 重新变成未认领 → 下一轮再插一次：自锁循环。
  it('accepts the omitted-background note', async () => {
    const { db, archive, engine } = harness('contract-omitted');
    for (let index = 0; index < 5; index += 1) append(archive, 100 + index, `背景 ${index}`, false);
    const turn = await openTurn(engine, archive, 1, withConfig({ background: { enabled: true, maxPerTurn: 2 } } as Partial<Config['context']>));
    expect(turn.delta.some((message) => message.origin === 'note')).toBe(true);
    expect(turn.delta.every((message) => message.role !== 'system' as never)).toBe(true);
    await expect(accepted(turn)).resolves.toBe('ok');
    closeDatabase(db);
  });

  // 在途轮次期间 /new：提交时走 baseInvalid 分支，无条件插一条重置说明（不受 injectNotice 控制）。
  it('accepts the context-reset note produced by /new during an in-flight turn', async () => {
    const { db, archive, engine } = harness('contract-reset');
    const first = await openTurn(engine, archive, 1);
    engine.appendDelta(first, { id: 'a', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'A' }] });
    await engine.commitTurn(first);
    const second = await openTurn(engine, archive, 2);
    engine.reset('chat:chat', 'test');
    engine.appendDelta(second, { id: 'b', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'B' }] });
    await engine.commitTurn(second);
    const rows = new ContextRepository(db, 'chat:chat').messagesThrough(100);
    expect(rows.some((row) => row.origin === 'note')).toBe(true);
    expect(rows.every((row) => row.role !== 'system' as never)).toBe(true);
    await expect(accepted(await openTurn(engine, archive, 3))).resolves.toBe('ok');
    closeDatabase(db);
  });

  it('accepts the rebase notice when context.rebase.injectNotice is on', async () => {
    const { db, archive, engine } = harness('contract-rebase');
    const config = withConfig({ rebase: { injectNotice: true } } as Partial<Config['context']>);
    const first = await openTurn(engine, archive, 1, config);
    const second = await openTurn(engine, archive, 2, config);
    engine.appendDelta(second, { id: 'b', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'B' }] });
    await engine.commitTurn(second);
    engine.appendDelta(first, { id: 'a', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'A' }] });
    await engine.commitTurn(first);
    await expect(accepted(await openTurn(engine, archive, 3, config))).resolves.toBe('ok');
    closeDatabase(db);
  });

  // 分级降级会把 tool-call 的 input 与 tool-result 的 output 换成占位；判别字段必须完好，
  // 否则整个 prompt 过不了 ModelMessage 校验，而降级结果是持久化的。
  it('accepts a context that has been pruned and downgraded', async () => {
    const { db, archive, engine } = harness('contract-pruned');
    const tight = withConfig({ limit: { tokens: 4000, maxMessages: 3, minKeepTurns: 1 } } as Partial<Config['context']>);
    for (let index = 1; index <= 4; index += 1) {
      const turn = await openTurn(engine, archive, index, tight);
      engine.appendDelta(turn, { id: `call-${index}`, role: 'assistant', origin: 'tool_call', parts: [{ type: 'tool-call', toolCallId: `c${index}`, toolName: 'grep', input: { pattern: 'x'.repeat(400) } }], pruneLevel: 2 });
      engine.appendDelta(turn, { id: `res-${index}`, role: 'tool', origin: 'tool_result', parts: [{ type: 'tool-result', toolCallId: `c${index}`, toolName: 'grep', output: { type: 'text', value: 'y'.repeat(400) } }], pruneLevel: 1 });
      engine.appendDelta(turn, { id: `ans-${index}`, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'z'.repeat(400) }] });
      await engine.commitTurn(turn);
    }
    await expect(accepted(await openTurn(engine, archive, 9, tight))).resolves.toBe('ok');
    closeDatabase(db);
  });

  it('accepts image parts after a hard truncation pass', async () => {
    const { db, archive, engine } = harness('contract-image');
    const tiny = withConfig({ limit: { tokens: 4000, maxMessages: 2, minKeepTurns: 1 } } as Partial<Config['context']>);
    const first = await openTurn(engine, archive, 1, tiny);
    engine.appendDelta(first, { id: 'img', role: 'user', origin: 'trigger', parts: [{ type: 'text', text: '看这张图' }, { type: 'image', image: 'AAAA'.repeat(500), mediaType: 'image/jpeg' }] });
    engine.appendDelta(first, { id: 'a', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'w'.repeat(4000) }] });
    await engine.commitTurn(first);
    const second = await openTurn(engine, archive, 2, tiny);
    engine.appendDelta(second, { id: 'b', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'v'.repeat(4000) }] });
    await engine.commitTurn(second);
    await expect(accepted(await openTurn(engine, archive, 3, tiny))).resolves.toBe('ok');
    closeDatabase(db);
  });

  // 缓存断点现在落在两处：`instructions` 里那条 system（静态）与已提交历史最后一条消息上的
  // `providerOptions`（移动）。后者是新的跨边界假设 —— AI SDK 收不收 ModelMessage 上的
  // providerOptions、会不会在 standardizePrompt 里把它丢掉、会不会把两条相邻 user 合并成一条
  // （合并就等于易变段被塞进用户那句话里），只有真的跨过这一跳才知道。
  it('keeps the trailing volatile message and per-message cache breakpoints intact', async () => {
    const seen: Array<{ role: string; content: unknown; providerOptions?: unknown }> = [];
    const capturing = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(...options.prompt as unknown as Array<{ role: string; content: unknown }>);
        return { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
      },
    });
    const ephemeral = { anthropic: { cacheControl: { type: 'ephemeral' } } };
    const agent = new ToolLoopAgent({ model: capturing, instructions: [{ role: 'system', content: '稳定段', providerOptions: ephemeral }] });
    await agent.generate({ messages: [
      { role: 'user', content: [{ type: 'text', text: '已提交历史' }], providerOptions: ephemeral },
      { role: 'user', content: [{ type: 'text', text: '本轮触发消息' }] },
      { role: 'user', content: [{ type: 'text', text: '<system-instructions id="0123456789ab">\n易变段\n</system-instructions id="0123456789ab">' }] },
    ] });
    const system = seen.filter((message) => message.role === 'system');
    expect(system.map((message) => message.content)).toEqual(['稳定段']);
    expect(system[0]!.providerOptions).toMatchObject(ephemeral);
    const users = seen.filter((message) => message.role === 'user');
    expect(users).toHaveLength(3);
    expect(users[0]!.providerOptions).toMatchObject(ephemeral);
    expect(users[1]!.providerOptions).toBeUndefined();
    expect((users.at(-1)!.content as Array<{ text: string }>)[0]!.text).toContain('</system-instructions id="0123456789ab">');
  });

  // 兜底那一层：库里已经有 role='system' 的历史行时（0006 迁移之前写入的），读出侧仍要能发出去。
  it('downgrades legacy system rows instead of letting the provider reject the turn', async () => {
    const { db, archive, engine } = harness('contract-legacy');
    const first = await openTurn(engine, archive, 1);
    engine.appendDelta(first, { id: 'note', role: 'user', origin: 'note', parts: [{ type: 'text', text: '历史旁白' }] });
    engine.appendDelta(first, { id: 'a', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'A' }] });
    await engine.commitTurn(first);
    db.prepare("UPDATE context_messages SET role='system' WHERE id='note'").run();
    const stored = new ContextRepository(db, 'chat:chat').messagesThrough(100);
    const legacy = { ...first, snapshot: { ...first.snapshot, messages: stored }, delta: [] } as RuntimeTurnContext;
    expect(contextMessages(legacy).every((message) => message.role !== 'system')).toBe(true);
    await expect(accepted(legacy)).resolves.toBe('ok');
    closeDatabase(db);
  });
});
