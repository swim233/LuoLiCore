import { z } from "zod";
import { roleRank, TG_ID_PATTERN } from "@luoli/shared";
import { acpSchema } from "../acp/schema.js";
import { checkApprovalPattern } from "../approval/rules.js";
import { APPROVAL_POLICIES } from "../tools/policy.js";

const role = z.enum(["owner", "trusted", "limited", "blocked"]);
const nullableMoney = z.number().nonnegative().nullable();
const mcpServerBase = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  enabled: z.boolean().default(true),
  minRole: role.optional(),
  toolAllow: z.array(z.string()).default([]),
  toolDeny: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
});
/**
 * 该 server 的登录方式。凭据本身不在此处 —— 它加密存放于 `mcp_auth` 表
 * （migrations/0011，理由见该文件开头：配置会进入 `config_revisions` 与配置导出，
 * 而 `headers.Authorization` 可绕过按键名判密的正则）。
 *
 * `stdio` 没有该字段：OAuth 属于 HTTP 范畴，而 stdio server 的登录由它自身在带外完成
 * （沿用 harness 的先例，docs/07 §4.5）—— 我方能做的只是将其 stderr 收入日志。
 */
const mcpAuthSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("bearer") }),
  z.object({
    mode: z.literal("oauth"),
    scope: z.string().optional(),
    /** 对方不支持动态注册（RFC 7591）时手工填写。留空则走动态注册。 */
    clientId: z.string().min(1).optional(),
    /** 授权服务器与资源服务器不同源、且对方无 RFC 9728 元数据时手工指定。 */
    issuer: z.string().url().optional(),
  }),
]);
const mcpServerSchema = z.discriminatedUnion("transport", [
  mcpServerBase.extend({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
  }),
  mcpServerBase.extend({
    transport: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string()).default({}),
    auth: mcpAuthSchema.default({ mode: "none" }),
  }),
]);
/**
 * 审批规则此前为 `z.record(z.unknown())`：写入端全部接受，而运行时 `ApprovalRules` 会丢弃没有
 * `tool` 的整条规则、`pattern` 无法编译的规则永不命中、`risk` 写错时按 medium 处理 —— 静默失效的
 * 审批门等同于门开着，而界面全程返回 200 OK。收严后写错即返回 400。
 * `always` 只接受 `true`：运行时不存在命中但无需审批的语义，接受 `false` 等于再造一个假开关。
 */
const approvalRuleSchema = z
  .object({
    tool: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    pattern: z.string().min(1).optional(),
    when: z.literal("target_exists").optional(),
    always: z.literal(true).optional(),
    risk: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.pattern === undefined) return;
    // 与 `compilePattern`（approval/rules.ts）共用同一实现：RE2 加 128 字符上界。可编译但会指数回溯
    // 的模式此前同样被接受 —— 而求值对象是模型给出的工具参数，一次回溯会阻塞整个单线程进程
    // （docs/27 · S-03）。
    const checked = checkApprovalPattern(rule.pattern);
    if (!checked.ok)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pattern"],
        message: `该规则在运行时永不命中：${checked.reason}`,
      });
  });
/**
 * Bot API 的全部更新类型（`getUpdates` 的 `allowed_updates`）。前四条是本适配器确实实现了处理器的，
 * 排在前面是因为 WebUI 按此顺序渲染那组复选框；其余即使申报也不会产生任何行为 —— 逐条的
 * 已处理 / 无处理器标注写在 `CONFIG_ENUM_NOTES`（descriptions.ts），顺序与此处一致。
 *
 * 收敛为 enum 而非自由字符串：拼错一个名字会使 Telegram 对整条 `getUpdates` 返回 400，表现为 bot
 * 收不到任何消息，而与配置面板上的保存成功提示之间隔着一次重启。新增处理器时需同步修改此表。
 */
export const TELEGRAM_UPDATE_KINDS = [
  "message",
  "edited_message",
  "callback_query",
  "my_chat_member",
  "channel_post",
  "edited_channel_post",
  "message_reaction",
  "message_reaction_count",
  "inline_query",
  "chosen_inline_result",
  "shipping_query",
  "pre_checkout_query",
  "purchased_paid_media",
  "poll",
  "poll_answer",
  "chat_member",
  "chat_join_request",
  "chat_boost",
  "removed_chat_boost",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
] as const;
/** 拼错的时区只在群聊分支抛错（私聊不经 Intl），漏到运行时会导致整个群会话无法开启轮次。 */
const ianaTimezone = z.string().refine(
  (zone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  },
  { message: "不是合法的 IANA 时区名" },
);
/**
 * 真正随 `config.changed` 生效的键（前缀匹配）。判据只有一条：运行时读取的是 getter
 * （`configStore.snapshot()` / `turn.config` / bot.ts 的 config Proxy），而非启动时的快照。
 * doc 11 中标注热更新的键必须位于此白名单内，由 `tests/config.test.ts` 逐条断言 ——
 * 上一轮有十组键标注了热更新而实际冻结于启动时，其中三组是故障时运维会去调整的开关
 * （docs/20 · W-CFG-02）。向此处添加键之前，先确认该读取路径确实每次都取新值。
 */
export const HOT_RELOADABLE_CONFIG_KEYS = [
  "telegram.allowBots",
  "telegram.strictCommandSuffix",
  "access.defaultUserRole",
  "access.defaultChatRole",
  "access.archiveBlocked",
  "trigger",
  "context.limit",
  "context.active",
  "context.hardCapRatio",
  "context.background",
  "context.rebase",
  "context.tokenRatioAlpha",
  "context.cacheCommits",
  // 回忆隔断：三个归档工具每次执行时从 `context.turn.config` 实时读取，`/new` 与 WebUI 清空从
  // `currentConfig()` 实时读取。开关变更后，下一次工具调用与下一次清空即按新值执行。
  "context.recallBarrier",
  // 含图轮次的判据范围：`runtime.ts` 每轮从 `turn.config`（即 `dependencies.config`）实时读取。
  "media.visionScope",
  // 合并窗口由 bot.ts 的 config Proxy 每条消息实时读取，修改后下一条消息即按新值执行。
  "concurrency.turnTimeoutMs",
  "concurrency.coalesceSameUserMs",
  // 提示词装配使用 `turn.config`（每轮 perChatConfig 重算一次），修改后下一轮生效。
  "prompt.maxTokens",
  "prompt.includeToolCatalog",
  "prompt.runtimeBlock",
  // 名称只在两处出现：WebUI 的品牌位（每次 config.changed 重新拉取即更新）与启动日志的那一行
  // （该行在启动时写入，不会追溯改写）。
  "general.name",
  // 取消时是否提交部分产出，`abortTurn` 从本轮 `turn.config` 读取。
  "cancel.commitPartial",
  // 心跳间隔在流式端点建流时从 `currentConfig(dependencies)` 读取，改后下一条流即按新值；
  // 已经在途的流沿用建流时的间隔（定时器已经起好，不重设）。
  "sdk.streamHeartbeatMs",
  "agent.main",
  // `agent.worker` 整段：四项均在每次派发时从本轮 `turn.config` 读取，修改后下一次派发生效；
  // 在途 worker 沿用启动时的值。
  "agent.worker",
  "agent.maxConcurrentWorkers",
  "agent.progressThrottleMs",
  // 仲裁的两项在每次 `ask_parent` 时从本轮 `turn.config` 实时读取（builtins.ts）。
  "agent.askArbiter",
  "agent.askTimeoutMs",
  // harness 的四项同理：`available()` 与 `execute()` 均从本轮 `turn.config` 实时读取。清空
  // `allowedDirs` 后下一轮即将工具移出目录 —— 关闭一个绕过全部工具闸的能力不应等待重启。
  "agent.harness",
  // `agent.acp` 整段同理，且比 harness 更彻底：连接不缓存（每次工具调用 spawn 一次），
  // 因此没有任何启动快照 —— `available()` 与 `execute()` 均从本轮 `turn.config` 实时读取，
  // `AcpManager` 自身不持有配置。关闭 `enabled` 或清空 `allowedDirs`，下一轮即无该工具。
  "agent.acp",
  // 四项均在每轮从 `turn.config` 实时读取（runtime.ts 的 wrappedFor / subagent 的 provider 块），
  // 修改后下一轮生效；在途轮次沿用开轮时的值。
  "provider.maxRetries",
  "provider.retryBaseMs",
  "provider.retryMaxMs",
  "provider.requestTimeoutMs",
  "provider.streamIdleTimeoutMs",
  "provider.catalog",
  // 冷却期在每次 `rebuild()` 时读取，而 `provider.*` 的任何变更都会触发 rebuildModels。
  "provider.healthDownCooldownMinutes",
  // 出网放行开关在每次探测时实时读取（app.ts 的 probeProvider 调用点、main.ts 的 provider-health
  // cron、ModelCatalog 的 options getter）。
  // 它属于故障时运维会去调整的开关，冻结即意味着界面提示修改成功而下一次探测仍访问私网。
  "provider.allowPrivateBaseUrl",
  // 三项均由 memory_write 从本轮 `turn.config` 读取（`approvalFor` 与 queueWrite 各一次）。
  "memory.pubWriteMinRole",
  "memory.pubWriteRequiresApproval",
  "memory.requireSourceTag",
  // archive 的四个 limit 经 `inputSchemaFor(context)`，每轮从 `turn.config` 读取一次 —— 修改后
  // 下一轮模型看到的 schema 即为新上限。
  "tools.maxRegistered",
  "tools.maxCallsPerTurn",
  "tools.maxConsecutiveErrors",
  "tools.defaultTimeoutMs",
  "tools.overrides",
  "tools.exec",
  "tools.tg",
  "tools.archive",
  // `tools.catalog` 整段（前缀覆盖全部叶子）与 `tools.maxRegistered` 走同一路径：经 `ToolRegistry`
  // 的 limits getter（`apps/bot/src/main.ts` 中的 `() => configStore.snapshot()…`）在每次 `active()` /
  // `activeView()` 时实时读取。折叠判据刻意不在 `RegisteredTool` 上标记，正是为了不被 MCP reconcile
  // 与此处的热更新污染。
  "tools.catalog",
  // 这三项各自实时读取：宿主 fs 放行在 `filesFor` 中取 snapshot，域名策略在 web_fetch 中取 turn.config。
  // `tools.fs` / `tools.web` 的其余键仍为启动快照，因此只列这三条而非整段。
  "tools.fs.allowHostFsForOwner",
  "tools.web.allowlist",
  "tools.web.denylist",
  // 自我扩展整段：四个 `available()` 均从本轮 `turn.config` 实时读取，而 `main.ts` 的 config.changed
  // 订阅在 `tools.selfExtend.` 变化时重新执行 `customTools.reconcile()` —— 关闭 `customTools.enabled`
  // 后下一轮该批工具即从目录中消失。标注热更新前先确认该 reconcile 分支仍存在（docs/20 · W-CFG-02）。
  "tools.selfExtend",
  "approval.enabled",
  "approval.ttlMs",
  "approval.rules",
  "approval.skipForOwner",
  "approval.rememberWithinTurn",
  // captureBodies 每轮从 turn.config 实时读取（runtime.ts 的 bodyForLog、/api/turns/:id/detail），
  // 修改后下一轮生效。遗漏在白名单外时，WebUI 会对这个排障中最常调整的开关提示需重启。
  // AlertDispatcher 每次 raise() 都实时读取 `alerts` 整段（开关、去重窗口、webhook、事件白名单）。
  // `skills.package.*` 在 `install_skill`（从 `turn.config` 读取，下一轮生效）与
  // `POST /api/skills/package`（每请求从 `currentConfig()` 实时读取）两处均为实时读取。
  // 整段 `skills` 仍不能标注热更新：`dir` 已被 `SkillLoader` 在构造时取走，`enabled` / `watch`
  // 也只在启动时判定一次（docs/21 §9 末尾）。
  "sandbox",
  "skills.defaultMinRole",
  "skills.package",
  "quota",
  "alerts",
  "logs.level",
  "logs.captureBodies",
  // `logs.compress` 只决定**此后**写入的行怎么存（编码方式逐行记在 `data_codec` 上，
  // 旧行照读），所以它热更新是安全的：`OperationsRepository.compressLogPayloads` 每次
  // `config.changed` 后整体替换一次即可。
  "logs.compress",
  "logs.redactPatterns",
  // mcp 整段曾列于此，但 `mcp.healthCheckCron` 由 `scheduler.add(config.mcp.healthCheckCron, …)`
  // 在启动时取走，Scheduler 也没有重配入口 —— 整段标注热更新等于对该项作出错误陈述（docs/20 · W-CFG-02）。
  // 只有这三项确实按 getter 读取（`McpManager` 的 config getter 加 config.changed 后的 reconcile）。
  "mcp.enabled",
  "mcp.defaultMinRole",
  "mcp.servers",
  // 前四项均为实时读取：`enabled` 在每次触发时查询（关闭后在途任务不受影响、下一次触发即跳过），
  // 另三项在 `schedule_create` 中从 `turn.config` 读取。`schedule.retentionDays` 不在此处 ——
  // 它与 `logs.retentionDays` 一样是 MaintenanceService 的构造参数，修改后需重启才生效。
  "schedule.enabled",
  "schedule.maxPerChat",
  "schedule.minIntervalMinutes",
  "schedule.maxPayloadChars",
  // WebUI 自身的几项在每请求时从 currentConfig() 实时读取（app.ts 的 requestIp / allowedOrigin /
  // 登录限流 / createSession / activePasswordHash），修改后下一次请求即按新值执行。只有 host / port
  // 例外：它们在 `serve()` 时已绑定，必须重启。
  "webui.publicUrl",
  "webui.sessionTtlHours",
  "webui.passwordHash",
  "webui.trustProxy",
  "webui.trustedProxyHops",
  "webui.allowOrigins",
  "webui.loginRateLimit",
  // bot.ts 的 config Proxy 每次访问都取新快照，输出节奏在每轮开始时读取：修改后下一轮生效，
  // 在途轮次沿用开轮时的值（编辑节流的定时器已在运行，中途更换节拍只会打乱该消息的刷新）。
  "output",
] as const;

/**
 * 仍可写入但无任何读取方的键。第五轮将此表从 65 条压缩到 13 条：25 条完成接线、5 条从 schema 移除、
 * 22 条随告警/出网/输出/记忆/日志几组功能接线。剩余每一条都需写明保留原因 ——
 * 暂未实现与无法实现或不应在该层实现是两回事，后者必须说明，否则下一轮需重新判定一次。
 */
export const KNOWN_UNIMPLEMENTED_CONFIG_KEYS = [
  // webhook 模式整体未实现。`main.ts` 在 `mode !== 'polling'` 时显式抛错，因此不会出现配置为
  // webhook 后静默收不到消息的情形（docs/19 · R-CFG-03）。这三个键随该模式一并保留。
  "telegram.webhook.url",
  "telegram.webhook.path",
  "telegram.webhook.secretToken",
  // 在下一轮 RUNTIME 中提示消息已被编辑，需要把上一轮之后的编辑记录一路带入提示词装配，
  // 而 RUNTIME 块当前的输入只有 turn 与 config。接线需先为 RuntimeTurnContext 增加一块会话级
  // 瞬时状态 —— 那属于上下文引擎的对外接口，不应为一条提示语顺带修改。
  "telegram.notifyEdits",
  // 编辑消息永不开启新轮次（docs/20 · W-TG-05）。若要实现，需先确定编辑触发的轮次与原轮次的
  // 关系：重开一轮，还是改写历史？两种语义都会影响 rebase 与认领水位。
  "trigger.ignoreEditedAsTrigger",
  // 记忆压缩本身未实现：`memory.compactCron` 定时任务只统计超过软上限的文档数，没有任何位置
  // 产出压缩结果。为一个不存在的产物配置是否自动应用，属于假开关。
  "memory.autoApplyCompaction",
  // 仲裁（`askArbiter`）与其期限（`askTimeoutMs`）已接线（docs/14 A7）。转人工未实现：
  // 它需要一条阻塞式的人机通道 —— 在 Telegram 发送带 inline 选项的消息、等待用户点击、把结果回传
  // 给正在等待的子 agent。该通道整体不存在（同一缺口也阻碍 inline keyboard 审批，docs/25 §8）。
  // 仲裁失败时该键为真只会记录一条 warn，不会真正询问用户 —— 因此它仍属未接线。
  "agent.askEscalateToUser",
  // 抓取的网页先用某个别名摘要再进入上下文，需要在 web_fetch 中插入一次模型调用：计费、配额、
  // 取消信号、失败降级都需一并处理。这是一个完整特性，而非一行读取。
  // （`agent/ask-arbiter.ts` 已实现同类路径，接线时可沿用其形态。）
  "tools.web.summarizeWithAlias",
  // 相册合并需在触发路径上按 `media_group_id` 缓冲 update 后统一开启轮次，与并发、认领水位、
  // 去重均有交互。`concurrency.coalesceSameUserMs` 做的是按用户合并，此项是按相册合并。
  "media.groupDebounceMs",
  // 子路径挂载：需为所有路由添加前缀、修改静态资源 base、修改 SPA 的 router base，三处需同时调整。
  // `publicUrl` 已随 `/webui` 一次性登录链接完成接线（第五轮）。
  "webui.basePath",
  // ACP 的两项（`agent.acp.maxTerminals` / `agent.acp.progressIntervalMs`）已移出本表：
  // 反向 `terminal/*` 与进度卡片本轮均已实现，前者是 `AcpTerminals` 的句柄上界、后者是
  // `AcpProgressCard` 的编辑节流。它们此前列于此表的理由是没有 terminal 可计数、没有在途对象需要
  // 节流 —— 该前提已不成立，因此不应继续列在此处。
] as const;

/**
 * `perChat.<key>.…` 可覆盖的路径集合。这是一条安全边界（docs/11 §2.1）：绕过它可为单个会话
 * 关闭权限检查，因此 WebUI 的写端点必须经 `runtimeConfigSchema.safeParse(mergeDotted(...))`。
 *
 * 导出是为了让 `tests/config.test.ts` 也能校验它。`perChat` 为 `z.record(z.unknown())`，
 * 因此白名单中的路径不是 schema 叶子键 —— 每个叶子要么被引用、要么进入 KNOWN_UNIMPLEMENTED
 * 那条断言覆盖不到它们，而 `character` 正是因此存在了一轮：可写入 `config_kv`、可通过校验、
 * `perChatConfig` 也会将其合并进本轮配置，但没有任何代码读取它（docs/27 · C-08）。
 */
export const PER_CHAT_OVERRIDE_ALLOWLIST = [
  /^output\./,
  /^context\.(limit|background|active)\./,
  /^context\.scope$/,
  /^trigger\./,
  /^agent\.main\./,
  /^character$/,
  /^memory\.pubWriteMinRole$/,
] as const;
/**
 * 白名单中不对应任何 schema 叶子的键。每一条都必须确实被代码读取（由 `tests/config.test.ts`
 * 逐条断言），否则即为一个可写入、可通过校验但无任何作用的假配置项。
 *
 * `character`：会话级人格文件名，由 `assembleMainPrompt` 读取后传给
 * `PromptDocuments.paths(userId, characterOverride)`。它会被用作 `memory/` 下的路径段，
 * 因此那一侧设有文件名形态校验（同 `S-08` 的经验）。
 */
export const PER_CHAT_NON_SCHEMA_KEYS = ["character"] as const;

export const configSchema = z
  .object({
    general: z
      .object({
        name: z.string().default("洛璃"),
        timezone: ianaTimezone.default("Asia/Shanghai"),
        // `general.locale` 已从 schema 移除：docs/14 §4 明确 i18n 第一版不做，保留一个运行时从不读取
        // 的语言开关只会让运维误以为修改后即可切换界面语言。实现 i18n 时与 `webui/src/i18n` 一并加回。
        maintenanceCron: z.string().default("0 4 * * *"),
        shutdown: z
          .object({ graceMs: z.number().int().positive().default(30_000) })
          .default({}),
      })
      .default({}),
    telegram: z
      .object({
        mode: z.enum(["polling", "webhook"]).default("polling"),
        dropPendingOnStart: z.boolean().default(false),
        // 默认值即已实现处理器的那四条。`message_reaction` 曾出现在默认值中，而适配器从未接入它
        // （`packages/telegram` 中只有发送表情的工具）—— 申报一类无人处理的更新只会徒增流量。
        // 一条都不勾选不等于不接收任何内容：Bot API 将空数组解释为除 chat_member 等少数类型外全部
        // 接收，与界面上一个都未勾选的含义正好相反。因此空数组直接拒绝，而不是保留一个语义反转的配置项。
        allowedUpdates: z
          .array(z.enum(TELEGRAM_UPDATE_KINDS))
          .min(1, {
            message:
              "至少保留一类，且须包含 message，否则 bot 无法接收任何消息：空数组在 Bot API 中表示接收绝大多数类型，与界面上未勾选任何一项的含义相反",
          })
          .default([
            "message",
            "edited_message",
            "callback_query",
            "my_chat_member",
          ]),
        webhook: z
          .object({
            url: z.string().default(""),
            path: z.string().default("/webhook/telegram"),
            secretToken: z.string().default(""),
          })
          .default({}),
        allowBots: z.array(z.string()).default([]),
        notifyEdits: z.boolean().default(true),
        strictCommandSuffix: z.boolean().default(false),
        throttle: z
          .object({
            globalPerSecond: z.number().positive().default(30),
            perChatPerMinute: z.number().positive().default(20),
          })
          .default({}),
      })
      .default({}),
    access: z
      .object({
        defaultUserRole: role.default("blocked"),
        defaultChatRole: role.default("blocked"),
        archiveBlocked: z.boolean().default(false),
        /**
         * 需校验形态。该值（来自 `LUOLI_OWNER_ID` 这一自由字符串环境变量）会被直接用作路径段：
         * `memory/sources/<sourceId>/private/<id>/PRIMEMORY.md`（`memory/store.ts`、
         * `prompt/documents.ts`），定时任务的 `createdBy` 也走同一路径 ——
         * `LUOLI_OWNER_ID=../../etc` 会使私有记忆写到目录之外
         * （属自伤场景，但此前没有任何校验，docs/27 · S-08）。判据与 `TG_ID_PATTERN` 相同：
         * Telegram 数字 id。空串照常放行（`loadConfig` 另有 requireOwner 给出的更明确报错）。
         */
        bootstrapOwnerId: z
          .string()
          .refine((value) => value === "" || TG_ID_PATTERN.test(value), {
            message: "必须是 Telegram 数字 id（将用作私有记忆的目录名）",
          })
          .default(""),
      })
      .default({}),
    trigger: z
      .object({
        private: z.boolean().default(true),
        mention: z.boolean().default(true),
        reply: z.boolean().default(true),
        command: z.boolean().default(true),
        channels: z.boolean().default(false),
        wakewords: z.array(z.string()).default(["洛璃"]),
        wakewordMinLength: z.number().int().min(1).default(2),
        requireTextAfterMention: z.boolean().default(false),
        ignoreEditedAsTrigger: z.boolean().default(true),
        cooldownMsPerUser: z.number().int().nonnegative().default(0),
      })
      .default({}),
    context: z
      .object({
        scope: z.enum(["chat", "thread"]).default("chat"),
        limit: z
          .object({
            tokens: z.number().int().min(4000).max(500_000).default(32_000),
            maxMessages: z.number().int().positive().default(200),
            minKeepTurns: z.number().int().positive().default(1),
          })
          .default({}),
        // 活跃期：一次裁剪会使前缀缓存全部失效，因此不在对话活跃时裁剪。`windowMs` 是滑动的空闲间隔
        // （每轮提交顺延一次），静默满该时长后的第一轮才裁剪 —— 那时缓存本已过期，代价为零。
        // `tokens` / `maxMessages` 是推迟期间的上限：推迟不等于取消，触及上限即执行裁剪，且裁剪目标是
        // `limit.*` 而非该上限（裁剪到上限意味着此后每轮都需再裁一次，docs/02 §5.1.1）。
        active: z
          .object({
            windowMs: z.number().int().nonnegative().default(0),
            tokens: z.number().int().min(4000).max(2_000_000).default(128_000),
            maxMessages: z.number().int().positive().default(1000),
          })
          .default({}),
        hardCapRatio: z.number().gt(0.3).max(0.95).default(0.85),
        background: z
          .object({
            enabled: z.boolean().default(true),
            maxPerTurn: z.number().int().nonnegative().default(20),
            showUsername: z.boolean().default(true),
            showTime: z.boolean().default(true),
            includeNonText: z.boolean().default(true),
          })
          .default({}),
        rebase: z
          .object({
            injectNotice: z.boolean().default(false),
            markMeta: z.boolean().default(true),
          })
          .default({}),
        cacheCommits: z.number().int().positive().default(64),
        tokenRatioAlpha: z.number().gt(0).lte(1).default(0.2),
        /**
         * 清空上下文（`/new` / WebUI）之后，模型是否仍能从归档中检索清空之前的内容。
         *
         * 关闭（默认）即只移动 `done` 指针：窗口已清空，但 `read_messages` / `search_messages` /
         * `get_message` 读取的是 `messages` 归档表，不受窗口约束 —— 实测清空后模型第一步即执行
         * `read_messages({direction:'before',limit:20})` 将 20 条历史整段取回，该工具结果又进入
         * 新窗口，于是清空在用户看来未生效（logs/2026-08-19 · turn `01M0CKK6W018B5KS9613SNEX5J`）。
         *
         * 开启即将清空时刻的 `messages.id` 记入 reset commit 的 `meta.archiveFloor`，三个归档工具
         * 只能看到其后的消息，并且清空会将背景认领水位一并推进到该位置 —— 否则清空之前尚未被认领
         * 的群消息会从另一条路径进入新窗口，与隔断语义矛盾。
         * owner 的 `admin_search_messages` 不受此限制（跨会话，按 key 记录的水位对它没有意义）。
         */
        recallBarrier: z.boolean().default(false),
      })
      .default({}),
    concurrency: z
      .object({
        mode: z.enum(["parallel", "serial"]).default("parallel"),
        perKey: z.number().int().positive().default(3),
        global: z.number().int().positive().default(8),
        queueMax: z.number().int().nonnegative().default(20),
        coalesceSameUserMs: z.number().int().nonnegative().default(0),
        turnTimeoutMs: z.number().int().positive().default(600_000),
      })
      .default({}),
    sdk: z
      .object({
        /**
         * SSE 保活注释帧的间隔（毫秒），`0` 关闭。
         *
         * 默认 15s：流在轮次执行期间可能长时间没有任何数据（模型在想、工具在跑），而 nginx 的
         * `proxy_read_timeout` 默认 60s —— 反代会比本系统自身的 `turnTimeoutMs`（默认 600s）
         * 更早掐断连接，客户端读到的是一次传输层中断而不是 `error` 事件。15s 给了 4 倍余量。
         */
        streamHeartbeatMs: z.number().int().nonnegative().default(15_000),
      })
      .default({}),
    cancel: z.object({ commitPartial: z.boolean().default(false) }).default({}),
    prompt: z
      .object({
        maxTokens: z.number().int().positive().default(12_000),
        includeToolCatalog: z.boolean().default(true),
        runtimeBlock: z
          .object({
            showQuota: z.boolean().default(true),
            showContextWatermark: z.boolean().default(true),
            showWorkspace: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),
    memory: z
      .object({
        dir: z.string().default("./memory"),
        pubWriteMinRole: role.default("trusted"),
        pubWriteRequiresApproval: z.boolean().default(false),
        softLimitTokens: z.number().int().positive().default(1500),
        hardLimitTokens: z.number().int().positive().default(3000),
        maxSections: z.number().int().positive().default(12),
        compactCron: z.string().default("0 3 * * 0"),
        autoApplyCompaction: z.boolean().default(false),
        requireSourceTag: z.boolean().default(true),
      })
      .default({}),
    agent: z
      .object({
        main: z
          .object({
            modelAlias: z.string().default("main"),
            maxSteps: z.number().int().positive().default(12),
            downgradeAfterStep: z.number().int().positive().default(8),
          })
          .default({}),
        // lw-worker：唯一的内建 worker，拿的是调用者有效角色下的工具全集。没有 `tools` 白名单，
        // 收窄由角色、`tools.overrides` 与 skill 允许集承担 —— 再加一层名单只会与它们分岔。
        worker: z
          .object({
            modelAlias: z.string().default("low"),
            maxSteps: z.number().int().positive().default(12),
            resultMaxChars: z.number().int().positive().default(4000),
            // `full` 档回灌给主 agent 的硬上界。`agent_runs.result_summary` 一侧没有降级兜底，
            // 因此这一档必须按构造有界，而不是等写入时才失败。
            maxResultChars: z.number().int().positive().default(65_536),
          })
          .default({}),
        maxConcurrentWorkers: z.number().int().positive().default(3),
        maxWorkersPerTurn: z.number().int().positive().default(10),
        askTimeoutMs: z.number().int().positive().default(120_000),
        maxAsksPerRun: z.number().int().positive().default(5),
        askArbiter: z.boolean().default(true),
        askEscalateToUser: z.boolean().default(false),
        progressThrottleMs: z.number().int().positive().default(3000),
        // M11 · HarnessAgent（docs/14 §2 Q8）：启动外部 CLI（Claude Code / Codex）修改宿主上的仓库。
        // `allowedDirs` 为空即整个功能关闭，工具不会进入模型的目录 —— 这是刻意的默认值：它绕过
        // 本系统全部工具闸（T17），启用必须是一次显式的运维操作，而非安装即可用。
        harness: z
          .object({
            command: z.string().default("claude"),
            // 任务正文作为 argv 的最后一项追加在这些参数之后，不经过 shell。
            args: z.array(z.string()).default(["-p"]),
            allowedDirs: z.array(z.string()).default([]),
            // 与 `allowedDirs` 取「或」：为真时本会话的默认工作目录
            // （`<sandbox.workspaceDir>/<chatId>/harness/<runId>`）无需登记即视为白名单内。
            // 单列一个开关而不是往 `allowedDirs` 里塞一条模板路径：那条路径含运行时才知道的
            // `chatId` 与 `runId`，写不进一份静态配置。
            workspaceFallback: z.boolean().default(false),
            timeoutMs: z.number().int().positive().default(900_000),
            maxOutputBytes: z.number().int().positive().default(65_536),
          })
          .default({}),
        // M13 · ACP 客户端（与 docs/14 §2 Q8 同一路径，改用协议而非 argv）。形状与默认值的理由见
        // `acp/schema.ts` —— 该文件不 import SDK 运行时，以便这份 schema 与 `scripts/config-schema.ts`
        // 都无需引入整个 ACP SDK。不扩展 `harness`：那一侧 `args` 的契约是任务正文作为 argv 最后一项，
        // 而 ACP 下任务经 `session/prompt` 传递，argv 中不含任务。
        acp: acpSchema.default({}),
      })
      .default({}),
    provider: z
      .object({
        maxRetries: z.number().int().nonnegative().default(2),
        retryBaseMs: z.number().int().positive().default(1000),
        retryMaxMs: z.number().int().positive().default(30_000),
        healthCheckCron: z.string().default("*/10 * * * *"),
        healthDownCooldownMinutes: z.number().positive().default(30),
        requestTimeoutMs: z.number().int().positive().default(120_000),
        streamIdleTimeoutMs: z.number().int().positive().default(60_000),
        allowPrivateBaseUrl: z.boolean().default(false),
        // 模型元数据目录（models.dev）。只在 WebUI 主动拉取时出网，缓存到 cacheFile 后按 ttlHours 用
        // ETag 条件请求续期；关闭后拉取模型只能得到上游 /models 提供的有限信息（docs/04 §5.4.1）。
        catalog: z
          .object({
            enabled: z.boolean().default(true),
            url: z.string().url().default("https://models.dev/api.json"),
            cacheFile: z.string().default("./data/cache/models.dev.json"),
            ttlHours: z.number().positive().default(168),
            timeoutMs: z.number().int().positive().default(30_000),
          })
          .default({}),
      })
      .default({}),
    tools: z
      .object({
        maxRegistered: z.number().int().positive().default(80),
        maxCallsPerTurn: z.number().int().positive().default(40),
        maxConsecutiveErrors: z.number().int().positive().default(3),
        defaultTimeoutMs: z.number().int().positive().default(60_000),
        // 运维覆盖层（docs/09 §3.7）。后三项一律 optional 且不设默认值 —— 字段缺失即沿用
        // `TOOL_POLICY` 或工具自身声明的值。写死默认值等于把每条历史覆盖行固定在写入当日的策略上。
        // 放宽需二次确认属于 `PATCH /api/tools/:name` 的端点行为而非 schema 约束：schema 只负责形状。
        overrides: z
          .record(
            z.object({
              enabled: z.boolean().default(true),
              minRole: role.optional(),
              approval: z.enum(APPROVAL_POLICIES).optional(),
              timeoutMs: z.number().int().positive().optional(),
            }),
          )
          .default({}),
        // 工具目录按需暴露（docs/07 §5）。仅为提示层视图：折叠只影响模型能否看到 schema，
        // 不新增以目录为边界的闸 —— 未展开工具被直接调用时照常经过 `admit()` / `execute()`。
        catalog: z
          .object({
            // 默认 `true` 在出厂配置下不产生任何变化：`mcp.enabled` 默认 false、`selfExtend.customTools`
            // 默认关闭、出厂 `plugins/` 只有 `.gitkeep`，因此出厂折叠集为空，而折叠集为空时 `search_tools`
            // 不进入目录，纯内建部署的提示词逐字节不变。理由不是 plugin 默认关闭：下方的
            // `plugins.enabled` 默认即为 `true`（它控制是否扫描插件目录；默认关闭的是只管 `write_plugin`
            // 的 `tools.selfExtend.plugins.enabled`）—— 向 `plugins/` 放入一个插件、owner 在扩展页启用它
            // （写入库时为 `enabled=0`），折叠集即非空。折叠判据按 `policy.source` 判定（mcp / plugin /
            // custom 三个来源一律折叠，不参考任何开关）。
            deferExternal: z.boolean().default(true),
            // 工具名 glob（minimatch，先例为 `mcp` 的 `toolAllow` 与 `tools.fs.denyGlobs`），命中的内建 /
            // agent 族同样折叠。命中豁免表（`search_tools` / `load_skill`）的模式静默不生效 —— 将展开
            // 入口本身折叠后即无任何途径执行展开。
            defer: z.array(z.string()).default([]),
            // 判据的最高优先级，高于上面两项：默认全部常驻加显式折叠才是向后兼容的方向，因此
            // 常驻为补集，而该白名单是运维在折叠整台 server 后恢复少数常用工具的唯一途径。
            resident: z.array(z.string()).default([]),
            // 取 `false` 时 TOOL CATALOG 的常驻段只列名字：描述与 provider tools 数组中的完全重复，
            // 而 tools 数组位于请求体头部、属缓存前缀，catalog 位于易变段且每步重发 —— 重复的成本主要
            // 在此。默认 `true` 保持现状逐字节不变：折叠与去重是两个独立变量，同时修改会在模型行为
            // 下降时无法归因（docs/06 §1）。
            residentDescriptions: z.boolean().default(true),
            // 一轮内累计展开工具数的上限（判据为 `已展开 + 本次新增 > 上限` 即整次拒绝）。实际需要抑制
            // 的是展开次数 —— 每次展开都会使请求体第 0 段（tools 数组）变化、击穿本轮剩余步骤的前缀缓存
            // （docs/04 §2.1）—— 因此触及上限时的 hint 是改用精确 `names` 一次批量展开：批量占用相同额度，
            // 但只承担一次缓存失效的代价。次数的硬上限来自 `agent.main.maxSteps`，而非此项。
            maxExpandedPerTurn: z.number().int().positive().default(32),
          })
          .default({}),
        fs: z
          .object({
            maxReadBytes: z.number().int().positive().default(262_144),
            maxWriteBytes: z.number().int().positive().default(5_242_880),
            showHidden: z.boolean().default(false),
            allowHostFsForOwner: z.boolean().default(false),
            denyGlobs: z
              .array(z.string())
              .default([
                "**/.env*",
                "**/*.pem",
                "**/*.key",
                "**/id_rsa*",
                "**/.ssh/**",
                "**/.git/config",
                "<root>/config/**",
                "<root>/data/luoli.db*",
                "<root>/memory/**",
                "<root>/skills/**",
                "<root>/plugins/**",
              ]),
            trashDir: z.string().default(".luoli-trash"),
            backupDir: z.string().default(".luoli-bak"),
          })
          .default({}),
        exec: z
          .object({
            defaultTimeoutMs: z.number().int().positive().default(60_000),
            maxTimeoutMs: z.number().int().positive().default(300_000),
            maxOutputBytes: z.number().int().positive().default(65_536),
          })
          .default({}),
        archive: z
          .object({
            defaultSearchLimit: z.number().int().positive().default(20),
            maxSearchLimit: z.number().int().positive().default(100),
            defaultReadLimit: z.number().int().positive().default(50),
            maxReadLimit: z.number().int().positive().default(200),
          })
          .default({}),
        tg: z
          .object({
            maxExtraMessagesPerTurn: z.number().int().nonnegative().default(3),
            maxFileSendMb: z.number().positive().default(50),
          })
          .default({}),
        web: z
          .object({
            maxResponseBytes: z.number().int().positive().default(2_097_152),
            timeoutMs: z.number().int().positive().default(15_000),
            retries: z.number().int().nonnegative().max(5).default(2),
            summarizeWithAlias: z.string().default("low"),
            allowlist: z.array(z.string()).default([]),
            denylist: z.array(z.string()).default(["*.local", "*.internal"]),
            searchProvider: z
              .enum(["", "brave", "serper", "tavily", "exa"])
              .default(""),
            searchApiKey: z.string().default(""),
          })
          .default({}),
        // 自我扩展（docs/07 §6）：模型为自身编写工具 / skill / plugin，或安装 MCP。
        // 整块默认关闭，与 `mcp.enabled`、`agent.harness.allowedDirs` 形态一致 —— 这几项都属于
        // 开启后模型可改变自身下一轮能力的功能，默认值必须为关闭。
        selfExtend: z
          .object({
            enabled: z.boolean().default(false),
            // `autoEnable` 开启即定义完成后下一轮可用。默认关闭的理由：网页或群聊注入 → define_tool →
            // owner 因 `approval.skipForOwner` 无感放行 → 立即成为持久能力，全程无人介入。
            // `requireSandbox` 开启后连 owner 也必须使用沙箱，此时自定义工具严格弱于 bash；
            // 默认关闭是需求方的决定（与 bash 同等对待），代价见 docs/14 T19。
            customTools: z
              .object({
                enabled: z.boolean().default(false),
                autoEnable: z.boolean().default(false),
                requireSandbox: z.boolean().default(false),
                maxTools: z.number().int().positive().default(20),
                maxBodyChars: z.number().int().positive().default(8000),
                defaultMinRole: z.enum(["trusted", "owner"]).default("owner"),
                timeoutMs: z.number().int().positive().default(60_000),
              })
              .default({}),
            // `minRole` 是模型编写的 skill 的下限：它可以写得更严格，不能写得更宽松。
            skills: z
              .object({
                enabled: z.boolean().default(false),
                minRole: role.default("trusted"),
              })
              .default({}),
            // stdio 即一条由模型生成的 argv，以 bot 进程身份运行在沙箱之外。写入后即禁用（由 owner 在
            // WebUI 复审该 argv 后再启用），若连这一步也不允许，可将 stdio 从此处移除。
            mcp: z
              .object({
                enabled: z.boolean().default(false),
                allowTransports: z
                  .array(z.enum(["stdio", "http"]))
                  .default(["stdio", "http"]),
              })
              .default({}),
            // plugin 在进程内完全受信（docs/14 A27）。模型只能写入文件，启用始终是 owner 的操作。
            plugins: z
              .object({
                enabled: z.boolean().default(false),
                maxBodyChars: z.number().int().positive().default(200_000),
              })
              .default({}),
          })
          .default({}),
      })
      .default({}),
    sandbox: z
      .object({
        mode: z.enum(["none", "docker"]).default("docker"),
        bypassRoles: z.array(role).default(["owner"]),
        image: z.string().default("luoli-sandbox:latest"),
        network: z.enum(["none", "bridge"]).default("none"),
        memoryMb: z.number().positive().default(512),
        cpus: z.number().positive().default(1),
        pidsLimit: z.number().int().positive().default(128),
        readOnlyRoot: z.boolean().default(true),
        tmpfsMb: z.number().positive().default(64),
        workspaceDir: z.string().default("./data/workspace"),
        hostWorkspaceDir: z.string().default(""),
        dockerBin: z.string().default("docker"),
        // 会话级持久容器（docs/05 §5.5）。`network` 与上方的 `sandbox.network` 是两个独立键：
        // 前者管理一次性容器（默认断网），后者管理持久容器（默认出网）。合并为一个的话，开启持久化
        // 会连带为一次性路径开放网络 —— 一个开关不应同时改变两件事。
        persistent: z
          .object({
            enabled: z.boolean().default(false),
            idleTtlMs: z.number().int().positive().default(86_400_000),
            maxLifetimeMs: z.number().int().nonnegative().default(0),
            maxContainers: z.number().int().positive().default(16),
            network: z.enum(["none", "bridge"]).default("bridge"),
            reapCron: z.string().default("*/5 * * * *"),
          })
          .default({}),
      })
      .default({}),
    // `allowInitiator` 已移除：WebUI 只有一个 owner 身份（docs/14 A15），裁决权无法下放至发起人，
    // 该开关在当前架构中没有可实现的落点（docs/21 §6）。
    approval: z
      .object({
        enabled: z.boolean().default(true),
        ttlMs: z.number().int().positive().default(180_000),
        skipForOwner: z.boolean().default(true),
        rememberWithinTurn: z.boolean().default(true),
        rules: z.array(approvalRuleSchema).default([]),
      })
      .default({}),
    output: z
      .object({
        mode: z.enum(["stream", "once"]).default("stream"),
        replyDelayMs: z.number().int().nonnegative().max(30_000).default(2000),
        streamBufferMs: z
          .number()
          .int()
          .nonnegative()
          .max(30_000)
          .default(2000),
        streamIntervalMs: z.number().int().positive().default(2000),
        streamMinDeltaChars: z.number().int().positive().default(24),
        flushOnSentence: z.boolean().default(true),
        maxMessageChars: z.number().int().min(100).max(4000).default(3900),
        parseMode: z.enum(["MarkdownV2", "HTML", "none"]).default("MarkdownV2"),
        typingWhileWorking: z.boolean().default(true),
        placeholderAfterMs: z.number().int().positive().default(4000),
        // 占位消息的文案。默认值即此前硬编码的 `…`，因此不配置时行为与之前一致。空数组表示不发送
        // 占位消息 —— `placeholderAfterMs` 为 positive，无法填 0，在此之前没有任何关闭途径。
        // 元素不加 `.min(1)`：被 schema 拦截的表现是整个进程无法启动（在 config_kv 中多输入一个空行
        // 即可触发），而空白行在挑选时被滤除只是少一条备选。
        placeholderTexts: z.array(z.string()).default(["…"]),
        placeholderPick: z.enum(["random", "fixed"]).default("random"),
        placeholderIndex: z.number().int().nonnegative().default(0),
        maxMentions: z.number().int().nonnegative().default(3),
      })
      .default({}),
    // `retentionDays`：媒体文件的保留天数（0 表示不清理）。删除文件、保留 `attachments` 行并将
    // `download_state` 置为 'expired' —— 若删除行，历史消息中的「[图片]」连同 mime、尺寸、已提取
    // 正文会一并消失（docs/14 §2 Q9-a）。与 `maintenance.retention.*` 一样在启动时传给
    // MaintenanceService，因此属于需重启项。
    /**
     * `visionScope`：判定本轮含图时统计哪些图片（`docs/04 §5.2`、`docs/08 §7.2`）。
     *
     * `window`（默认，即既有行为）表示整个上下文窗口，`snapshot + delta` 合并统计。代价是一张图片
     * 会使其后的每一轮都固定在 vision 别名上：图片留在窗口内，而判据不区分用户当前发送的与三轮前
     * 的那张 —— 纯文本提问同样会切换到成本更高的别名；在没有任何支持图像的别名时，该轮回复末尾还会
     * 附加图片未被查看的提示，而用户本轮根本没有发送图片。
     *
     * `turn` 表示只统计本轮新进入的图片（触发消息、被回复的那条、本轮认领的群背景消息，即
     * `turn.delta`）。更早轮次留在窗口内的图片：只有本轮确实落在不支持图像的模型上时才整体替换为
     * 占位文本（`docs/02` 的不变量：不透明 part 要么原样保留、要么整体替换为占位，不能截断），
     * 落在支持图像的模型上则原样携带 —— 重新查看上文图片的场景在 vision 模型上仍然可用。
     */
    media: z
      .object({
        dir: z.string().default("./data/files"),
        retentionDays: z.number().int().nonnegative().default(90),
        maxImageBytes: z.number().int().positive().default(8_388_608),
        maxDocBytes: z.number().int().positive().default(20_971_520),
        maxImageEdge: z.number().int().positive().default(1568),
        maxImagesPerTurn: z.number().int().positive().default(4),
        visionScope: z.enum(["window", "turn"]).default("window"),
        groupDebounceMs: z.number().int().positive().default(1500),
        stickerAsImage: z.boolean().default(false),
        downloadVoice: z.boolean().default(true),
        extract: z
          .object({
            enabled: z.boolean().default(true),
            maxChars: z.number().int().positive().default(40_000),
            inlineChars: z.number().int().positive().default(4000),
            codeExtensions: z.array(z.string()).default([]),
          })
          .default({}),
      })
      .default({}),
    skills: z
      .object({
        enabled: z.boolean().default(true),
        dir: z.string().default("./skills"),
        watch: z.boolean().default(true),
        defaultMinRole: role.default("trusted"),
        // 安装 skill 包时的解包上限（docs/07 §2.5）。两个体积上限一律按实际写出的字节数判定，
        // 不采信 zip 头中的 `uncompressedSize` —— 该字段由打包方填写，压缩炸弹正是由此进入。
        // 关闭 `allowExecutable` 后包退化为纯文本，`scripts/` 与 `bin/` 即使安装也无法执行。
        package: z
          .object({
            maxEntries: z.number().int().positive().default(2000),
            maxTotalBytes: z.number().int().positive().default(67_108_864),
            maxFileBytes: z.number().int().positive().default(33_554_432),
            allowExecutable: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),
    plugins: z
      .object({
        enabled: z.boolean().default(true),
        dir: z.string().default("./plugins"),
        watch: z.boolean().default(false),
        hookTimeoutMs: z.number().int().positive().default(5000),
        order: z.array(z.string()).default([]),
        autoDisableAfterErrors: z.number().int().positive().default(3),
      })
      .default({}),
    mcp: z
      .object({
        enabled: z.boolean().default(false),
        connectTimeoutMs: z.number().int().positive().default(15_000),
        healthCheckCron: z.string().default("*/5 * * * *"),
        defaultMinRole: role.default("trusted"),
        servers: z.array(mcpServerSchema).default([]),
      })
      .default({}),
    // 定时任务（docs/14 §2 Q4 已决策）。上界写入 schema 而不仅写在工具描述中：模型可见 schema，
    // 不可见我方文档（docs/26 §5）。`minIntervalMinutes` 限制的是 cron 两次触发之间的间隔 ——
    // `* * * * *` 在 agent 模式下即每分钟一次真实模型调用。
    schedule: z
      .object({
        enabled: z.boolean().default(true),
        maxPerChat: z.number().int().positive().max(200).default(20),
        minIntervalMinutes: z.number().int().positive().default(5),
        maxPayloadChars: z.number().int().positive().max(20_000).default(2000),
        retentionDays: z.number().int().nonnegative().default(30),
      })
      .default({}),
    /**
     * 维护任务的保留期。`MaintenanceService.cleanup()` 此前只清理 `log_events` / `processed_updates` /
     * `sessions` / `approvals` / 子 agent 结果 / `scheduled_jobs`，而 `usage_ledger` /
     * `config_revisions` / `memory_revisions` / `quota_counters` 只增不减 —— 读端点均有 LIMIT，
     * 因此症状不是慢查询而是库文件持续增长，且 `VACUUM` 无效（数据仍在，docs/27 · R-05）。
     *
     * 此处只为这四张派生数据表设定保留期。`turns` 与 `tasks` 刻意不在其中：它们是 trace 的骨架
     * （`/api/turns/:id/detail` 依靠 turn 行串联日志、用量与上下文），删除等于历史轮次消失
     * —— 那属于 docs/14 §2 Q9 的未决问题，不宜代需求方决定。每一项取 0 表示不清理。
     */
    maintenance: z
      .object({
        retention: z
          .object({
            usageDays: z.number().int().nonnegative().default(400),
            quotaCounterDays: z.number().int().nonnegative().default(400),
            configRevisionDays: z.number().int().nonnegative().default(180),
            memoryRevisionDays: z.number().int().nonnegative().default(180),
          })
          .default({}),
      })
      .default({}),
    // 没有 ftsTokenizer：`tokenize='trigram'` 写死在 0001_init.sql 的建表语句中，更换它必须追加一份
    // 重建 `messages_fts` 的迁移，配置项无法生效。docs/14 §2 Q3 已决定不引入 jieba，该键随之移除。
    db: z
      .object({
        path: z.string().default("./data/luoli.db"),
        backupKeep: z.number().int().nonnegative().default(5),
        vacuumCron: z.string().default("0 5 * * 0"),
      })
      .default({}),
    logs: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        // 日志的唯一落点，独立于 `db.path`（docs/10 §3）。主库有 `VACUUM INTO` 备份与定期
        // VACUUM 两处整库重写，把载荷并进去等于每次迁移复制一遍。
        dbPath: z.string().default("./data/logs.db"),
        captureBodies: z.boolean().default(true),
        compress: z.boolean().default(true),
        retentionDays: z.number().int().nonnegative().default(30),
        console: z.enum(["pretty", "json", "off"]).default("pretty"),
        redactPatterns: z.array(z.string()).default([]),
      })
      .default({}),
    quota: z
      .object({
        enabled: z.boolean().default(true),
        requirePricing: z.boolean().default(true),
        minReserveUsd: z.number().nonnegative().default(0.02),
        global: z
          .object({
            daily: nullableMoney.default(5),
            monthly: nullableMoney.default(100),
          })
          .default({}),
        perChat: z
          .object({
            daily: nullableMoney.default(1),
            monthly: nullableMoney.default(null),
          })
          .default({}),
        perUser: z
          .object({
            daily: nullableMoney.default(0.5),
            monthly: nullableMoney.default(null),
            byRole: z
              .record(
                z.object({
                  daily: nullableMoney.optional(),
                  monthly: nullableMoney.optional(),
                }),
              )
              .default({}),
          })
          .default({}), // perTurn 只保留真正生效的两项。maxToolCalls / maxSubagents / maxDurationMs 已移除：
        // 它们各有一个真正生效的同名键（`tools.maxCallsPerTurn` / `agent.maxWorkersPerTurn` /
        // `concurrency.turnTimeoutMs`），并存会导致运维在错误的配置项上修改（同 docs/22 · N-CFG-02）。
        perTurn: z
          .object({
            maxCostUsd: z.number().positive().default(0.5),
            maxSteps: z.number().int().positive().default(12),
          })
          .default({}),
        rateLimit: z
          .object({
            turnsPerUserPerHour: z.number().int().positive().default(30),
            turnsPerChatPerHour: z.number().int().positive().default(100),
            concurrentPerUser: z.number().int().positive().default(2),
          })
          .default({}),
        onExceeded: z
          .object({
            reply: z.boolean().default(true),
            message: z
              .string()
              .default(
                "今天的额度用完了（已用 {spent}/{limit}），{resetAt} 重置。",
              ),
            notifyOwner: z.boolean().default(true),
          })
          .default({}),
        warnAtRatio: z.number().gt(0).lte(1).default(0.8),
      })
      .default({}),
    webui: z
      .object({
        enabled: z.boolean().default(true),
        host: z.string().default("127.0.0.1"),
        port: z.number().int().positive().default(8787),
        basePath: z.string().default("/"),
        publicUrl: z.string().default(""),
        sessionTtlHours: z.number().positive().default(168),
        passwordHash: z.string().default(""),
        trustProxy: z.boolean().default(false),
        trustedProxyHops: z.number().int().min(1).max(16).default(1),
        allowOrigins: z.array(z.string()).default([]),
        loginRateLimit: z
          .object({
            attempts: z.number().int().positive().default(5),
            windowMinutes: z.number().int().positive().default(15),
          })
          .default({}),
      })
      .default({}),
    alerts: z
      .object({
        notifyOwner: z.boolean().default(true),
        dedupeMinutes: z.number().positive().default(30),
        webhookUrl: z.string().default(""),
        on: z.array(z.string()).default([]),
      })
      .default({}),
    perChat: z.record(z.unknown()).default({}),
  })
  .superRefine((cfg, ctx) => {
    /**
     * 三条跨字段校验必须给出对方字段的当前取值：WebUI 表单一次只修改一个字段，而这三条报错表达的
     * 是所修改字段与另一字段冲突 —— 只提示必须小于硬上限的话，运维无法得知硬上限当前是多少，
     * 也就无从判断应将哪个字段改成什么（`GET /api/config` 中的 200 多个值需自行查找）。
     */
    if (cfg.concurrency.perKey > cfg.concurrency.global)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["concurrency", "perKey"],
        message: `单会话并发（${cfg.concurrency.perKey}）不能大于全局并发 concurrency.global（当前 ${cfg.concurrency.global}）—— 前者是后者的一部分`,
      });
    if (cfg.memory.softLimitTokens >= cfg.memory.hardLimitTokens)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memory", "softLimitTokens"],
        message: `软上限（${cfg.memory.softLimitTokens}）必须小于硬上限 memory.hardLimitTokens（当前 ${cfg.memory.hardLimitTokens}）：软上限触发压缩、硬上限直接截断，两者相等将使压缩失效。请同时修改这两个字段以调大上限`,
      });
    if (
      cfg.webui.host !== "127.0.0.1" &&
      cfg.webui.host !== "::1" &&
      !cfg.webui.passwordHash
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["webui", "passwordHash"],
        message: `绑定 ${cfg.webui.host} 等非回环地址时必须先设置登录口令（webui.passwordHash 当前为空）：使用 pnpm webui:passwd <口令> 生成哈希，或使用设置页的「修改登录口令」`,
      });
    for (const [key, value] of Object.entries(cfg.perChat)) {
      const walk = (node: unknown, prefix = ""): void => {
        if (!node || typeof node !== "object" || Array.isArray(node)) {
          if (
            !PER_CHAT_OVERRIDE_ALLOWLIST.some((pattern) => pattern.test(prefix))
          )
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["perChat", key, ...prefix.split(".")],
              message: "path is not in perChat override allowlist",
            });
          return;
        }
        for (const [part, child] of Object.entries(node))
          walk(child, prefix ? `${prefix}.${part}` : part);
      };
      walk(value);
      const memoryRole = (value as { memory?: { pubWriteMinRole?: unknown } })
        .memory?.pubWriteMinRole;
      if (
        typeof memoryRole === "string" &&
        ["blocked", "limited", "trusted", "owner"].includes(memoryRole) &&
        roleRank(memoryRole as "blocked" | "limited" | "trusted" | "owner") <
          roleRank(cfg.memory.pubWriteMinRole)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["perChat", key, "memory", "pubWriteMinRole"],
          message: "会话级公开记忆写入角色只能比全局更严格",
        });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;
