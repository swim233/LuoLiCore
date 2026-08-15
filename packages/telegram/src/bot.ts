import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { UserFromGetMe } from 'grammy/types';
import type { Config, ConfigStore, ContextEngine, LogSink, MainAgentStreamResult, MemoryStore, QuotaGuard, QuotaReservation, TurnConcurrency, TurnRegistry } from '@luoli/core';
import { perChatConfig, resolveEffectiveRole } from '@luoli/core';
import type { ArchivedMessage, ArchiveRepository, OperationsRepository, PrincipalRepository, Sqlite, TurnRepository } from '@luoli/db';
import type { Role, RuntimeTurnContext } from '@luoli/shared';
import { roleRank } from '@luoli/shared';
import { contextKey, modelAliasKey, readAppKv, writeAppKv } from '@luoli/db';
import { matchTrigger } from './trigger.js';
import { holdReply, splitTelegramText } from './output.js';

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
  log: LogSink;
  botInfo?: UserFromGetMe;
}

function messageKind(message: Record<string, unknown>): string {
  const ordered = ['text', 'photo', 'document', 'voice', 'video', 'video_note', 'sticker', 'animation', 'audio', 'location', 'poll'];
  return ordered.find((key) => key in message) ?? 'other';
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
  effectiveRole: Role;
  userId: string;
  chatId: string;
  isPrivate: boolean;
  triggerReason: string | null;
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
  bot.use(async (ctx, next) => {
    if (!dependencies.operations.claimUpdate(ctx.update.update_id)) return;
    const from = ctx.from;
    const chat = ctx.chat;
    const message = ctx.message;
    if (!from || !chat || !message) { await next(); return; }
    const pluginMessages = await dependencies.plugins?.hook('onMessage', ctx);
    if (pluginMessages?.some((entry) => entry && typeof entry === 'object' && 'result' in entry && (entry as { result?: { drop?: boolean } }).result?.drop)) return;
    const userId = String(from.id);
    const chatId = String(chat.id);
    const isPrivate = chat.type === 'private';
    const userRole = dependencies.principals.roleOf('user', userId) ?? config.access.defaultUserRole;
    const storedChatRole = dependencies.principals.roleOf('chat', chatId);
    const effectiveRole = resolveEffectiveRole({ userRole, ...(storedChatRole ? { chatRole: storedChatRole } : {}), isPrivate, defaultChatRole: config.access.defaultChatRole });
    dependencies.principals.upsertSeen({ id: `user:${userId}`, kind: 'user', tgId: userId, role: userRole, displayName: [from.first_name, from.last_name].filter(Boolean).join(' '), username: from.username ?? null, chatType: null });
    dependencies.principals.upsertSeen({ id: `chat:${chatId}`, kind: 'chat', tgId: chatId, role: storedChatRole ?? (isPrivate ? userRole : config.access.defaultChatRole), displayName: ('title' in chat ? chat.title : from.first_name) ?? null, username: 'username' in chat ? chat.username ?? null : null, chatType: chat.type });
    if (from.is_bot && !config.telegram.allowBots.includes(from.username ?? '')) return;
    dependencies.log.event({ level: 'debug', kind: 'tg.update', summary: `Update ${ctx.update.update_id}`, chatId, userId, data: { updateId: ctx.update.update_id, type: 'message' } });
    // 触发判定要看会话级覆盖（docs/08 §4）：唤醒词是 perChat 白名单里的键，只读全局快照的话
    // WebUI/API 写进去的会话唤醒词能存住却永远匹配不上。key 用全局 scope 算，与 openTurn 保持一致。
    const triggerConfig = perChatConfig(currentConfig(), contextKey({ chatId, messageThreadId: message.message_thread_id ?? null }, config.context.scope)).trigger;
    const triggerReason = message.text?.startsWith('/') ? 'command' : matchTrigger(ctx, { ...triggerConfig, strictCommandSuffix: config.telegram.strictCommandSuffix }, bot.botInfo.id, bot.botInfo.username);
    dependencies.log.event({ level: 'debug', kind: triggerReason ? 'trigger.matched' : 'trigger.skipped', summary: triggerReason ?? 'not triggered', chatId, userId, data: { reason: triggerReason } });
    let archived: ArchivedMessage | null = null;
    if (effectiveRole !== 'blocked' || config.access.archiveBlocked) {
      archived = dependencies.archive.scope(chatId, message.message_thread_id ?? null).append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: message.message_id,
        tgUpdateId: ctx.update.update_id, direction: 'in', fromKind: 'user', fromUserId: userId,
        fromName: [from.first_name, from.last_name].filter(Boolean).join(' '), fromUsername: from.username ?? null,
        kind: messageKind(message as unknown as Record<string, unknown>), text: message.text ?? message.caption ?? null,
        tgDate: message.date * 1000, raw: message, triggered: triggerReason !== null, triggerReason });
      const mediaParts = await media.process(message as unknown as Record<string, unknown>, archived);
      if (mediaParts.length) {
        archived.mediaParts = mediaParts;
        dependencies.db.prepare('UPDATE messages SET media_parts_json=? WHERE id=?').run(JSON.stringify(mediaParts), archived.id);
      }
    }
    if (effectiveRole === 'blocked') {
      dependencies.log.event({ level: 'info', kind: 'access.denied', summary: 'blocked principal', chatId, userId, data: { userRole, chatRole: storedChatRole } });
      return;
    }
    if (!archived) return;
    ingress.set(ctx.update.update_id, { archived, effectiveRole, userId, chatId, isPrivate, triggerReason });
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

  bot.command('ping', async (ctx) => {
    if (!await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text))) return;
    await ctx.reply(`LuoLiCore ${process.env.npm_package_version ?? 'dev'}\n运行正常\n${JSON.stringify(dependencies.operations.dashboard())}`);
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
  bot.command('ctx', async (ctx) => {
    const key = contextKey({ chatId: String(ctx.chat.id), messageThreadId: ctx.message?.message_thread_id ?? null }, config.context.scope);
    if (!await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text))) return;
    await ctx.reply(`\`\`\`json\n${JSON.stringify(dependencies.context.stats(key), null, 2)}\n\`\`\``, { parse_mode: 'MarkdownV2' });
  });
  bot.command('tasks', async (ctx) => {
    const tasks = dependencies.turns.active(String(ctx.chat.id));
    if (!await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text))) return;
    await ctx.reply(tasks.length ? `\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\`` : '当前没有在途任务。', { parse_mode: 'MarkdownV2' });
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
    const actor = dependencies.principals.roleOf('user', String(ctx.from?.id ?? ''));
    if (actor !== 'owner') { await ctx.reply('权限不足。'); return; }
    const [kind, id, role] = ctx.match.trim().split(/\s+/);
    if (!kind || !id || !['owner', 'trusted', 'limited', 'blocked'].includes(role ?? '') || !['user', 'chat'].includes(kind)) { await ctx.reply('用法：/grant <user|chat> <id> <role>'); return; }
    dependencies.principals.upsertSeen({ id: `${kind}:${id}`, kind: kind as 'user' | 'chat', tgId: id, role: role as 'owner' | 'trusted' | 'limited' | 'blocked', displayName: null, username: null, chatType: null }, `command:${ctx.from?.id}`);
    dependencies.principals.setRole(`${kind}:${id}`, role as 'owner' | 'trusted' | 'limited' | 'blocked', `command:${ctx.from?.id}`);
    await ctx.reply(`已设置 ${kind}:${id} = ${role}`);
  });
  bot.command('revoke', async (ctx) => {
    const actor = dependencies.principals.roleOf('user', String(ctx.from?.id ?? ''));
    if (actor !== 'owner') { await ctx.reply('权限不足。'); return; }
    const id = ctx.match.trim();
    const changed = dependencies.principals.setRole(id, 'blocked', `command:${ctx.from?.id}`);
    await ctx.reply(changed ? `已撤销 ${id}` : '主体不存在。');
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
    const editedTrigger = perChatConfig(currentConfig(), contextKey({ chatId, messageThreadId: message.message_thread_id ?? null }, config.context.scope)).trigger;
    const triggerReason = editedTrigger.ignoreEditedAsTrigger ? null : matchTrigger(ctx, { ...editedTrigger, strictCommandSuffix: config.telegram.strictCommandSuffix }, bot.botInfo.id, bot.botInfo.username);
    dependencies.archive.scope(chatId, message.message_thread_id ?? null).append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: message.message_id, tgUpdateId: ctx.update.update_id,
      direction: 'in', fromKind: 'user', fromUserId: userId, fromName: [from.first_name, from.last_name].filter(Boolean).join(' '), fromUsername: from.username ?? null,
      kind: messageKind(message as unknown as Record<string, unknown>), text: message.text ?? message.caption ?? null, tgDate: message.edit_date ? message.edit_date * 1000 : Date.now(), raw: message,
      triggered: triggerReason !== null, triggerReason, revision: row.revision });
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
    const { userId, chatId, effectiveRole, archived, triggerReason } = access;
    const message = ctx.message;
    if (!triggerReason || triggerReason === 'command') return;
    if (!dependencies.quota.canStart({ chatId, userId, turnsPerUserPerHour: config.quota.rateLimit.turnsPerUserPerHour,
      turnsPerChatPerHour: config.quota.rateLimit.turnsPerChatPerHour, concurrentPerUser: config.quota.rateLimit.concurrentPerUser })) {
      if (config.quota.onExceeded.reply) await ctx.reply(config.quota.onExceeded.message.replace('{spent}', '—').replace('{limit}', '—').replace('{resetAt}', '下个额度窗口'));
      return;
    }
    const scoped = dependencies.archive.scope(chatId, message.message_thread_id ?? null);

    const key = contextKey({ chatId, messageThreadId: message.message_thread_id ?? null }, config.context.scope);
    const roleLimits = config.quota.perUser.byRole[effectiveRole];
    const estimatedTokens = Math.max(config.context.limit.tokens / 4, 1000);
    const modelEstimate = dependencies.estimateTurnCost?.(estimatedTokens, key) ?? null;
    if (config.quota.enabled && config.quota.requirePricing && effectiveRole !== 'owner' && modelEstimate === null) { await ctx.reply('当前模型缺少定价，无法开始对话。'); return; }
    const reservation = config.quota.enabled ? dependencies.quota.reserve({ chatId, userId,
      estimateUsd: Math.max(config.quota.minReserveUsd, modelEstimate ?? config.quota.minReserveUsd),
      limits: { globalDaily: config.quota.global.daily, globalMonthly: config.quota.global.monthly,
        chatDaily: config.quota.perChat.daily, chatMonthly: config.quota.perChat.monthly,
        userDaily: roleLimits?.daily ?? config.quota.perUser.daily, userMonthly: roleLimits?.monthly ?? config.quota.perUser.monthly } }) : null;
    dependencies.log.event({ level: reservation ? 'info' : 'warn', kind: reservation ? 'quota.check' : 'quota.exceeded', summary: reservation ? 'Quota reservation accepted' : 'Quota reservation rejected', chatId, userId, data: { estimatedTokens, estimateUsd: modelEstimate } });
    if (config.quota.enabled && !reservation) {
      await ctx.reply(config.quota.onExceeded.message.replace('{spent}', '—').replace('{limit}', '—').replace('{resetAt}', '下个额度窗口'));
      return;
    }
    const pendingId = crypto.randomUUID();
    const pending = dependencies.registry.register({ id: pendingId, key, chatId, userId, role: effectiveRole }, config.concurrency.turnTimeoutMs);
    let release: (() => void) | null = null;
    try { release = await dependencies.concurrency.acquire(key, pending.controller.signal); }
    catch (error) {
      dependencies.registry.finish(pendingId);
      if (reservation) dependencies.quota.release(reservation);
      await ctx.reply(error instanceof Error && error.message === 'turn_queue_cancelled' ? '⛔ 已取消' : '当前排队已满，请稍后');
      return;
    }
    // openTurn 之后到大 try 之间的每一行都可能抛（非法时区、坏形状快照、DB 约束）。放在 try 外面时
    // 抛出会永久泄漏并发槽与配额预留，该会话在 perKey 次触发后彻底卡死（docs/19 · R-BOT-01）。
    let turn: RuntimeTurnContext;
    try {
      turn = await dependencies.context.openTurn({ chatId, threadId: message.message_thread_id ?? null, key, initiatorUserId: userId,
        effectiveRole, isPrivate: chat.type === 'private', trigger: archived, abortSignal: pending.controller.signal, config: perChatConfig(currentConfig(), key) });
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
    try {
      const generated = dependencies.onTurn ? await dependencies.onTurn(turn, reservation) : '尚未配置可用模型。请在 WebUI 中添加 Provider、模型和 main 别名。';
      let answer: string;
      if (typeof generated === 'string') {
        await holdReply(receivedAt, config.output.replyDelayMs);
        for (const part of splitTelegramText(generated, config.output.maxMessageChars)) {
          const sent = await ctx.reply(part, { parse_mode: 'MarkdownV2' });
          scoped.append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: sent.message_id, direction: 'out', fromKind: 'bot', fromUserId: String(bot.botInfo.id), fromName: bot.botInfo.first_name, fromUsername: bot.botInfo.username,
            kind: 'text', text: part, tgDate: sent.date * 1000, raw: sent, triggered: false, turnId: turn.turnId });
        }
        answer = generated;
      } else {
        const output = new (await import('./stream-output.js')).TelegramOutput(bot, chatId, { mode: config.output.mode, replyDelayMs: config.output.replyDelayMs, intervalMs: config.output.streamIntervalMs, minDeltaChars: config.output.streamMinDeltaChars, maxChars: config.output.maxMessageChars },
          (error) => dependencies.log.event({ level: 'warn', kind: 'tg.error', summary: 'Streaming delivery failed', traceId: turn.turnId, chatId, data: { error: error instanceof Error ? error.message : String(error) } }), receivedAt);
        const consumed = await output.consume(generated.stream, message.message_id);
        if (consumed.interrupted) { generated.interrupt(); void generated.final.catch(() => undefined); answer = consumed.text; }
        // final 为空、但流里已经发出去了内容时以发出去的为准：否则用户盯着屏幕上的回复，
        // 却又收到一句「这轮没成」，上下文里还少了这段话。
        else { const final = await generated.final; answer = final.trim() ? final : consumed.text; }
        for (const messageId of consumed.messageIds) scoped.append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: messageId, direction: 'out', fromKind: 'bot', fromUserId: String(bot.botInfo.id), fromName: bot.botInfo.first_name, fromUsername: bot.botInfo.username,
          kind: 'text', text: answer, tgDate: Date.now(), raw: { streamed: true, interrupted: consumed.interrupted }, triggered: false, turnId: turn.turnId });
      }
      // 空正文既发不出去（splitTelegramText('') 是空数组，用户看到的是彻底的沉默），
      // 又会把一条空的 assistant 消息留进上下文。当成失败处理：至少用户知道这轮没成，
      // 而且下一轮的 prompt 里不会多一条谁都解释不了的空消息（docs/16 §5「摘除比伪造安全」）。
      if (!answer.trim()) throw new Error('model_returned_empty');
      dependencies.context.appendDelta(turn, { id: turn.turnId, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: answer }], textPreview: answer.slice(0, 240), pruneLevel: 0 });
      const committed = await dependencies.context.commitTurn(turn);
      dependencies.turns.finish(turn.turnId, { state: 'committed', commitId: committed.commit.id, rebased: committed.rebased });
      await dependencies.plugins?.hook('afterCommit', { turn, committed });
      dependencies.log.event({ level: 'info', kind: 'turn.end', summary: 'turn committed', traceId: turn.turnId, chatId, userId, key, data: { state: 'committed', rebased: committed.rebased } });
      dependencies.memory.flush(turn.turnId);
    } catch (error) {
      const cancelled = turn.abortSignal.aborted;
      await dependencies.context.abortTurn(turn, cancelled ? 'cancelled' : 'failed', error);
      dependencies.turns.finish(turn.turnId, cancelled ? { state: 'cancelled', cancelReason: String(turn.abortSignal.reason ?? 'cancelled') } : { state: 'failed', error: error instanceof Error ? error.message : String(error) });
      dependencies.log.event({ level: cancelled ? 'warn' : 'error', kind: 'turn.end', summary: cancelled ? 'turn cancelled' : error instanceof Error ? error.message : 'turn failed', traceId: turn.turnId, chatId, userId, key });
      await ctx.reply(cancelled ? '⛔ 已取消' : failureText(error, turn.turnId.slice(0, 12)));
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
