import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Bot } from 'grammy';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, MemoryStore, QuotaGuard, TurnConcurrency, TurnRegistry, configSchema } from '@luoli/core';
import { createTelegramBot } from '@luoli/telegram';

/**
 * 回归：**流吐过内容之后才断掉的轮次，此前会以 `committed` 收尾。**
 *
 * 步骤级失败与 `turnTimeoutMs` 到点的 abort 都不会让 `result.stream` 抛（AI SDK 把它们吞进内部
 * onError，流照常正常结束），于是投递侧看不出这一轮是断的：用户没有「（生成中断）」也没有超时提示，
 * `turns` 那行记成 committed，`consecutiveFailures` 还被清零。实测 logs/2026-08-18 · B8F92Z：
 * 19:03:03 开轮 → 19:13:03 `model.error timeout`（600 秒到点）→ 19:16:04 `turn.end turn committed`。
 *
 * 现在 runtime 在这两种情况下让流抛出去（= 投递侧的 `interrupted`），而这里断言 `bot.ts` 那一侧的账：
 * **delta 照常提交、状态不许是 committed** —— docs/04 §5.3 点名的「§1 delta 不提交规则的唯一例外」。
 */

const botInfo = { id: 1, is_bot: true as const, first_name: 'Bot', username: 'mybot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };

const privateUpdate = (id: number, text: string): never => ({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000),
  chat: { id: 500, type: 'private', first_name: 'User' }, from: { id: 500, is_bot: false, first_name: 'User' }, text } }) as never;

interface Fixture { bot: Bot; db: ReturnType<typeof openDatabase>; registry: TurnRegistry; sent: string[];
  calls: Array<{ method: string; payload: Record<string, unknown> }>; alerts: Array<{ kind: string; count: unknown }> }

/** `onTurn` 拿到 turn 之后由用例决定这条流怎么结束（`final` 缺省时按「最后一步没有正文」处理）。 */
type StreamMaker = (turn: { turnId: string; abortSignal: AbortSignal }, registry: TurnRegistry) => { stream: AsyncIterable<string>; final?: Promise<string> };

async function fixture(name: string, makeStream: StreamMaker, patch: Record<string, unknown> = {}): Promise<Fixture> {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/${name}-memory`, { recursive: true, force: true });
  rmSync(`./data/${name}-logs`, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  // `once` 档：consume 不做流式编辑，收尾一次性 send —— 「（生成中断）」那个后缀两档共用一份代码。
  const config = configSchema.parse({ access: { defaultUserRole: 'trusted', defaultChatRole: 'trusted', bootstrapOwnerId: '1' },
    quota: { enabled: false }, output: { mode: 'once', replyDelayMs: 0 }, ...patch });
  const archive = new ArchiveRepository(db);
  const operations = new OperationsRepository(db);
  const registry = new TurnRegistry();
  const sent: string[] = [];
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const alerts: Array<{ kind: string; count: unknown }> = [];
  const bot = await createTelegramBot('12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {
    config, db, principals: new PrincipalRepository(db), archive, operations, context: new ContextEngine(db, archive), turns: new TurnRepository(db),
    quota: new QuotaGuard(db, 'UTC'), memory: new MemoryStore(db, `./data/${name}-memory`, 1500, 3000),
    registry, concurrency: new TurnConcurrency(config.concurrency),
    log: new LogSink(operations, `./data/${name}-logs`), botInfo,
    alerts: { fire: (kind, _summary, data) => { alerts.push({ kind, count: (data as { count?: unknown } | undefined)?.count }); } },
    onTurn: async (turn) => {
      const made = makeStream(turn, registry);
      const final = made.final ?? Promise.resolve('');
      void final.catch(() => undefined);
      return { stream: made.stream, final, interrupt: () => undefined };
    },
  });
  bot.api.config.use((async (_prev: unknown, method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === 'sendMessage') sent.push(String(payload.text));
    return { ok: true, result: method === 'sendMessage' || method === 'editMessageText'
      ? { message_id: 900 + sent.length, date: 0, chat: { id: 500, type: 'private' }, text: String(payload.text ?? '') } : true };
  }) as never);
  return { bot, db, registry, sent, calls, alerts };
}

const turnRow = (db: ReturnType<typeof openDatabase>): { state: string; cancel_reason: string | null; error: string | null; commit_id: string | null } =>
  db.prepare('SELECT state,cancel_reason,error,commit_id FROM turns').get() as never;
const committedAssistantText = (db: ReturnType<typeof openDatabase>): string[] =>
  db.prepare("SELECT text_preview FROM context_messages WHERE role='assistant' AND ordinal IS NOT NULL").pluck().all() as string[];
const turnEndLog = (db: ReturnType<typeof openDatabase>): { level: string; summary: string } =>
  db.prepare("SELECT level,summary FROM log_events WHERE kind='turn.end'").get() as never;

describe('吐过内容之后断掉的轮次', () => {
  /**
   * **超时不是取消**（docs/04 §5.3 的三档）。判据只看 `abortSignal.aborted` 的那一版把
   * `turnTimeoutMs` 和 `/cancel` 归成一类，于是超时的轮次记 `cancelled` 并被 `noteFailure` 跳过
   * —— 「每一轮都卡满十分钟」这种最该响的故障一次告警都不响（logs/2026-08-18：三十来轮全 cancelled）。
   */
  it('turnTimeoutMs 到点：内容留下、delta 照常提交，轮次记 failed', async () => {
    const bed = await fixture('partial-timeout', (turn, registry) => ({ stream: (async function* () {
      yield '先查一下数据库。';
      // `TurnRegistry` 那条 setTimeout 干的就是这件事（reason 恒为 'timeout'）。
      registry.cancel(turn.turnId, '500', 'owner', 'timeout');
      throw turn.abortSignal.reason instanceof Error ? turn.abortSignal.reason : new Error(String(turn.abortSignal.reason));
    })() }));
    await bed.bot.handleUpdate(privateUpdate(1, '帮我查个东西'));
    expect(bed.sent).toEqual(['先查一下数据库。\n\n（生成中断）']);
    // `cancel_reason` 仍记 timeout（是谁掐的），但状态是 failed 且 error 与「上游中途挂」分得开。
    expect(turnRow(bed.db)).toMatchObject({ state: 'failed', cancel_reason: 'timeout', error: 'turn_timeout' });
    // 提交照做（上下文必须与用户所见一致），而且那一行要指得着这次提交。
    expect(turnRow(bed.db).commit_id).toBeTruthy();
    expect(committedAssistantText(bed.db)).toEqual(['先查一下数据库。\n\n（生成中断）']);
    expect(turnEndLog(bed.db)).toEqual({ level: 'warn', summary: 'turn timed out after partial delivery' });
    closeDatabase(bed.db);
  }, 20_000);

  it('用户 /cancel：仍记 cancelled，且不计入连续失败', async () => {
    const bed = await fixture('partial-cancel', (turn, registry) => ({ stream: (async function* () {
      yield '在查了。';
      registry.cancel(turn.turnId, '500', 'owner');
      throw new Error(String(turn.abortSignal.reason));
    })() }));
    await bed.bot.handleUpdate(privateUpdate(1, '帮我查个东西'));
    expect(turnRow(bed.db)).toMatchObject({ state: 'cancelled', cancel_reason: 'user', error: null });
    expect(turnEndLog(bed.db)).toEqual({ level: 'warn', summary: 'turn cancelled after partial delivery' });
    closeDatabase(bed.db);
  }, 20_000);

  it('连续 5 轮超时会响 consecutive_turn_failures，连续 5 轮 /cancel 不会', async () => {
    const timedOut = await fixture('partial-alert-timeout', (turn, registry) => ({ stream: (async function* () {
      yield '在查。';
      registry.cancel(turn.turnId, '500', 'owner', 'timeout');
      throw new Error(String(turn.abortSignal.reason));
    })() }));
    for (let index = 1; index <= 5; index += 1) await timedOut.bot.handleUpdate(privateUpdate(index, '查一下'));
    expect(timedOut.alerts).toEqual([{ kind: 'consecutive_turn_failures', count: 5 }]);
    closeDatabase(timedOut.db);

    const cancelled = await fixture('partial-alert-cancel', (turn, registry) => ({ stream: (async function* () {
      yield '在查。';
      registry.cancel(turn.turnId, '500', 'owner');
      throw new Error(String(turn.abortSignal.reason));
    })() }));
    for (let index = 1; index <= 5; index += 1) await cancelled.bot.handleUpdate(privateUpdate(index, '查一下'));
    expect(cancelled.alerts).toEqual([]);
    closeDatabase(cancelled.db);
  }, 40_000);

  it('上游中途挂（没人取消）：记 failed 而不是 cancelled', async () => {
    const bed = await fixture('partial-failed', () => ({ stream: (async function* () {
      yield '好，我看看。';
      throw new Error('request_timeout_15000ms');
    })() }));
    await bed.bot.handleUpdate(privateUpdate(1, '帮我查个东西'));
    expect(bed.sent).toEqual(['好，我看看。\n\n（生成中断）']);
    expect(turnRow(bed.db)).toMatchObject({ state: 'failed', error: 'stream_interrupted', cancel_reason: null });
    expect(committedAssistantText(bed.db)).toEqual(['好，我看看。\n\n（生成中断）']);
    expect(turnEndLog(bed.db)).toEqual({ level: 'warn', summary: 'turn failed after partial delivery' });
    closeDatabase(bed.db);
  }, 20_000);

  // 一个字都没投出去的那一路：中断本身不是原因，原因在 `final` 那条链上。把它吞掉的话整轮会以
  // 含糊的 `model_returned_empty` 收尾 —— 正是 runtime 那份 `onExhausted` 要避免的事。
  it('一个字都没发出去时报的是真正的上游错误，不是「没吐出正文」', async () => {
    const bed = await fixture('partial-none', () => ({
      stream: (async function* () { throw new Error('request_timeout_15000ms'); })(),
      final: Promise.reject(new Error('request_timeout_15000ms')),
    }));
    await bed.bot.handleUpdate(privateUpdate(1, '帮我查个东西'));
    expect(turnRow(bed.db)).toMatchObject({ state: 'failed', cancel_reason: null });
    expect(turnRow(bed.db).error).toContain('request_timeout_15000ms');
    // 什么都没投出去 → 不提交 delta（`abortTurn` 那条路），上下文里不留半截 assistant 消息。
    expect(committedAssistantText(bed.db)).toEqual([]);
    expect(bed.sent).toHaveLength(1);
    closeDatabase(bed.db);
  }, 20_000);

  /**
   * 一个 chunk 都没来时那条占位消息（`output.placeholderAfterMs`）**必须被摘掉**。「空正文不加
   * （生成中断）后缀」那一版让收尾文本变成空串，而 `splitTelegramText('')` 是空数组 —— 收尾循环
   * 一次调用都不发，占位消息于是永久停在「正在想…」。这正是 logs/2026-08-18 的主路径。
   */
  it('一个 chunk 都没来时，占位消息被删掉而不是永久停在「正在想…」', async () => {
    const bed = await fixture('partial-placeholder', () => ({
      stream: (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw new Error('request_timeout_15000ms');
      })(),
      final: Promise.reject(new Error('request_timeout_15000ms')),
    }), { output: { mode: 'stream', replyDelayMs: 0, placeholderAfterMs: 5, placeholderTexts: ['正在想…'], placeholderPick: 'fixed', typingWhileWorking: false } });
    await bed.bot.handleUpdate(privateUpdate(1, '帮我查个东西'));
    const placeholder = bed.calls.find((call) => call.method === 'sendMessage' && call.payload.text === '正在想…');
    expect(placeholder).toBeTruthy();
    expect(bed.calls.filter((call) => call.method === 'deleteMessage').map((call) => call.payload.message_id)).toEqual([901]);
    // 也不许留一条空正文的 out 归档行：归档跟着 `messageIds` 走，而那一份现在是空的。
    expect(bed.db.prepare("SELECT COUNT(*) FROM messages WHERE direction='out'").pluck().get()).toBe(0);
    expect(turnRow(bed.db)).toMatchObject({ state: 'failed', cancel_reason: null });
    expect(turnRow(bed.db).error).toContain('request_timeout_15000ms');
    closeDatabase(bed.db);
  }, 20_000);

  /**
   * `docs/28 · L-TG-03`：一条 9469 字的回复切成 3 条 Telegram 消息，`messages` 表里是 3 行、
   * **每行 `length(text)` 都是 9469**、head/tail 完全相同 —— 连带 `messages_fts` 也是三份，
   * `search_messages` 把同一条回复搜出三次，归档体积按分段数翻倍。上下文侧一直是对的
   * （`context_messages` 只有一条），所以这条缺陷只在「投递侧分段 × 归档」这条缝里。
   */
  it('分段投递：每个 message_id 存自己那一段，上下文仍是一条整全文', async () => {
    const answer = `首段标记：${'甲'.repeat(120)}中段：${'乙'.repeat(120)}末段标记。`;
    const bed = await fixture('segment-archive', () => ({ stream: (async function* () { yield answer; })(), final: Promise.resolve(answer) }),
      { output: { mode: 'once', replyDelayMs: 0, maxMessageChars: 100 } });
    await bed.bot.handleUpdate(privateUpdate(1, '给我一段长的'));
    const rows = bed.db.prepare("SELECT tg_message_id AS id, text FROM messages WHERE direction='out' ORDER BY id").all() as Array<{ id: number; text: string }>;
    expect(rows.length).toBeGreaterThan(2);
    // 三行各存自己那一段：没有一行是全文，也没有两行相同。
    expect(rows.every((row) => [...row.text].length < [...answer].length)).toBe(true);
    expect(new Set(rows.map((row) => row.text)).size).toBe(rows.length);
    expect(rows.map((row) => row.text).join('').replaceAll(/\s/gu, '')).toBe(answer.replaceAll(/\s/gu, ''));
    // 只有末段那一行含末段的标记 → `search_messages` 不再把同一条回复搜出三次。
    for (const marker of ['首段标记', '末段标记']) {
      expect(bed.db.prepare(`SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH '"${marker}"'`).pluck().get()).toBe(1);
    }
    // 上下文侧一个字都不动：仍是一条整全文。
    const parts = bed.db.prepare("SELECT parts_json FROM context_messages WHERE role='assistant'").pluck().all() as string[];
    expect(parts.map((entry) => JSON.parse(entry))).toEqual([[{ type: 'text', text: answer }]]);
    closeDatabase(bed.db);
  }, 20_000);

  it('正常收尾的那一路一个字都没变', async () => {
    const bed = await fixture('partial-ok', () => ({ stream: (async function* () { yield '查好了：三条。'; })() }));
    await bed.bot.handleUpdate(privateUpdate(1, '帮我查个东西'));
    expect(bed.sent).toEqual(['查好了：三条。']);
    expect(turnRow(bed.db)).toMatchObject({ state: 'committed', cancel_reason: null, error: null });
    expect(turnEndLog(bed.db)).toEqual({ level: 'info', summary: 'turn committed' });
    closeDatabase(bed.db);
  }, 20_000);
});
