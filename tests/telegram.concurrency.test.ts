import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GrammyError, type Bot } from 'grammy';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, MemoryStore, QuotaGuard, TurnConcurrency, TurnRegistry, configSchema } from '@luoli/core';
import { UpdatePoller, createTelegramBot } from '@luoli/telegram';

/**
 * 「同时处理多条消息」这件事在两层上都会被卡住，两层都得有断言：
 *
 * 1. **入口**：grammY 内建的 `bot.start()` 逐条串行喂 update，所以 `TurnConcurrency` 的
 *    global / perKey / queueMax 永远争用不到 —— 上一轮实测「阻塞」就是这一层。`UpdatePoller`
 *    并发派发，并且**有界**（在途到顶就不再拉）。
 * 2. **轮次**：入口并发之后，同一个会话里 `perKey` 个轮次要真的同时在跑；而并发派发不许把
 *    同一个 chat 的归档顺序打乱 —— `claimBackground` 按 `messages.id` 排，倒序等于模型看到的
 *    对话顺序和用户打字的顺序不一样。
 */

const botInfo = { id: 1, is_bot: true as const, first_name: 'Bot', username: 'mybot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  if (!predicate()) throw new Error(`等不到：${what}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface FetchCall { offset?: number; limit?: number; timeout?: number; allowed_updates?: string[] }
type FakeSignal = { aborted: boolean; addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void };

/**
 * 假 Bot：只实现 `UpdatePoller` 用到的三个入口。批次用完之后 `getUpdates` 挂着不返回
 * （模拟 long poll），直到 `stop()` abort —— 不带 signal 的那次调用是 `stop()` 的 offset 确认，
 * 立刻返回空。
 */
function fakeBot(batches: Array<Array<{ update_id: number }>>, handle: (updateId: number) => Promise<void>): { bot: Bot; calls: FetchCall[]; commits: FetchCall[]; fail: (error: unknown) => void } {
  const calls: FetchCall[] = [];
  const commits: FetchCall[] = [];
  let cursor = 0;
  let failure: unknown = null;
  const api = {
    deleteWebhook: async (): Promise<boolean> => true,
    getUpdates: async (payload: FetchCall, signal?: FakeSignal): Promise<Array<{ update_id: number }>> => {
      // 不带 signal 的那次是 `stop()` 的 offset 确认，不是拉取。
      if (!signal) { commits.push(payload); return []; }
      calls.push(payload);
      if (failure) { const error = failure; failure = null; throw error; }
      const batch = batches[cursor++];
      if (batch) return batch;
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return [];
    },
  };
  return { bot: { api, handleUpdate: (update: { update_id: number }) => handle(update.update_id) } as unknown as Bot, calls, commits, fail: (error) => { failure = error; } };
}

const noopFatal = (): void => undefined;

describe('UpdatePoller：并发派发 update', () => {
  it('一批 update 同时在跑，而不是等上一条处理完', async () => {
    const gate = deferred();
    const started: number[] = [];
    const { bot, calls, commits } = fakeBot([[{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }]],
      async (id) => { started.push(id); await gate.promise; });
    const poller = new UpdatePoller(bot, { maxInFlight: 8, timeoutSeconds: 0, onError: () => undefined, onFatal: noopFatal });
    poller.start();
    await until(() => started.length === 3, '三条 update 同时在途');
    expect(poller.inFlight).toBe(3);
    // offset 在派发时就前移：等 handler 结束才前移会让同一批里的后几条被重复拉一次。
    await until(() => calls.length === 2, '第二次 getUpdates');
    expect(calls[1]?.offset).toBe(4);
    gate.resolve();
    expect(await poller.drain(2000)).toBe(true);
    await poller.stop();
    // 停机要把 offset 交回 Telegram，否则重启后先空跑一批已经处理过的 update（去重表挡得住，
    // 但那一批里的新消息要等它们过完）。
    expect(commits).toEqual([{ offset: 4, limit: 1, timeout: 0 }]);
  });

  it('在途到 maxInFlight 就不再拉新的（backpressure 压回 getUpdates）', async () => {
    const gate = deferred();
    const started: number[] = [];
    const { bot, calls } = fakeBot([[{ update_id: 1 }, { update_id: 2 }], [{ update_id: 3 }]],
      async (id) => { started.push(id); await gate.promise; });
    const poller = new UpdatePoller(bot, { maxInFlight: 2, timeoutSeconds: 0, onError: () => undefined, onFatal: noopFatal });
    poller.start();
    await until(() => started.length === 2, '两条 update 在途');
    await sleep(30);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.limit).toBe(2);
    gate.resolve();
    await until(() => started.length === 3, '腾出位置后继续拉');
    await poller.stop();
    expect(await poller.drain(1000)).toBe(true);
  });

  it('handler 抛错只上报不中断循环', async () => {
    // grammY 只在自家轮询里把中间件错误路由到 bot.catch。自己派发就得自己接：漏一个就是
    // unhandledRejection，而 main.ts 那条路径会直接带走整个进程。
    const errors: string[] = [];
    const started: number[] = [];
    const { bot } = fakeBot([[{ update_id: 1 }], [{ update_id: 2 }]], async (id) => {
      started.push(id);
      if (id === 1) throw new Error('boom');
    });
    const poller = new UpdatePoller(bot, { maxInFlight: 4, timeoutSeconds: 0, onFatal: noopFatal,
      onError: (error, phase) => errors.push(`${phase}:${error instanceof Error ? error.message : String(error)}`) });
    poller.start();
    await until(() => started.length === 2, '第一条抛错之后照常处理第二条');
    expect(errors).toEqual(['handle:boom']);
    await poller.stop();
  });

  it('409 当致命错误上报并停止轮询，不无限重试跟另一个实例互抢', async () => {
    const fatal: string[] = [];
    const { bot, fail } = fakeBot([], async () => undefined);
    fail(new GrammyError('Call to getUpdates failed!', { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, 'getUpdates', {}));
    const poller = new UpdatePoller(bot, { maxInFlight: 4, timeoutSeconds: 0, onError: () => undefined,
      onFatal: (error) => fatal.push(error instanceof Error ? error.message : String(error)) });
    poller.start();
    await until(() => fatal.length === 1, '409 上报 onFatal');
    expect(fatal[0]).toContain('409');
    expect(poller.running).toBe(false);
  });
});

interface BotFixture { bot: Bot; db: ReturnType<typeof openDatabase>; replies: string[] }

function telegramFixture(name: string, overrides: Record<string, unknown>,
  dependencies: { onTurn?: (turnId: string) => Promise<string>; plugins?: { hook(name: string, ...arguments_: unknown[]): Promise<unknown[]> } } = {}): Promise<BotFixture> {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/${name}-memory`, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { defaultUserRole: 'trusted', defaultChatRole: 'trusted', bootstrapOwnerId: '1' },
    quota: { enabled: false, rateLimit: { concurrentPerUser: 3 } }, output: { replyDelayMs: 0 }, ...overrides });
  const principals = new PrincipalRepository(db);
  const archive = new ArchiveRepository(db);
  const operations = new OperationsRepository(db);
  return createTelegramBot('12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {
    config, db, principals, archive, operations, context: new ContextEngine(db, archive), turns: new TurnRepository(db),
    quota: new QuotaGuard(db, 'UTC'), memory: new MemoryStore(db, `./data/${name}-memory`, 1500, 3000),
    registry: new TurnRegistry(), concurrency: new TurnConcurrency(config.concurrency),
    log: new LogSink(operations, `./data/${name}-logs`), botInfo,
    ...(dependencies.plugins ? { plugins: dependencies.plugins } : {}),
    ...(dependencies.onTurn ? { onTurn: (turn) => dependencies.onTurn!(turn.turnId) } : {}),
  }).then((bot) => {
    // 整个 Bot API 短路掉：测试不打网络。发出去的正文留一份 —— 拒绝时用户看到的那句话本身
    // 就是判据（docs/28 · L-QUOTA-02）。
    const replies: string[] = [];
    bot.api.config.use((async (_prev: unknown, method: string, payload: { text?: string }) => {
      if (method === 'sendMessage' && typeof payload.text === 'string') replies.push(payload.text);
      return { ok: true, result: method === 'sendMessage' || method === 'editMessageText'
        ? { message_id: 900, date: 0, chat: { id: 500, type: 'private' }, text: 'ok' } : true };
    }) as never);
    return { bot, db, replies };
  });
}

function privateUpdate(id: number, text: string): never {
  return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 500, type: 'private', first_name: 'User' },
    from: { id: 500, is_bot: false, first_name: 'User' }, text } } as never;
}

function groupUpdate(id: number, text: string): never {
  return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: -100, type: 'group', title: 'Group' },
    from: { id: 200, is_bot: false, first_name: 'User' }, text } } as never;
}

describe('同一会话的多条消息并行成轮', () => {
  it('perKey 允许的三轮同时在跑', async () => {
    const started: string[] = [];
    const gate = deferred();
    const { bot, db } = await telegramFixture('tg-concurrent-turns', {},
      { onTurn: async (turnId) => { started.push(turnId); await gate.promise; return `回答 ${turnId.slice(0, 6)}`; } });
    const inflight = [1, 2, 3].map((id) => bot.handleUpdate(privateUpdate(id, `第 ${id} 条`)));
    await until(() => started.length === 3, '三轮同时在跑');
    // 三轮都已经进了 turns 表且都是 running —— 串行的话这里只会有 1 行。
    const running = db.prepare("SELECT COUNT(*) AS count FROM turns WHERE state='running'").pluck().get() as number;
    expect(running).toBe(3);
    gate.resolve();
    await Promise.all(inflight);
    const committed = db.prepare("SELECT COUNT(*) AS count FROM turns WHERE state='committed'").pluck().get() as number;
    expect(committed).toBe(3);
    closeDatabase(db);
  }, 20_000);

  it('perKey=1 时多出来的那些排队而不是被丢掉', async () => {
    const started: string[] = [];
    const gate = deferred();
    const { bot, db } = await telegramFixture('tg-serial-turns', { concurrency: { perKey: 1, global: 1, queueMax: 5 } },
      { onTurn: async (turnId) => { started.push(turnId); await gate.promise; return `回答 ${turnId.slice(0, 6)}`; } });
    const inflight = [1, 2, 3].map((id) => bot.handleUpdate(privateUpdate(id, `第 ${id} 条`)));
    await until(() => started.length === 1, '第一轮开跑');
    await sleep(30);
    expect(started).toHaveLength(1);
    gate.resolve();
    await Promise.all(inflight);
    // 排队的两条最终都跑完了：`queueMax` 之内不许丢消息。
    const committed = db.prepare("SELECT COUNT(*) AS count FROM turns WHERE state='committed'").pluck().get() as number;
    expect(committed).toBe(3);
    closeDatabase(db);
  }, 20_000);

  it('同一个 chat 的归档顺序不被并发派发打乱', async () => {
    // 入口段里有真实的异步等待（这里用 onMessage 钩子模拟慢的媒体下载）：没有那把按 chat 的锁，
    // 后到的消息会先落库，`claimBackground` 按 id 排出来的对话顺序就是倒的。
    const { bot, db } = await telegramFixture('tg-ingress-order', {}, {
      plugins: { hook: async (name, ...arguments_) => {
        const context = arguments_[0] as { message?: { text?: string } } | undefined;
        if (name === 'onMessage' && context?.message?.text === '先说的') await sleep(60);
        return [];
      } },
    });
    await Promise.all([bot.handleUpdate(groupUpdate(1, '先说的')), bot.handleUpdate(groupUpdate(2, '后说的'))]);
    const texts = db.prepare("SELECT text FROM messages WHERE direction='in' ORDER BY id").pluck().all() as string[];
    expect(texts).toEqual(['先说的', '后说的']);
    closeDatabase(db);
  });
});

/**
 * 那个三元此前只看 `reservation` 是不是空，而额度关着时它恒为空 —— 于是每一轮都记一条
 * `warn quota.exceeded`「Quota reservation rejected」而轮次照常开（logs/2026-08-18：31 轮里 30 条）。
 * 排障时第一眼看到的就是它，而真正的故障在 363 秒后才落第一行。
 */
describe('额度这条警报只在真的被拒时响', () => {
  it('quota.enabled=false 的一轮一条都不落', async () => {
    const { bot, db } = await telegramFixture('tg-quota-off', {}, { onTurn: async () => '好' });
    await bot.handleUpdate(privateUpdate(1, '你好'));
    expect(db.prepare("SELECT COUNT(*) AS count FROM log_events WHERE kind IN ('quota.exceeded','quota.check')").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM turns WHERE state='committed'").pluck().get()).toBe(1);
    closeDatabase(db);
  }, 20_000);

  /**
   * 真人看到的原话：**「今天的额度用完了（已用 —/—），下个额度窗口 重置。」** 而真实原因是
   * 「这一小时你已经开了 30 轮」，与金额无关，占位符还原样漏了出去（docs/28 · L-QUOTA-02）。
   * 紧邻的 `concurrent` 分支早就论证过这么做的危害（「会让人当天不再尝试」），同一个论证适用于
   * 频率这一档。**这句不受 `onExceeded.reply` 管**：那个开关是给「额度用光」用的。
   */
  it('频率拒绝给的是频率文案，不是额度文案，也不漏占位符', async () => {
    // 限额取 2、第 3 条被拒 —— 照 `AC-QUOTA-012` 写的那个场景，别让用例与验收条目各说一套。
    const { bot, db, replies } = await telegramFixture('tg-rate-user-message',
      { quota: { enabled: false, rateLimit: { turnsPerUserPerHour: 2, turnsPerChatPerHour: 100, concurrentPerUser: 3 }, onExceeded: { reply: false } } },
      { onTurn: async () => '好' });
    await bot.handleUpdate(privateUpdate(1, '第一句'));
    await bot.handleUpdate(privateUpdate(2, '第二句'));
    await bot.handleUpdate(privateUpdate(3, '第三句'));
    // 第三条被频率闸挡住：没有第三个轮次，但用户拿到了一句说得清的话。
    expect(db.prepare('SELECT COUNT(*) AS count FROM turns').pluck().get()).toBe(2);
    const last = replies.at(-1)!;
    expect(last).toContain('频率上限');
    expect(last).toContain('按人算');
    expect(last).not.toContain('额度用完');
    expect(last).not.toContain('—/—');
    // 挡下来的那条要降级成背景消息，否则它既没被回答也进不了下一轮上下文。
    expect(db.prepare('SELECT triggered FROM messages WHERE tg_message_id=3').pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM log_events WHERE kind='quota.check' AND summary LIKE '%rate_user%'").pluck().get()).toBe(1);
    closeDatabase(db);
  }, 20_000);

  /**
   * 定时任务的轮次不再计入按小时的频率闸：它不是「人在刷」，而本轮测试用定时任务跑的 38 轮
   * 把 owner 自己挡在了门外（docs/28 · L-QUOTA-02）。金额额度照旧全部生效。
   */
  it('同一小时里的定时轮次不占创建者的频率额度', async () => {
    const { bot, db } = await telegramFixture('tg-rate-schedule-exempt',
      { quota: { enabled: false, rateLimit: { turnsPerUserPerHour: 2, turnsPerChatPerHour: 3, concurrentPerUser: 3 } } },
      { onTurn: async () => '好' });
    for (let index = 0; index < 10; index += 1) {
      db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_reason,state,started_at)
        VALUES (?,'chat:500','500','500','owner','schedule','committed',?)`).run(`job-turn-${index}`, Date.now());
    }
    await bot.handleUpdate(privateUpdate(1, '你好'));
    expect(db.prepare("SELECT COUNT(*) AS count FROM turns WHERE trigger_reason<>'schedule'").pluck().get()).toBe(1);
    closeDatabase(db);
  }, 20_000);

  it('额度开着而预留被拒时照旧响，并且不开轮次', async () => {
    const { bot, db, replies } = await telegramFixture('tg-quota-rejected',
      { quota: { enabled: true, requirePricing: false, minReserveUsd: 0.02, perUser: { daily: 0.001 } } },
      { onTurn: async () => '好' });
    await bot.handleUpdate(privateUpdate(1, '你好'));
    expect(db.prepare("SELECT COUNT(*) AS count FROM log_events WHERE kind='quota.exceeded'").pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM turns').pluck().get()).toBe(0);
    expect(replies.at(-1)).toContain('额度用完了');
    // 没开成轮次的触发消息一律降级成背景（docs/20 · W-TG-05）：金额这一档此前留着 `triggered=1`，
    // 于是额度用光那天说的每一句话既没被回答、也再没进过任何一轮的上下文。
    expect(db.prepare('SELECT triggered FROM messages WHERE tg_message_id=1').pluck().get()).toBe(0);
    closeDatabase(db);
  }, 20_000);

  /**
   * `quota.onExceeded.reply=false` 的语义是「额度用光了就别再回话」，而**金额这一档是它唯一管得着
   * 的地方**（频率与并发各有自己的文案）。分档文案那次整改把 `main` 上唯一的读点删掉了，而金额档
   * 从来没读过它 —— 于是这个开关存得住、WebUI 还在写、运行时零效果。
   */
  it('onExceeded.reply=false 时金额超额一句都不回，而拒绝照旧记账并降级', async () => {
    const { bot, db, replies } = await telegramFixture('tg-quota-silent',
      { quota: { enabled: true, requirePricing: false, minReserveUsd: 0.02, perUser: { daily: 0.001 }, onExceeded: { reply: false } } },
      { onTurn: async () => '好' });
    await bot.handleUpdate(privateUpdate(1, '你好'));
    expect(replies, '关掉之后一句都不该回').toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM turns').pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM log_events WHERE kind='quota.exceeded'").pluck().get()).toBe(1);
    expect(db.prepare('SELECT triggered FROM messages WHERE tg_message_id=1').pluck().get()).toBe(0);
    closeDatabase(db);
  }, 20_000);
});
