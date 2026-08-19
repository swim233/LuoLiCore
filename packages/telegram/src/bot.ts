import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { Message, UserFromGetMe } from 'grammy/types';
import type { Config, ConfigStore, ContextEngine, LogSink, MainAgentStreamResult, MemoryStore, QuotaGuard, QuotaReservation, TurnConcurrency, TurnRegistry } from '@luoli/core';
import { KeyedMutex, TurnFailureStreak, perChatConfig, resolveEffectiveRole } from '@luoli/core';
import type { ArchivedMessage, ArchiveRepository, OperationsRepository, PrincipalRepository, ScopedArchiveRepository, Sqlite, TurnRepository } from '@luoli/db';
import type { Role, RuntimeTurnContext } from '@luoli/shared';
import { parsePrincipal, roleRank } from '@luoli/shared';
import { contextKey, modelAliasKey, readAppKv, writeAppKv } from '@luoli/db';
import { matchTrigger } from './trigger.js';
import { capMentions, deliveryOrder, holdReply, segmentTelegramText, sendWithFallback, type ParseFallbackInfo } from './output.js';
import { archiveQuotedMessage, attachMedia, messageKind } from './reply.js';
import { TelegramOutput } from './stream-output.js';

export interface TelegramDependencies {
  config: Readonly<Config> | ConfigStore;
  principals: PrincipalRepository;
  archive: ArchiveRepository;
  operations: OperationsRepository;
  context: ContextEngine;
  turns: TurnRepository;
  quota: QuotaGuard;
  memory: MemoryStore;
  db: Sqlite;
  registry: TurnRegistry;
  plugins?: { hook(name: string, ...arguments_: unknown[]): Promise<unknown[]> };
  tools?: { releaseTurn(turnId: string): void };
  approvals?: { releaseTurn(turnId: string): void };
  concurrency: TurnConcurrency;
  onTurn?: (turn: RuntimeTurnContext, reservation: QuotaReservation | null) => Promise<string | MainAgentStreamResult>;
  estimateTurnCost?: (inputTokens: number, key: string) => number | null;
  /** 签发一次性登录 token（`@luoli/server` 的 `issueLoginToken`）。缺它时 `/webui` 明说不可用。 */
  issueLoginToken?: () => { token: string; expiresAt: number };
  /** 告警分发。缺它时这几条只落日志 —— 别让「装配方没给」变成静默崩溃。 */
  alerts?: { fire(kind: 'quota_global_exceeded' | 'consecutive_turn_failures', summary: string, data?: Record<string, unknown>, key?: string): void };
  /**
   * 连续失败计数。**装配方建一份传给所有开轮次的入口**（这里与 `ScheduledJobRunner`）——
   * 它此前是本文件的一个闭包变量，于是定时轮次的失败一次都不计入，「上游变黑洞」在没人聊天的
   * 部署里一次告警都不响（docs/28 · L-SCH-02）。缺它时退回本地一份，行为与从前一致。
   */
  failures?: TurnFailureStreak;
  log: LogSink;
  botInfo?: UserFromGetMe;
}

// 运维态失败（模型没配、缺定价）不能并进「出了点问题」：用户重试多少次都不会好，
// 得说清楚该由谁去做什么（docs/08 §9）。其余错误仍不暴露内部细节，只给 ref。
function failureText(error: unknown, reference: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  // 上游挂了和「模型没话说」得分开讲：前者重试有用，后者重试没用。
  if (/RetryError|APICallError/i.test(name) || /Failed after \d+ attempts/i.test(message)) return `模型服务暂时连不上（上游重试已耗尽），过一会儿再试。(ref: ${reference})`;
  if (message.startsWith('model alias unavailable')) return `模型还没配置好，得管理员在 WebUI 里配上 provider 和 main 别名。(ref: ${reference})`;
  if (message === 'model_pricing_required') return `当前模型没配价格，管理员补上定价才能用。(ref: ${reference})`;
  if (message === 'model_returned_empty') return `模型这轮没吐出任何正文，我不知道该回你什么。再说一次试试？(ref: ${reference})`;
  return `出了点问题，已记录。(ref: ${reference})`;
}
interface TelegramIngress {
  archived: ArchivedMessage;
  quoted: ArchivedMessage | null;
  effectiveRole: Role;
  userId: string;
  chatId: string;
  isPrivate: boolean;
  triggerReason: string | null;
}

function pluginText(result: unknown[], original: string): string {
  let text = original;
  for (const entry of result) {
    const value = entry && typeof entry === 'object' && 'result' in entry ? (entry as { result?: unknown }).result : null;
    if (typeof value === 'string') text = value;
    else if (value && typeof value === 'object' && 'text' in value && typeof (value as { text?: unknown }).text === 'string') text = (value as { text: string }).text;
  }
  return text;
}
export async function createTelegramBot(token: string, dependencies: TelegramDependencies): Promise<Bot> {
  const currentConfig = (): Readonly<Config> => 'snapshot' in dependencies.config ? dependencies.config.snapshot() : dependencies.config;
  const config = new Proxy({} as Readonly<Config>, { get: (_target, property) => currentConfig()[property as keyof Config] });
  const bot = new Bot(token, dependencies.botInfo ? { botInfo: dependencies.botInfo } : undefined);
  await bot.init();
  bot.catch((error) => dependencies.log.event({ level: 'error', kind: 'tg.error', summary: error.message, data: error.error }));
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  bot.api.config.use(apiThrottler({ global: { reservoir: config.telegram.throttle.globalPerSecond, reservoirRefreshAmount: config.telegram.throttle.globalPerSecond, reservoirRefreshInterval: 1000 }, group: { reservoir: config.telegram.throttle.perChatPerMinute, reservoirRefreshAmount: config.telegram.throttle.perChatPerMinute, reservoirRefreshInterval: 60_000 }, out: { minTime: 1000 } }));
  bot.api.config.use(async (prev, method, payload, signal) => {
    const span = dependencies.log.span({ level: 'info', kind: 'tg.api', summary: method, data: { method } });
    try { const result = await prev(method, payload, signal); span.end({ ok: true }); return result; }
    catch (error) { span.end(undefined, error); throw error; }
  });
  const media = new (await import('./media.js')).TelegramMedia(bot.api, token, dependencies.db, config.media);
  const ingress = new Map<number, TelegramIngress>();
  /** `trigger.cooldownMsPerUser` 的按人时间戳。有界淘汰见使用处。 */
  const triggerCooldown = new Map<string, number>();
  /** `concurrency.coalesceSameUserMs` 的在等窗口，键是 `${chatId}:${userId}`。同一个键最多一个。 */
  const coalescing = new Map<string, { supersede: () => void }>();
  /**
   * 跨会话计数：连续失败说明的是「这个部署坏了」，不是「这个群坏了」（docs/10 §6）。
   * 两个失败出口（抛出去的、以及「吐过内容之后断掉」的）共用同一份，免得两边阈值走岔；
   * 定时轮次也往同一份里记 —— 前提是装配方把 `failures` 传进来（docs/28 · L-SCH-02）。
   */
  const failures = dependencies.failures ?? new TurnFailureStreak(dependencies.alerts);
  /**
   * 入口段（认领 update → 归档 → 挂媒体）按 chat 串行。
   *
   * update 现在是**并发**派发的（`UpdatePoller`），而归档顺序就是上下文顺序 ——
   * `claimBackground` 与 `recent` 都按 `messages.id` 排。这一段里有真实的异步等待
   * （`onMessage` 钩子、媒体下载），两条同 chat 的消息一起进来就可能在库里倒序，
   * 表现是模型看到的对话顺序和用户打字的顺序不一样。
   *
   * 非 message 的 update 连 `next()` 一起锁在里面：编辑走的 `MAX(revision)+1` 是
   * 读-改-写，同一条消息的两次编辑并发跑会算出同一个 revision。
   *
   * 锁只盖入口段，**轮次在锁外跑** —— 那才是要并行的部分（`concurrency.perKey`）。
   */
  const ingressOrder = new KeyedMutex();
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    const chat = ctx.chat;
    const message = ctx.message;
    // 归档在锁内、挂媒体在锁外。前者定的是上下文顺序（`messages.id` 序），后者会去解析用户上传的
    // 文件 —— 一个畸形 PDF 挂在锁里就是「这个会话之后的每条消息既不归档也不触发，日志里连一条
    // turn.start 都没有」，而挂住不算抛错、`bot.catch` 也不会说话（docs/27 · R-01）。
    const pending: Array<{ payload: Message; row: ArchivedMessage }> = [];
    let scopedArchive: ScopedArchiveRepository | null = null;
    const admitted = await ingressOrder.run(chat ? String(chat.id) : 'global', async (): Promise<TelegramIngress | null> => {
      if (!dependencies.operations.claimUpdate(ctx.update.update_id)) return null;
      if (!from || !chat || !message) { await next(); return null; }
      const pluginMessages = await dependencies.plugins?.hook('onMessage', ctx);
      if (pluginMessages?.some((entry) => entry && typeof entry === 'object' && 'result' in entry && (entry as { result?: { drop?: boolean } }).result?.drop)) return null;
      const userId = String(from.id);
      const chatId = String(chat.id);
      const isPrivate = chat.type === 'private';
      const userRole = dependencies.principals.roleOf('user', userId) ?? config.access.defaultUserRole;
      const storedChatRole = dependencies.principals.roleOf('chat', chatId);
      const effectiveRole = resolveEffectiveRole({ userRole, ...(storedChatRole ? { chatRole: storedChatRole } : {}), isPrivate, defaultChatRole: config.access.defaultChatRole });
      dependencies.principals.upsertSeen({ id: `user:${userId}`, kind: 'user', tgId: userId, role: userRole, displayName: [from.first_name, from.last_name].filter(Boolean).join(' '), username: from.username ?? null, chatType: null });
      dependencies.principals.upsertSeen({ id: `chat:${chatId}`, kind: 'chat', tgId: chatId, role: storedChatRole ?? (isPrivate ? userRole : config.access.defaultChatRole), displayName: ('title' in chat ? chat.title : from.first_name) ?? null, username: 'username' in chat ? chat.username ?? null : null, chatType: chat.type });
      if (from.is_bot && !config.telegram.allowBots.includes(from.username ?? '')) return null;
      dependencies.log.event({ level: 'debug', kind: 'tg.update', summary: `Update ${ctx.update.update_id}`, chatId, userId, data: { updateId: ctx.update.update_id, type: 'message' } });
      // 触发判定要看会话级覆盖（docs/08 §4）：唤醒词是 perChat 白名单里的键，只读全局快照的话
      // WebUI/API 写进去的会话唤醒词能存住却永远匹配不上。key 用全局 scope 算，与 openTurn 保持一致。
      const triggerConfig = perChatConfig(currentConfig(), contextKey({ chatId, messageThreadId: message.message_thread_id ?? null }, config.context.scope)).trigger;
      // 判定整个交给 matchTrigger：裸 `/` 前缀一律当命令的话，白名单和 `trigger.command` 开关都被绕开，
      // 私聊里一句「/home/app 这个目录满了」会石沉大海（docs/20 · W-TG-01）。
      const triggerReason = matchTrigger(ctx, { ...triggerConfig, strictCommandSuffix: config.telegram.strictCommandSuffix }, bot.botInfo.id, bot.botInfo.username);
      dependencies.log.event({ level: 'debug', kind: triggerReason ? 'trigger.matched' : 'trigger.skipped', summary: triggerReason ?? 'not triggered', chatId, userId, data: { reason: triggerReason } });
      let archived: ArchivedMessage | null = null;
      let quoted: ArchivedMessage | null = null;
      if (effectiveRole !== 'blocked' || config.access.archiveBlocked) {
        const scoped = dependencies.archive.scope(chatId, message.message_thread_id ?? null);
        scopedArchive = scoped;
        archived = scoped.append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: message.message_id,
          tgUpdateId: ctx.update.update_id, direction: 'in', fromKind: 'user', fromUserId: userId,
          fromName: [from.first_name, from.last_name].filter(Boolean).join(' '), fromUsername: from.username ?? null,
          kind: messageKind(message as unknown as Record<string, unknown>), text: message.text ?? message.caption ?? null,
          // reply_to / media_group 的列建表时就有，但一直没人往里写 —— 「回复了谁」是这条消息语义的一部分，
          // 丢了它，事后无论从库里还是从上下文里都看不出用户当时在指着哪一条说话。
          replyToTgMessageId: message.reply_to_message?.message_id ?? null, mediaGroupId: message.media_group_id ?? null,
          tgDate: message.date * 1000, raw: message, triggered: triggerReason !== null, triggerReason });
        pending.push({ payload: message, row: archived });
        if (triggerReason !== null && triggerReason !== 'command') {
          const found = archiveQuotedMessage(bot.botInfo.id, scoped, message, archived);
          if (found) { quoted = found.row; pending.push(found); }
        }
      }
      if (effectiveRole === 'blocked') {
        dependencies.log.event({ level: 'info', kind: 'access.denied', summary: 'blocked principal', chatId, userId, data: { userRole, chatRole: storedChatRole } });
        return null;
      }
      if (!archived) return null;
      return { archived, quoted, effectiveRole, userId, chatId, isPrivate, triggerReason };
    });
    // 锁外：`blocked` 主体（`archiveBlocked` 打开时也归档）同样要补媒体，所以这一步先于 `admitted` 判定。
    // 仍在 `next()` 之前 —— openTurn 物化快照时 parts 必须已经挂上。
    if (scopedArchive) for (const item of pending) await attachMedia(media, scopedArchive, item.payload, item.row);
    if (!admitted) return;
    ingress.set(ctx.update.update_id, admitted);
    try { await next(); } finally { ingress.delete(ctx.update.update_id); }
  });
  const requireRole = async (updateId: number, minimum: Role, reply: (text: string) => Promise<unknown>): Promise<TelegramIngress | null> => {
    const access = ingress.get(updateId);
    if (!access || roleRank(access.effectiveRole) < roleRank(minimum)) {
      await reply('权限不足。');
      return null;
    }
    return access;
  };

  // 命令表就是 /help 的内容，也是 HANDLED_COMMANDS 的对照物（tests/trigger.test.ts 断言三者一致）。
  const COMMANDS: Array<{ name: string; minRole: Role; usage: string; description: string }> = [
    { name: 'start', minRole: 'limited', usage: '/start', description: '自我介绍与你当前的权限' },
    { name: 'help', minRole: 'limited', usage: '/help', description: '可用命令列表' },
    { name: 'ping', minRole: 'limited', usage: '/ping', description: '健康检查' },
    { name: 'new', minRole: 'limited', usage: '/new', description: '开新话题（窗口清零，历史保留）' },
    { name: 'undo', minRole: 'limited', usage: '/undo', description: '撤销上一条上下文提交' },
    { name: 'ctx', minRole: 'limited', usage: '/ctx', description: '上下文窗口与提交状态' },
    { name: 'cancel', minRole: 'limited', usage: '/cancel [id]', description: '取消在途任务' },
    { name: 'tasks', minRole: 'limited', usage: '/tasks', description: '在途任务列表' },
    { name: 'memory', minRole: 'limited', usage: '/memory', description: '查看自己的私有记忆（仅私聊）' },
    { name: 'forgetme', minRole: 'limited', usage: '/forgetme', description: '清空自己的私有记忆（仅私聊）' },
    { name: 'whoami', minRole: 'limited', usage: '/whoami', description: '自己的角色与有效权限' },
    { name: 'usage', minRole: 'owner', usage: '/usage', description: '累计用量' },
    { name: 'webui', minRole: 'owner', usage: '/webui', description: '生成一次性控制台登录链接（仅私聊，5 分钟有效）' },
    { name: 'model', minRole: 'trusted', usage: '/model [alias]', description: '查看/固定本会话模型别名' },
    { name: 'whois', minRole: 'owner', usage: '/whois <id>', description: '查某个主体的角色' },
    { name: 'grant', minRole: 'owner', usage: '/grant <user|chat> <id> <role>', description: '授权' },
    { name: 'revoke', minRole: 'owner', usage: '/revoke <id>', description: '降为 blocked' },
  ];
  bot.command('start', async (ctx) => {
    const access = await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text));
    if (!access) return;
    await ctx.reply(`我是 ${bot.botInfo.first_name}。直接说话就行；群里 @我、回复我、或用唤醒词都能叫我。\n`
      + `你当前的权限：${access.effectiveRole}。\n发 /help 看可用命令。`);
  });
  bot.command('help', async (ctx) => {
    const access = await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text));
    if (!access) return;
    const lines = COMMANDS.filter((entry) => roleRank(access.effectiveRole) >= roleRank(entry.minRole)).map((entry) => `${entry.usage} — ${entry.description}`);
    await ctx.reply(`可用命令（按你当前权限 ${access.effectiveRole} 过滤）：\n${lines.join('\n')}`);
  });
  bot.command('whois', async (ctx) => {
    if (!await requireRole(ctx.update.update_id, 'owner', (text) => ctx.reply(text))) return;
    const parsed = parsePrincipal(ctx.match);
    if (!parsed) { await ctx.reply('用法：/whois <id>，或 /whois <user|chat> <id> —— id 必须是 Telegram 数字 id。'); return; }
    const kinds = parsed.kind ? [parsed.kind] : ['user', 'chat'] as const;
    const found = kinds.map((kind) => ({ kind, role: dependencies.principals.roleOf(kind, parsed.tgId) })).filter((entry) => entry.role !== null);
    await ctx.reply(found.length ? found.map((entry) => `${entry.kind}:${parsed.tgId} = ${entry.role}`).join('\n') : `没有 ${parsed.tgId} 的记录（未见过的主体按默认角色处理）。`);
  });
  bot.command('ping', async (ctx) => {
    const access = await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text));
    if (!access) return;
    const detail = access.effectiveRole === 'owner' ? `\n${JSON.stringify(dependencies.operations.dashboard())}` : '';
    await ctx.reply(`LuoLiCore ${process.env.npm_package_version ?? 'dev'}\n运行正常\n有效权限：${access.effectiveRole}${detail}`);
  });
  /**
   * 一次性登录链接（docs/09 §2.3）。**只在 owner 私聊里给** —— 群里发出来等于把 owner 全权限
   * 递给屏幕前的所有人，而这条链接换的是一个不需要口令的 session。
   *
   * 链接自己不进归档：`/webui` 是 `HANDLED_COMMANDS`，命令消息本来就不进上下文（docs/14 A6），
   * 但回复是 bot 发的，所以这里显式不走 `scoped.append` —— 一个能登录的 URL 落进消息表，
   * 泄露面比口令还大。
   */
  bot.command('webui', async (ctx) => {
    const access = await requireRole(ctx.update.update_id, 'owner', (text) => ctx.reply(text));
    if (!access) return;
    if (!access.isPrivate) { await ctx.reply('这个命令只在私聊里用 —— 登录链接不该出现在群里。'); return; }
    const base = currentConfig().webui.publicUrl.trim().replace(/\/$/, '');
    if (!base) { await ctx.reply('还没配 `webui.publicUrl`，生成不出可点的链接。去设置页填上对外可访问的地址（例如 https://luoli.example.com）。'); return; }
    const issued = dependencies.issueLoginToken?.();
    if (!issued) { await ctx.reply('这个部署没装配 WebUI，登录链接不可用。'); return; }
    dependencies.log.event({ level: 'warn', kind: 'webui.action', summary: 'one-time login link issued via /webui', userId: access.userId });
    await ctx.reply(`${base}/login?t=${issued.token}\n\n5 分钟内有效、只能用一次，进程重启即失效。别转发。`, { link_preview_options: { is_disabled: true } });
  });
  bot.command('new', async (ctx) => {
    const key = contextKey({ chatId: String(ctx.chat.id), messageThreadId: ctx.message?.message_thread_id ?? null }, config.context.scope);
    if (!await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text))) return;
    dependencies.context.reset(key, `command:${ctx.from?.id ?? 'unknown'}`);
    await ctx.reply('已开启新话题，历史记录仍保留。');
  });
  bot.command('undo', async (ctx) => {
    const key = contextKey({ chatId: String(ctx.chat.id), messageThreadId: ctx.message?.message_thread_id ?? null }, config.context.scope);
    if (!await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text))) return;
    await ctx.reply(dependencies.context.undo(key) ? '已撤销上一条上下文提交。' : '没有可撤销的提交。');
  });
  // 摘要而不是整份 JSON：stats() 带着窗口内全部消息及其 parts，活跃会话轻松越过 Telegram 的
  // 4096 字符上限，API 400 之后用户看到的是彻底的沉默（docs/20 · W-TG-02）。完整数据看 WebUI。
  bot.command('ctx', async (ctx) => {
    const key = contextKey({ chatId: String(ctx.chat.id), messageThreadId: ctx.message?.message_thread_id ?? null }, config.context.scope);
    if (!await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text))) return;
    const stats = dependencies.context.stats(key) as { commit: { id: string; seq: number; windowStart: number; headOrdinal: number } | null; messageCount: number; tokens: number; claimWatermark: number };
    const commit = stats.commit;
    await ctx.reply(commit
      ? `上下文 ${key}\ncommit ${commit.id.slice(0, 12)}（第 ${commit.seq} 次）\n窗口 ordinal ${commit.windowStart}–${commit.headOrdinal}\n${stats.messageCount} 条消息 / 约 ${stats.tokens} tokens（上限 ${config.context.limit.maxMessages} 条 / ${config.context.limit.tokens} tokens）\n完整时间线见 WebUI：http://${config.webui.host}:${config.webui.port}/chats/${encodeURIComponent(key)}`
      : `上下文 ${key} 还是空的，还没有提交过任何一轮。`);
  });
  bot.command('tasks', async (ctx) => {
    const tasks = dependencies.turns.active(String(ctx.chat.id)) as Array<{ id: string; state: string; started_at?: number }>;
    if (!await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text))) return;
    await ctx.reply(tasks.length
      ? `在途任务 ${tasks.length} 个：\n${tasks.slice(0, 20).map((task) => `${task.id.slice(0, 12)} ${task.state}${task.started_at ? ` 已运行 ${Math.round((Date.now() - task.started_at) / 1000)}s` : ''}`).join('\n')}`
      : '当前没有在途任务。');
  });
  bot.command('model', async (ctx) => {
    const access = await requireRole(ctx.update.update_id, 'trusted', (text) => ctx.reply(text));
    if (!access) return;
    const key = contextKey({ chatId: String(ctx.chat.id), messageThreadId: ctx.message?.message_thread_id ?? null }, config.context.scope);
    const requested = ctx.match.trim();
    if (!requested) {
      await ctx.reply(`当前模型别名：${readAppKv<string>(dependencies.db, modelAliasKey(key)) ?? config.agent.main.modelAlias}`);
      return;
    }
    if (!['main', 'high', 'low', 'vision'].includes(requested)) { await ctx.reply('未知模型别名。可选：main / high / low / vision'); return; }
    // 写 app_kv 而不是 config_kv：config_kv 的每一行都会被当成配置覆盖层解析（docs/19 · R-CFG-01）。
    writeAppKv(dependencies.db, modelAliasKey(key), requested, `command:${ctx.from?.id ?? 'unknown'}`);
    await ctx.reply(`当前会话模型已固定为 ${requested}`);
  });
  bot.command('whoami', async (ctx) => {
    if (!await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text))) return;
    const userId = String(ctx.from?.id ?? '');
    const chatId = String(ctx.chat.id);
    const user = dependencies.principals.roleOf('user', userId) ?? config.access.defaultUserRole;
    const chat = dependencies.principals.roleOf('chat', chatId) ?? (ctx.chat.type === 'private' ? user : config.access.defaultChatRole);
    await ctx.reply(`user=${user} chat=${chat} effective=${resolveEffectiveRole({ userRole: user, chatRole: chat, isPrivate: ctx.chat.type === 'private', defaultChatRole: config.access.defaultChatRole })}`);
  });
  bot.command('grant', async (ctx) => {
    if (!await requireRole(ctx.update.update_id, 'owner', (text) => ctx.reply(text))) return;
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const role = parts.at(-1) ?? '';
    // 主体串交给 `parsePrincipal`：此前 `/grant user @alice owner` 一路通过，写出一条
    // `tg_id='@alice'` 的主体行 —— 永远匹配不到任何消息，命令还回「已设置」（docs/27 · C-05）。
    const parsed = parts.length >= 2 ? parsePrincipal(parts.slice(0, -1).join(' ')) : null;
    if (!parsed?.kind || !['owner', 'trusted', 'limited', 'blocked'].includes(role)) { await ctx.reply('用法：/grant <user|chat> <id> <role> —— id 必须是 Telegram 数字 id（群/频道为负数）。'); return; }
    dependencies.principals.upsertSeen({ id: parsed.id, kind: parsed.kind, tgId: parsed.tgId, role: role as Role, displayName: null, username: null, chatType: null }, `command:${ctx.from?.id}`);
    dependencies.principals.setRole(parsed.id, role as Role, `command:${ctx.from?.id}`);
    await ctx.reply(`已设置 ${parsed.id} = ${role}`);
  });
  bot.command('revoke', async (ctx) => {
    if (!await requireRole(ctx.update.update_id, 'owner', (text) => ctx.reply(text))) return;
    const parsed = parsePrincipal(ctx.match);
    if (!parsed) { await ctx.reply('用法：/revoke <user|chat> <id>，或 /revoke <id>（两种主体都试）。'); return; }
    // 裸 id 两种主体都试。`/grant` 收的是 `<kind> <id>`，而这里此前只收完整主体 id ——
    // 于是 `/revoke 123456`（owner 最可能敲的写法）静默无效，只回一句「主体不存在」。
    const targets = parsed.kind ? [parsed.id] : [`user:${parsed.tgId}`, `chat:${parsed.tgId}`];
    const revoked = targets.filter((id) => dependencies.principals.setRole(id, 'blocked', `command:${ctx.from?.id}`));
    await ctx.reply(revoked.length ? `已撤销 ${revoked.join('、')}` : '主体不存在。');
  });
  bot.command('memory', async (ctx) => {
    const access = await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text));
    if (!access) return;
    if (!access.isPrivate) { await ctx.reply('私有记忆只能在私聊查看。'); return; }
    const document = dependencies.memory.read('primemory', access.userId, access.effectiveRole, access.userId, true);
    await ctx.reply(document.content || '尚无私有记忆。');
  });
  bot.command('forgetme', async (ctx) => {
    const access = await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text));
    if (!access) return;
    if (!access.isPrivate) { await ctx.reply('请在私聊中执行 /forgetme。'); return; }
    await ctx.reply(dependencies.memory.forgetPrivate(access.userId) ? '已清空你的私有记忆；版本记录按保留策略保存。' : '尚无私有记忆。');
  });
  bot.command('cancel', async (ctx) => {
    const access = await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text));
    if (!access) return;
    const id = ctx.match.trim() || dependencies.registry.latest(access.chatId, access.userId)?.id;
    if (!id || !dependencies.registry.cancel(id, access.userId, access.effectiveRole)) { await ctx.reply('没有可取消的任务，或你无权取消。'); return; }
    await ctx.reply('⛔ 已取消');
  });
  bot.on('edited_message', async (ctx) => {
    const message = ctx.editedMessage;
    const from = message.from;
    if (!from) return;
    const chatId = String(message.chat.id);
    const userId = String(from.id);
    const isPrivate = message.chat.type === 'private';
    const userRole = dependencies.principals.roleOf('user', userId) ?? config.access.defaultUserRole;
    const storedChatRole = dependencies.principals.roleOf('chat', chatId);
    const effectiveRole = resolveEffectiveRole({ userRole, ...(storedChatRole ? { chatRole: storedChatRole } : {}), isPrivate, defaultChatRole: config.access.defaultChatRole });
    if (effectiveRole === 'blocked' && !config.access.archiveBlocked) return;
    const row = dependencies.db.prepare('SELECT COALESCE(MAX(revision),-1)+1 AS revision FROM messages WHERE chat_id=? AND tg_message_id=?').get(chatId, message.message_id) as { revision: number };
    // 编辑永远不开新轮次（`trigger.ignoreEditedAsTrigger` 因此标 🚧）。但也绝不能记成 triggered=1：
    // claimBackground 只认领 triggered=0 的消息，被判成触发却没人开轮次的编辑等于凭空消失
    // ——既不回应、也不进背景上下文（docs/20 · W-TG-05）。统一按背景消息归档。
    const editedTrigger = perChatConfig(currentConfig(), contextKey({ chatId, messageThreadId: message.message_thread_id ?? null }, config.context.scope)).trigger;
    const wouldTrigger = matchTrigger(ctx, { ...editedTrigger, strictCommandSuffix: config.telegram.strictCommandSuffix }, bot.botInfo.id, bot.botInfo.username);
    if (wouldTrigger) dependencies.log.event({ level: 'info', kind: 'trigger.skipped', summary: 'edited message would trigger but edits never open a turn', chatId, userId, data: { reason: wouldTrigger, tgMessageId: message.message_id } });
    dependencies.archive.scope(chatId, message.message_thread_id ?? null).append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: message.message_id, tgUpdateId: ctx.update.update_id,
      direction: 'in', fromKind: 'user', fromUserId: userId, fromName: [from.first_name, from.last_name].filter(Boolean).join(' '), fromUsername: from.username ?? null,
      kind: messageKind(message as unknown as Record<string, unknown>), text: message.text ?? message.caption ?? null, tgDate: message.edit_date ? message.edit_date * 1000 : Date.now(), raw: message,
      triggered: false, triggerReason: null, revision: row.revision });
  });
  bot.on('my_chat_member', async (ctx) => {
    const member = ctx.myChatMember;
    const chatId = String(member.chat.id);
    const active = !['left', 'kicked'].includes(member.new_chat_member.status);
    dependencies.principals.upsertSeen({ id: `chat:${chatId}`, kind: 'chat', tgId: chatId, role: dependencies.principals.roleOf('chat', chatId) ?? config.access.defaultChatRole,
      displayName: ('title' in member.chat ? member.chat.title : null) ?? null, username: 'username' in member.chat ? member.chat.username ?? null : null, chatType: member.chat.type }, 'telegram:my_chat_member');
    dependencies.log.event({ level: 'info', kind: 'tg.membership', summary: active ? 'bot added to chat' : 'bot removed from chat', chatId, data: { status: member.new_chat_member.status } });
  });
  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.callbackQuery.data.startsWith('c:')) return;
    const turnId = ctx.callbackQuery.data.slice(2);
    const userId = String(ctx.from.id);
    const role = dependencies.principals.roleOf('user', userId) ?? config.access.defaultUserRole;
    const cancelled = dependencies.registry.cancel(turnId, userId, role);
    await ctx.answerCallbackQuery(cancelled ? '已取消' : { text: '只有发起人或管理员可以取消', show_alert: true });
  });
  bot.command('usage', async (ctx) => {
    if (!await requireRole(ctx.update.update_id, 'owner', (text) => ctx.reply(text))) return;
    const report = dependencies.operations.dashboard();
    await ctx.reply(`当前累计用量：${JSON.stringify(report)}`);
  });

  bot.on('message', async (ctx) => {
    const receivedAt = Date.now();
    const access = ingress.get(ctx.update.update_id);
    if (!access) return;
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;
    const { userId, chatId, effectiveRole, archived, quoted, triggerReason } = access;
    const message = ctx.message;
    if (!triggerReason || triggerReason === 'command') return;
    // `trigger.cooldownMsPerUser`：同一个人连着 @ 好几句时，只开第一轮。**被压住的那条不会消失**
    // ——它已经以 triggered=0 落库（下面这行改的就是这个），所以下一轮的背景认领会把它带进上下文。
    // 与 `quota.rateLimit` 是两件事：那个按小时算配额，这个按秒防连点。
    const cooldownMs = config.trigger.cooldownMsPerUser;
    if (cooldownMs > 0) {
      const last = triggerCooldown.get(userId) ?? 0;
      if (receivedAt - last < cooldownMs) {
        dependencies.archive.scope(chatId, message.message_thread_id ?? null).demoteToBackground(archived.id);
        dependencies.log.event({ level: 'debug', kind: 'trigger.cooldown', summary: 'trigger suppressed by per-user cooldown', chatId, userId, data: { cooldownMs, sinceMs: receivedAt - last } });
        return;
      }
      triggerCooldown.set(userId, receivedAt);
      // 有界：一个群里换一批人说话就是一批新键，不清的话这张表只涨不落。
      // 只删过期项**挡不住上界**：`cooldownMsPerUser` 较大时，短时间内超过 4096 个不同发言人
      // 一个都不过期，这张表照样越过上界继续涨（docs/27 · R-07）。所以清完还超的话按插入序
      // （Map 的迭代序）再淘汰最旧的那些 —— 它们本来也是最接近过期的。
      if (triggerCooldown.size > 4096) {
        for (const [key, at] of triggerCooldown) if (receivedAt - at >= cooldownMs) triggerCooldown.delete(key);
        while (triggerCooldown.size > 4096) triggerCooldown.delete(triggerCooldown.keys().next().value!);
      }
    }
    // `concurrency.coalesceSameUserMs`：同一个人在窗口内连着说，只为**最后一条**开轮次。
    // 先到的那几条降级成背景消息 —— 它们的正文照样进这一轮的上下文（`claimBackground` 认领），
    // 只是渲染成 `[名字 时间] …` 而不是触发消息。这与 docs/02 §215 早先设想的「追加进同一份
    // delta」不是一回事：往**已经在跑**的轮次里塞新的 user 消息会撞上 `finalized` 后禁止
    // `appendDelta` 的不变量，那是上下文引擎的红线。默认 0（关）。
    const coalesceMs = config.concurrency.coalesceSameUserMs;
    if (coalesceMs > 0) {
      const coalesceKey = `${chatId}:${userId}`;
      coalescing.get(coalesceKey)?.supersede();
      let superseded = false;
      let wake: () => void = () => undefined;
      const waiter = { supersede: () => { superseded = true; wake(); } };
      coalescing.set(coalesceKey, waiter);
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, coalesceMs);
        timer.unref?.();
      });
      if (coalescing.get(coalesceKey) === waiter) coalescing.delete(coalesceKey);
      if (superseded) {
        dependencies.archive.scope(chatId, message.message_thread_id ?? null).demoteToBackground(archived.id);
        dependencies.log.event({ level: 'debug', kind: 'trigger.coalesced', summary: 'superseded by a later message from the same user', chatId, userId, data: { coalesceMs } });
        return;
      }
    }
    // `inFlight` 走进程内的注册表而不是 `turns` 表：从这里到 `registry.register` 之间**没有 await**，
    // 所以这个判据是真的能挡住同一个人两条并发消息的（docs/27 · R-04）。
    if (!dependencies.quota.canStart({ chatId, userId, turnsPerUserPerHour: config.quota.rateLimit.turnsPerUserPerHour,
      turnsPerChatPerHour: config.quota.rateLimit.turnsPerChatPerHour, concurrentPerUser: config.quota.rateLimit.concurrentPerUser,
      inFlight: dependencies.registry.countForUser(userId) })) {
      // 判成触发却没人开轮次的消息必须降级成背景（同 `cooldownMsPerUser` 那一路，docs/20 · W-TG-05）：
      // `claimBackground` 只认领 `triggered=0`，留着 1 的话这条消息既没被回答、也进不了下一轮的上下文。
      dependencies.archive.scope(chatId, message.message_thread_id ?? null).demoteToBackground(archived.id);
      // `concurrentPerUser` 挡下来的不是额度：这个人手上还有轮次在跑，说完就能接着说。入口串行的
      // 年代这一档碰不到，所以一直和额度共用同一句文案 —— 而「今天的额度用完了」会让人当天不再尝试。
      // 这句不受 `onExceeded.reply` 管：那个开关是给「额度用光」用的，而这里沉默等于 bot 装没看见。
      const rejection = dependencies.quota.lastStartRejection;
      if (rejection === 'concurrent') {
        dependencies.log.event({ level: 'info', kind: 'quota.check', summary: 'concurrent turn limit reached', chatId, userId, data: { concurrentPerUser: config.quota.rateLimit.concurrentPerUser } });
        await ctx.reply(`我同时最多接 ${config.quota.rateLimit.concurrentPerUser} 件事，你手上的还没说完。等它收尾再说这条。`);
      } else if (rejection === 'rate_user' || rejection === 'rate_chat') {
        // **频率这一档也不是额度。** 上面那个论证一字不改地适用：真人看到的原话是「今天的额度
        // 用完了（已用 —/—），下个额度窗口 重置。」而真实原因是「这一小时开了 30 轮」，与金额
        // 无关，占位符还直接漏了出去（docs/28 · L-QUOTA-02）。窗口是**滚动**一小时
        // （`canStart` 数的是 `started_at >= now-1h`），所以说的是「等最早那一轮滚出窗口」而不是
        // 「整点重置」—— 后者会让人在 59 分时白等。
        // 同样不受 `onExceeded.reply` 管，理由与并发那档一致：那个开关是给「额度用光」用的
        // （沉默意味着「今天别再来了」），而频率拒绝沉默等于 bot 对一句正常的话装没看见。
        const perChat = rejection === 'rate_chat';
        const limit = perChat ? config.quota.rateLimit.turnsPerChatPerHour : config.quota.rateLimit.turnsPerUserPerHour;
        dependencies.log.event({ level: 'info', kind: 'quota.check', summary: `hourly turn rate limit reached (${rejection})`, chatId, userId, data: { rejection, limit } });
        // 说「到上限了」而不是「开了 N 轮」：判据是 `count >= limit`，运维中途调小限额时 count
        // 会大于 limit，报一个算不准的数字比不报更糟。
        await ctx.reply(`${perChat ? '这个会话' : '你'}最近一小时开的轮次到频率上限了（每小时 ${limit} 轮，按${perChat ? '会话' : '人'}算，与额度无关）。`
          + '等最早那一轮满一小时滚出窗口就能接着说，最多再等一小时。');
      } else {
        // `canStart` 只有那三档，走到这里说明有人加了第四档却没跟这里对齐。**别再套额度文案** ——
        // 那正是上面两处注释在说的事（占位符会原样漏给用户，而原因根本不是金额）。
        dependencies.log.event({ level: 'warn', kind: 'quota.check', summary: `unhandled start rejection: ${String(rejection)}`, chatId, userId, data: { rejection } });
        await ctx.reply('现在接不了这条，过一会儿再说。');
      }
      return;
    }
    const scoped = dependencies.archive.scope(chatId, message.message_thread_id ?? null);

    const key = contextKey({ chatId, messageThreadId: message.message_thread_id ?? null }, config.context.scope);
    const roleLimits = config.quota.perUser.byRole[effectiveRole];
    // 预留额按「这一轮大概会发出去多少」估：窗口现有水位 + 系统提示词的预算上限。
    // 之前是 `limit.tokens / 4` 这个与本会话无关的常数，空会话高估、长会话严重低估（docs/17 · N-QUOTA-01）。
    const estimatedTokens = Math.max(dependencies.context.windowTokens(key) + config.prompt.maxTokens, 1000);
    const modelEstimate = dependencies.estimateTurnCost?.(estimatedTokens, key) ?? null;
    if (config.quota.enabled && config.quota.requirePricing && effectiveRole !== 'owner' && modelEstimate === null) { await ctx.reply('当前模型缺少定价，无法开始对话。'); return; }
    const reservation = config.quota.enabled ? dependencies.quota.reserve({ chatId, userId,
      estimateUsd: Math.max(config.quota.minReserveUsd, modelEstimate ?? config.quota.minReserveUsd),
      limits: { globalDaily: config.quota.global.daily, globalMonthly: config.quota.global.monthly,
        chatDaily: config.quota.perChat.daily, chatMonthly: config.quota.perChat.monthly,
        userDaily: roleLimits?.daily ?? config.quota.perUser.daily, userMonthly: roleLimits?.monthly ?? config.quota.perUser.monthly } }) : null;
    // **额度关着的时候一条都不落。** 这个三元此前只看 `reservation` 是不是空，而
    // `quota.enabled=false` 时它恒为空 —— 于是每一轮都记一条 `warn quota.exceeded`
    // 「Quota reservation rejected」而轮次照常开（logs/2026-08-18：31 轮里 30 条）。`docs/10` 给这个 kind 定的
    // 字段是 `scope/subject/spent/limit`，额度关着时四个都不存在；而排障时第一眼看到的就是它。
    if (config.quota.enabled) {
      dependencies.log.event({ level: reservation ? 'info' : 'warn', kind: reservation ? 'quota.check' : 'quota.exceeded', summary: reservation ? 'Quota reservation accepted' : 'Quota reservation rejected', chatId, userId, data: { estimatedTokens, estimateUsd: modelEstimate } });
    }
    if (config.quota.enabled && !reservation) {
      // 拒绝的原因分档：global 超限是「整个部署停摆」，必须让 owner 知道；chat / user 超限只是
      // 这个人/这个群用完了（docs/10 §6 的 quota_global_exceeded）。
      const rejection = dependencies.quota.lastRejection;
      const money = (value: number): string => `$${value.toFixed(2)}`;
      if (rejection?.scope === 'global' && config.quota.onExceeded.notifyOwner) {
        dependencies.alerts?.fire('quota_global_exceeded', `全局额度用尽：${rejection.window} 窗口已用 ${money(rejection.spent)} / ${money(rejection.limit)}`,
          { window: rejection.window, spent: rejection.spent, limit: rejection.limit }, rejection.window);
      }
      await ctx.reply(config.quota.onExceeded.message
        .replace('{spent}', rejection ? money(rejection.spent) : '—')
        .replace('{limit}', rejection ? money(rejection.limit) : '—')
        .replace('{resetAt}', rejection?.window === 'month' ? '下月初' : '明天'));
      return;
    }
    const pendingId = crypto.randomUUID();
    const pending = dependencies.registry.register({ id: pendingId, key, chatId, userId, role: effectiveRole }, config.concurrency.turnTimeoutMs);
    let release: (() => void) | null = null;
    try { release = await dependencies.concurrency.acquire(key, pending.controller.signal); }
    catch (error) {
      dependencies.registry.finish(pendingId);
      if (reservation) dependencies.quota.release(reservation);
      // 同上：队列满/被取消也是「触发了但没轮次」，不降级这条消息就彻底丢了。
      dependencies.archive.scope(chatId, message.message_thread_id ?? null).demoteToBackground(archived.id);
      dependencies.log.event({ level: 'warn', kind: 'turn.end', summary: error instanceof Error ? error.message : 'turn queue rejected', chatId, userId, key,
        data: { state: 'rejected', active: dependencies.concurrency.active, queued: dependencies.concurrency.queued } });
      await ctx.reply(error instanceof Error && error.message === 'turn_queue_cancelled' ? '⛔ 已取消' : '当前排队已满，请稍后');
      return;
    }
    // openTurn 之后到大 try 之间的每一行都可能抛（非法时区、坏形状快照、DB 约束）。放在 try 外面时
    // 抛出会永久泄漏并发槽与配额预留，该会话在 perKey 次触发后彻底卡死（docs/19 · R-BOT-01）。
    let turn: RuntimeTurnContext;
    try {
      turn = await dependencies.context.openTurn({ chatId, threadId: message.message_thread_id ?? null, key, initiatorUserId: userId,
        effectiveRole, isPrivate: chat.type === 'private', trigger: archived, ...(quoted ? { quoted } : {}),
        ...('title' in chat && chat.title ? { chatTitle: chat.title } : {}),
        abortSignal: pending.controller.signal, config: perChatConfig(currentConfig(), key) });
      dependencies.registry.finish(pendingId);
      const tracked = dependencies.registry.register({ id: turn.turnId, key, chatId, userId, role: effectiveRole }, config.concurrency.turnTimeoutMs);
      Object.assign(turn, { abortSignal: tracked.controller.signal });
      dependencies.turns.create({ id: turn.turnId, key, chatId, threadId: message.message_thread_id ?? null, userId, role: effectiveRole,
        triggerMessageId: archived.id, triggerReason, baseCommitId: turn.baseCommitId });
    } catch (error) {
      dependencies.registry.finish(pendingId);
      release?.();
      if (reservation) dependencies.quota.release(reservation);
      dependencies.log.event({ level: 'error', kind: 'turn.end', summary: error instanceof Error ? error.message : 'turn setup failed', chatId, userId, key, data: { state: 'setup_failed' } });
      await ctx.reply('出了点问题，已记录。');
      return;
    }
    dependencies.log.event({ level: 'info', kind: 'turn.start', summary: `Turn ${turn.turnId} started`, traceId: turn.turnId, chatId, userId, key, data: { role: effectiveRole, triggerReason } });
    // 总览页的在途 turn 表只有这一个数据来源：`GET /api/turns/active` 给首屏，之后靠这三种事件增量更新。
    dependencies.log.publish('turn.started', { turnId: turn.turnId, key, chatId, user: userId, role: effectiveRole, triggerReason, at: Date.now() });
    try {
      const generated = dependencies.onTurn ? await dependencies.onTurn(turn, reservation) : '尚未配置可用模型。请在 WebUI 中添加 Provider、模型和 main 别名。';
      let answer: string;
      /** 流吐过内容之后才断掉（`/cancel`、`turnTimeoutMs`、上游中途挂）。见下面收尾那一段。 */
      let broken = false;
      // doc 11 §2.1 把 output.* 列进 perChat 白名单，投递侧却一直读的是全局快照 —— 会话级
      // 的 mode/节奏覆盖存得住、也过了校验，就是永远不生效。取本轮那份合并后的配置。
      const outputConfig = perChatConfig(currentConfig(), key).output;
      // 解析失败降级成纯文本这一跳此前一个字都不落，于是行内代码那个 bug 只能靠翻下一次模型调用的
      // context blob 反推（docs/00 §2.3）。两条投递路径共用这一个回调。
      const onParseFallback = (info: ParseFallbackInfo): void => void dependencies.log.event({ level: 'warn', kind: 'tg.parse_fallback',
        summary: `${outputConfig.parseMode} 渲染被拒，已降级成纯文本${info.phase === 'edit' ? '重编辑' : '重发'}`,
        traceId: turn.turnId, chatId, userId, key, data: { chars: info.chars, error: info.error, phase: info.phase } });
      if (typeof generated === 'string') {
        const hooked = dependencies.plugins ? pluginText(await dependencies.plugins.hook('beforeSend', { turn, text: generated }), generated) : generated;
        // `output.maxMentions` 在**投递侧**收口：提示词里说好不要 @全群不是边界，这里才是。
        const outgoing = capMentions(hooked, outputConfig.maxMentions);
        await holdReply(receivedAt, outputConfig.replyDelayMs);
        // 引用触发消息：与流式那条路（`TelegramOutput.consume`）必须一致。此前这条兜底路径不带
        // 引用，于是「尚未配置可用模型」这类提示在群里飘着，没人知道它在回谁（docs/14 §2 Q10）。
        // **只有第一条分片带**，否则一条长回复会在群里刷出一串引用块。
        // 分片要跟着 parseMode 走：三档各有自己的渲染器，按一档渲染再按另一档声明发出去，
        // 用户看到的就是转义符本身（docs/08 §5.3）。
        const segmented = segmentTelegramText(outgoing, outputConfig.maxMessageChars, outputConfig.parseMode);
        // 这一批分段按 chat 串行（docs/28 · L-TG-02）：段与段之间那个空档里挤进别的轮次的
        // `sendMessage` 时，用户看到的是「最后一段在后面几条回复之后才冒出来」。
        await deliveryOrder.run(chatId, async () => {
          for (const [index, part] of segmented.rendered.entries()) {
            const sent = await sendWithFallback(bot.api, chatId, part, index === 0 ? { reply_parameters: { message_id: message.message_id } } : {}, outputConfig.parseMode, onParseFallback);
            // 归档存**渲染前**的正文，与流式那条路（下面存 `answer`）一致。存 `part` 的话
            // `messages.text` 里躺的是 MarkdownV2 转义后的文本 —— WebUI 会话页和 `read_messages`
            // 看到的 bot 发言带一串 `\-` `\.`，同一张表里两条路径两种内容。**分片时每个
            // `message_id` 存自己那一段**（`segmentTelegramText`，docs/28 · L-TG-03）：此前这里给
            // 每一段都存一份完整全文，三段的回复在 `messages` 与 `messages_fts` 里各躺三份。
            scoped.append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: sent.message_id, direction: 'out', fromKind: 'bot', fromUserId: String(bot.botInfo.id), fromName: bot.botInfo.first_name, fromUsername: bot.botInfo.username,
              kind: 'text', text: segmented.archived[index] ?? outgoing, tgDate: sent.date * 1000, raw: sent, triggered: false, turnId: turn.turnId });
          }
        });
        answer = outgoing;
      } else {
        const output = new TelegramOutput(bot, chatId, { mode: outputConfig.mode, replyDelayMs: outputConfig.replyDelayMs, bufferMs: outputConfig.streamBufferMs, intervalMs: outputConfig.streamIntervalMs, minDeltaChars: outputConfig.streamMinDeltaChars, maxChars: outputConfig.maxMessageChars,
          parseMode: outputConfig.parseMode, flushOnSentence: outputConfig.flushOnSentence, typingWhileWorking: outputConfig.typingWhileWorking, placeholderAfterMs: outputConfig.placeholderAfterMs,
          placeholderTexts: outputConfig.placeholderTexts, placeholderPick: outputConfig.placeholderPick, placeholderIndex: outputConfig.placeholderIndex },
          (error) => dependencies.log.event({ level: 'warn', kind: 'tg.error', summary: 'Streaming delivery failed', traceId: turn.turnId, chatId, data: { error: error instanceof Error ? error.message : String(error) } }), receivedAt,
          // 插件钩子只在定稿时跑一次；`capMentions` 是每帧都要过的那一道 —— 拆成两个回调之前
          // 它俩合在这个 async 闭包里，而流式编辑路径压根不调它，「@ 全群上限」于是形同虚设。
          async (text) => (dependencies.plugins ? pluginText(await dependencies.plugins.hook('beforeSend', { turn, text }), text) : text),
          (text) => capMentions(text, outputConfig.maxMentions));
        output.onParseFallback = onParseFallback;
        const consumed = await output.consume(generated.stream, message.message_id);
        if (consumed.interrupted) {
          broken = true;
          // `interrupt()` 先放开 `drained`，否则下面那个 await 会永远悬着（流中途抛的时候
          // `streamDone()` 所在的收尾回调压根没跑到）。
          generated.interrupt();
          // **一个字都没投出去时不能把原因吞掉。** 真正的错误在 `final` 那条链上（`streamFailure`）；
          // 这里 `answer = ''` 会让整轮以含糊的 `model_returned_empty` 收尾，而那正是 runtime 那份
          // `onExhausted` 要避免的事 —— 用户该看到「模型服务暂时连不上」而不是「没吐出正文」。
          if (!consumed.text.trim()) answer = await generated.final;
          else { void generated.final.catch(() => undefined); answer = consumed.text; }
        }
        // **归档与上下文一律存「真正发出去的那份」**，也就是流里攒到的全文。
        // `generated.final` 是 AI SDK 的 `result.text` = **最后一步**的正文，而多步轮次发给用户的是
        // 「旁白段落 + 结论」整条消息 —— 拿 final 落库的话，屏幕上有三段、`read_messages` 与
        // WebUI 会话页只有最后一段，下一轮模型也看不见自己的旁白，用户一句「你上面第二段说的」
        // 就无从对应。实测两轮真实多步（logs/2026-08-18 验证轮）都是这个差异。
        // final 仍然留着当**失败信号**：它为空意味着最后一步没吐正文，那条 warn 照记。
        else {
          const final = await generated.final;
          answer = consumed.text.trim() ? consumed.text : final;
          // 这条回落此前一个字都不落日志（docs/00 §2.3）。它意味着「最后一步没有正文」——
          // 而流里攒到的很可能只是工具调用之间的过程旁白，被当成了答复提交进上下文（本次事故）。
          // 收尾补跑（runtime 的 `wrapUpIfNeeded`）能救大多数，救不了的至少要在日志里留下痕迹。
          if (!final.trim()) dependencies.log.event({ level: 'warn', kind: 'turn.no_final_text', summary: 'Last step produced no text; fell back to streamed narration',
            traceId: turn.turnId, chatId, userId, key, data: { streamedChars: consumed.text.length, messages: consumed.messageIds.length } });
        }
        // **分段时每个 `message_id` 存自己那一段**（docs/28 · L-TG-03）：此前这个循环给每一段都存
        // `answer`，一条 9469 字切成 3 条的回复于是在 `messages` 里躺三行 9469 字、`messages_fts`
        // 三份，`search_messages` 把同一条回复搜出三次。`segments` 只在真的分片时非空 —— 单条那一路
        // 存的仍是模型原话（`answer`），而 `segments` 出自改写并渲染之后的文本。
        // 上下文侧不动：下面 `appendDelta` 仍是一条整全文。
        for (const [index, messageId] of consumed.messageIds.entries()) scoped.append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: messageId, direction: 'out', fromKind: 'bot', fromUserId: String(bot.botInfo.id), fromName: bot.botInfo.first_name, fromUsername: bot.botInfo.username,
          kind: 'text', text: consumed.segments[index] ?? answer, tgDate: Date.now(), raw: { streamed: true, interrupted: consumed.interrupted }, triggered: false, turnId: turn.turnId });
      }
      // 空正文既发不出去（splitTelegramText('') 是空数组，用户看到的是彻底的沉默），
      // 又会把一条空的 assistant 消息留进上下文。当成失败处理：至少用户知道这轮没成，
      // 而且下一轮的 prompt 里不会多一条谁都解释不了的空消息（docs/16 §5「摘除比伪造安全」）。
      if (!answer.trim()) throw new Error('model_returned_empty');
      dependencies.context.appendDelta(turn, { id: turn.turnId, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: answer }], textPreview: answer.slice(0, 240), pruneLevel: 0 });
      const committed = await dependencies.context.commitTurn(turn);
      /**
       * **流吐过内容之后才断掉的轮次：delta 照常提交，但状态不许记成 committed。** 这正是
       * docs/04 §5.3 点名要「在实现中显式处理」的那条 —— §1「delta 不提交」规则的唯一例外：
       * 内容已经在用户屏幕上，上下文必须与用户所见一致，可这一轮确实没跑完。
       *
       * 此前这里只有一条 committed 分支，于是 `turnTimeoutMs` 到点被 abort、而前面某一步已经吐过
       * 旁白的轮次，会以「成功」收尾：用户没有任何提示、`turns` 那行是 committed、
       * `consecutiveFailures` 还被清零（实测 logs/2026-08-18 · B8F92Z：19:13:03 `model.error
       * timeout` = 600 秒到点，19:16:04 `turn.end turn committed`）。「（生成中断）」那个后缀由
       * `TelegramOutput.consume` 在同一条 `interrupted` 上加。
       */
      /**
       * **超时不是取消。** 两者都是 abort，可判据只看 `aborted` 的话，`turnTimeoutMs` 到点的轮次
       * 会记 `cancelled` 并被下面的 `failures.failed` 跳过 —— 于是「每一轮都卡满十分钟」这种最该响的
       * 故障一次告警都不响（`logs/2026-08-18`：三十来轮全记 cancelled，`consecutiveFailures`
       * 一次没涨）。`docs/04 §5.3` 现在把收尾分三档：`/cancel` → cancelled；超时 → failed 且计入；
       * 上游自己挂 → failed。用户可见文案仍按 `reason` 分（收到「已取消」的人会以为自己误触了）。
       */
      const timedOut = turn.abortSignal.reason === 'timeout';
      const cancelled = broken && turn.abortSignal.aborted && !timedOut;
      const state = broken ? (cancelled ? 'cancelled' : 'failed') : 'committed';
      const settled = dependencies.turns.finish(turn.turnId, { state, commitId: committed.commit.id, rebased: committed.rebased,
        // 超时那一档两个字段都带：`cancel_reason='timeout'` 说清是谁掐的，`error` 让它在失败列表里
        // 与「上游中途挂了」分得开。
        ...(cancelled || timedOut ? { cancelReason: String(turn.abortSignal.reason ?? 'cancelled') } : {}),
        ...(state === 'failed' ? { error: timedOut ? 'turn_timeout' : 'stream_interrupted' } : {}) });
      await dependencies.plugins?.hook('afterCommit', { turn, committed });
      dependencies.log.event({ level: broken ? 'warn' : 'info', kind: 'turn.end',
        summary: broken ? `${cancelled ? 'turn cancelled' : timedOut ? 'turn timed out' : 'turn failed'} after partial delivery` : 'turn committed',
        traceId: turn.turnId, chatId, userId, key, data: { state, rebased: committed.rebased, ...(broken ? { deliveredChars: answer.length } : {}) } });
      dependencies.log.publish('turn.finished', { turnId: turn.turnId, key, chatId, state, steps: settled?.steps ?? 0, toolCalls: settled?.toolCalls ?? 0, costUsd: settled?.costUsd ?? 0, rebased: committed.rebased, durationMs: settled?.durationMs ?? 0 });
      // 工具真的跑过、结果也进了已提交的上下文：记忆写入跟着提交走，否则上下文说「写好了」而库里没有。
      dependencies.memory.flush(turn.turnId);
      // 断掉的一轮不清零（它不是一次成功），但也只有 `failed` 才计入连续失败 —— 取消不算故障，
      // 超时算（`docs/04 §5.3` 的三档）。
      if (!broken) failures.succeeded();
      else if (!cancelled) failures.failed(timedOut ? 'turn_timeout' : 'stream_interrupted');
      // `quota.warnAtRatio`：跨过预警线时在回复后补一句，每个 bucket 只提示一次（docs/10 §5.4）。
      // 提示挂在成功那一轮的后面而不是单独发一条：多一条消息在群里是噪音。
      if (reservation) {
        const warning = dependencies.quota.warning(reservation, config.quota.warnAtRatio);
        if (warning) await ctx.reply(`（${warning.window === 'month' ? '本月' : '今日'}额度已用 ${Math.round(warning.spent / warning.limit * 100)}%）`).catch(() => undefined);
      }
    } catch (error) {
      // 与上面那一路同一份判据：超时是故障，不是取消（`docs/04 §5.3`）。这条路上的表现更直接 ——
      // 一个字都没投递出去的超时轮次此前也记 cancelled，于是上游变黑洞时连续失败告警永不触发。
      const timedOut = turn.abortSignal.reason === 'timeout';
      const cancelled = turn.abortSignal.aborted && !timedOut;
      // `abortTurn` 也在写库（`releaseClaims`，`cancel.commitPartial` 开着时还会跑一整个
      // `commitTurn`）。它抛出去的话下面这行就不执行了，`turns` 那行会一直是 `state='running'`
      // —— `GET /api/turns/active` 与总览页的 running 计数在整个进程生命周期内都是错的，
      // 直到下次重启的 `recoverAfterCrash` 才收拾。清理是尽力而为，**记状态不是**。
      try { await dependencies.context.abortTurn(turn, cancelled ? 'cancelled' : 'failed', error); }
      catch (cleanup) { dependencies.log.event({ level: 'error', kind: 'ctx.abort', summary: 'abortTurn failed; turn still recorded as ended', traceId: turn.turnId, chatId, userId, key, data: { error: cleanup instanceof Error ? cleanup.message : String(cleanup) } }); }
      const settled = dependencies.turns.finish(turn.turnId, cancelled
        ? { state: 'cancelled', cancelReason: String(turn.abortSignal.reason ?? 'cancelled') }
        : { state: 'failed', error: timedOut ? 'turn_timeout' : error instanceof Error ? error.message : String(error), ...(timedOut ? { cancelReason: 'timeout' } : {}) });
      dependencies.log.event({ level: cancelled ? 'warn' : 'error', kind: 'turn.end', summary: cancelled ? 'turn cancelled' : timedOut ? 'turn timed out' : error instanceof Error ? error.message : 'turn failed', traceId: turn.turnId, chatId, userId, key });
      dependencies.log.publish('turn.finished', { turnId: turn.turnId, key, chatId, state: cancelled ? 'cancelled' : 'failed', steps: settled?.steps ?? 0, toolCalls: settled?.toolCalls ?? 0, costUsd: settled?.costUsd ?? 0, rebased: false, durationMs: settled?.durationMs ?? 0 });
      // 连续 5 轮失败是「整个部署坏了」的信号（docs/10 §6）。取消不算 —— 用户点了取消不是故障；
      // 超时算，而且它正是那个信号最该覆盖的场景（上游变黑洞时每一轮都走这条路）。
      if (!cancelled) failures.failed(timedOut ? 'turn_timeout' : error instanceof Error ? error.message : String(error));
      // 记账上超时算故障，**对用户仍是另一句话**：没点过取消的人收到「已取消」只会以为自己误触了，
      // 而收到一句通用的失败提示也说不出「这一轮卡了十分钟」。
      await ctx.reply(timedOut ? `这一轮太久没有进展，已经停下了。(ref: ${turn.turnId.slice(0, 12)})`
        : cancelled ? '⛔ 已取消'
        : failureText(error, turn.turnId.slice(0, 12)));
    } finally {
      dependencies.tools?.releaseTurn(turn.turnId);
      dependencies.approvals?.releaseTurn(turn.turnId);
      dependencies.memory.discard(turn.turnId);
      dependencies.registry.finish(turn.turnId);
      release?.();
      if (reservation) dependencies.quota.release(reservation);
    }
  });
  return bot;
}
