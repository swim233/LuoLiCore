import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, ScheduleRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { FileTools, PathJail, TOOL_POLICY, ToolRegistry, configSchema, registerBuiltins, type Config, type LogSink } from '@luoli/core';
import { TelegramTools, type ParseMode } from '@luoli/telegram';
import type { Bot } from 'grammy';

/** 投递侧的 `tg.send` 要真的落下来（docs/28 · L-LOG-02），所以这里收事件而不是丢掉。 */
const logged: Array<{ kind: string; level?: string; traceId?: string; parentSpanId?: string; data?: unknown }> = [];
const log = { event: (event: { kind: string; level?: string; traceId?: string; parentSpanId?: string; data?: unknown }) => { logged.push(event); return 1; },
  publish: () => undefined, span: () => ({ id: 's', end: () => undefined }) } as unknown as LogSink;

interface ApiCall { method: string; arguments_: unknown[] }

function fakeBot(calls: ApiCall[], fail?: string) {
  let nextMessageId = 10;
  const record = (method: string, result: (id: number) => unknown) => (...arguments_: unknown[]) => {
    calls.push({ method, arguments_ });
    if (fail === method) throw new Error('Call to "' + method + '" failed! (403: not enough rights)');
    nextMessageId += 1;
    return Promise.resolve(result(nextMessageId));
  };
  return { botInfo: { id: 7, first_name: 'Nori', username: 'nori_bot' },
    api: { sendMessage: record('sendMessage', (id) => ({ message_id: id, date: 1000 })), sendPhoto: record('sendPhoto', (id) => ({ message_id: id, date: 1000 })),
      sendDocument: record('sendDocument', (id) => ({ message_id: id, date: 1000, document: { file_name: 'r.txt' } })),
      setMessageReaction: record('setMessageReaction', () => true), pinChatMessage: record('pinChatMessage', () => true) } } as unknown as Bot;
}

function harness(name: string, options: { wired?: boolean; fail?: string; config?: Partial<Config['tools']['tg']>; parseMode?: ParseMode } = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const workspace = resolve(`./data/${name}-workspace`);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  const calls: ApiCall[] = [];
  const bot = fakeBot(calls, options.fail);
  const telegram = new TelegramTools({ bot: () => bot, archive, maxMessageChars: () => 3900, maxMentions: () => 5,
    parseMode: () => options.parseMode ?? 'MarkdownV2', log });
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 });
  // 定时任务的投递也靠 Telegram，所以它跟 telegram 一族同生共死：`deliverable` 跟着 `wired` 走。
  const schedule = { jobs: new ScheduleRepository(db), deliverable: () => options.wired !== false,
    runner: { register: () => true, unregister: () => true, nextRun: () => null } };
  registerBuiltins(registry, { archive, sandbox: { plan: () => ({ allowed: true }) },
    filesFor: (root: string) => new FileTools(new PathJail(root, []), 1000, 1000),
    pubWriteMinRole: 'trusted', maxWebBytes: 1000, webSearch: { provider: 'brave', apiKey: 'k' }, schedule,
    ...(options.wired === false ? {} : { telegram }) } as never);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, tools: { tg: options.config ?? {} } });
  const turn = { turnId: 't1', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'owner',
    isPrivate: false, baseCommitId: null, triggerTgMessageId: 4321, config,
    snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal };
  return { db, archive, registry, calls, workspace, turn, context: { turn, workspace, agentKind: 'main' } as never };
}

describe('telegram side tools', () => {
  /**
   * 这条是本轮真正的回归：五个工具一直好好地注册着，`TOOL_POLICY ↔ 注册表` 的启动断言也一直过，
   * 但 `main.ts` 从来没传过 `telegram` 依赖，于是它们永远进不了模型的工具目录 —— 模型说
   * 「我没有这个功能」是对的。注册 ≠ 模型看得见，断言必须落在 `activeNames` 上。
   */
  it('keeps the whole telegram family out of the catalog until the bridge is wired', () => {
    const family = ['send_message', 'send_photo', 'send_file', 'react', 'pin_message'];
    const dark = harness('tg-tools-dark', { wired: false });
    expect(family.filter((name) => dark.registry.has(name))).toEqual(family);
    expect(family.filter((name) => dark.registry.activeNames('owner', dark.context).includes(name))).toEqual([]);
    closeDatabase(dark.db);

    const wired = harness('tg-tools-wired');
    const active = new Set(wired.registry.activeNames('owner', wired.context));
    expect(family.filter((name) => !active.has(name))).toEqual([]);
    // 依赖齐全时，主 agent 能看到的应当就是策略表的全集减去：子 agent 专用的那两个，
    // `spawn_harness` —— 这个 harness 是**默认关闭**的（`agent.harness.allowedDirs` 为空），
    // 而且这条 turn 是群聊（`isPrivate: false`）。两个条件各自都足以把它挡在目录之外，
    // 这正是 docs/14 §2 Q8-a/b 要的：不进目录，而不是进了目录再报错。
    // 接着八个是自我扩展那一族：它们由 `registerAuthoringTools` 注册（这个 harness 只装了
    // builtins），而且 `tools.selfExtend.enabled` 出厂就是关的 —— 两条各自都足以让它们缺席。
    // 最后六个是容器管理（docs/05 §3.11）：由 `registerContainerTools` 注册，而且
    // `sandbox.persistent.enabled` 出厂也是关的 —— 同样两条各自都够。
    // 夹在中间的 `stay_silent` 缺席的理由与上面几族都不同：它注册着、角色也够（owner ≥ trusted），
    // 挡住它的是 `available()` 里那两道轮次形态闸 —— 这条 turn 没有 `silenceable`，而它的唯一
    // 置位方是 `ScheduledJobRunner`（docs/02 §10.5 ②）。**一条普通轮次看得见它就是这次改动最坏
    // 的失败形态**：模型可以对着正在等回话的人宣布不汇报。四个 `schedule_*` 则都在目录里
    // （`deliverable()` 为真），`schedule_update` 因此不出现在这张缺席表上。
    // `search_tools` 缺席的理由又是一档新的：它注册着（这个 harness 只装 builtins，连注册都没有），
    // 而**就算注册了它也不该在**——这条 turn 的折叠集是空的（没有 MCP / plugin / custom 工具），
    // `hasDeferrable()` 为假于是整个元工具不进目录。这正是 docs/07 §5 承诺的「纯内建部署的提示词
    // 逐字节不变」：折叠机制在没有东西可折叠时必须完全隐身（`AC-TOOL-049`）。
    // `spawn_acp` 缺席的理由与 `spawn_harness` 同一条（三道门任一不成立就不进目录），外加一条
    // 独有的：这个 harness 没传 `acp` 依赖，而 `available()` 判的第一项就是它在不在 —— 没有 ACP
    // 客户端的部署里这个工具根本不该露面（同 telegram 那五个与 `deliverable()` 的关系）。
    expect(Object.keys(TOOL_POLICY).filter((name) => !active.has(name))).toEqual(['ask_parent', 'report_progress', 'search_tools', 'stay_silent', 'spawn_harness', 'spawn_acp',
      'define_tool', 'delete_tool', 'list_tools', 'write_skill', 'install_skill', 'write_plugin', 'install_mcp', 'list_mcp',
      'container_list', 'container_exec', 'container_reset', 'container_inspect', 'container_keep', 'container_logs']);
    closeDatabase(wired.db);
  });

  it('reacts to the trigger message by default and normalises variation selectors', async () => {
    const h = harness('tg-tools-react');
    expect(await h.registry.execute('react', { emoji: '👍' }, h.context)).toMatchObject({ ok: true, messageId: 4321 });
    // `❤️`（带 U+FE0F）与 Telegram 认的 `❤` 是两个字符串；按字面比会把最常用的几个判成不支持。
    expect(await h.registry.execute('react', { messageId: 99, emoji: '❤️' }, h.context)).toMatchObject({ ok: true, emoji: '❤' });
    expect(h.calls.map((call) => call.arguments_[1])).toEqual([4321, 99]);
    closeDatabase(h.db);
  });

  it('rejects emoji Telegram does not accept without calling the API', async () => {
    const h = harness('tg-tools-react-bad');
    const result = await h.registry.execute('react', { emoji: '🍕' }, h.context) as { ok: boolean; error: string; allowed: string[] };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unsupported_emoji');
    expect(result.allowed).toContain('👍');
    expect(h.calls).toEqual([]);
    closeDatabase(h.db);
  });

  it('needs an explicit messageId when the turn has no trigger message', async () => {
    const h = harness('tg-tools-react-noturn');
    Object.assign(h.turn, { triggerTgMessageId: undefined });
    expect(await h.registry.execute('react', { emoji: '👍' }, h.context)).toMatchObject({ ok: false, error: 'message_id_required' });
    closeDatabase(h.db);
  });

  it('archives what it sends and caps extra messages per turn', async () => {
    const h = harness('tg-tools-send', { config: { maxExtraMessagesPerTurn: 2 } });
    expect(await h.registry.execute('send_message', { text: '第一条' }, h.context)).toMatchObject({ ok: true, messageIds: [11] });
    expect(await h.registry.execute('send_message', { text: '第二条' }, h.context)).toMatchObject({ ok: true });
    expect(await h.registry.execute('send_message', { text: '第三条' }, h.context)).toMatchObject({ ok: false, error: 'extra_message_limit_exceeded' });
    expect(h.calls).toHaveLength(2);
    // 不回写归档的话，模型自己追发过的内容下一轮就从上下文和 read_messages 里消失了。
    const rows = h.archive.scope('1', null).recent(10);
    expect(rows.map((row) => ({ direction: row.direction, fromKind: row.fromKind, text: row.text, turnId: row.turnId })))
      .toEqual([{ direction: 'out', fromKind: 'bot', text: '第二条', turnId: 't1' }, { direction: 'out', fromKind: 'bot', text: '第一条', turnId: 't1' }]);
    closeDatabase(h.db);
  });

  it('archives the pre-render text, not the MarkdownV2-escaped payload', async () => {
    // 发出去的是渲染后的（行内代码要变成 code 实体），存下来的必须是渲染前的 —— 三条出站路径
    // （这里、`bot.ts` 的非流式兜底、`TelegramOutput`）在 `messages.text` 里放的得是同一种东西，
    // 否则 WebUI 会话页和 `read_messages` 看到的 bot 发言一半带着 `\-` `\.` 这类转义符。
    const h = harness('tg-tools-archive-raw');
    expect(await h.registry.execute('send_message', { text: '用 `pnpm i` 装 1.2-beta' }, h.context)).toMatchObject({ ok: true });
    expect(h.calls[0]!.arguments_[1]).toBe('用 `pnpm i` 装 1\\.2\\-beta');
    expect(h.archive.scope('1', null).recent(1)[0]!.text).toBe('用 `pnpm i` 装 1.2-beta');
    closeDatabase(h.db);
  });

  /**
   * `docs/28 · L-TG-03`：分段投递时三条出站路径都给**每一段**存了一份完整全文（实测一条 9469 字的
   * 回复在 `messages` 里躺三行 9469 字），连带 `messages_fts` 三份 → `search_messages` 把同一条
   * 回复搜出三次。这条路还额外差一道：归档存的是**未经 `capMentions`** 的原文。
   */
  it('archives each segment on its own row, capped mentions included', async () => {
    const h = harness('tg-tools-segments');
    // maxMessageChars 是 3900，所以这段 4002 字正好切成两条，断点落在中间那个空行上。
    const text = `${'甲'.repeat(2000)}\n\n${'乙'.repeat(2000)}`;
    expect(await h.registry.execute('send_message', { text }, h.context)).toMatchObject({ ok: true, messageIds: [11, 12] });
    expect(h.calls).toHaveLength(2);
    // recent() 是倒序：先看到后发的那一段。两行各存自己那一段，而不是两份全文。
    expect(h.archive.scope('1', null).recent(10).map((row) => row.text)).toEqual(['乙'.repeat(2000), '甲'.repeat(2000)]);
    closeDatabase(h.db);
  });

  it('archives the capped text, not the raw one with every mention still in it', async () => {
    // 三条出站路径都该在 `messages.text` 里放「真正发出去的那份」。这条路此前存收口前的原文，
    // 于是 `read_messages` 与 WebUI 里躺的 @ 数量比群里实际出现的多（maxMentions=5）。
    const h = harness('tg-tools-cap-archive');
    const text = '@alpha1 @bravo2 @charlie3 @delta44 @echo555 @foxtrot6 收到';
    expect(await h.registry.execute('send_message', { text }, h.context)).toMatchObject({ ok: true });
    expect(h.archive.scope('1', null).recent(1)[0]!.text).toBe('@alpha1 @bravo2 @charlie3 @delta44 @echo555 foxtrot6 收到');
    closeDatabase(h.db);
  });

  it('keeps send_file inside the workspace and under the size cap', async () => {
    const h = harness('tg-tools-file', { config: { maxFileSendMb: 0.001 } });
    writeFileSync(resolve(h.workspace, 'small.txt'), 'ok');
    writeFileSync(resolve(h.workspace, 'big.txt'), 'x'.repeat(4096));
    expect(await h.registry.execute('send_file', { file: '../../etc/passwd' }, h.context)).toMatchObject({ ok: false, error: 'path_outside_workspace' });
    expect(await h.registry.execute('send_file', { file: 'missing.txt' }, h.context)).toMatchObject({ ok: false, error: 'file_not_found' });
    expect(await h.registry.execute('send_file', { file: 'big.txt' }, h.context)).toMatchObject({ ok: false, error: 'file_too_large' });
    expect(h.calls).toEqual([]);
    expect(await h.registry.execute('send_file', { file: 'small.txt', caption: '报告' }, h.context)).toMatchObject({ ok: true, messageId: 11 });
    expect(h.calls[0]?.method).toBe('sendDocument');
    // 越界与超限都不该消耗本轮的追发预算：预算是给真正发出去的消息留的。
    expect((h.turn as { extraMessages?: number }).extraMessages).toBe(1);
    closeDatabase(h.db);
  });

  /**
   * `tg.api` 那条在 grammY 的 transformer 里，**拿不到 turn 上下文**：生产库 9745 条里
   * `trace_id IS NULL` 的是 9745 条，按 trace 归轮的结果每一轮都是 0，而 `data` 只有
   * `{method, ok}` —— 没有 chars、没有 messageId（docs/28 · L-LOG-02）。所以语义 span 在
   * 投递层发，而这里知道 turnId 与本次 `tool.call` 的 span。
   */
  it('每条追发都落一条带 traceId 的 tg.send，父是本次 tool.call 的 span', async () => {
    const h = harness('tg-tools-log');
    logged.length = 0;
    expect(await h.registry.execute('send_message', { text: '追发一条' }, h.context)).toMatchObject({ ok: true });
    const sends = logged.filter((event) => event.kind === 'tg.send');
    expect(sends).toHaveLength(1);
    // `execute()` 浅拷贝 context 时把 `tool.call` 的 span id 塞了进去，`target()` 再原样带下来。
    expect(sends[0]).toMatchObject({ traceId: 't1', parentSpanId: 's' });
    expect(sends[0]!.data).toMatchObject({ method: 'sendMessage', ok: true, messageId: 11, chars: 4, path: 'tool' });
    closeDatabase(h.db);
  });

  it('turns upstream API failures into tool errors the model can act on', async () => {
    const h = harness('tg-tools-fail', { fail: 'pinChatMessage' });
    logged.length = 0;
    const result = await h.registry.execute('pin_message', {}, h.context) as { ok: boolean; error: string; hint: string };
    expect(result).toMatchObject({ ok: false, error: 'telegram_api_error' });
    expect(result.hint).toContain('not enough rights');
    // **吞掉的那一跳要自己落一行**（`docs/10 §2` 的 `tg.send` 失败档 warn）：上游报错在这里被换成
    // `ok:false` 交回模型，不落的话「发不出去」在带 traceId 的日志里一个字都没有 —— 只剩没有
    // turn 上下文的 `tg.api`（docs/28 · L-LOG-02）。此前五个调用点全硬写 `ok: true`，失败档不可达。
    const sends = logged.filter((event) => event.kind === 'tg.send');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ level: 'warn', traceId: 't1' });
    expect(sends[0]!.data).toMatchObject({ method: 'pinChatMessage', ok: false, path: 'tool' });
    closeDatabase(h.db);
  });

  it('模型发的消息被 Telegram 拒收时同样落一行 warn 的 tg.send', async () => {
    const h = harness('tg-tools-send-fail', { fail: 'sendMessage' });
    logged.length = 0;
    expect(await h.registry.execute('send_message', { text: '发不出去的一条' }, h.context)).toMatchObject({ ok: false, error: 'telegram_api_error' });
    const sends = logged.filter((event) => event.kind === 'tg.send');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.data).toMatchObject({ method: 'sendMessage', ok: false, path: 'tool' });
    closeDatabase(h.db);
  });
});
