import { statSync } from "node:fs";
import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { Message, UserFromGetMe } from "grammy/types";
import type {
  Config,
  ConfigStore,
  ContextEngine,
  LogSink,
  MainAgentStreamResult,
  MemoryStore,
  PromptResolution,
  QuotaGuard,
  QuotaReservation,
  TurnConcurrency,
  TurnRegistry,
  UsageLedger,
} from "@luoli/core";
import {
  KeyedMutex,
  PROMPT_CALLBACK_PREFIX,
  TurnFailureStreak,
  perChatConfig,
  resolveEffectiveRole,
} from "@luoli/core";
import type {
  ArchivedMessage,
  ArchiveRepository,
  OperationsRepository,
  PrincipalRepository,
  ScopedArchiveRepository,
  Sqlite,
  TurnRepository,
} from "@luoli/db";
import type { Role, RuntimeTurnContext } from "@luoli/shared";
import { parsePrincipal, roleRank } from "@luoli/shared";
import { contextKey, modelAliasKey, readAppKv, writeAppKv } from "@luoli/db";
import { matchTrigger } from "./trigger.js";
import {
  capMentions,
  deliveryOrder,
  holdReply,
  segmentTelegramText,
  sendWithFallback,
  type ParseFallbackInfo,
} from "./output.js";
import { promptAckText } from "./prompts.js";
import { archiveQuotedMessage, attachMedia, messageKind } from "./reply.js";
import { TelegramOutput } from "./stream-output.js";

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
  plugins?: {
    hook(name: string, ...arguments_: unknown[]): Promise<unknown[]>;
  };
  tools?: { releaseTurn(turnId: string): void };
  approvals?: { releaseTurn(turnId: string): void };
  /**
   * 阻塞式人机通道的等待者注册表（`docs/05 §6.1`，core 的 `PendingPrompts`）。inline keyboard
   * 审批类回调（`a:` 前缀）从此处查找等待者；缺省时该类回调一律回「已过期」—— 但此时也不会有
   * 任何带按钮的消息发出。裁决本身不在此处执行：`PromptRequest.claim` 才是原子抢占点
   * （审批传入的是 `DatabaseApprovalBroker.decide`）。
   */
  prompts?: {
    resolve(
      token: string,
      actor: { userId: string; role: Role; chatId: string },
    ): PromptResolution;
  };
  concurrency: TurnConcurrency;
  onTurn?: (
    turn: RuntimeTurnContext,
    reservation: QuotaReservation | null,
  ) => Promise<string | MainAgentStreamResult>;
  estimateTurnCost?: (inputTokens: number, key: string) => number | null;
  /** 签发一次性登录 token（`@luoli/server` 的 `issueLoginToken`）。缺省时 `/webui` 明确回复不可用。 */
  issueLoginToken?: () => { token: string; expiresAt: number };
  /** 告警分发。缺省时这几条仅写入日志 —— 装配方未提供不应导致静默崩溃。 */
  alerts?: {
    fire(
      kind: "quota_global_exceeded" | "consecutive_turn_failures",
      summary: string,
      data?: Record<string, unknown>,
      key?: string,
    ): void;
  };
  /**
   * 连续失败计数。装配方创建一份并传给所有开轮次的入口（本文件与 `ScheduledJobRunner`）——
   * 它此前是本文件的闭包变量，导致定时轮次的失败完全不计入，「上游不可用」在无人聊天的
   * 部署中不会触发任何告警（docs/28 · L-SCH-02）。缺省时退回本地实例，行为与此前一致。
   */
  failures?: TurnFailureStreak;
  log: LogSink;
  /** 用量合计（`/usage`）。缺省时该命令明确回复不可用 —— 不以 `turns` 替代，两份数据口径不一致。 */
  ledger?: UsageLedger;
  /** 进程启动时刻。`/ping` 的上线时长依赖它；缺省时该行显示「未知」而非编造值。 */
  startedAt?: number;
  botInfo?: UserFromGetMe;
  /**
   * 本进程是否正在关停。装配方传入 `() => shuttingDown`。
   *
   * `UpdatePoller.stop()` 会 abort 在途的 `getUpdates`，`#fetch` 的 catch 确实吞掉了该异常 —— 但
   * `tg.api` 的 span 在更低一层（下方的 transformer）已记为 error。生产库中 42 条
   * `tg.api` error 全部（42/42）落在某次 `system.stop` 的 3 秒内（共 56 次关停），即该部署至今
   * 未发生过一次真实的 Telegram API 故障，而日志中存在 42 条 error 级噪声：真实故障与正常重启
   * 在日志上无法区分（docs/28 · L-TG-01）。缺省时行为与此前一致。
   */
  stopping?: () => boolean;
}

/**
 * 判定该错误是否为 abort。判据需收窄 —— 只有关停期间的 abort 才降级为 info，
 * 关停期间真实发生的 API 故障（发送最后一条消息被拒）仍记为 error。
 *
 * grammY 将 fetch 失败包装为 `HttpError`（原始异常挂在 `error` 或 `cause` 上），因此需逐层下钻。
 */
function isAbortLike(error: unknown, depth = 0): boolean {
  if (depth > 3 || !error || typeof error !== "object") return false;
  const value = error as {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
    error?: unknown;
  };
  if (value.name === "AbortError" || value.name === "TimeoutError") return true;
  if (typeof value.message === "string" && /abort/i.test(value.message))
    return true;
  return (
    isAbortLike(value.cause, depth + 1) || isAbortLike(value.error, depth + 1)
  );
}

// 运维态失败（模型未配置、缺少定价）不能并入通用错误提示：用户重试多少次都不会成功，
// 需明确说明由谁执行何种操作（docs/08 §9）。其余错误仍不暴露内部细节，只给出 ref。
function failureText(error: unknown, reference: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  // 上游不可用与模型无输出需分别处理：前者重试有效，后者重试无效。
  if (
    /RetryError|APICallError/i.test(name) ||
    /Failed after \d+ attempts/i.test(message)
  )
    return `模型服务不可用（上游重试已耗尽），请稍后重试。(ref: ${reference})`;
  if (message.startsWith("model alias unavailable"))
    return `模型未配置，需管理员在 WebUI 配置 provider 与 main 别名。(ref: ${reference})`;
  if (message === "model_pricing_required")
    return `当前模型缺少定价，需管理员补充定价后可用。(ref: ${reference})`;
  if (message === "model_returned_empty")
    return `模型本轮未返回任何正文，请重新发送。(ref: ${reference})`;
  return `处理失败，已记录。(ref: ${reference})`;
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

/** 时长的可读格式化。`/ping` 的上线时长、`/tasks` 的已运行时长、`ago()` 均使用它。 */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const units: Array<[number, string]> = [
    [Math.floor(seconds / 86_400), "天"],
    [Math.floor((seconds % 86_400) / 3600), "小时"],
    [Math.floor((seconds % 3600) / 60), "分"],
  ];
  return units
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value}${unit}`)
    .join("");
}

/** 聊天中展示的相对时间，精度到分钟即可；精确值一律另给可与库中对应的字段（`/ctx` 给 commit seq）。 */
function ago(at: number): string {
  return `${duration(Date.now() - at)}前`;
}

/** `data/` 下该数据库实际占用的磁盘 —— `-wal` 常大于主库，只统计主库会显著低估。 */
function databaseBytes(path: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(`${path}${suffix}`).size;
    } catch {
      /* checkpoint 之后 -wal / -shm 可能不存在 */
    }
  }
  return total;
}

const megabytes = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const thousands = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}K`
      : String(value);

/** `tasks.progress_json` 是 `report_progress` 原样写入的 `{status,current,total,detail}`。 */
function progressText(raw: string | null): string {
  if (!raw) return "尚无进度";
  try {
    const payload = JSON.parse(raw) as {
      status?: string;
      current?: number;
      total?: number;
      detail?: string;
    };
    const ratio =
      typeof payload.current === "number" && typeof payload.total === "number"
        ? ` ${payload.current}/${payload.total}`
        : "";
    return [`${payload.status ?? "进行中"}${ratio}`, payload.detail]
      .filter(Boolean)
      .join(" · ");
  } catch {
    return "进度解析失败";
  }
}

function pluginText(result: unknown[], original: string): string {
  let text = original;
  for (const entry of result) {
    const value =
      entry && typeof entry === "object" && "result" in entry
        ? (entry as { result?: unknown }).result
        : null;
    if (typeof value === "string") text = value;
    else if (
      value &&
      typeof value === "object" &&
      "text" in value &&
      typeof (value as { text?: unknown }).text === "string"
    )
      text = (value as { text: string }).text;
  }
  return text;
}
export async function createTelegramBot(
  token: string,
  dependencies: TelegramDependencies,
): Promise<Bot> {
  const currentConfig = (): Readonly<Config> =>
    "snapshot" in dependencies.config
      ? dependencies.config.snapshot()
      : dependencies.config;
  const config = new Proxy({} as Readonly<Config>, {
    get: (_target, property) => currentConfig()[property as keyof Config],
  });
  const bot = new Bot(
    token,
    dependencies.botInfo ? { botInfo: dependencies.botInfo } : undefined,
  );
  await bot.init();
  bot.catch((error) =>
    dependencies.log.event({
      level: "error",
      kind: "tg.error",
      summary: error.message,
      data: error.error,
    }),
  );
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  bot.api.config.use(
    apiThrottler({
      global: {
        reservoir: config.telegram.throttle.globalPerSecond,
        reservoirRefreshAmount: config.telegram.throttle.globalPerSecond,
        reservoirRefreshInterval: 1000,
      },
      group: {
        reservoir: config.telegram.throttle.perChatPerMinute,
        reservoirRefreshAmount: config.telegram.throttle.perChatPerMinute,
        reservoirRefreshInterval: 60_000,
      },
      out: { minTime: 1000 },
    }),
  );
  // 传输层日志（`docs/10 §2` 的 `tg.api`）：该层取不到 turn/chat 上下文，因此既无 traceId
  // 也无法说明发送内容。「本轮发出了什么」由投递层的 `tg.send` / `tg.edit` / `tg.action` 回答
  // （docs/28 · L-LOG-02）。安装位置在 `autoRetry` 与 `apiThrottler` 之后即最外层，
  // 因此此处的 `durationMs` 包含节流排队与全部重试退避。
  bot.api.config.use(async (prev, method, payload, signal) => {
    const span = dependencies.log.span({
      level: "info",
      kind: "tg.api",
      summary: method,
      data: { method },
    });
    try {
      const result = await prev(method, payload, signal);
      span.end({ ok: true });
      return result;
    } catch (error) {
      // 关停时被中止的长轮询不属于故障（docs/28 · L-TG-01）：记为 info + `reason:'shutdown'`，
      // 使「是否发生过真实的 Telegram 故障」可直接按 `level='error'` 查询得到答案。
      if (dependencies.stopping?.() === true && isAbortLike(error)) {
        span.end(
          {
            ok: false,
            reason: "shutdown",
            error: error instanceof Error ? error.message : String(error),
          },
          undefined,
          { level: "info", summary: `${method} aborted during shutdown` },
        );
      } else span.end(undefined, error);
      throw error;
    }
  });
  const media = new (await import("./media.js")).TelegramMedia(
    bot.api,
    token,
    dependencies.db,
    config.media,
    dependencies.log,
  );
  const ingress = new Map<number, TelegramIngress>();
  /** `trigger.cooldownMsPerUser` 的按用户时间戳。有界淘汰见使用处。 */
  const triggerCooldown = new Map<string, number>();
  /** `concurrency.coalesceSameUserMs` 的等待窗口，键为 `${chatId}:${userId}`。同一键最多一项。 */
  const coalescing = new Map<string, { supersede: () => void }>();
  /**
   * 跨会话计数：连续失败反映的是部署级故障，而非单个群的问题（docs/10 §6）。
   * 两个失败出口（向外抛出的、以及产出内容后中断的）共用同一实例，避免两侧阈值不一致；
   * 定时轮次也写入同一实例 —— 前提是装配方传入了 `failures`（docs/28 · L-SCH-02）。
   */
  const failures =
    dependencies.failures ?? new TurnFailureStreak(dependencies.alerts);
  /**
   * 入口段（认领 update → 归档 → 挂载媒体）按 chat 串行。
   *
   * update 现为并发派发（`UpdatePoller`），而归档顺序即上下文顺序 ——
   * `claimBackground` 与 `recent` 均按 `messages.id` 排序。该段内存在真实的异步等待
   * （`onMessage` 钩子、媒体下载），同一 chat 的两条消息同时进入时可能在库中乱序，
   * 表现为模型看到的对话顺序与用户实际发送顺序不一致。
   *
   * 非 message 类型的 update 连同 `next()` 一并纳入锁内：编辑使用的 `MAX(revision)+1` 是
   * 读-改-写序列，同一条消息的两次编辑并发执行会算出相同的 revision。
   *
   * 锁只覆盖入口段，轮次在锁外执行 —— 那才是需要并行的部分（`concurrency.perKey`）。
   */
  const ingressOrder = new KeyedMutex();
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    const chat = ctx.chat;
    const message = ctx.message;
    // 归档在锁内、挂载媒体在锁外。前者确定上下文顺序（`messages.id` 序），后者会解析用户上传的
    // 文件 —— 畸形 PDF 在锁内挂起会导致该会话此后每条消息既不归档也不触发，日志中没有任何
    // turn.start，而挂起不构成异常抛出，`bot.catch` 也不会记录（docs/27 · R-01）。
    const pending: Array<{ payload: Message; row: ArchivedMessage }> = [];
    let scopedArchive: ScopedArchiveRepository | null = null;
    const admitted = await ingressOrder.run(
      chat ? String(chat.id) : "global",
      async (): Promise<TelegramIngress | null> => {
        if (!dependencies.operations.claimUpdate(ctx.update.update_id))
          return null;
        if (!from || !chat || !message) {
          await next();
          return null;
        }
        const pluginMessages = await dependencies.plugins?.hook(
          "onMessage",
          ctx,
        );
        if (
          pluginMessages?.some(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              "result" in entry &&
              (entry as { result?: { drop?: boolean } }).result?.drop,
          )
        )
          return null;
        const userId = String(from.id);
        const chatId = String(chat.id);
        const isPrivate = chat.type === "private";
        const userRole =
          dependencies.principals.roleOf("user", userId) ??
          config.access.defaultUserRole;
        const storedChatRole = dependencies.principals.roleOf("chat", chatId);
        const effectiveRole = resolveEffectiveRole({
          userRole,
          ...(storedChatRole ? { chatRole: storedChatRole } : {}),
          isPrivate,
          defaultChatRole: config.access.defaultChatRole,
        });
        dependencies.principals.upsertSeen({
          id: `user:${userId}`,
          kind: "user",
          tgId: userId,
          role: userRole,
          displayName: [from.first_name, from.last_name]
            .filter(Boolean)
            .join(" "),
          username: from.username ?? null,
          chatType: null,
        });
        // 私聊不占 `chat:` 行（docs/05 §2.2）：私聊的角色只由 `user:` 那行决定，而
        // `upsertSeen` 的 ON CONFLICT 分支刻意不动 role —— 首次私聊写下的 `chat:<正数>` 行会把
        // 出厂 `defaultUserRole` 冻死在那里，此后把 `user:` 提到 trusted 也不生效，必须再改一次
        // `chat:` 行才行。这条是一次真实事故的来源。
        if (!isPrivate)
          dependencies.principals.upsertSeen({
            id: `chat:${chatId}`,
            kind: "chat",
            tgId: chatId,
            role: storedChatRole ?? config.access.defaultChatRole,
            displayName:
              ("title" in chat ? chat.title : from.first_name) ?? null,
            username: "username" in chat ? (chat.username ?? null) : null,
            chatType: chat.type,
          });
        if (
          from.is_bot &&
          !config.telegram.allowBots.includes(from.username ?? "")
        )
          return null;
        dependencies.log.event({
          level: "debug",
          kind: "tg.update",
          summary: `Update ${ctx.update.update_id}`,
          chatId,
          userId,
          data: { updateId: ctx.update.update_id, type: "message" },
        });
        // 触发判定需读取会话级覆盖（docs/08 §4）：唤醒词属于 perChat 白名单键，只读全局快照会导致
        // WebUI/API 写入的会话唤醒词可以保存但永远匹配不上。key 按全局 scope 计算，与 openTurn 一致。
        const triggerConfig = perChatConfig(
          currentConfig(),
          contextKey(
            { chatId, messageThreadId: message.message_thread_id ?? null },
            config.context.scope,
          ),
        ).trigger;
        // 判定完全交由 matchTrigger：若将裸 `/` 前缀一律视为命令，白名单与 `trigger.command` 开关都被绕过，
        // 私聊中的「/home/app 这个目录满了」会得不到任何响应（docs/20 · W-TG-01）。
        const triggerReason = matchTrigger(
          ctx,
          {
            ...triggerConfig,
            strictCommandSuffix: config.telegram.strictCommandSuffix,
          },
          bot.botInfo.id,
          bot.botInfo.username,
        );
        dependencies.log.event({
          level: "debug",
          kind: triggerReason ? "trigger.matched" : "trigger.skipped",
          summary: triggerReason ?? "not triggered",
          chatId,
          userId,
          data: { reason: triggerReason },
        });
        let archived: ArchivedMessage | null = null;
        let quoted: ArchivedMessage | null = null;
        if (effectiveRole !== "blocked" || config.access.archiveBlocked) {
          const scoped = dependencies.archive.scope(
            chatId,
            message.message_thread_id ?? null,
          );
          scopedArchive = scoped;
          archived = scoped.append({
            chatId,
            messageThreadId: message.message_thread_id ?? null,
            tgMessageId: message.message_id,
            tgUpdateId: ctx.update.update_id,
            direction: "in",
            fromKind: "user",
            fromUserId: userId,
            fromName: [from.first_name, from.last_name]
              .filter(Boolean)
              .join(" "),
            fromUsername: from.username ?? null,
            kind: messageKind(message as unknown as Record<string, unknown>),
            text: message.text ?? message.caption ?? null,
            // reply_to / media_group 两列建表时即存在，但此前从未写入 —— 回复对象是该消息语义的一部分，
            // 缺失后无论从库中还是从上下文中都无法判断用户当时指向的是哪一条消息。
            replyToTgMessageId: message.reply_to_message?.message_id ?? null,
            mediaGroupId: message.media_group_id ?? null,
            tgDate: message.date * 1000,
            raw: message,
            triggered: triggerReason !== null,
            triggerReason,
          });
          pending.push({ payload: message, row: archived });
          if (triggerReason !== null && triggerReason !== "command") {
            const found = archiveQuotedMessage(
              bot.botInfo.id,
              scoped,
              message,
              archived,
            );
            if (found) {
              quoted = found.row;
              pending.push(found);
            }
          }
        }
        if (effectiveRole === "blocked") {
          dependencies.log.event({
            level: "info",
            kind: "access.denied",
            summary: "blocked principal",
            chatId,
            userId,
            data: { userRole, chatRole: storedChatRole },
          });
          return null;
        }
        if (!archived) return null;
        return {
          archived,
          quoted,
          effectiveRole,
          userId,
          chatId,
          isPrivate,
          triggerReason,
        };
      },
    );
    // 锁外：`blocked` 主体（`archiveBlocked` 开启时同样归档）也需补挂媒体，故本步先于 `admitted` 判定。
    // 仍位于 `next()` 之前 —— openTurn 物化快照时 parts 必须已挂载完成。
    if (scopedArchive)
      for (const item of pending)
        await attachMedia(media, scopedArchive, item.payload, item.row);
    if (!admitted) return;
    ingress.set(ctx.update.update_id, admitted);
    try {
      await next();
    } finally {
      ingress.delete(ctx.update.update_id);
    }
  });
  const requireRole = async (
    updateId: number,
    minimum: Role,
    reply: (text: string) => Promise<unknown>,
  ): Promise<TelegramIngress | null> => {
    const access = ingress.get(updateId);
    if (!access || roleRank(access.effectiveRole) < roleRank(minimum)) {
      await reply("权限不足。");
      return null;
    }
    return access;
  };

  // 命令表即 /help 的内容，也是 HANDLED_COMMANDS 的对照来源（tests/trigger.test.ts 断言三者一致）。
  const COMMANDS: Array<{
    name: string;
    minRole: Role;
    usage: string;
    description: string;
  }> = [
    {
      name: "start",
      minRole: "limited",
      usage: "/start",
      description: "身份说明与当前权限",
    },
    {
      name: "help",
      minRole: "limited",
      usage: "/help",
      description: "可用命令列表",
    },
    {
      name: "ping",
      minRole: "limited",
      usage: "/ping",
      description: "健康检查",
    },
    {
      name: "new",
      minRole: "limited",
      usage: "/new",
      description: "清空上下文窗口（保留历史）",
    },
    {
      name: "undo",
      minRole: "limited",
      usage: "/undo",
      description: "撤销上一条上下文提交",
    },
    {
      name: "ctx",
      minRole: "limited",
      usage: "/ctx",
      description: "上下文窗口与提交状态",
    },
    {
      name: "cancel",
      minRole: "limited",
      usage: "/cancel [id]",
      description: "取消在途任务",
    },
    {
      name: "tasks",
      minRole: "limited",
      usage: "/tasks",
      description: "在途任务列表",
    },
    {
      name: "memory",
      minRole: "limited",
      usage: "/memory",
      description: "查看私有记忆（仅私聊）",
    },
    {
      name: "whoami",
      minRole: "limited",
      usage: "/whoami",
      description: "角色与有效权限",
    },
    {
      name: "usage",
      minRole: "owner",
      usage: "/usage",
      description: "累计用量",
    },
    {
      name: "webui",
      minRole: "owner",
      usage: "/webui",
      description: "一次性控制台登录链接（仅私聊，5 分钟有效）",
    },
    {
      name: "model",
      minRole: "trusted",
      usage: "/model [alias]",
      description: "查看/固定本会话模型别名",
    },
    {
      name: "whois",
      minRole: "owner",
      usage: "/whois <id>",
      description: "查询主体角色",
    },
    {
      name: "grant",
      minRole: "owner",
      usage: "/grant <user|chat> <id> <role>",
      description: "授权",
    },
    {
      name: "revoke",
      minRole: "owner",
      usage: "/revoke <id>",
      description: "降为 blocked",
    },
  ];
  bot.command("start", async (ctx) => {
    const access = await requireRole(ctx.update.update_id, "limited", (text) =>
      ctx.reply(text),
    );
    if (!access) return;
    await ctx.reply(
      `我是 ${bot.botInfo.first_name}。直接发送消息即可对话；群聊中 @我、回复我或使用唤醒词均可触发。\n` +
        `你当前的权限：${access.effectiveRole}。\n发送 /help 查看可用命令。`,
    );
  });
  bot.command("help", async (ctx) => {
    const access = await requireRole(ctx.update.update_id, "limited", (text) =>
      ctx.reply(text),
    );
    if (!access) return;
    const lines = COMMANDS.filter(
      (entry) => roleRank(access.effectiveRole) >= roleRank(entry.minRole),
    ).map((entry) => `${entry.usage} — ${entry.description}`);
    await ctx.reply(
      `可用命令（按你当前权限 ${access.effectiveRole} 过滤）：\n${lines.join("\n")}`,
    );
  });
  bot.command("whois", async (ctx) => {
    if (
      !(await requireRole(ctx.update.update_id, "owner", (text) =>
        ctx.reply(text),
      ))
    )
      return;
    const parsed = parsePrincipal(ctx.match);
    if (!parsed) {
      await ctx.reply(
        "用法：/whois <id>，或 /whois <user|chat> <id>。id 必须是 Telegram 数字 id。",
      );
      return;
    }
    const kinds = parsed.kind ? [parsed.kind] : (["user", "chat"] as const);
    const found = kinds
      .map((kind) => ({
        kind,
        role: dependencies.principals.roleOf(kind, parsed.tgId),
      }))
      .filter((entry) => entry.role !== null);
    await ctx.reply(
      found.length
        ? found
            .map((entry) => `${entry.kind}:${parsed.tgId} = ${entry.role}`)
            .join("\n")
        : `没有 ${parsed.tgId} 的记录（未见过的主体按默认角色处理）。`,
    );
  });
  bot.command("ping", async (ctx) => {
    const access = await requireRole(ctx.update.update_id, "limited", (text) =>
      ctx.reply(text),
    );
    if (!access) return;
    // 四项都要输出（docs/08 §8「版本、上线时长、模型别名、DB 大小」）。此前只有版本，owner 额外
    // 看到的是 `JSON.stringify(dashboard())` —— 那是运维总览，与健康检查所需的四项没有交集，且原样
    // 输出 JSON 正是 W-TG-02 为 `/ctx`、`/tasks` 修复过的反模式。用量查询用 `/usage`（docs/29 · M-TG-03）。
    const key = contextKey(
      {
        chatId: String(ctx.chat.id),
        messageThreadId: ctx.message?.message_thread_id ?? null,
      },
      config.context.scope,
    );
    // 会话别名优先于配置层，与实际开轮时的判据一致（main.ts 的 estimateTurnCost 同样如此计算）。
    const alias =
      readAppKv<string>(dependencies.db, modelAliasKey(key)) ??
      perChatConfig(currentConfig(), key).agent.main.modelAlias;
    await ctx.reply(
      `LuoLiCore ${process.env.npm_package_version ?? "dev"}\n运行正常\n` +
        `上线时长：${dependencies.startedAt ? duration(Date.now() - dependencies.startedAt) : "未知"}\n` +
        `模型别名：${alias}\n` +
        `DB 大小：${megabytes(databaseBytes(dependencies.db.name))}（含 -wal / -shm）\n` +
        `有效权限：${access.effectiveRole}`,
    );
  });
  /**
   * 一次性登录链接（docs/09 §2.3）。仅在 owner 私聊中提供 —— 在群内发出等于将 owner 全部权限
   * 交给所有可见者，而该链接可兑换一个无需口令的 session。
   *
   * 链接本身不进归档：`/webui` 属于 `HANDLED_COMMANDS`，命令消息本就不进上下文（docs/14 A6），
   * 但回复由 bot 发出，因此此处显式不调用 `scoped.append` —— 可登录的 URL 写入消息表，
   * 泄露面大于口令本身。
   */
  bot.command("webui", async (ctx) => {
    const access = await requireRole(ctx.update.update_id, "owner", (text) =>
      ctx.reply(text),
    );
    if (!access) return;
    if (!access.isPrivate) {
      await ctx.reply("该命令仅限私聊使用：登录链接不应出现在群聊中。");
      return;
    }
    const base = currentConfig().webui.publicUrl.trim().replace(/\/$/, "");
    if (!base) {
      await ctx.reply(
        "未配置 `webui.publicUrl`，无法生成链接。请在设置页填写对外可访问的地址（例如 https://luoli.example.com）。",
      );
      return;
    }
    const issued = dependencies.issueLoginToken?.();
    if (!issued) {
      await ctx.reply("本部署未启用 WebUI，登录链接不可用。");
      return;
    }
    dependencies.log.event({
      level: "warn",
      kind: "webui.action",
      summary: "one-time login link issued via /webui",
      userId: access.userId,
    });
    await ctx.reply(
      `${base}/login?t=${issued.token}\n\n5 分钟内有效、仅可使用一次，进程重启后失效。请勿转发。`,
      { link_preview_options: { is_disabled: true } },
    );
  });
  bot.command("new", async (ctx) => {
    const key = contextKey(
      {
        chatId: String(ctx.chat.id),
        messageThreadId: ctx.message?.message_thread_id ?? null,
      },
      config.context.scope,
    );
    if (
      !(await requireRole(ctx.update.update_id, "limited", (text) =>
        ctx.reply(text),
      ))
    )
      return;
    // `context.recallBarrier` 开启时，清空还需推进背景认领水位（见 `ContextEngine.reset` 的 docstring）。
    const barrier = currentConfig().context.recallBarrier;
    dependencies.context.reset(key, `command:${ctx.from?.id ?? "unknown"}`, {
      advanceClaims: barrier,
    });
    // 回执需与开关状态一致：隔断关闭时，「历史记录仍保留」意味着模型仍可通过 read_messages 检索。
    await ctx.reply(
      barrier
        ? "已清空上下文窗口。历史消息仍保留在数据库中，此前的内容不再进入上下文。"
        : "已清空上下文窗口，历史记录仍保留（我仍可通过 read_messages 检索更早的消息）。",
    );
  });
  bot.command("undo", async (ctx) => {
    const key = contextKey(
      {
        chatId: String(ctx.chat.id),
        messageThreadId: ctx.message?.message_thread_id ?? null,
      },
      config.context.scope,
    );
    if (
      !(await requireRole(ctx.update.update_id, "limited", (text) =>
        ctx.reply(text),
      ))
    )
      return;
    await ctx.reply(
      dependencies.context.undo(key)
        ? "已撤销上一条上下文提交。"
        : "没有可撤销的提交。",
    );
  });
  // 输出摘要而非完整 JSON：stats() 包含窗口内全部消息及其 parts，活跃会话极易超过 Telegram 的
  // 4096 字符上限，API 返回 400 后用户看到的是完全无响应（docs/20 · W-TG-02）。完整数据见 WebUI。
  bot.command("ctx", async (ctx) => {
    const key = contextKey(
      {
        chatId: String(ctx.chat.id),
        messageThreadId: ctx.message?.message_thread_id ?? null,
      },
      config.context.scope,
    );
    if (
      !(await requireRole(ctx.update.update_id, "limited", (text) =>
        ctx.reply(text),
      ))
    )
      return;
    const stats = dependencies.context.stats(key) as {
      commit: {
        id: string;
        seq: number;
        windowStart: number;
        headOrdinal: number;
      } | null;
      messageCount: number;
      tokens: number;
      claimWatermark: number;
      lastPrune: { seq: number; at: number } | null;
      lastRebase: { seq: number; at: number } | null;
    };
    const commit = stats.commit;
    // 输出 seq 而不仅是时间戳：seq 可直接与 `context_commits` 对应，相对时间仅供阅读。
    const marker = (row: { seq: number; at: number } | null): string =>
      row ? `第 ${row.seq} 次提交（${ago(row.at)}）` : "无";
    await ctx.reply(
      commit
        ? `上下文 ${key}\ncommit ${commit.id.slice(0, 12)}（第 ${commit.seq} 次）\n窗口 ordinal ${commit.windowStart}–${commit.headOrdinal}\n${stats.messageCount} 条消息 / 约 ${stats.tokens} tokens（上限 ${config.context.limit.maxMessages} 条 / ${config.context.limit.tokens} tokens）\n背景认领位点 tg#${stats.claimWatermark}\n最近 prune：${marker(stats.lastPrune)}\n最近 rebase：${marker(stats.lastRebase)}\n完整时间线见 WebUI：http://${config.webui.host}:${config.webui.port}/chats/${encodeURIComponent(key)}`
        : `上下文 ${key} 为空，尚无提交。`,
    );
  });
  /**
   * 两类都要列出。`turns` 表示用户发出的那轮是否仍在执行，`tasks` 表示 `spawn_agent` 派发的子 agent ——
   * 同一个「任务」在 Telegram 与 WebUI「任务与审批」页此前各指其中一类，实测出现过混淆
   * （docs/29 · M-TG-05）。标题与进度只存在于 `tasks` 表，turns 行没有也不应有。
   */
  bot.command("tasks", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const turns = dependencies.turns.active(chatId) as Array<{
      id: string;
      state: string;
      started_at?: number;
    }>;
    const tasks = dependencies.db
      .prepare(
        "SELECT id,title,state,progress_json AS progress,created_at AS createdAt FROM tasks WHERE chat_id=? AND state='running' ORDER BY created_at",
      )
      .all(chatId) as Array<{
      id: string;
      title: string;
      state: string;
      progress: string | null;
      createdAt: number;
    }>;
    if (
      !(await requireRole(ctx.update.update_id, "limited", (text) =>
        ctx.reply(text),
      ))
    )
      return;
    const sections: string[] = [];
    if (turns.length)
      sections.push(
        `在途轮次 ${turns.length} 个：\n${turns
          .slice(0, 20)
          .map(
            (turn) =>
              `${turn.id.slice(0, 12)} ${turn.state}${turn.started_at ? ` · 已运行 ${duration(Date.now() - turn.started_at)}` : ""}`,
          )
          .join("\n")}`,
      );
    if (tasks.length)
      sections.push(
        `子 agent 任务 ${tasks.length} 个：\n${tasks
          .slice(0, 20)
          .map(
            (task) =>
              `${task.id.slice(0, 12)}「${task.title}」· 已运行 ${duration(Date.now() - task.createdAt)} · ${progressText(task.progress)}`,
          )
          .join("\n")}`,
      );
    await ctx.reply(
      sections.length
        ? sections.join("\n\n")
        : "当前无在途轮次，也无子 agent 任务。",
    );
  });
  bot.command("model", async (ctx) => {
    const access = await requireRole(ctx.update.update_id, "trusted", (text) =>
      ctx.reply(text),
    );
    if (!access) return;
    const key = contextKey(
      {
        chatId: String(ctx.chat.id),
        messageThreadId: ctx.message?.message_thread_id ?? null,
      },
      config.context.scope,
    );
    const requested = ctx.match.trim();
    if (!requested) {
      await ctx.reply(
        `当前模型别名：${readAppKv<string>(dependencies.db, modelAliasKey(key)) ?? config.agent.main.modelAlias}`,
      );
      return;
    }
    if (!["main", "high", "low", "vision"].includes(requested)) {
      await ctx.reply("未知模型别名。可选：main / high / low / vision");
      return;
    }
    // 写入 app_kv 而非 config_kv：config_kv 的每一行都会被当作配置覆盖层解析（docs/19 · R-CFG-01）。
    writeAppKv(
      dependencies.db,
      modelAliasKey(key),
      requested,
      `command:${ctx.from?.id ?? "unknown"}`,
    );
    await ctx.reply(`当前会话模型已固定为 ${requested}`);
  });
  bot.command("whoami", async (ctx) => {
    if (
      !(await requireRole(ctx.update.update_id, "limited", (text) =>
        ctx.reply(text),
      ))
    )
      return;
    const userId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat.id);
    const isPrivate = ctx.chat.type === "private";
    const user =
      dependencies.principals.roleOf("user", userId) ??
      config.access.defaultUserRole;
    // 私聊没有会话角色可言（docs/05 §2.2），报一个出来就是凭空多一档看着能改的东西。
    const chat = isPrivate
      ? null
      : (dependencies.principals.roleOf("chat", chatId) ??
        config.access.defaultChatRole);
    const effective = resolveEffectiveRole({
      userRole: user,
      ...(chat ? { chatRole: chat } : {}),
      isPrivate,
      defaultChatRole: config.access.defaultChatRole,
    });
    await ctx.reply(
      isPrivate
        ? `user=${user} effective=${effective}`
        : `user=${user} chat=${chat} effective=${effective}`,
    );
  });
  /**
   * `chat` 主体的两条硬约束（docs/05 §2.2），`/grant` 与 `/revoke` 共用一份。私聊已不占
   * `chat:` 行，正数 id 写进去只是一行永不参与判定的死数据；而群内有效角色封顶 trusted，
   * chat 行的 owner 档在全库零效果 —— 收下它等于让命令回执与 WebUI 一起说谎。
   */
  const chatSubjectError = (tgId: string, role?: string): string | null => {
    if (!tgId.startsWith("-"))
      return "chat 主体只能是群 / 频道，ID 以 -100 开头。私聊改用 user 主体。";
    return role === "owner"
      ? "chat 主体不能设为 owner：群 / 频道内的有效权限封顶 trusted。"
      : null;
  };
  bot.command("grant", async (ctx) => {
    if (
      !(await requireRole(ctx.update.update_id, "owner", (text) =>
        ctx.reply(text),
      ))
    )
      return;
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const role = parts.at(-1) ?? "";
    // 主体串交由 `parsePrincipal` 解析：此前 `/grant user @alice owner` 会全程通过，写出一条
    // `tg_id='@alice'` 的主体行 —— 永远匹配不到任何消息，而命令仍回复「已设置」（docs/27 · C-05）。
    const parsed =
      parts.length >= 2 ? parsePrincipal(parts.slice(0, -1).join(" ")) : null;
    if (
      !parsed?.kind ||
      !["owner", "trusted", "limited", "blocked"].includes(role)
    ) {
      await ctx.reply(
        "用法：/grant <user|chat> <id> <role>。id 必须是 Telegram 数字 id（群/频道为负数）。",
      );
      return;
    }
    if (parsed.kind === "chat") {
      const denied = chatSubjectError(parsed.tgId, role);
      if (denied) {
        await ctx.reply(denied);
        return;
      }
    }
    dependencies.principals.upsertSeen(
      {
        id: parsed.id,
        kind: parsed.kind,
        tgId: parsed.tgId,
        role: role as Role,
        displayName: null,
        username: null,
        chatType: null,
      },
      `command:${ctx.from?.id}`,
    );
    dependencies.principals.setRole(
      parsed.id,
      role as Role,
      `command:${ctx.from?.id}`,
    );
    await ctx.reply(`已设置 ${parsed.id} = ${role}`);
  });
  bot.command("revoke", async (ctx) => {
    if (
      !(await requireRole(ctx.update.update_id, "owner", (text) =>
        ctx.reply(text),
      ))
    )
      return;
    const parsed = parsePrincipal(ctx.match);
    if (!parsed) {
      await ctx.reply(
        "用法：/revoke <user|chat> <id>，或 /revoke <id>（两类主体均尝试）。",
      );
      return;
    }
    if (parsed.kind === "chat") {
      const denied = chatSubjectError(parsed.tgId);
      if (denied) {
        await ctx.reply(denied);
        return;
      }
    }
    // 裸 id 时两种主体都尝试。`/grant` 接收的是 `<kind> <id>`，而此处此前只接收完整主体 id ——
    // 导致 `/revoke 123456`（owner 最常用的写法）静默失效，仅回复「主体不存在」。
    const targets = parsed.kind
      ? [parsed.id]
      : [`user:${parsed.tgId}`, `chat:${parsed.tgId}`];
    const revoked = targets.filter((id) =>
      dependencies.principals.setRole(id, "blocked", `command:${ctx.from?.id}`),
    );
    await ctx.reply(
      revoked.length ? `已撤销 ${revoked.join("、")}` : "主体不存在。",
    );
  });
  bot.command("memory", async (ctx) => {
    const access = await requireRole(ctx.update.update_id, "limited", (text) =>
      ctx.reply(text),
    );
    if (!access) return;
    if (!access.isPrivate) {
      await ctx.reply("私有记忆仅限私聊查看。");
      return;
    }
    const document = dependencies.memory.read(
      "primemory",
      access.userId,
      access.effectiveRole,
      access.userId,
      true,
    );
    // owner 查看过用户私有记忆这一事实必须对被查看者可见：若仅写入一条只有 owner 能在控制台
    // 检索到的日志，那只是记录而非问责（D11，`docs/06 §425`；docs/29 · M-MEM-01）。
    const seen = dependencies.memory.lastOwnerRead(access.userId);
    await ctx.reply(
      [
        document.content || "尚无私有记忆。",
        seen
          ? `\n—— 最近被 owner ${seen.op === "write" ? "改动" : "查看"}于 ${ago(seen.ts)}`
          : "",
      ].join(""),
    );
  });
  bot.command("cancel", async (ctx) => {
    const access = await requireRole(ctx.update.update_id, "limited", (text) =>
      ctx.reply(text),
    );
    if (!access) return;
    const id =
      ctx.match.trim() ||
      dependencies.registry.latest(access.chatId, access.userId)?.id;
    if (
      !id ||
      !dependencies.registry.cancel(id, access.userId, access.effectiveRole)
    ) {
      await ctx.reply("没有可取消的任务，或无取消权限。");
      return;
    }
    await ctx.reply("⛔ 已取消");
  });
  bot.on("edited_message", async (ctx) => {
    const message = ctx.editedMessage;
    const from = message.from;
    if (!from) return;
    const chatId = String(message.chat.id);
    const userId = String(from.id);
    const isPrivate = message.chat.type === "private";
    const userRole =
      dependencies.principals.roleOf("user", userId) ??
      config.access.defaultUserRole;
    const storedChatRole = dependencies.principals.roleOf("chat", chatId);
    const effectiveRole = resolveEffectiveRole({
      userRole,
      ...(storedChatRole ? { chatRole: storedChatRole } : {}),
      isPrivate,
      defaultChatRole: config.access.defaultChatRole,
    });
    if (effectiveRole === "blocked" && !config.access.archiveBlocked) return;
    const row = dependencies.db
      .prepare(
        "SELECT COALESCE(MAX(revision),-1)+1 AS revision FROM messages WHERE chat_id=? AND tg_message_id=?",
      )
      .get(chatId, message.message_id) as { revision: number };
    // 编辑永不开启新轮次（`trigger.ignoreEditedAsTrigger` 因此标 🚧）。同时也绝不能记为 triggered=1：
    // claimBackground 只认领 triggered=0 的消息，被判为触发却无人开轮次的编辑将完全丢失
    // —— 既不回应也不进入背景上下文（docs/20 · W-TG-05）。统一按背景消息归档。
    const editedTrigger = perChatConfig(
      currentConfig(),
      contextKey(
        { chatId, messageThreadId: message.message_thread_id ?? null },
        config.context.scope,
      ),
    ).trigger;
    const wouldTrigger = matchTrigger(
      ctx,
      {
        ...editedTrigger,
        strictCommandSuffix: config.telegram.strictCommandSuffix,
      },
      bot.botInfo.id,
      bot.botInfo.username,
      message,
    );
    if (wouldTrigger)
      dependencies.log.event({
        level: "info",
        kind: "trigger.skipped",
        summary: "edited message would trigger but edits never open a turn",
        chatId,
        userId,
        data: { reason: wouldTrigger, tgMessageId: message.message_id },
      });
    dependencies.archive
      .scope(chatId, message.message_thread_id ?? null)
      .append({
        chatId,
        messageThreadId: message.message_thread_id ?? null,
        tgMessageId: message.message_id,
        tgUpdateId: ctx.update.update_id,
        direction: "in",
        fromKind: "user",
        fromUserId: userId,
        fromName: [from.first_name, from.last_name].filter(Boolean).join(" "),
        fromUsername: from.username ?? null,
        kind: messageKind(message as unknown as Record<string, unknown>),
        text: message.text ?? message.caption ?? null,
        tgDate: message.edit_date ? message.edit_date * 1000 : Date.now(),
        raw: message,
        triggered: false,
        triggerReason: null,
        revision: row.revision,
      });
  });
  bot.on("my_chat_member", async (ctx) => {
    const member = ctx.myChatMember;
    const chatId = String(member.chat.id);
    const active = !["left", "kicked"].includes(member.new_chat_member.status);
    // 同主路径：私聊不占 `chat:` 行（docs/05 §2.2）。用户 block/unblock 机器人也会走到这里。
    if (member.chat.type !== "private")
      dependencies.principals.upsertSeen(
        {
          id: `chat:${chatId}`,
          kind: "chat",
          tgId: chatId,
          role:
            dependencies.principals.roleOf("chat", chatId) ??
            config.access.defaultChatRole,
          displayName:
            ("title" in member.chat ? member.chat.title : null) ?? null,
          username:
            "username" in member.chat ? (member.chat.username ?? null) : null,
          chatType: member.chat.type,
        },
        "telegram:my_chat_member",
      );
    dependencies.log.event({
      level: "info",
      kind: "tg.membership",
      summary: active ? "bot added to chat" : "bot removed from chat",
      chatId,
      data: { status: member.new_chat_member.status },
    });
  });
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = String(ctx.from.id);
    // `a:` 表示阻塞式人机提示（审批的 inline keyboard、后续的转人工与 ACP permission，docs/05 §6.1）。
    // 判据为**本条 callback 所在会话**的有效角色（D9，docs/05 §2.2），不是裸的用户角色 ——
    // 下方 `c:` 分支只取用户角色，是既有的窄口径，不要照搬。按钮如今只落在 owner 私聊里
    // （那里有效角色恒为 owner），所以走到这儿的越权点击只可能来自伪造的 `callback_data`；
    // 照会话算仍是必需的，它与 `PendingPrompts.resolve` 的会话绑定合起来才挡得住「在自己是
    // owner 的群里替另一个会话裁决」。
    if (data.startsWith(PROMPT_CALLBACK_PREFIX)) {
      const chat = ctx.chat;
      // 会话无法识别（消息不可达）时按查不到该提示处理 —— 有效角色是按会话计算的，
      // 会话不匹配时该判据本身失去意义（同 `PendingPrompts.resolve` 会话绑定的理由）。
      if (!chat) {
        await ctx.answerCallbackQuery({
          text: "无法识别该消息所属的会话，请重新发起。",
          show_alert: true,
        });
        return;
      }
      const userRole =
        dependencies.principals.roleOf("user", userId) ??
        config.access.defaultUserRole;
      const storedChatRole = dependencies.principals.roleOf(
        "chat",
        String(chat.id),
      );
      const effectiveRole = resolveEffectiveRole({
        userRole,
        ...(storedChatRole ? { chatRole: storedChatRole } : {}),
        isPrivate: chat.type === "private",
        defaultChatRole: config.access.defaultChatRole,
      });
      const resolution = dependencies.prompts?.resolve(data, {
        userId,
        role: effectiveRole,
        chatId: String(chat.id),
      }) ?? { status: "unknown" as const };
      // 先应答再编辑。超过约 15 秒未调用 answerCallbackQuery，客户端会持续显示加载状态；而撤键盘
      // 是 fire-and-forget 的（`PendingPrompts` 收尾时会自行撤除，见该处的去重逻辑）。查不到等待者
      // 的情形（进程曾重启）无人代为撤除，因此此处补一次 —— 否则按钮会永久留在屏幕上。
      // 只有 `unknown` 应当撤除：若 `invalid`（提示仍存在、仅该下标无对应选项）也执行这一步，
      // 一次伪造的 `callback_data` 即可撤除一条有效提示的键盘。
      await ctx.answerCallbackQuery(promptAckText(resolution));
      if (resolution.status === "unknown")
        void ctx.editMessageReplyMarkup().catch(() => undefined);
      return;
    }
    if (!data.startsWith("c:")) return;
    const turnId = data.slice(2);
    const role =
      dependencies.principals.roleOf("user", userId) ??
      config.access.defaultUserRole;
    const cancelled = dependencies.registry.cancel(turnId, userId, role);
    await ctx.answerCallbackQuery(
      cancelled
        ? "已取消"
        : { text: "只有发起人或管理员可以取消", show_alert: true },
    );
  });
  bot.command("usage", async (ctx) => {
    if (
      !(await requireRole(ctx.update.update_id, "owner", (text) =>
        ctx.reply(text),
      ))
    )
      return;
    // 读取 `usage_ledger` 而非 `turns`：试跑（`agents.createDryRun()`）写入 ledger 但不创建 turns 行，
    // 因此只要在 WebUI 上试跑过一次，「`/usage` = 用量页 = ledger 聚合」即永久不一致
    // （docs/29 · M-QUOTA-01）。同时不再原样输出 `dashboard()` JSON —— 那是运维总览而非用量报表。
    if (!dependencies.ledger) {
      await ctx.reply("用量账本未接入，该命令不可用。请在 WebUI 用量页查看。");
      return;
    }
    const requested = ctx.match.trim() || "today";
    if (!["today", "month"].includes(requested)) {
      await ctx.reply("用法：/usage [today|month]");
      return;
    }
    const window = requested === "month" ? "month" : "day";
    const timezone = config.general.timezone;
    const chatId = String(ctx.chat.id);
    const line = (
      label: string,
      filter: Parameters<UsageLedger["summary"]>[2],
    ): string => {
      const row = dependencies.ledger!.summary(window, timezone, filter);
      return `${label} $${row.costUsd.toFixed(6)} · ${row.turns} 轮 · ${thousands(row.inputTokens)} in / ${thousands(row.outputTokens)} out`;
    };
    await ctx.reply(
      `用量 · ${window === "day" ? "今天" : "本月"}（${timezone}）\n` +
        `${line("全局", {})}\n` +
        `${line("本会话", { chatId })}\n` +
        `${line("本人", { userId: String(ctx.from?.id ?? "") })}\n` +
        "口径：usage_ledger，与 WebUI 用量页一致；不含 ACP 外部支出。",
    );
  });

  bot.on("message", async (ctx) => {
    const receivedAt = Date.now();
    const access = ingress.get(ctx.update.update_id);
    if (!access) return;
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;
    const { userId, chatId, effectiveRole, archived, quoted, triggerReason } =
      access;
    const message = ctx.message;
    if (!triggerReason || triggerReason === "command") return;
    // `trigger.cooldownMsPerUser`：同一用户连续 @ 多次时只开启第一轮。被抑制的消息不会丢失
    // —— 它已以 triggered=0 落库（下方代码即执行该降级），因此下一轮的背景认领会将其纳入上下文。
    // 与 `quota.rateLimit` 是两件事：后者按小时计配额，本项按秒抑制连续触发。
    const cooldownMs = config.trigger.cooldownMsPerUser;
    if (cooldownMs > 0) {
      const last = triggerCooldown.get(userId) ?? 0;
      if (receivedAt - last < cooldownMs) {
        dependencies.archive
          .scope(chatId, message.message_thread_id ?? null)
          .demoteToBackground(archived.id);
        dependencies.log.event({
          level: "debug",
          kind: "trigger.cooldown",
          summary: "trigger suppressed by per-user cooldown",
          chatId,
          userId,
          data: { cooldownMs, sinceMs: receivedAt - last },
        });
        return;
      }
      triggerCooldown.set(userId, receivedAt);
      // 需有界：群内换一批发言者即产生一批新键，不清理则该表只增不减。
      // 仅删除过期项无法保证上界：`cooldownMsPerUser` 较大时，短时间内超过 4096 个不同发言者
      // 均未过期，该表仍会突破上界继续增长（docs/27 · R-07）。因此清理后仍超限时按插入序
      // （Map 的迭代序）淘汰最旧的若干项 —— 它们本就是最接近过期的。
      if (triggerCooldown.size > 4096) {
        for (const [key, at] of triggerCooldown)
          if (receivedAt - at >= cooldownMs) triggerCooldown.delete(key);
        while (triggerCooldown.size > 4096)
          triggerCooldown.delete(triggerCooldown.keys().next().value!);
      }
    }
    // `concurrency.coalesceSameUserMs`：同一用户在窗口内连续发言时，只为最后一条开启轮次。
    // 先到的若干条降级为背景消息 —— 其正文仍进入本轮上下文（由 `claimBackground` 认领），
    // 只是渲染为 `[名字 时间] …` 而非触发消息。这与 docs/02 §215 早期设想的「追加进同一份
    // delta」不同：向已在执行的轮次注入新的 user 消息会违反 `finalized` 后禁止
    // `appendDelta` 的不变量，那是上下文引擎的红线。默认 0（关闭）。
    const coalesceMs = config.concurrency.coalesceSameUserMs;
    if (coalesceMs > 0) {
      const coalesceKey = `${chatId}:${userId}`;
      coalescing.get(coalesceKey)?.supersede();
      let superseded = false;
      let wake: () => void = () => undefined;
      const waiter = {
        supersede: () => {
          superseded = true;
          wake();
        },
      };
      coalescing.set(coalesceKey, waiter);
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, coalesceMs);
        timer.unref?.();
      });
      if (coalescing.get(coalesceKey) === waiter)
        coalescing.delete(coalesceKey);
      if (superseded) {
        dependencies.archive
          .scope(chatId, message.message_thread_id ?? null)
          .demoteToBackground(archived.id);
        dependencies.log.event({
          level: "debug",
          kind: "trigger.coalesced",
          summary: "superseded by a later message from the same user",
          chatId,
          userId,
          data: { coalesceMs },
        });
        return;
      }
    }
    // `inFlight` 读取进程内注册表而非 `turns` 表：从此处到 `registry.register` 之间没有 await，
    // 因此该判据确实能拦截同一用户的两条并发消息（docs/27 · R-04）。
    if (
      !dependencies.quota.canStart({
        chatId,
        userId,
        turnsPerUserPerHour: config.quota.rateLimit.turnsPerUserPerHour,
        turnsPerChatPerHour: config.quota.rateLimit.turnsPerChatPerHour,
        concurrentPerUser: config.quota.rateLimit.concurrentPerUser,
        inFlight: dependencies.registry.countForUser(userId),
      })
    ) {
      // 判为触发但未开启轮次的消息必须降级为背景（同 `cooldownMsPerUser` 路径，docs/20 · W-TG-05）：
      // `claimBackground` 只认领 `triggered=0`，保留 1 会使该消息既得不到回应也无法进入下一轮上下文。
      dependencies.archive
        .scope(chatId, message.message_thread_id ?? null)
        .demoteToBackground(archived.id);
      // `concurrentPerUser` 拦截的不是额度：该用户仍有轮次在执行，结束后即可继续。入口串行时期
      // 这一档不可能触发，因此长期与额度共用同一文案 —— 而「今天的额度用完了」会使用户当天不再尝试。
      // 本条不受 `onExceeded.reply` 控制：该开关用于额度耗尽场景，此处沉默等同于 bot 不响应。
      const rejection = dependencies.quota.lastStartRejection;
      if (rejection === "concurrent") {
        dependencies.log.event({
          level: "info",
          kind: "quota.check",
          summary: "concurrent turn limit reached",
          chatId,
          userId,
          data: { concurrentPerUser: config.quota.rateLimit.concurrentPerUser },
        });
        await ctx.reply(
          `我同时最多处理 ${config.quota.rateLimit.concurrentPerUser} 轮，你的上一轮尚未结束。等它结束后再发送。`,
        );
      } else if (rejection === "rate_user" || rejection === "rate_chat") {
        // 频率这一档同样不是额度。上述论证完全适用：用户实际看到的是「今天的额度
        // 用完了（已用 —/—），下个额度窗口 重置。」而真实原因是「本小时已开启 30 轮」，与金额
        // 无关，且占位符原样泄露给了用户（docs/28 · L-QUOTA-02）。窗口是滚动一小时
        // （`canStart` 统计的是 `started_at >= now-1h`），因此表述为「等待最早一轮滚出窗口」而非
        // 「整点重置」—— 后者会让用户在 59 分时无谓等待。
        // 同样不受 `onExceeded.reply` 控制，理由与并发档一致：该开关用于额度耗尽场景
        // （沉默意味着当天不必再尝试），而频率拒绝时沉默等同于 bot 对正常请求不响应。
        const perChat = rejection === "rate_chat";
        const limit = perChat
          ? config.quota.rateLimit.turnsPerChatPerHour
          : config.quota.rateLimit.turnsPerUserPerHour;
        dependencies.log.event({
          level: "info",
          kind: "quota.check",
          summary: `hourly turn rate limit reached (${rejection})`,
          chatId,
          userId,
          data: { rejection, limit },
        });
        // 表述为「已达上限」而非「已开启 N 轮」：判据是 `count >= limit`，运维中途调小限额时 count
        // 会大于 limit，给出不准确的数字比不给更差。
        await ctx.reply(
          `${perChat ? "这个会话" : "你"}最近一小时的轮次已达频率上限（每小时 ${limit} 轮，按${perChat ? "会话" : "人"}算，与额度无关）。` +
            "最早一轮满一小时移出滚动窗口后即可继续，最长等待一小时。",
        );
      } else {
        // `canStart` 只有那三档，执行到此说明新增了第四档但未同步本处。不要复用额度文案 ——
        // 上面两处注释已说明原因（占位符会原样泄露给用户，且真实原因与金额无关）。
        dependencies.log.event({
          level: "warn",
          kind: "quota.check",
          summary: `unhandled start rejection: ${String(rejection)}`,
          chatId,
          userId,
          data: { rejection },
        });
        await ctx.reply("当前无法处理该请求，请稍后重试。");
      }
      return;
    }
    const scoped = dependencies.archive.scope(
      chatId,
      message.message_thread_id ?? null,
    );

    const key = contextKey(
      { chatId, messageThreadId: message.message_thread_id ?? null },
      config.context.scope,
    );
    const roleLimits = config.quota.perUser.byRole[effectiveRole];
    // 预留额按本轮预计发送量估算：窗口当前水位 + 系统提示词的预算上限。
    // 此前使用 `limit.tokens / 4` 这一与会话无关的常数，空会话高估、长会话严重低估（docs/17 · N-QUOTA-01）。
    const estimatedTokens = Math.max(
      dependencies.context.windowTokens(key) + config.prompt.maxTokens,
      1000,
    );
    const modelEstimate =
      dependencies.estimateTurnCost?.(estimatedTokens, key) ?? null;
    // 拒绝时同样要将该消息降级为背景（同频率 / 冷却 / 合并三条路径，docs/20 · W-TG-05）：保留
    // `triggered=1` 会使它既得不到回应、也无法被 `claimBackground` 认领，模型下一轮无从得知有人发言。
    if (
      config.quota.enabled &&
      config.quota.requirePricing &&
      effectiveRole !== "owner" &&
      modelEstimate === null
    ) {
      scoped.demoteToBackground(archived.id);
      await ctx.reply("当前模型缺少定价，无法开始对话。");
      return;
    }
    const reservation = config.quota.enabled
      ? dependencies.quota.reserve({
          chatId,
          userId,
          estimateUsd: Math.max(
            config.quota.minReserveUsd,
            modelEstimate ?? config.quota.minReserveUsd,
          ),
          limits: {
            globalDaily: config.quota.global.daily,
            globalMonthly: config.quota.global.monthly,
            chatDaily: config.quota.perChat.daily,
            chatMonthly: config.quota.perChat.monthly,
            userDaily: roleLimits?.daily ?? config.quota.perUser.daily,
            userMonthly: roleLimits?.monthly ?? config.quota.perUser.monthly,
          },
        })
      : null;
    // 额度关闭时不记录任何一条。该三元表达式此前只判断 `reservation` 是否为空，而
    // `quota.enabled=false` 时它恒为空 —— 导致每一轮都记录一条 `warn quota.exceeded`
    // 「Quota reservation rejected」而轮次照常开启（logs/2026-08-18：31 轮中有 30 条）。`docs/10` 为该 kind
    // 定义的字段是 `scope/subject/spent/limit`，额度关闭时四者均不存在；而排障时首先看到的正是它。
    if (config.quota.enabled) {
      dependencies.log.event({
        level: reservation ? "info" : "warn",
        kind: reservation ? "quota.check" : "quota.exceeded",
        summary: reservation
          ? "Quota reservation accepted"
          : "Quota reservation rejected",
        chatId,
        userId,
        data: { estimatedTokens, estimateUsd: modelEstimate },
      });
    }
    if (config.quota.enabled && !reservation) {
      // 拒绝原因分档：global 超限意味着整个部署停止服务，必须通知 owner；chat / user 超限仅表示
      // 该用户或该群的额度已用尽（docs/10 §6 的 quota_global_exceeded）。
      const rejection = dependencies.quota.lastRejection;
      const money = (value: number): string => `$${value.toFixed(2)}`;
      if (
        rejection?.scope === "global" &&
        config.quota.onExceeded.notifyOwner
      ) {
        dependencies.alerts?.fire(
          "quota_global_exceeded",
          `全局额度用尽：${rejection.window} 窗口已用 ${money(rejection.spent)} / ${money(rejection.limit)}`,
          {
            window: rejection.window,
            spent: rejection.spent,
            limit: rejection.limit,
          },
          rejection.window,
        );
      }
      // 同上：未成功开启轮次的触发消息一律降级为背景，否则额度耗尽当天的全部发言都会丢失。
      scoped.demoteToBackground(archived.id);
      // 金额档是 `onExceeded.reply` 唯一生效的位置（docs/11 的 quota 段）：关闭它的语义是
      // 额度耗尽后不再回复。频率与并发两档各有独立文案且不受其控制，理由见上方两处注释。
      // 分档文案那次调整删除了 `main` 上唯一的读取点（那个 `else if`），而金额档从未读取过它 ——
      // 导致该开关可以保存、WebUI 仍在写入，但运行时无任何效果。
      if (config.quota.onExceeded.reply) {
        await ctx.reply(
          config.quota.onExceeded.message
            .replace("{spent}", rejection ? money(rejection.spent) : "—")
            .replace("{limit}", rejection ? money(rejection.limit) : "—")
            .replace(
              "{resetAt}",
              rejection?.window === "month" ? "下月初" : "明天",
            ),
        );
      }
      return;
    }
    const pendingId = crypto.randomUUID();
    const pending = dependencies.registry.register(
      { id: pendingId, key, chatId, userId, role: effectiveRole },
      config.concurrency.turnTimeoutMs,
    );
    let release: (() => void) | null = null;
    // 排队时长此前完全不可观测：`turn.start` 在获取槽位之后才发出且不携带等待时长，因此
    // 「bot 长时间无响应」是排队还是上游慢，日志中无法区分（docs/28 · L-LOG-01）。判据使用只读的
    // `available()` —— 无条件记录 `turn.queued` 等于每轮多一行 info，而需要定位的是发生过排队的轮次。
    const queuedAt = Date.now();
    const wasQueued = !dependencies.concurrency.available(key);
    const queueSnapshot = {
      active: dependencies.concurrency.active,
      queued: dependencies.concurrency.queued,
    };
    try {
      release = await dependencies.concurrency.acquire(
        key,
        pending.controller.signal,
      );
    } catch (error) {
      dependencies.registry.finish(pendingId);
      if (reservation) dependencies.quota.release(reservation);
      // 同上：队列已满或被取消同样属于「已触发但无轮次」，不降级该消息就会彻底丢失。
      dependencies.archive
        .scope(chatId, message.message_thread_id ?? null)
        .demoteToBackground(archived.id);
      dependencies.log.event({
        level: "warn",
        kind: "turn.end",
        summary: error instanceof Error ? error.message : "turn queue rejected",
        chatId,
        userId,
        key,
        data: {
          state: "rejected",
          active: dependencies.concurrency.active,
          queued: dependencies.concurrency.queued,
        },
      });
      await ctx.reply(
        error instanceof Error && error.message === "turn_queue_cancelled"
          ? "⛔ 已取消"
          : "当前排队已满，请稍后",
      );
      return;
    }
    // openTurn 之后到外层 try 之间的每一行都可能抛出（非法时区、形状异常的快照、DB 约束）。若置于
    // try 之外，抛出会永久泄漏并发槽与配额预留，该会话在 perKey 次触发后完全卡死（docs/19 · R-BOT-01）。
    let turn: RuntimeTurnContext;
    try {
      turn = await dependencies.context.openTurn({
        chatId,
        threadId: message.message_thread_id ?? null,
        key,
        initiatorUserId: userId,
        effectiveRole,
        isPrivate: chat.type === "private",
        trigger: archived,
        ...(quoted ? { quoted } : {}),
        ...("title" in chat && chat.title ? { chatTitle: chat.title } : {}),
        abortSignal: pending.controller.signal,
        config: perChatConfig(currentConfig(), key),
      });
      dependencies.registry.finish(pendingId);
      const tracked = dependencies.registry.register(
        { id: turn.turnId, key, chatId, userId, role: effectiveRole },
        config.concurrency.turnTimeoutMs,
      );
      Object.assign(turn, { abortSignal: tracked.controller.signal });
      dependencies.turns.create({
        id: turn.turnId,
        key,
        chatId,
        threadId: message.message_thread_id ?? null,
        userId,
        role: effectiveRole,
        triggerMessageId: archived.id,
        triggerReason,
        baseCommitId: turn.baseCommitId,
      });
    } catch (error) {
      dependencies.registry.finish(pendingId);
      release?.();
      if (reservation) dependencies.quota.release(reservation);
      dependencies.log.event({
        level: "error",
        kind: "turn.end",
        summary: error instanceof Error ? error.message : "turn setup failed",
        chatId,
        userId,
        key,
        data: { state: "setup_failed" },
      });
      await ctx.reply("处理失败，已记录。");
      return;
    }
    const waitedMs = Date.now() - queuedAt;
    // `turn.queued` 先于 `turn.start` 记录，且此时已知等待时长：turnId 在 `openTurn` 之后才产生，
    // 而没有 traceId 的排队记录无法归属到本轮（`docs/10 §2`）。
    if (wasQueued)
      dependencies.log.event({
        level: "info",
        kind: "turn.queued",
        summary: `Turn ${turn.turnId} waited ${waitedMs}ms in queue`,
        traceId: turn.turnId,
        ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
        chatId,
        userId,
        key,
        durationMs: waitedMs,
        data: { ...queueSnapshot, waitedMs },
      });
    // `spanId` 为该 trace 的根：其余轮次级 span 均挂载于其下（`docs/10 §1`）。
    dependencies.log.event({
      level: "info",
      kind: "turn.start",
      summary: `Turn ${turn.turnId} started`,
      traceId: turn.turnId,
      ...(turn.rootSpanId ? { spanId: turn.rootSpanId } : {}),
      chatId,
      userId,
      key,
      data: { role: effectiveRole, triggerReason, waitedMs },
    });
    // 总览页的在途 turn 表仅有这一个数据来源：`GET /api/turns/active` 提供首屏，之后由这三类事件增量更新。
    dependencies.log.publish("turn.started", {
      turnId: turn.turnId,
      key,
      chatId,
      user: userId,
      role: effectiveRole,
      triggerReason,
      at: Date.now(),
    });
    try {
      const generated = dependencies.onTurn
        ? await dependencies.onTurn(turn, reservation)
        : "尚未配置可用模型。请在 WebUI 中添加 Provider、模型和 main 别名。";
      let answer: string;
      /** 流已产出内容后才中断（`/cancel`、`turnTimeoutMs`、上游中途断开）。见下方收尾段。 */
      let broken = false;
      // doc 11 §2.1 将 output.* 列入 perChat 白名单，但投递侧长期读取全局快照 —— 会话级的
      // mode/节奏覆盖可以保存且能通过校验，但永远不生效。此处取本轮合并后的配置。
      const outputConfig = perChatConfig(currentConfig(), key).output;
      // 解析失败降级为纯文本这一跳此前无任何日志，导致行内代码相关的缺陷只能通过翻查下一次模型调用的
      // context blob 反推（docs/00 §2.3）。两条投递路径共用该回调。
      const onParseFallback = (info: ParseFallbackInfo): void =>
        void dependencies.log.event({
          level: "warn",
          kind: "tg.parse_fallback",
          summary: `${outputConfig.parseMode} 渲染被拒，已降级成纯文本${info.phase === "edit" ? "重编辑" : "重发"}`,
          traceId: turn.turnId,
          chatId,
          userId,
          key,
          data: { chars: info.chars, error: info.error, phase: info.phase },
        });
      if (typeof generated === "string") {
        const hooked = dependencies.plugins
          ? pluginText(
              await dependencies.plugins.hook("beforeSend", {
                turn,
                text: generated,
              }),
              generated,
            )
          : generated;
        // `output.maxMentions` 在投递侧收口：提示词中的约定不构成边界，此处才是。
        const outgoing = capMentions(hooked, outputConfig.maxMentions);
        await holdReply(receivedAt, outputConfig.replyDelayMs);
        // 引用触发消息：必须与流式路径（`TelegramOutput.consume`）一致。此前该兜底路径不携带
        // 引用，导致「尚未配置可用模型」一类提示在群内孤立出现，无法判断其回复对象（docs/14 §2 Q10）。
        // 只有第一条分片携带引用，否则一条长回复会在群内产生一串引用块。
        // 分片需与 parseMode 保持一致：三档各有独立渲染器，按一档渲染再按另一档声明发送，
        // 用户看到的将是转义符本身（docs/08 §5.3）。
        // 该兜底路径同样需要投递侧 span：它是 `onTurn` 缺省时的提示与非流式产出所走的路径
        // （`docs/10 §2` 的 `tg.send`，docs/28 · L-LOG-02）。失败档同样记录（warn）：此处抛出
        // 只会记为整轮失败，而本轮发出了什么、哪一段未发出，只有该日志能够回答。
        const logSend = (
          ok: boolean,
          ms: number,
          data: Record<string, unknown>,
        ): void =>
          void dependencies.log.event({
            level: ok ? "debug" : "warn",
            kind: "tg.send",
            summary: `sendMessage → ${chatId}`,
            traceId: turn.turnId,
            ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
            chatId,
            userId,
            key,
            durationMs: ms,
            data: { method: "sendMessage", ok, path: "fallback", ...data },
          });
        const segmented = segmentTelegramText(
          outgoing,
          outputConfig.maxMessageChars,
          outputConfig.parseMode,
        );
        // 本批分段按 chat 串行（docs/28 · L-TG-02）：若在段与段之间插入其他轮次的
        // `sendMessage`，用户看到的将是最后一段出现在后续若干条回复之后。
        await deliveryOrder.run(chatId, async () => {
          for (const [index, part] of segmented.rendered.entries()) {
            const sentAt = Date.now();
            const sent = await sendWithFallback(
              bot.api,
              chatId,
              part,
              index === 0
                ? { reply_parameters: { message_id: message.message_id } }
                : {},
              outputConfig.parseMode,
              onParseFallback,
            ).catch((error: unknown) => {
              logSend(false, Date.now() - sentAt, {
                chars: part.length,
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            });
            logSend(true, Date.now() - sentAt, {
              messageId: sent.message_id,
              chars: part.length,
            });
            // 归档写入渲染前的正文，与流式路径（下方写入 `answer`）一致。若写入 `part`，
            // `messages.text` 中存放的将是 MarkdownV2 转义后的文本 —— WebUI 会话页与 `read_messages`
            // 看到的 bot 发言会带有一串 `\-` `\.`，同一张表内两条路径两种内容。分片时每个
            // `message_id` 写入其对应段（`segmentTelegramText`，docs/28 · L-TG-03）：此前此处为
            // 每一段都写入完整全文，三段的回复在 `messages` 与 `messages_fts` 中各存三份。
            scoped.append({
              chatId,
              messageThreadId: message.message_thread_id ?? null,
              tgMessageId: sent.message_id,
              direction: "out",
              fromKind: "bot",
              fromUserId: String(bot.botInfo.id),
              fromName: bot.botInfo.first_name,
              fromUsername: bot.botInfo.username,
              kind: "text",
              text: segmented.archived[index] ?? outgoing,
              tgDate: sent.date * 1000,
              raw: sent,
              triggered: false,
              turnId: turn.turnId,
            });
          }
        });
        answer = outgoing;
      } else {
        const output = new TelegramOutput(
          bot,
          chatId,
          {
            mode: outputConfig.mode,
            replyDelayMs: outputConfig.replyDelayMs,
            bufferMs: outputConfig.streamBufferMs,
            intervalMs: outputConfig.streamIntervalMs,
            minDeltaChars: outputConfig.streamMinDeltaChars,
            maxChars: outputConfig.maxMessageChars,
            parseMode: outputConfig.parseMode,
            flushOnSentence: outputConfig.flushOnSentence,
            typingWhileWorking: outputConfig.typingWhileWorking,
            placeholderAfterMs: outputConfig.placeholderAfterMs,
            placeholderTexts: outputConfig.placeholderTexts,
            placeholderPick: outputConfig.placeholderPick,
            placeholderIndex: outputConfig.placeholderIndex,
          },
          (error) =>
            dependencies.log.event({
              level: "warn",
              kind: "tg.error",
              summary: "Streaming delivery failed",
              traceId: turn.turnId,
              chatId,
              data: {
                error: error instanceof Error ? error.message : String(error),
              },
            }),
          receivedAt,
          // 插件钩子只在定稿时执行一次；`capMentions` 需每帧执行 —— 拆分为两个回调之前
          // 两者合并在同一个 async 闭包内，而流式编辑路径不会调用它，导致 @ 全群上限完全失效。
          async (text) =>
            dependencies.plugins
              ? pluginText(
                  await dependencies.plugins.hook("beforeSend", { turn, text }),
                  text,
                )
              : text,
          (text) => capMentions(text, outputConfig.maxMentions),
        );
        output.onParseFallback = onParseFallback;
        // 投递层的语义 span（`docs/10 §1` 的 span K/L/M）。`tg.edit` / `tg.action` 由
        // `TelegramOutput` 聚合为一条，此处只负责将其写成日志行。
        output.onDelivery = (event) =>
          void dependencies.log.event({
            level: event.ok ? "debug" : "warn",
            kind:
              event.kind === "send"
                ? "tg.send"
                : event.kind === "edit"
                  ? "tg.edit"
                  : "tg.action",
            summary: `${event.kind} → ${chatId}${event.count ? ` ×${event.count}` : ""}`,
            traceId: turn.turnId,
            ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
            chatId,
            userId,
            key,
            durationMs: event.ms,
            data: {
              ok: event.ok,
              ...(event.messageId === undefined
                ? {}
                : { messageId: event.messageId }),
              ...(event.chars === undefined ? {} : { chars: event.chars }),
              ...(event.count === undefined
                ? {}
                : event.kind === "edit"
                  ? { editCount: event.count }
                  : { count: event.count }),
              ...(event.path ? { path: event.path } : {}),
              ...(event.error ? { error: event.error } : {}),
            },
          });
        const consumed = await output.consume(
          generated.stream,
          message.message_id,
        );
        if (consumed.interrupted) {
          broken = true;
          // `interrupt()` 需先释放 `drained`，否则下方的 await 会永久挂起（流中途抛出时
          // `streamDone()` 所在的收尾回调不会执行）。
          generated.interrupt();
          // 未投递任何内容时不能吞掉失败原因。真正的错误在 `final` 链上（`streamFailure`）；
          // 此处 `answer = ''` 会使整轮以含糊的 `model_returned_empty` 收尾，而那正是 runtime 的
          // `onExhausted` 要避免的情况 —— 用户应看到「模型服务不可用」而非「未返回任何正文」。
          if (!consumed.text.trim()) answer = await generated.final;
          else {
            void generated.final.catch(() => undefined);
            answer = consumed.text;
          }
        }
        // 归档与上下文一律写入实际发出的内容，即流中累积的全文。
        // `generated.final` 是 AI SDK 的 `result.text`，即最后一步的正文，而多步轮次发送给用户的是
        // 「过程说明 + 结论」的整条消息 —— 若以 final 落库，屏幕上有三段而 `read_messages` 与
        // WebUI 会话页只有最后一段，下一轮模型也看不到自身的过程说明，用户引用「上面第二段」时
        // 无法对应。实测两轮真实多步（logs/2026-08-18 验证轮）均存在该差异。
        // final 仍保留作为失败信号：其为空意味着最后一步未产出正文，对应的 warn 照常记录。
        else {
          const final = await generated.final;
          answer = consumed.text.trim() ? consumed.text : final;
          // 该回落路径此前无任何日志（docs/04 §2 的收尾补跑一节）。它意味着最后一步没有正文 ——
          // 而流中累积的很可能只是工具调用之间的过程说明，被当作答复提交进了上下文（本次故障）。
          // 收尾补跑（runtime 的 `wrapUpIfNeeded`）可覆盖大部分场景，无法覆盖的至少要在日志中留痕。
          if (!final.trim())
            dependencies.log.event({
              level: "warn",
              kind: "turn.no_final_text",
              summary:
                "Last step produced no text; fell back to streamed narration",
              traceId: turn.turnId,
              chatId,
              userId,
              key,
              data: {
                streamedChars: consumed.text.length,
                messages: consumed.messageIds.length,
              },
            });
        }
        // 分段时每个 `message_id` 写入其对应段（docs/28 · L-TG-03）：此前该循环为每一段都写入
        // `answer`，一条 9469 字切成 3 条的回复因此在 `messages` 中占三行各 9469 字、`messages_fts`
        // 存三份，`search_messages` 会将同一条回复搜出三次。`segments` 仅在实际分片时非空 —— 单条
        // 路径写入的仍是模型原文（`answer`），而 `segments` 来自改写并渲染之后的文本。
        // 上下文侧不变：下方 `appendDelta` 仍写入一条完整全文。
        for (const [index, messageId] of consumed.messageIds.entries())
          scoped.append({
            chatId,
            messageThreadId: message.message_thread_id ?? null,
            tgMessageId: messageId,
            direction: "out",
            fromKind: "bot",
            fromUserId: String(bot.botInfo.id),
            fromName: bot.botInfo.first_name,
            fromUsername: bot.botInfo.username,
            kind: "text",
            text: consumed.segments[index] ?? answer,
            tgDate: Date.now(),
            raw: { streamed: true, interrupted: consumed.interrupted },
            triggered: false,
            turnId: turn.turnId,
          });
      }
      // 空正文既无法发出（splitTelegramText('') 返回空数组，用户看到的是完全无响应），
      // 又会向上下文写入一条空的 assistant 消息。按失败处理：至少用户能得知本轮未成功，
      // 且下一轮 prompt 中不会多出一条无法解释的空消息（docs/16 §5「摘除比伪造安全」）。
      if (!answer.trim()) throw new Error("model_returned_empty");
      dependencies.context.appendDelta(turn, {
        id: turn.turnId,
        role: "assistant",
        origin: "assistant",
        parts: [{ type: "text", text: answer }],
        textPreview: answer.slice(0, 240),
        pruneLevel: 0,
      });
      const committed = await dependencies.context.commitTurn(turn);
      /**
       * 已产出内容后才中断的轮次：delta 照常提交，但状态不得记为 committed。这正是
       * docs/04 §5.3 明确要求在实现中显式处理的一条 —— §1「delta 不提交」规则的唯一例外：
       * 内容已呈现在用户屏幕上，上下文必须与用户所见一致，但本轮确实未执行完成。
       *
       * 此前此处只有一条 committed 分支，导致 `turnTimeoutMs` 到期被 abort、且前序步骤已产出
       * 过程说明的轮次会以成功状态收尾：用户没有任何提示、`turns` 行记为 committed、
       * `consecutiveFailures` 还被清零（实测 logs/2026-08-18 · B8F92Z：19:13:03 `model.error
       * timeout` 即 600 秒到期，19:16:04 `turn.end turn committed`）。「（生成中断）」后缀由
       * `TelegramOutput.consume` 依据同一个 `interrupted` 添加。
       */
      /**
       * 超时不等同于取消。两者都表现为 abort，但若判据只看 `aborted`，`turnTimeoutMs` 到期的轮次
       * 会记为 `cancelled` 并被下方的 `failures.failed` 跳过 —— 导致「每轮都耗满十分钟」这类最需要
       * 告警的故障不会触发任何告警（`logs/2026-08-18`：三十余轮全部记为 cancelled，`consecutiveFailures`
       * 始终为 0）。`docs/04 §5.3` 现将收尾分为三档：`/cancel` → cancelled；超时 → failed 且计入；
       * 上游中断 → failed。用户可见文案仍按 `reason` 区分（收到「已取消」会误以为是自己触发的）。
       */
      const timedOut = turn.abortSignal.reason === "timeout";
      const cancelled = broken && turn.abortSignal.aborted && !timedOut;
      const state = broken ? (cancelled ? "cancelled" : "failed") : "committed";
      const settled = dependencies.turns.finish(turn.turnId, {
        state,
        commitId: committed.commit.id,
        rebased: committed.rebased,
        // 超时档两个字段都写：`cancel_reason='timeout'` 表明中断来源，`error` 使其在失败列表中
        // 可与上游中途断开区分开。
        ...(cancelled || timedOut
          ? { cancelReason: String(turn.abortSignal.reason ?? "cancelled") }
          : {}),
        ...(state === "failed"
          ? { error: timedOut ? "turn_timeout" : "stream_interrupted" }
          : {}),
      });
      await dependencies.plugins?.hook("afterCommit", { turn, committed });
      dependencies.log.event({
        level: broken ? "warn" : "info",
        kind: "turn.end",
        summary: broken
          ? `${cancelled ? "turn cancelled" : timedOut ? "turn timed out" : "turn failed"} after partial delivery`
          : "turn committed",
        traceId: turn.turnId,
        ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
        chatId,
        userId,
        key,
        data: {
          state,
          rebased: committed.rebased,
          waitedMs,
          ...(broken ? { deliveredChars: answer.length } : {}),
        },
      });
      dependencies.log.publish("turn.finished", {
        turnId: turn.turnId,
        key,
        chatId,
        state,
        steps: settled?.steps ?? 0,
        toolCalls: settled?.toolCalls ?? 0,
        costUsd: settled?.costUsd ?? 0,
        rebased: committed.rebased,
        durationMs: settled?.durationMs ?? 0,
      });
      // 工具已实际执行且结果已进入已提交的上下文：记忆写入随提交一并落库，否则上下文声称已写入而库中没有。
      dependencies.memory.flush(turn.turnId);
      // 中断的轮次不清零计数（它不是一次成功），但只有 `failed` 才计入连续失败 —— 取消不算故障，
      // 超时算（`docs/04 §5.3` 的三档）。
      if (!broken) failures.succeeded();
      else if (!cancelled)
        failures.failed(timedOut ? "turn_timeout" : "stream_interrupted");
      // `quota.warnAtRatio`：越过预警线时在回复后追加一句，每个 bucket 只提示一次（docs/10 §5.4）。
      // 提示附在成功轮次之后而非单独发送：群内多一条消息即为噪声。
      if (reservation) {
        const warning = dependencies.quota.warning(
          reservation,
          config.quota.warnAtRatio,
        );
        if (warning)
          await ctx
            .reply(
              `（${warning.window === "month" ? "本月" : "今日"}额度已用 ${Math.round((warning.spent / warning.limit) * 100)}%）`,
            )
            .catch(() => undefined);
      }
    } catch (error) {
      // 与上方路径共用同一判据：超时属于故障而非取消（`docs/04 §5.3`）。本路径上的影响更直接 ——
      // 未投递任何内容的超时轮次此前同样记为 cancelled，导致上游不可用时连续失败告警永不触发。
      const timedOut = turn.abortSignal.reason === "timeout";
      const cancelled = turn.abortSignal.aborted && !timedOut;
      // `abortTurn` 同样会写库（`releaseClaims`，`cancel.commitPartial` 开启时还会执行完整的
      // `commitTurn`）。若它向外抛出，下一行将不会执行，`turns` 行会长期停留在 `state='running'`
      // —— `GET /api/turns/active` 与总览页的 running 计数在整个进程生命周期内都是错误的，
      // 直到下次重启的 `recoverAfterCrash` 才会修正。清理属于尽力而为，状态记录不是。
      try {
        await dependencies.context.abortTurn(
          turn,
          cancelled ? "cancelled" : "failed",
          error,
        );
      } catch (cleanup) {
        dependencies.log.event({
          level: "error",
          kind: "ctx.abort",
          summary: "abortTurn failed; turn still recorded as ended",
          traceId: turn.turnId,
          chatId,
          userId,
          key,
          data: {
            error: cleanup instanceof Error ? cleanup.message : String(cleanup),
          },
        });
      }
      const settled = dependencies.turns.finish(
        turn.turnId,
        cancelled
          ? {
              state: "cancelled",
              cancelReason: String(turn.abortSignal.reason ?? "cancelled"),
            }
          : {
              state: "failed",
              error: timedOut
                ? "turn_timeout"
                : error instanceof Error
                  ? error.message
                  : String(error),
              ...(timedOut ? { cancelReason: "timeout" } : {}),
            },
      );
      dependencies.log.event({
        level: cancelled ? "warn" : "error",
        kind: "turn.end",
        summary: cancelled
          ? "turn cancelled"
          : timedOut
            ? "turn timed out"
            : error instanceof Error
              ? error.message
              : "turn failed",
        traceId: turn.turnId,
        ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
        chatId,
        userId,
        key,
        data: { state: cancelled ? "cancelled" : "failed", waitedMs },
      });
      dependencies.log.publish("turn.finished", {
        turnId: turn.turnId,
        key,
        chatId,
        state: cancelled ? "cancelled" : "failed",
        steps: settled?.steps ?? 0,
        toolCalls: settled?.toolCalls ?? 0,
        costUsd: settled?.costUsd ?? 0,
        rebased: false,
        durationMs: settled?.durationMs ?? 0,
      });
      // 连续 5 轮失败是部署级故障的信号（docs/10 §6）。取消不计入 —— 用户主动取消不属于故障；
      // 超时计入，且它正是该信号最需要覆盖的场景（上游不可用时每一轮都走这条路径）。
      if (!cancelled)
        failures.failed(
          timedOut
            ? "turn_timeout"
            : error instanceof Error
              ? error.message
              : String(error),
        );
      // 统计上超时计为故障，但对用户仍使用独立文案：未执行过取消的用户收到「已取消」会误以为是
      // 自己触发的，而通用失败提示也无法说明本轮已耗时十分钟。
      await ctx.reply(
        timedOut
          ? `本轮长时间无进展，已终止。(ref: ${turn.turnId.slice(0, 12)})`
          : cancelled
            ? "对话已取消"
            : failureText(error, turn.turnId.slice(0, 12)),
      );
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
