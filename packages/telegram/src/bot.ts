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
import { holdReply, sendWithFallback, splitTelegramText } from './output.js';
import { attachMedia, messageKind, resolveQuotedMessage } from './reply.js';
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
    // 判定整个交给 matchTrigger：裸 `/` 前缀一律当命令的话，白名单和 `trigger.command` 开关都被绕开，
    // 私聊里一句「/home/app 这个目录满了」会石沉大海（docs/20 · W-TG-01）。
    const triggerReason = matchTrigger(ctx, { ...triggerConfig, strictCommandSuffix: config.telegram.strictCommandSuffix }, bot.botInfo.id, bot.botInfo.username);
    dependencies.log.event({ level: 'debug', kind: triggerReason ? 'trigger.matched' : 'trigger.skipped', summary: triggerReason ?? 'not triggered', chatId, userId, data: { reason: triggerReason } });
    let archived: ArchivedMessage | null = null;
    let quoted: ArchivedMessage | null = null;
    if (effectiveRole !== 'blocked' || config.access.archiveBlocked) {
      const scoped = dependencies.archive.scope(chatId, message.message_thread_id ?? null);
      archived = scoped.append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: message.message_id,
        tgUpdateId: ctx.update.update_id, direction: 'in', fromKind: 'user', fromUserId: userId,
        fromName: [from.first_name, from.last_name].filter(Boolean).join(' '), fromUsername: from.username ?? null,
        kind: messageKind(message as unknown as Record<string, unknown>), text: message.text ?? message.caption ?? null,
        // reply_to / media_group 的列建表时就有，但一直没人往里写 —— 「回复了谁」是这条消息语义的一部分，
        // 丢了它，事后无论从库里还是从上下文里都看不出用户当时在指着哪一条说话。
        replyToTgMessageId: message.reply_to_message?.message_id ?? null, mediaGroupId: message.media_group_id ?? null,
        tgDate: message.date * 1000, raw: message, triggered: triggerReason !== null, triggerReason });
      await attachMedia(media, scoped, message, archived);
      if (triggerReason !== null && triggerReason !== 'command') quoted = await resolveQuotedMessage({ media, botId: bot.botInfo.id }, scoped, message, archived);
    }
    if (effectiveRole === 'blocked') {
      dependencies.log.event({ level: 'info', kind: 'access.denied', summary: 'blocked principal', chatId, userId, data: { userRole, chatRole: storedChatRole } });
      return;
    }
    if (!archived) return;
    ingress.set(ctx.update.update_id, { archived, quoted, effectiveRole, userId, chatId, isPrivate, triggerReason });
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
    const raw = ctx.match.trim();
    if (!raw) { await ctx.reply('用法：/whois <id>，或 /whois <user|chat> <id>'); return; }
    const [first, second] = raw.split(/\s+/);
    const kinds = second && ['user', 'chat'].includes(first!) ? [first as 'user' | 'chat'] : ['user', 'chat'] as const;
    const id = second ?? first!;
    const found = kinds.map((kind) => ({ kind, role: dependencies.principals.roleOf(kind, id) })).filter((entry) => entry.role !== null);
    await ctx.reply(found.length ? found.map((entry) => `${entry.kind}:${id} = ${entry.role}`).join('\n') : `没有 ${id} 的记录（未见过的主体按默认角色处理）。`);
  });
  bot.command('ping', async (ctx) => {
    const access = await requireRole(ctx.update.update_id, 'limited', (text) => ctx.reply(text));
    if (!access) return;
    const detail = access.effectiveRole === 'owner' ? `\n${JSON.stringify(dependencies.operations.dashboard())}` : '';
    await ctx.reply(`LuoLiCore ${process.env.npm_package_version ?? 'dev'}\n运行正常\n有效权限：${access.effectiveRole}${detail}`);
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
    const [kind, id, role] = ctx.match.trim().split(/\s+/);
    if (!kind || !id || !['owner', 'trusted', 'limited', 'blocked'].includes(role ?? '') || !['user', 'chat'].includes(kind)) { await ctx.reply('用法：/grant <user|chat> <id> <role>'); return; }
    dependencies.principals.upsertSeen({ id: `${kind}:${id}`, kind: kind as 'user' | 'chat', tgId: id, role: role as 'owner' | 'trusted' | 'limited' | 'blocked', displayName: null, username: null, chatType: null }, `command:${ctx.from?.id}`);
    dependencies.principals.setRole(`${kind}:${id}`, role as 'owner' | 'trusted' | 'limited' | 'blocked', `command:${ctx.from?.id}`);
    await ctx.reply(`已设置 ${kind}:${id} = ${role}`);
  });
  bot.command('revoke', async (ctx) => {
    if (!await requireRole(ctx.update.update_id, 'owner', (text) => ctx.reply(text))) return;
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
    if (!dependencies.quota.canStart({ chatId, userId, turnsPerUserPerHour: config.quota.rateLimit.turnsPerUserPerHour,
      turnsPerChatPerHour: config.quota.rateLimit.turnsPerChatPerHour, concurrentPerUser: config.quota.rateLimit.concurrentPerUser })) {
      if (config.quota.onExceeded.reply) await ctx.reply(config.quota.onExceeded.message.replace('{spent}', '—').replace('{limit}', '—').replace('{resetAt}', '下个额度窗口'));
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
        effectiveRole, isPrivate: chat.type === 'private', trigger: archived, ...(quoted ? { quoted } : {}),
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
      // doc 11 §2.1 把 output.* 列进 perChat 白名单，投递侧却一直读的是全局快照 —— 会话级
      // 的 mode/节奏覆盖存得住、也过了校验，就是永远不生效。取本轮那份合并后的配置。
      const outputConfig = perChatConfig(currentConfig(), key).output;
      if (typeof generated === 'string') {
        const outgoing = dependencies.plugins ? pluginText(await dependencies.plugins.hook('beforeSend', { turn, text: generated }), generated) : generated;
        await holdReply(receivedAt, outputConfig.replyDelayMs);
        for (const part of splitTelegramText(outgoing, outputConfig.maxMessageChars)) {
          const sent = await sendWithFallback(bot.api, chatId, part);
          scoped.append({ chatId, messageThreadId: message.message_thread_id ?? null, tgMessageId: sent.message_id, direction: 'out', fromKind: 'bot', fromUserId: String(bot.botInfo.id), fromName: bot.botInfo.first_name, fromUsername: bot.botInfo.username,
            kind: 'text', text: part, tgDate: sent.date * 1000, raw: sent, triggered: false, turnId: turn.turnId });
        }
        answer = outgoing;
      } else {
        const output = new TelegramOutput(bot, chatId, { mode: outputConfig.mode, replyDelayMs: outputConfig.replyDelayMs, bufferMs: outputConfig.streamBufferMs, intervalMs: outputConfig.streamIntervalMs, minDeltaChars: outputConfig.streamMinDeltaChars, maxChars: outputConfig.maxMessageChars },
          (error) => dependencies.log.event({ level: 'warn', kind: 'tg.error', summary: 'Streaming delivery failed', traceId: turn.turnId, chatId, data: { error: error instanceof Error ? error.message : String(error) } }), receivedAt,
          dependencies.plugins ? async (text) => pluginText(await dependencies.plugins!.hook('beforeSend', { turn, text }), text) : undefined);
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
      const settled = dependencies.turns.finish(turn.turnId, { state: 'committed', commitId: committed.commit.id, rebased: committed.rebased });
      await dependencies.plugins?.hook('afterCommit', { turn, committed });
      dependencies.log.event({ level: 'info', kind: 'turn.end', summary: 'turn committed', traceId: turn.turnId, chatId, userId, key, data: { state: 'committed', rebased: committed.rebased } });
      dependencies.log.publish('turn.finished', { turnId: turn.turnId, key, chatId, state: 'committed', steps: settled?.steps ?? 0, toolCalls: settled?.toolCalls ?? 0, costUsd: settled?.costUsd ?? 0, rebased: committed.rebased, durationMs: settled?.durationMs ?? 0 });
      dependencies.memory.flush(turn.turnId);
    } catch (error) {
      const cancelled = turn.abortSignal.aborted;
      await dependencies.context.abortTurn(turn, cancelled ? 'cancelled' : 'failed', error);
      const settled = dependencies.turns.finish(turn.turnId, cancelled ? { state: 'cancelled', cancelReason: String(turn.abortSignal.reason ?? 'cancelled') } : { state: 'failed', error: error instanceof Error ? error.message : String(error) });
      dependencies.log.event({ level: cancelled ? 'warn' : 'error', kind: 'turn.end', summary: cancelled ? 'turn cancelled' : error instanceof Error ? error.message : 'turn failed', traceId: turn.turnId, chatId, userId, key });
      dependencies.log.publish('turn.finished', { turnId: turn.turnId, key, chatId, state: cancelled ? 'cancelled' : 'failed', steps: settled?.steps ?? 0, toolCalls: settled?.toolCalls ?? 0, costUsd: settled?.costUsd ?? 0, rebased: false, durationMs: settled?.durationMs ?? 0 });
      // 轮次超时和用户主动取消都走 abort，但对用户是两回事：没点过取消的人收到「已取消」
      // 只会以为自己误触了，而真实情况是这一轮卡在某处直到 `concurrency.turnTimeoutMs`。
      await ctx.reply(cancelled
        ? turn.abortSignal.reason === 'timeout' ? `这一轮太久没有进展，已经停下了。(ref: ${turn.turnId.slice(0, 12)})` : '⛔ 已取消'
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
