import { z } from 'zod';
import { roleRank, TG_ID_PATTERN } from '@luoli/shared';
import { checkApprovalPattern } from '../approval/rules.js';
import { APPROVAL_POLICIES } from '../tools/policy.js';

const role = z.enum(['owner', 'trusted', 'limited', 'blocked']);
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
 * 「这台 server 怎么登录」。**凭据本身不在这里** —— 它在 `mcp_auth` 表里，加密存放
 * （migrations/0011，理由写在那个文件开头：配置要进 `config_revisions` 与配置导出，
 * 而 `headers.Authorization` 逃得过按键名判密的那条正则）。
 *
 * `stdio` 没有这个字段：OAuth 是 HTTP 的事，而一台 stdio server 的「登录」是它自己在带外做的
 * （照 harness 的先例，docs/07 §4.5）—— 能帮上的只有把它的 stderr 收进日志。
 */
const mcpAuthSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('bearer') }),
  z.object({
    mode: z.literal('oauth'),
    scope: z.string().optional(),
    /** 对方不支持动态注册（RFC 7591）时手填。留空就走动态注册。 */
    clientId: z.string().min(1).optional(),
    /** 授权服务器与资源服务器不同源、且对方没有 RFC 9728 元数据时手指一下。 */
    issuer: z.string().url().optional(),
  }),
]);
const mcpServerSchema = z.discriminatedUnion('transport', [
  mcpServerBase.extend({ transport: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string()).default({}) }),
  mcpServerBase.extend({ transport: z.literal('http'), url: z.string().url(), headers: z.record(z.string()).default({}), auth: mcpAuthSchema.default({ mode: 'none' }) }),
]);
/**
 * 审批规则此前是 `z.record(z.unknown())`：写入端什么都收，运行时 `ApprovalRules` 却会把没有 `tool`
 * 的规则整条丢掉、`pattern` 编译不了的规则永不命中、`risk` 写错时当 medium ——「静默不生效」的
 * 审批门等于门开着，而界面上一路 200 OK。收严之后写错当场 400。
 * `always` 只收 `true`：运行时没有「命中但不需要审批」这个语义，收下 `false` 等于再造一个假开关。
 */
const approvalRuleSchema = z.object({
  tool: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  pattern: z.string().min(1).optional(),
  when: z.literal('target_exists').optional(),
  always: z.literal(true).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
}).strict().superRefine((rule, ctx) => {
  if (rule.pattern === undefined) return;
  // 与 `compilePattern`（approval/rules.ts）同一份实现：RE2 + 128 字符上界。能编译但会指数回溯的
  // 模式此前照样收 —— 而求值对象是模型给的工具参数，一次回溯卡死的是整个单线程进程（docs/27 · S-03）。
  const checked = checkApprovalPattern(rule.pattern);
  if (!checked.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pattern'], message: `这条规则在运行时永不命中：${checked.reason}` });
});
/**
 * Bot API 的全部更新类型（`getUpdates` 的 `allowed_updates`）。**前四条是本适配器真的有处理器的**，
 * 排在前面是因为 WebUI 按这个顺序渲染那一组复选框；其余的申报了也不会有任何行为 —— 逐条的
 * 「已处理 / 无处理器」写在 `CONFIG_ENUM_NOTES`（descriptions.ts），与这里同一份顺序。
 *
 * 收成 enum 而不是自由字符串：拼错一个名字 Telegram 会整条 `getUpdates` 400，而表现是「bot 一条
 * 消息都收不到」，与配置面板上那个绿色的「保存成功」隔着一次重启。加处理器时这张表要跟着动。
 */
export const TELEGRAM_UPDATE_KINDS = [
  'message', 'edited_message', 'callback_query', 'my_chat_member',
  'channel_post', 'edited_channel_post', 'message_reaction', 'message_reaction_count',
  'inline_query', 'chosen_inline_result', 'shipping_query', 'pre_checkout_query', 'purchased_paid_media',
  'poll', 'poll_answer', 'chat_member', 'chat_join_request', 'chat_boost', 'removed_chat_boost',
  'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages',
] as const;
/** 拼错的时区只在群聊分支炸（私聊不走 Intl），漏到运行时会让整个群会话开不了轮次。 */
const ianaTimezone = z.string().refine((zone) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}, { message: '不是合法的 IANA 时区名' });
/**
 * 真正会跟着 `config.changed` 生效的键（前缀匹配）。判据只有一个：**运行时读的是 getter
 * （`configStore.snapshot()` / `turn.config` / bot.ts 的 config Proxy），而不是启动时那份快照**。
 * doc 11 里标 `热更新` 的键必须落在这个白名单里，`tests/config.test.ts` 逐条断言 ——
 * 上一轮有十组键标着热更新而实际冻在启动时，其中三组还是「出事时运维会去点的那个开关」
 * （docs/20 · W-CFG-02）。往这里加键之前，先确认那条读取路径真的每次都取新值。
 */
export const HOT_RELOADABLE_CONFIG_KEYS = [
  'telegram.allowBots', 'telegram.strictCommandSuffix',
  'access.defaultUserRole', 'access.defaultChatRole', 'access.archiveBlocked',
  'trigger',
  'context.limit', 'context.active', 'context.hardCapRatio', 'context.background', 'context.rebase', 'context.tokenRatioAlpha', 'context.cacheCommits',
  // 回忆隔断：归档三工具每次执行从 `context.turn.config` 现读，`/new` 与 WebUI 清空从
  // `currentConfig()` 现读。开关一改，下一次工具调用与下一次清空就按新值走。
  'context.recallBarrier',
  // 含图轮次的判据范围：`runtime.ts` 每轮从 `turn.config`（= `dependencies.config`）现读。
  'media.visionScope',
  // 合并窗口是 bot.ts 的 config Proxy 每条消息现读的，改完下一条消息就按新值走。
  'concurrency.turnTimeoutMs', 'concurrency.coalesceSameUserMs',
  // 提示词装配拿的是 `turn.config`（每轮 perChatConfig 重算一次），改完下一轮生效。
  'prompt.maxTokens', 'prompt.includeToolCatalog', 'prompt.runtimeBlock',
  // 名字只在两处露面：WebUI 的品牌位（每次 config.changed 重拉即变）与启动日志那一行
  // （那行是启动时盖的章，不会追溯改写）。
  'general.name',
  // 取消时是否提交半截产出，`abortTurn` 从本轮 `turn.config` 读。
  'cancel.commitPartial',
  // `agentsDir` 与 `agents` 一起热更新：两者任一变化都触发一次重扫 + `replaceDefinitions`
  // （main.ts 的 scanAgents）。改了目录却还用着旧目录扫出来的定义是最难查的一种「没生效」。
  'agent.main', 'agent.agents', 'agent.agentsDir', 'agent.maxConcurrentSubagents', 'agent.progressThrottleMs',
  // 仲裁那两项每次 `ask_parent` 从本轮 `turn.config` 现读（builtins.ts）。
  'agent.askArbiter', 'agent.askTimeoutMs',
  // harness 的四项同理：`available()` 与 `execute()` 都从本轮 `turn.config` 现读。清空
  // `allowedDirs` 下一轮就把工具从目录里摘掉 —— 关一个绕过全部工具闸的能力不该等重启。
  'agent.harness',
  // 四项都是每轮从 `turn.config` 现读的（runtime.ts 的 wrappedFor / subagent 的 provider 块），
  // 改完下一轮生效；在途那一轮沿用开轮时的值。
  'provider.maxRetries', 'provider.retryBaseMs', 'provider.retryMaxMs', 'provider.requestTimeoutMs', 'provider.streamIdleTimeoutMs', 'provider.catalog',
  // 冷却期在每次 `rebuild()` 时读，而 `provider.*` 的任何改动都会触发 rebuildModels。
  'provider.healthDownCooldownMinutes',
  // 出网放行开关每次探测现读（app.ts 的 probeProvider 调用点、ModelCatalog 的 options getter）。
  // 它是「出事时运维会去点的那个开关」那一类，冻住等于界面说改成功了、下一次探测照样打私网。
  'provider.allowPrivateBaseUrl',
  // 三项都是 memory_write 从本轮 `turn.config` 读的（`approvalFor` 与 queueWrite 各一次）。
  'memory.pubWriteMinRole', 'memory.pubWriteRequiresApproval', 'memory.requireSourceTag',
  // archive 的四个 limit 走 `inputSchemaFor(context)`，每轮从 `turn.config` 取一次 —— 改完下一轮
  // 模型看到的 schema 就是新的上限。
  'tools.maxRegistered', 'tools.maxCallsPerTurn', 'tools.maxConsecutiveErrors', 'tools.defaultTimeoutMs', 'tools.overrides', 'tools.exec', 'tools.tg', 'tools.archive',
  // `tools.catalog` 整段（前缀覆盖全部叶子）与 `tools.maxRegistered` 走同一条路：经 `ToolRegistry`
  // 的 limits getter（`apps/bot/src/main.ts` 那个 `() => configStore.snapshot()…`）在每次 `active()` /
  // `activeView()` 时现读。折叠判据刻意不在 `RegisteredTool` 上打标，就是为了不被 MCP reconcile
  // 与这里的热更新弄脏。
  'tools.catalog',
  // 这三项各自现读：宿主 fs 放行在 `filesFor` 里取 snapshot，域名策略在 web_fetch 里取 turn.config。
  // `tools.fs` / `tools.web` 的其余键仍是启动快照，所以只列这三条而不是整段。
  'tools.fs.allowHostFsForOwner', 'tools.web.allowlist', 'tools.web.denylist',
  // 自我扩展整段：四个 `available()` 都从本轮 `turn.config` 现读，而 `main.ts` 的 config.changed
  // 订阅在 `tools.selfExtend.` 变化时重跑 `customTools.reconcile()` —— 关掉 `customTools.enabled`
  // 下一轮那批工具就从目录里消失。标热更新之前先确认那条 reconcile 分支还在（docs/20 · W-CFG-02）。
  'tools.selfExtend',
  'approval.enabled', 'approval.ttlMs', 'approval.rules', 'approval.skipForOwner', 'approval.rememberWithinTurn',
  // captureBodies 是每轮从 turn.config 现读的（runtime.ts 的 bodyForLog、/api/turns/:id/detail），
  // 改完下一轮就生效。漏在白名单外时 WebUI 会对着排障时最常翻的这个开关说「需重启」。
  // AlertDispatcher 每次 raise() 都现读 `alerts` 整段（开关、去重窗口、webhook、事件白名单）。
  // `skills.package.*` 在 `install_skill`（从 `turn.config` 取，下一轮生效）与
  // `POST /api/skills/package`（每请求从 `currentConfig()` 现读）两处都是现读的。
  // 整段 `skills` 仍然不能标热更新：`dir` 被 `SkillLoader` 在构造时拿走了，`enabled` / `watch`
  // 也只在启动时判过一次（docs/21 §9 末尾）。
  'sandbox', 'skills.defaultMinRole', 'skills.package', 'quota', 'alerts', 'logs.level', 'logs.captureBodies', 'logs.redactPatterns',
  // mcp 整段曾在这里，但 `mcp.healthCheckCron` 是 `scheduler.add(config.mcp.healthCheckCron, …)`
  // 在启动时拿走的，Scheduler 也没有重配入口 —— 整段标热更新等于对着那一项说谎（docs/20 · W-CFG-02）。
  // 这三项才是真的按 getter 读（`McpManager` 的 config getter + config.changed 后的 reconcile）。
  'mcp.enabled', 'mcp.defaultMinRole', 'mcp.servers',
  // 前四项都是现读的：`enabled` 在每次触发时查（关掉之后在途不受影响、下一次触发就跳过），
  // 另三项在 `schedule_create` 里从 `turn.config` 取。`schedule.retentionDays` **不在这里** ——
  // 它跟 `logs.retentionDays` 一样是 MaintenanceService 的构造参数，改完要重启才生效。
  'schedule.enabled', 'schedule.maxPerChat', 'schedule.minIntervalMinutes', 'schedule.maxPayloadChars',
  // WebUI 自己那几项是每请求从 currentConfig() 现读的（app.ts 的 requestIp / allowedOrigin /
  // 登录限流 / createSession / activePasswordHash），改完下一次请求就按新值走。只有 host / port
  // 例外：它们在 `serve()` 时就绑定了，必须重启。
  'webui.publicUrl', 'webui.sessionTtlHours', 'webui.passwordHash', 'webui.trustProxy', 'webui.trustedProxyHops', 'webui.allowOrigins', 'webui.loginRateLimit',
  // bot.ts 的 config Proxy 每次访问都取新快照，输出节奏是在每轮开始时读的：改了下一轮生效，
  // 在途那一轮沿用开轮时的值（编辑节流的定时器已经在跑，中途换节拍只会让这条消息的刷新变乱）。
  'output',
] as const;

/**
 * 仍然「存得下但没人读」的键。第五轮把这张表从 65 条压到 13 条：25 条接线、5 条从 schema 摘除、
 * 22 条随告警/出网/输出/记忆/日志几组功能接线。**剩下的每一条都写明为什么留着**——
 * 「暂时没做」和「做不了 / 不该在这一层做」是两回事，后者得说出来，否则下一轮又要重新判一次。
 */
export const KNOWN_UNIMPLEMENTED_CONFIG_KEYS = [
  // webhook 模式整体没实现。`main.ts` 在 `mode !== 'polling'` 时**显式抛错**，所以不会出现
  // 「配成 webhook 之后静默收不到消息」那种形态（docs/19 · R-CFG-03）。这三个键跟着那个模式走。
  'telegram.webhook.url',
  'telegram.webhook.path',
  'telegram.webhook.secretToken',
  // 「消息被编辑时在下一轮 RUNTIME 提示」要把「上一轮之后有哪些编辑」一路带进提示词装配，
  // 而 RUNTIME 块的输入现在只有 turn 与 config。接它得先给 RuntimeTurnContext 加一块会话级
  // 的瞬时状态 —— 那是上下文引擎的表面，不该为一条提示语顺手改。
  'telegram.notifyEdits',
  // 编辑消息永远不开新轮次（docs/20 · W-TG-05）。真要实现得先定「编辑触发的那一轮跟原轮次
  // 什么关系」——重开一轮？改写历史？两种语义都会动到 rebase 与认领水位。
  'trigger.ignoreEditedAsTrigger',
  // 记忆压缩**本身**没实现：`memory.compactCron` 那个定时任务只统计超过软上限的文档数，
  // 没有任何地方产出「压缩结果」。给一个不存在的产物配「是否自动应用」是假开关。
  'memory.autoApplyCompaction',
  // 仲裁（`askArbiter`）与它的期限（`askTimeoutMs`）已接线（docs/14 A7）。**转人工没有**：
  // 它要的是一个阻塞式的人机通道——在 Telegram 发一条带 inline 选项的消息、等人点、把结果回灌
  // 给正在等的子 agent。那条通道整体不存在（同一个缺口也挡着 inline keyboard 审批，docs/25 §8）。
  // 仲裁失败时这个键为真只会记一条 warn，不会真的去问人 —— 所以它仍然是未接线。
  'agent.askEscalateToUser',
  // 「抓回来的网页先用某个别名摘要再进上下文」要在 web_fetch 里插一次模型调用：计费、配额、
  // 取消信号、失败降级都得跟着走一遍。那是一个特性，不是一行读取。
  // （`agent/ask-arbiter.ts` 已经趟过同一条路，要接的话照那个形状抄。）
  'tools.web.summarizeWithAlias',
  // 相册合并要在触发路径上按 `media_group_id` 缓冲 update 再统一开轮次，与并发、认领水位、
  // 去重都有交互。`concurrency.coalesceSameUserMs` 做的是按人合并，这个是按相册合并。
  'media.groupDebounceMs',
  // 子路径挂载：要给所有路由加前缀、改静态资源的 base、改 SPA 的 router base，三处一起动。
  // `publicUrl` 已随 `/webui` 一次性登录链接接线（第五轮）。
  'webui.basePath',
] as const;



/**
 * `perChat.<key>.…` 能覆盖哪些路径。**这是一条安全边界**（docs/11 §2.1）：绕过它可以给单个会话
 * 关掉权限检查，所以 WebUI 的写端点必须走 `runtimeConfigSchema.safeParse(mergeDotted(...))`。
 *
 * 导出出来是为了让 `tests/config.test.ts` 也能量它。`perChat` 是 `z.record(z.unknown())`，
 * 所以白名单里的路径**不是** schema 叶子键 —— 「每个叶子要么被引用、要么进 KNOWN_UNIMPLEMENTED」
 * 那条断言看不见它们，而 `character` 就这么在里面躺过一轮：能存进 `config_kv`、能过校验、
 * `perChatConfig` 也会把它合进本轮配置，但没有任何代码读它（docs/27 · C-08）。
 */
export const PER_CHAT_OVERRIDE_ALLOWLIST = [
  /^output\./, /^context\.(limit|background|active)\./, /^context\.scope$/, /^trigger\./, /^agent\.main\./, /^character$/, /^memory\.pubWriteMinRole$/,
] as const;
/**
 * 白名单里**不对应任何 schema 叶子**的键。每一条都必须真的被代码读到（`tests/config.test.ts`
 * 逐条断言），否则就是一个「存得下、过得了校验、什么都不做」的假格子。
 *
 * `character`：会话级人格文件名，由 `assembleMainPrompt` 读出来交给
 * `PromptDocuments.paths(userId, characterOverride)`。它会被当成 `memory/` 下的路径段用，
 * 所以那边有一道文件名形态闸（同 `S-08` 的教训）。
 */
export const PER_CHAT_NON_SCHEMA_KEYS = ['character'] as const;

export const configSchema = z.object({
  general: z.object({
    name: z.string().default('洛璃'),
    timezone: ianaTimezone.default('Asia/Shanghai'),
    // `general.locale` 已从 schema 摘除：i18n 在 docs/14 §4 明确「第一版不做」，留一个运行时
    // 从不读的语言开关只会让运维以为改了就能换界面语言。真做 i18n 时和 `webui/src/i18n` 一起加回来。
    maintenanceCron: z.string().default('0 4 * * *'),
    shutdown: z.object({ graceMs: z.number().int().positive().default(30_000) }).default({}),
  }).default({}),
  telegram: z.object({
    mode: z.enum(['polling', 'webhook']).default('polling'),
    dropPendingOnStart: z.boolean().default(false),
    // 默认值 = 有处理器的那四条。`message_reaction` 曾在默认值里躺着，而适配器从来没有接过它
    // （`packages/telegram` 里只有**发**表情的工具）—— 申报一类没人处理的更新只是白拉一遍流量。
    // 一条都不勾**不等于**什么都不收：Bot API 把空数组读作「除 chat_member 那几类外全都收」，
    // 正好与界面上「一个都没勾」相反。所以空数组当场拒掉，而不是留一个语义翻转的格子。
    allowedUpdates: z.array(z.enum(TELEGRAM_UPDATE_KINDS)).min(1, { message: '至少留一类（一定要有 message，否则 bot 收不到任何消息）：空数组在 Bot API 里表示「几乎全都收」，与界面上一个都没勾的意思相反' })
      .default(['message', 'edited_message', 'callback_query', 'my_chat_member']),
    webhook: z.object({ url: z.string().default(''), path: z.string().default('/webhook/telegram'), secretToken: z.string().default('') }).default({}),
    allowBots: z.array(z.string()).default([]),
    notifyEdits: z.boolean().default(true),
    strictCommandSuffix: z.boolean().default(false),
    throttle: z.object({ globalPerSecond: z.number().positive().default(30), perChatPerMinute: z.number().positive().default(20) }).default({}),
  }).default({}),
  access: z.object({
    defaultUserRole: role.default('blocked'),
    defaultChatRole: role.default('blocked'),
    archiveBlocked: z.boolean().default(false),
    /**
     * **形态要校验。** 这个值（来自 `LUOLI_OWNER_ID`，自由字符串环境变量）会被直接当成路径段用：
     * `memory/private/<id>/PRIMEMORY.md`（`memory/store.ts`、`prompt/documents.ts`），
     * 定时任务的 `createdBy` 也走这条路 —— `LUOLI_OWNER_ID=../../etc` 会让私有记忆落到目录外
     * （自伤，但此前没有任何一道闸，docs/27 · S-08）。判据与 `TG_ID_PATTERN` 同一套：
     * Telegram 数字 id。空串照旧放行（`loadConfig` 另有 requireOwner 那条更清楚的报错）。
     */
    bootstrapOwnerId: z.string().refine((value) => value === '' || TG_ID_PATTERN.test(value),
      { message: '必须是 Telegram 数字 id（它会被当成私有记忆的目录名用）' }).default(''),
  }).default({}),
  trigger: z.object({
    private: z.boolean().default(true), mention: z.boolean().default(true), reply: z.boolean().default(true), command: z.boolean().default(true),
    channels: z.boolean().default(false), wakewords: z.array(z.string()).default(['洛璃']), wakewordMinLength: z.number().int().min(1).default(2),
    requireTextAfterMention: z.boolean().default(false), ignoreEditedAsTrigger: z.boolean().default(true), cooldownMsPerUser: z.number().int().nonnegative().default(0),
  }).default({}),
  context: z.object({
    scope: z.enum(['chat', 'thread']).default('chat'),
    limit: z.object({ tokens: z.number().int().min(4000).max(500_000).default(32_000), maxMessages: z.number().int().positive().default(200), minKeepTurns: z.number().int().positive().default(1) }).default({}),
    // 活跃期：裁剪一次 = 前缀缓存全灭，所以别在对话正热的时候裁。`windowMs` 是滑动的空闲间隔
    // （每轮提交顺延一次），安静满这么久之后的第一轮才裁 —— 那时缓存本来就已过期，代价为零。
    // `tokens` / `maxMessages` 是推迟期间的天花板：推迟不是取消，撞到天花板照裁，且**裁回
    // `limit.*` 而不是天花板**（裁到天花板等于此后每轮都要再裁一次，docs/02 §5.1.1）。
    active: z.object({ windowMs: z.number().int().nonnegative().default(0), tokens: z.number().int().min(4000).max(2_000_000).default(128_000), maxMessages: z.number().int().positive().default(1000) }).default({}),
    hardCapRatio: z.number().gt(0.3).max(0.95).default(0.85),
    background: z.object({ enabled: z.boolean().default(true), maxPerTurn: z.number().int().nonnegative().default(20), showUsername: z.boolean().default(true), showTime: z.boolean().default(true), includeNonText: z.boolean().default(true) }).default({}),
    rebase: z.object({ injectNotice: z.boolean().default(false), markMeta: z.boolean().default(true) }).default({}),
    cacheCommits: z.number().int().positive().default(64), tokenRatioAlpha: z.number().gt(0).lte(1).default(0.2),
    /**
     * 清空上下文（`/new` / WebUI）之后，模型还能不能从归档里把清空之前的话翻回来。
     *
     * 关（默认）= 只挪 `done` 指针：窗口空了，但 `read_messages` / `search_messages` /
     * `get_message` 读的是 `messages` 归档表，不受窗口约束 —— 实测清空后模型第一步就
     * `read_messages({direction:'before',limit:20})` 把 20 条历史整段捞回来，那份工具结果又落进
     * 新窗口，于是「清空」在用户眼里没生效（logs/2026-08-19 · turn `01M0CKK6W018B5KS9613SNEX5J`）。
     *
     * 开 = 清空那一刻的 `messages.id` 记进 reset commit 的 `meta.archiveFloor`，三个归档工具
     * 只能看到它之后的消息，**并且**清空会把背景认领水位一并推到那里 —— 否则清空之前那些
     * 还没被认领的群发言会从另一扇门进到新窗口里，与隔断自相矛盾。
     * owner 的 `admin_search_messages` 不受管（跨会话，按 key 记的水位对它没有意义）。
     */
    recallBarrier: z.boolean().default(false),
  }).default({}),
  concurrency: z.object({ mode: z.enum(['parallel', 'serial']).default('parallel'), perKey: z.number().int().positive().default(3), global: z.number().int().positive().default(8), queueMax: z.number().int().nonnegative().default(20), coalesceSameUserMs: z.number().int().nonnegative().default(0), turnTimeoutMs: z.number().int().positive().default(600_000) }).default({}),
  cancel: z.object({ commitPartial: z.boolean().default(false) }).default({}),
  prompt: z.object({ maxTokens: z.number().int().positive().default(12_000), includeToolCatalog: z.boolean().default(true), runtimeBlock: z.object({ showQuota: z.boolean().default(true), showContextWatermark: z.boolean().default(true), showWorkspace: z.boolean().default(true) }).default({}) }).default({}),
  memory: z.object({ dir: z.string().default('./memory'), pubWriteMinRole: role.default('trusted'), pubWriteRequiresApproval: z.boolean().default(false), softLimitTokens: z.number().int().positive().default(1500), hardLimitTokens: z.number().int().positive().default(3000), maxSections: z.number().int().positive().default(12), compactCron: z.string().default('0 3 * * 0'), autoApplyCompaction: z.boolean().default(false), requireSourceTag: z.boolean().default(true), forgetMeRetentionDays: z.number().int().nonnegative().default(30) }).default({}),
  agent: z.object({
    main: z.object({ modelAlias: z.string().default('main'), maxSteps: z.number().int().positive().default(12), downgradeAfterStep: z.number().int().positive().default(8) }).default({}),
    maxDepth: z.number().int().positive().default(3), maxConcurrentSubagents: z.number().int().positive().default(3), maxSubagentsPerTurn: z.number().int().positive().default(10), askTimeoutMs: z.number().int().positive().default(120_000), maxAsksPerRun: z.number().int().positive().default(5), askArbiter: z.boolean().default(true), askEscalateToUser: z.boolean().default(false), progressThrottleMs: z.number().int().positive().default(3000),
    // `agentsDir`：`agents/<name>.md` 的目录（docs/14 §2 Q5）。文件是**只读**来源，下面这份
    // `agents`（DB / WebUI）里的同名定义覆盖它。优先级写死，不做成配置项。
    agentsDir: z.string().default('./agents'),
    // M11 · HarnessAgent（docs/14 §2 Q8）：起一个外部 CLI（Claude Code / Codex）改宿主上的仓库。
    // **`allowedDirs` 为空 = 整个功能关闭**，工具连模型的目录都不进 —— 这是刻意的默认：它绕过
    // 本系统全部工具闸（T17），开它必须是一次显式的运维动作，而不是「装上就有」。
    harness: z.object({
      command: z.string().default('claude'),
      // 任务正文作为 argv 的最后一项追加在这些参数之后，**不经 shell**。
      args: z.array(z.string()).default(['-p']),
      allowedDirs: z.array(z.string()).default([]),
      timeoutMs: z.number().int().positive().default(900_000),
      maxOutputBytes: z.number().int().positive().default(65_536),
    }).default({}),
    agents: z.array(z.object({ name: z.string(), description: z.string(), modelAlias: z.string(), maxSteps: z.number().int().positive(), minRole: role.default('limited'), tools: z.array(z.string()).default([]), resultMaxChars: z.number().int().positive().default(4000), instructions: z.string(), injectMemory: z.boolean().default(false) })).default([]),
  }).default({}),
  provider: z.object({ maxRetries: z.number().int().nonnegative().default(2), retryBaseMs: z.number().int().positive().default(1000), retryMaxMs: z.number().int().positive().default(30_000), healthCheckCron: z.string().default('*/10 * * * *'), healthDownCooldownMinutes: z.number().positive().default(30), requestTimeoutMs: z.number().int().positive().default(120_000), streamIdleTimeoutMs: z.number().int().positive().default(60_000), allowPrivateBaseUrl: z.boolean().default(false),
    // 模型元数据目录（models.dev）。只在 WebUI 主动拉取时出网，缓存到 cacheFile 后按 ttlHours 用
    // ETag 条件请求续期；关掉之后拉取模型只剩上游 /models 给的那点信息（docs/04 §5.4.1）。
    catalog: z.object({ enabled: z.boolean().default(true), url: z.string().url().default('https://models.dev/api.json'), cacheFile: z.string().default('./data/cache/models.dev.json'), ttlHours: z.number().positive().default(168), timeoutMs: z.number().int().positive().default(30_000) }).default({}),
  }).default({}),
  tools: z.object({
    maxRegistered: z.number().int().positive().default(80), maxCallsPerTurn: z.number().int().positive().default(40), maxConsecutiveErrors: z.number().int().positive().default(3), defaultTimeoutMs: z.number().int().positive().default(60_000),
    // 运维覆盖层（docs/09 §3.7）。后三项一律 optional 且**不给默认值** —— 字段缺席 = 沿用
    // `TOOL_POLICY` / 工具自己声明的那份。写死默认值等于把每条历史覆盖行钉在写它那天的策略上。
    // 「放宽要二次确认」是 `PATCH /api/tools/:name` 的端点行为而不是 schema 约束：schema 只管形状。
    overrides: z.record(z.object({ enabled: z.boolean().default(true), minRole: role.optional(),
      approval: z.enum(APPROVAL_POLICIES).optional(), timeoutMs: z.number().int().positive().optional() })).default({}),
    // 工具目录按需暴露（docs/07 §5）。**纯粹是提示层视图**：折叠只改模型看不看见 schema，
    // 不新增以目录为边界的闸 —— 未展开工具被硬调照常走 `admit()` / `execute()`。
    catalog: z.object({
      // 默认 `true` 在**出厂配置**下是零改变：`mcp.enabled` 默认 false、`selfExtend.customTools`
      // 默认关、出厂 `plugins/` 只有 `.gitkeep` ⇒ 出厂折叠集为空，而折叠集为空时 `search_tools`
      // 不进目录，纯内建部署的提示词逐字节不变。**理由不是「plugin 默认关」**：下面那个
      // `plugins.enabled` 默认就是 `true`（它管扫不扫插件目录；默认关的是只管 `write_plugin` 的
      // `tools.selfExtend.plugins.enabled`）—— 往 `plugins/` 放一个插件、owner 在扩展页启用它
      // （落库即 `enabled=0`），折叠集就非空。折叠判据按 `policy.source` 走（mcp / plugin / custom
      // 三个来源一律折叠，不看任何开关）。
      deferExternal: z.boolean().default(true),
      // 工具名 glob（minimatch，先例是 `mcp` 的 `toolAllow` 与 `tools.fs.denyGlobs`），命中的内建 /
      // agent 族也折叠。命中豁免表（`search_tools` / `load_skill`）的模式**静默不生效** —— 把展开
      // 的入口自己折叠掉就再没有人能展开了。
      defer: z.array(z.string()).default([]),
      // 判据的第一顺位，压得过上面两项：「默认全常驻 + 显式折叠」才是向后兼容的方向，所以
      // 常驻是补集，而这份白名单是运维在折叠整台 server 之后捞回几个常用工具的唯一途径。
      resident: z.array(z.string()).default([]),
      // `false` 时 TOOL CATALOG 的常驻段只列名字：描述与 provider tools 数组里那份完全重复，
      // 而 tools 数组在请求体头部、属缓存前缀，catalog 在易变段每步重发 —— 重复贵就贵在这里。
      // 默认 `true` 保持现状逐字节不变：折叠与去重是两个变量，同时动的话模型行为真变差时
      // 分不清是哪个引起的（docs/06 §1）。
      residentDescriptions: z.boolean().default(true),
      // 一轮内**累计展开的工具数**上限（判据是 `已展开 + 本次新增 > 上限` 就整次拒掉）。要压的其实
      // 是展开的**次数** —— 每次展开都让请求体第 0 段（tools 数组）变化、打穿本轮剩余步骤的前缀缓存
      // （docs/04 §2.1）—— 所以撞上限时的 hint 是「改用精确 `names` 一次批量展开」：批量占掉同样多
      // 的额度，但只付一次缓存的账。次数的硬上限来自 `agent.main.maxSteps`，不是这一项。
      maxExpandedPerTurn: z.number().int().positive().default(32),
    }).default({}),
    fs: z.object({ maxReadBytes: z.number().int().positive().default(262_144), maxWriteBytes: z.number().int().positive().default(5_242_880), showHidden: z.boolean().default(false), allowHostFsForOwner: z.boolean().default(false), denyGlobs: z.array(z.string()).default(['**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/.ssh/**', '**/.git/config', '<root>/config/**', '<root>/data/luoli.db*', '<root>/memory/**', '<root>/skills/**', '<root>/plugins/**']), trashDir: z.string().default('.luoli-trash'), backupDir: z.string().default('.luoli-bak') }).default({}),
    exec: z.object({ defaultTimeoutMs: z.number().int().positive().default(60_000), maxTimeoutMs: z.number().int().positive().default(300_000), maxOutputBytes: z.number().int().positive().default(65_536) }).default({}),
    archive: z.object({ defaultSearchLimit: z.number().int().positive().default(20), maxSearchLimit: z.number().int().positive().default(100), defaultReadLimit: z.number().int().positive().default(50), maxReadLimit: z.number().int().positive().default(200) }).default({}),
    tg: z.object({ maxExtraMessagesPerTurn: z.number().int().nonnegative().default(3), maxFileSendMb: z.number().positive().default(50) }).default({}),
    web: z.object({ maxResponseBytes: z.number().int().positive().default(2_097_152), timeoutMs: z.number().int().positive().default(15_000), retries: z.number().int().nonnegative().max(5).default(2), summarizeWithAlias: z.string().default('low'), allowlist: z.array(z.string()).default([]), denylist: z.array(z.string()).default(['*.local', '*.internal']), searchProvider: z.enum(['', 'brave', 'serper', 'tavily', 'exa']).default(''), searchApiKey: z.string().default('') }).default({}),
    // 自我扩展（docs/07 §6）：模型给自己写工具 / 写 skill / 写 plugin / 装 MCP。
    // **整块默认关闭**，与 `mcp.enabled`、`agent.harness.allowedDirs` 同一个形态 —— 这几件事都是
    // 「打开之后模型能改变自己下一轮的能力」，默认值必须是关。
    selfExtend: z.object({
      enabled: z.boolean().default(false),
      // `autoEnable` 打开 = 定义完下一轮就能用。默认关着的理由：网页 / 群聊注入 → define_tool →
      // owner 因 `approval.skipForOwner` 无感放行 → 立刻成为持久能力，中间没有人。
      // `requireSandbox` 打开则连 owner 也必须走沙箱，此时自定义工具**严格弱于** bash；
      // 默认关着是需求方拍的板（与 bash 一视同仁），代价见 docs/14 T19。
      customTools: z.object({ enabled: z.boolean().default(false), autoEnable: z.boolean().default(false), requireSandbox: z.boolean().default(false),
        maxTools: z.number().int().positive().default(20), maxBodyChars: z.number().int().positive().default(8000),
        defaultMinRole: z.enum(['trusted', 'owner']).default('owner'), timeoutMs: z.number().int().positive().default(60_000) }).default({}),
      // `minRole` 是模型写出来的 skill 的**下限**：它可以写得更严，不能写得更松。
      skills: z.object({ enabled: z.boolean().default(false), minRole: role.default('trusted') }).default({}),
      // stdio = 一条模型发明的 argv，以 bot 进程的身份跑在沙箱之外。落地即禁用（owner 在 WebUI
      // 复审那条 argv 再开），想连这一步都不给就把 stdio 从这里去掉。
      mcp: z.object({ enabled: z.boolean().default(false), allowTransports: z.array(z.enum(['stdio', 'http'])).default(['stdio', 'http']) }).default({}),
      // plugin 是进程内全信任（docs/14 A27）。模型只能把文件写下来，启用永远是 owner 的动作。
      plugins: z.object({ enabled: z.boolean().default(false), maxBodyChars: z.number().int().positive().default(200_000) }).default({}),
    }).default({}),
  }).default({}),
  sandbox: z.object({ mode: z.enum(['none', 'jail', 'docker']).default('docker'), bypassRoles: z.array(role).default(['owner']), image: z.string().default('luoli-sandbox:latest'), network: z.enum(['none', 'bridge']).default('none'), memoryMb: z.number().positive().default(512), cpus: z.number().positive().default(1), pidsLimit: z.number().int().positive().default(128), readOnlyRoot: z.boolean().default(true), tmpfsMb: z.number().positive().default(64), workspaceDir: z.string().default('./data/workspace'), hostWorkspaceDir: z.string().default(''), dockerBin: z.string().default('docker'),
    // 会话级持久容器（docs/05 §5.5）。**`network` 与上面那个 `sandbox.network` 是两个键**：
    // 那个管一次性容器（默认断网），这个管持久容器（默认出网）。合并成一个的话，打开持久化
    // 就顺手把一次性那条路也开了网 —— 一个开关不能悄悄改两件事。
    persistent: z.object({ enabled: z.boolean().default(false), idleTtlMs: z.number().int().positive().default(86_400_000), maxLifetimeMs: z.number().int().nonnegative().default(0), maxContainers: z.number().int().positive().default(16), network: z.enum(['none', 'bridge']).default('bridge'), reapCron: z.string().default('*/5 * * * *') }).default({}) }).default({}),
  // `allowInitiator` 已摘除：WebUI 只有一个 owner 身份（docs/14 A15），裁决权下放不到发起人，
  // 这个开关在当前架构里没有能实现它的落点（docs/21 §6）。
  approval: z.object({ enabled: z.boolean().default(true), ttlMs: z.number().int().positive().default(180_000), skipForOwner: z.boolean().default(true), rememberWithinTurn: z.boolean().default(true), rules: z.array(approvalRuleSchema).default([]) }).default({}),
  output: z.object({ mode: z.enum(['stream', 'once']).default('stream'), replyDelayMs: z.number().int().nonnegative().max(30_000).default(2000), streamBufferMs: z.number().int().nonnegative().max(30_000).default(2000), streamIntervalMs: z.number().int().positive().default(2000), streamMinDeltaChars: z.number().int().positive().default(24), flushOnSentence: z.boolean().default(true), maxMessageChars: z.number().int().min(100).max(4000).default(3900), parseMode: z.enum(['MarkdownV2', 'HTML', 'none']).default('MarkdownV2'), typingWhileWorking: z.boolean().default(true), placeholderAfterMs: z.number().int().positive().default(4000),
    // 占位消息的文案。默认那一条就是此前硬编码的 `…`，所以不配也和以前一样。**空数组 = 不发占位
    // 消息** —— `placeholderAfterMs` 是 positive，填不了 0，在这之前根本没有关掉它的途径。
    // 元素不加 `.min(1)`：schema 拦下来的表现是整个进程起不来（config_kv 里多敲一个空行就够），
    // 空白行在挑选时滤掉只是少一条备选。
    placeholderTexts: z.array(z.string()).default(['…']), placeholderPick: z.enum(['random', 'fixed']).default('random'), placeholderIndex: z.number().int().nonnegative().default(0),
    maxMentions: z.number().int().nonnegative().default(3) }).default({}),
  // `retentionDays`：媒体**文件**的保留天数（0 = 不清）。删文件、留 `attachments` 行并把
  // `download_state` 写成 'expired' —— 行删掉的话历史消息里那条「[图片]」连同 mime/尺寸/已提取
  // 正文一起消失（docs/14 §2 Q9-a）。与 `maintenance.retention.*` 一样在启动时交给
  // MaintenanceService，所以是「需重启」。
  /**
   * `visionScope`：判断「这一轮含图」时看哪些图（`docs/04 §5.2`、`docs/08 §7.2`）。
   *
   * `window`（默认，= 一直以来的行为）= 整个上下文窗口，`snapshot + delta` 一起算。代价是**一张图
   * 会把它之后的每一轮都钉在 vision 别名上**：图片留在窗口里，而判据不区分「用户此刻发的」与
   * 「三轮前那张」—— 纯文本的一句「几点了」照样切走贵的那一档；一个能看图的别名都没有时，
   * 那一轮的回复末尾还会附上「这张图我没能真的看到」，而用户这一轮根本没发图。
   *
   * `turn` = 只算**本轮新进来的**图（触发消息、被回复的那条、本轮认领的群背景发言，也就是
   * `turn.delta`）。更早轮次留在窗口里的图片：这一轮真落在看不了图的模型上时才整体换成占位文本
   * （`docs/02` 的不变量：不透明 part 要么原样保留、要么整体换占位，不能截半），落在能看图的
   * 模型上则原样带着 —— 「再看一遍上面那张图」在 vision 模型上仍然可用。
   */
  media: z.object({ dir: z.string().default('./data/files'), retentionDays: z.number().int().nonnegative().default(90), maxImageBytes: z.number().int().positive().default(8_388_608), maxDocBytes: z.number().int().positive().default(20_971_520), maxImageEdge: z.number().int().positive().default(1568), maxImagesPerTurn: z.number().int().positive().default(4), visionScope: z.enum(['window', 'turn']).default('window'), groupDebounceMs: z.number().int().positive().default(1500), stickerAsImage: z.boolean().default(false), downloadVoice: z.boolean().default(true), extract: z.object({ enabled: z.boolean().default(true), maxChars: z.number().int().positive().default(40_000), inlineChars: z.number().int().positive().default(4000), codeExtensions: z.array(z.string()).default([]) }).default({}) }).default({}),
  skills: z.object({ enabled: z.boolean().default(true), dir: z.string().default('./skills'), watch: z.boolean().default(true), defaultMinRole: role.default('trusted'),
    // 装 skill 包时的解包上限（docs/07 §2.5）。**两个体积上限一律按实际写出的字节数判**，
    // 不信 zip 头里的 `uncompressedSize` —— 那个字段是打包方填的，压缩炸弹正是从这里进来。
    // `allowExecutable` 关掉 = 包退化成纯文本，`scripts/` 与 `bin/` 装进来也跑不了。
    package: z.object({ maxEntries: z.number().int().positive().default(2000), maxTotalBytes: z.number().int().positive().default(67_108_864),
      maxFileBytes: z.number().int().positive().default(33_554_432), allowExecutable: z.boolean().default(true) }).default({}) }).default({}),
  plugins: z.object({ enabled: z.boolean().default(true), dir: z.string().default('./plugins'), watch: z.boolean().default(false), hookTimeoutMs: z.number().int().positive().default(5000), order: z.array(z.string()).default([]), autoDisableAfterErrors: z.number().int().positive().default(3) }).default({}),
  mcp: z.object({ enabled: z.boolean().default(false), connectTimeoutMs: z.number().int().positive().default(15_000), healthCheckCron: z.string().default('*/5 * * * *'), defaultMinRole: role.default('trusted'), servers: z.array(mcpServerSchema).default([]) }).default({}),
  // 定时任务（docs/14 §2 Q4 已拍板）。上界写进 schema 而不只写在工具描述里：模型看得见 schema，
  // 看不见我们的文档（docs/26 §5）。`minIntervalMinutes` 卡的是 cron 两次触发之间的间隔 ——
  // `* * * * *` 在 agent 模式下就是每分钟一次真实模型调用。
  schedule: z.object({ enabled: z.boolean().default(true), maxPerChat: z.number().int().positive().max(200).default(20),
    minIntervalMinutes: z.number().int().positive().default(5), maxPayloadChars: z.number().int().positive().max(20_000).default(2000),
    retentionDays: z.number().int().nonnegative().default(30) }).default({}),
  /**
   * 维护任务的保留期。`MaintenanceService.cleanup()` 此前只清 `log_events` / `processed_updates` /
   * `sessions` / `approvals` / 子 agent 结果 / `scheduled_jobs`，而 `usage_ledger` /
   * `config_revisions` / `memory_revisions` / `quota_counters` 只涨不落 —— 读端点都有 LIMIT，
   * 所以症状不是慢查询而是**库文件只涨不落**，且 `VACUUM` 帮不上（数据还在，docs/27 · R-05）。
   *
   * 这里只给这四张**派生数据**表定保留期。`turns` 与 `tasks` 刻意不在其列：它们是 trace 的骨架
   * （`/api/turns/:id/detail` 靠 turn 行把日志、用量与上下文串起来），删掉等于历史轮次凭空消失
   * —— 那是 docs/14 §2 Q9 的未决问题，替需求方决定不合适。**每一项 0 = 不清。**
   */
  maintenance: z.object({
    retention: z.object({
      usageDays: z.number().int().nonnegative().default(400),
      quotaCounterDays: z.number().int().nonnegative().default(400),
      configRevisionDays: z.number().int().nonnegative().default(180),
      memoryRevisionDays: z.number().int().nonnegative().default(180),
    }).default({}),
  }).default({}),
  // 没有 ftsTokenizer：`tokenize='trigram'` 写死在 0001_init.sql 的建表语句里，换它必须追加一份
  // 重建 `messages_fts` 的迁移，配置项换不动。docs/14 §2 Q3 已拍板不引入 jieba，键随之摘除。
  db: z.object({ path: z.string().default('./data/luoli.db'), backupKeep: z.number().int().nonnegative().default(5), vacuumCron: z.string().default('0 5 * * 0') }).default({}),
  logs: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']).default('info'), dir: z.string().default('./logs'), captureBodies: z.boolean().default(true), bodyMaxBytes: z.number().int().positive().default(262_144), maxFileMb: z.number().positive().default(128), retentionDays: z.number().int().nonnegative().default(30), gzipAfterDays: z.number().int().nonnegative().default(3), console: z.enum(['pretty', 'json', 'off']).default('pretty'), redactPatterns: z.array(z.string()).default([]) }).default({}),
  quota: z.object({ enabled: z.boolean().default(true), requirePricing: z.boolean().default(true), minReserveUsd: z.number().nonnegative().default(0.02), global: z.object({ daily: nullableMoney.default(5), monthly: nullableMoney.default(100) }).default({}), perChat: z.object({ daily: nullableMoney.default(1), monthly: nullableMoney.default(null) }).default({}), perUser: z.object({ daily: nullableMoney.default(0.5), monthly: nullableMoney.default(null), byRole: z.record(z.object({ daily: nullableMoney.optional(), monthly: nullableMoney.optional() })).default({}) }).default({}), // perTurn 只留真正生效的两项。maxToolCalls / maxSubagents / maxDurationMs 已摘除：
  // 它们各有一个真正在管这件事的同名键（`tools.maxCallsPerTurn` / `agent.maxSubagentsPerTurn` /
  // `concurrency.turnTimeoutMs`），并存等于让运维在错的那个格子里改（docs/22 · N-CFG-02 一脉）。
  perTurn: z.object({ maxCostUsd: z.number().positive().default(0.5), maxSteps: z.number().int().positive().default(12) }).default({}), rateLimit: z.object({ turnsPerUserPerHour: z.number().int().positive().default(30), turnsPerChatPerHour: z.number().int().positive().default(100), concurrentPerUser: z.number().int().positive().default(2) }).default({}), onExceeded: z.object({ reply: z.boolean().default(true), message: z.string().default('今天的额度用完了（已用 {spent}/{limit}），{resetAt} 重置。'), notifyOwner: z.boolean().default(true) }).default({}), warnAtRatio: z.number().gt(0).lte(1).default(0.8) }).default({}),
  webui: z.object({ enabled: z.boolean().default(true), host: z.string().default('127.0.0.1'), port: z.number().int().positive().default(8787), basePath: z.string().default('/'), publicUrl: z.string().default(''), sessionTtlHours: z.number().positive().default(168), passwordHash: z.string().default(''), trustProxy: z.boolean().default(false), trustedProxyHops: z.number().int().min(1).max(16).default(1), allowOrigins: z.array(z.string()).default([]), loginRateLimit: z.object({ attempts: z.number().int().positive().default(5), windowMinutes: z.number().int().positive().default(15) }).default({}) }).default({}),
  alerts: z.object({ notifyOwner: z.boolean().default(true), dedupeMinutes: z.number().positive().default(30), webhookUrl: z.string().default(''), on: z.array(z.string()).default([]) }).default({}),
  perChat: z.record(z.unknown()).default({}),
}).superRefine((cfg, ctx) => {
  /**
   * 跨字段的三条**必须点名对方那一格现在是多少**：WebUI 的表单一次只改一格，而这三条报错说的是
   * 「你改的这一格和另一格冲突」—— 只说「必须小于硬上限」的话，运维看不出硬上限此刻是几，
   * 也就不知道该把哪一格改成什么（`GET /api/config` 里那 200 多个值得自己翻）。
   */
  if (cfg.concurrency.perKey > cfg.concurrency.global) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['concurrency', 'perKey'], message: `单会话并发（${cfg.concurrency.perKey}）不能大于全局并发 concurrency.global（当前 ${cfg.concurrency.global}）—— 前者是后者的一部分` });
  if (cfg.memory.softLimitTokens >= cfg.memory.hardLimitTokens) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memory', 'softLimitTokens'], message: `软上限（${cfg.memory.softLimitTokens}）必须小于硬上限 memory.hardLimitTokens（当前 ${cfg.memory.hardLimitTokens}）：软上限触发压缩、硬上限直接截断，两者相等等于压缩永远来不及。要调大就把这两格一起改` });
  if (cfg.webui.host !== '127.0.0.1' && cfg.webui.host !== '::1' && !cfg.webui.passwordHash) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['webui', 'passwordHash'], message: `绑到 ${cfg.webui.host} 这种非回环地址时必须先设登录口令（webui.passwordHash 现在是空的）：pnpm webui:passwd <口令> 生成哈希，或用设置页的「修改登录口令」` });
  for (const [key, value] of Object.entries(cfg.perChat)) {
    const walk = (node: unknown, prefix = ''): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        if (!PER_CHAT_OVERRIDE_ALLOWLIST.some((pattern) => pattern.test(prefix))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['perChat', key, ...prefix.split('.')], message: 'path is not in perChat override allowlist' });
        return;
      }
      for (const [part, child] of Object.entries(node)) walk(child, prefix ? `${prefix}.${part}` : part);
    };
    walk(value);
    const memoryRole = (value as { memory?: { pubWriteMinRole?: unknown } }).memory?.pubWriteMinRole;
    if (typeof memoryRole === 'string' && ['blocked', 'limited', 'trusted', 'owner'].includes(memoryRole)
      && roleRank(memoryRole as 'blocked' | 'limited' | 'trusted' | 'owner') < roleRank(cfg.memory.pubWriteMinRole)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['perChat', key, 'memory', 'pubWriteMinRole'], message: '会话级公开记忆写入角色只能比全局更严格' });
    }
  }
});

export type Config = z.infer<typeof configSchema>;
