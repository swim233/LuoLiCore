import { zodToJsonSchema } from "zod-to-json-schema";
import { configSchema } from "./schema.js";

/**
 * 每个配置键一行的作用说明，是说明文字的唯一来源：`configJsonSchema()` 把它注入
 * `GET /api/config/schema` 返回的 JSON Schema，WebUI 的全部配置表单直接渲染 `description`，
 * 前端不维护第二份清单，`config/config.schema.json` 同样由该函数生成。
 *
 * 放在 schema.ts 之外而非逐个 `.describe()`：其一那边是每行一个模块的密集写法，插入 200 多段
 * 中文会严重影响可读性；其二 `nullableMoney`、`role` 这些 zod 实例被多处复用，挂上 `.describe()`
 * 会让 `quota.global.daily` 与 `quota.perUser.monthly` 共用同一句说明。按点分路径给出才能一键一句。
 *
 * 说明写明该项的作用与修改后的影响，不写是否热更新或未接线：那两件事由徽标表达，
 * 抄入正文只会多一处会漂移的副本。`tests/config.test.ts` 断言这里的键与 schema 叶子严格一一对应，
 * 新增配置项时会触发该断言。
 */
export const CONFIG_DESCRIPTIONS: Record<string, string> = {
  general: "实例级的基本信息：名字、时区、维护窗口。",
  "general.name": "机器人对外显示的名字，用于日志与 WebUI 标题。",
  "general.timezone":
    "所有时间行为的基准时区（IANA 名，如 Asia/Shanghai）。配额的日/月账期切换与给模型的时间戳均按它计算；拼写错误会在群聊分支报错。",
  "general.maintenanceCron":
    "每日维护任务的 cron 表达式（清理过期数据、轮转日志、备份）。",
  "general.shutdown.graceMs":
    "收到停止信号后留给在途轮次收尾的毫秒数；超时强制退出。",

  telegram: "与 Telegram 服务端对接的方式：收哪些更新、发送速率、命令识别。",
  "telegram.mode":
    "更新获取方式：polling 由本进程主动轮询（无需公网地址），webhook 由 Telegram 回调（需可访问的 https 地址）。",
  "telegram.dropPendingOnStart":
    "启动时是否丢弃离线期间堆积的更新。关闭时重启后会重新处理全部积压消息。",
  "telegram.allowedUpdates":
    "向 Telegram 声明接收哪几类更新。移除 message 等同于停止接收全部消息；勾选没有处理器的类型不产生任何行为，只增加无效流量。chat_member / chat_join_request 等类型 Telegram 默认不推送，需显式勾选。",
  "telegram.webhook.url":
    "webhook 模式下提供给 Telegram 的完整 https 回调地址。",
  "telegram.webhook.path": "本进程监听 webhook 回调的路径。",
  "telegram.webhook.secretToken":
    "Telegram 回调时携带的密钥请求头，用于校验请求来源，防止伪造。",
  "telegram.allowBots":
    "允许触发本 bot 的其他 bot username 列表，一行一条。默认不响应任何 bot 消息，避免 bot 之间循环触发。",
  "telegram.notifyEdits":
    "用户编辑历史消息后，是否在下一轮 RUNTIME 块中标注该消息已被编辑。",
  "telegram.strictCommandSuffix":
    "群聊中的斜杠命令是否必须写成 /cmd@botusername 才被识别。同一群内有多个 bot 时启用，否则同名命令会被任意 bot 响应。",
  "telegram.throttle.globalPerSecond":
    "全局发送速率上限（条/秒）。超出的请求排队而非丢弃，用于规避 Telegram 的 429 限流。",
  "telegram.throttle.perChatPerMinute":
    "单个**群聊**会话的发送速率上限（条/分钟）。私聊不受本项约束：限流器按 chat_id 正负分流，私聊使用仅限定最小间隔（1 秒）的令牌桶。",

  access:
    "访问控制。有效角色取用户与群角色的较高者并封顶 trusted，任一为 blocked 则不响应；私聊只看用户角色。",
  "access.defaultUserRole":
    "未在主体页登记的用户的默认角色。默认 blocked，需逐个放行。",
  "access.defaultChatRole":
    "未登记的群 / 频道的默认角色。出厂 blocked，即整群不响应。",
  "access.archiveBlocked":
    "blocked 主体的消息是否仍归档入库（只存储不响应）。启用后可事后检索，代价是为不受信任的主体保留了写库入口。",
  "access.bootstrapOwnerId":
    "首次启动写入 principals 表的 owner Telegram user id，通常由环境变量 LUOLI_OWNER_ID 提供。",

  trigger:
    "哪些消息触发一轮对话。群聊默认仅在被提及时响应，其余消息作为背景发言。",
  "trigger.private": "私聊中每条消息是否触发响应。",
  "trigger.mention": "群聊中被 @ 时是否触发。",
  "trigger.reply": "用户回复 bot 的消息时是否触发。",
  "trigger.command": "是否响应斜杠命令。",
  "trigger.channels":
    "是否响应频道消息（channel_post）。频道没有提及机制，启用后对每条频道消息均触发。",
  "trigger.wakewords":
    "群聊唤醒词，一行一条。普通字符串按包含匹配且忽略大小写（nori 匹配 Nori）；以 ^ 开头按正则处理，区分大小写，需忽略时写 ^(?i)nori。仅扫描消息前 4096 字符，过长或存在回溯风险的正则会被静默跳过。",
  "trigger.wakewordMinLength":
    "唤醒词的最短长度（按去掉前导 ^ 之后的字符数计算）。短于该长度的条目整条忽略，避免单字误触发。",
  "trigger.requireTextAfterMention": "仅 @ bot 而没有其他内容时不触发。",
  "trigger.ignoreEditedAsTrigger": "用户编辑历史消息时是否不重新开启轮次。",
  "trigger.cooldownMsPerUser":
    "同一用户两次触发之间的最小间隔（毫秒），0 = 不限。",

  context:
    "每轮送入模型的对话历史的累积与裁剪策略。修改前需确认上下文引擎的不变量清单。",
  "context.scope":
    "上下文的分隔粒度：chat = 整个会话共用一份历史，thread = 每个话题各一份。切换后新 key 从空上下文开始，旧记录不会迁移。",
  "context.limit.tokens":
    "单轮送入模型的上下文 token 上限。超出后按 turn 边界推进窗口起点，整轮裁剪最旧内容，不会切开一轮。",
  "context.limit.maxMessages":
    "上下文保留的消息条数上限，与 token 上限共同作为裁剪判据，任一先触发即生效。",
  "context.limit.minKeepTurns":
    "裁剪时至少保留的最近轮次数，确保当前对话不会被完全裁剪。",
  "context.active.windowMs":
    "活跃期长度：距上一轮提交在该时长内视为对话进行中，期间超过上述上限也不裁剪，以保持前缀缓存命中。每轮顺延，静默满该时长后的第一轮才裁剪。0 = 关闭。建议与 provider 的缓存有效期同量级（多数为 5 分钟 = 300000）。",
  "context.active.tokens":
    "活跃期内允许增长到的 token 上限。触发后仍执行裁剪，且一次裁剪回上方的 context.limit.tokens：仅裁剪到该上限会导致此后每轮都需再次裁剪。",
  "context.active.maxMessages":
    "活跃期内允许增长到的消息条数上限，与 token 上限任一先触发即生效。",
  "context.hardCapRatio":
    "轮内硬上限 = 模型上下文窗口 × 该比例。触发后依次降级工具调用参数、降级工具结果，最后执行字符级硬截断。",
  "context.background.enabled":
    "群聊中没有触发 bot 的消息是否作为背景发言进入上下文，用于提供对话背景。",
  "context.background.maxPerTurn": "单轮进入上下文的背景发言条数上限。",
  "context.background.showUsername":
    "背景发言前缀是否附带 @用户名（数字 id 始终附带，用户名可能重复或变更）。",
  "context.background.showTime": "背景发言前缀是否附带发言时间。",
  "context.background.includeNonText":
    "图片、文档等非文本背景消息是否以占位符形式进入上下文。",
  "context.rebase.injectNotice":
    "上下文 rebase（改写历史）之后，是否向会话插入一条可见的说明消息。",
  "context.rebase.markMeta":
    "是否在受 rebase 影响的消息 meta 上写入标记，WebUI 的上下文视图据此标红。",
  "context.cacheCommits":
    "物化后的上下文结果的 LRU 缓存容量（按 commit 数计算）。调大可降低 CPU 开销，代价是增加常驻内存。",
  "context.tokenRatioAlpha":
    "token 估算校准的 EMA 系数：越大越快收敛到上游返回的真实用量，越小越平滑。",
  "context.recallBarrier":
    "清空上下文（/new 或 WebUI 的「清空上下文窗口」）之后，是否同时将归档检索限制在该时刻之后。关闭时 read_messages / search_messages / get_message 仍可检索清空前的内容，清空只对窗口生效；开启后背景认领位点一并推进到清空时刻，清空前的群发言不再重新进入。owner 的 admin_search_messages 不受此限制；用 /undo 撤销该次清空会一并解除。",

  concurrency: "并发轮次数、队列长度与单轮超时。",
  "concurrency.mode":
    "parallel = 不同会话并行执行轮次；serial = 全局串行，用于故障排查。",
  "concurrency.perKey":
    "单个会话同时执行的轮次上限。必须 ≤ global，否则拒绝启动。",
  "concurrency.global": "全进程同时执行的轮次上限。",
  "concurrency.queueMax":
    "并发达到上限后可排队等待的轮次数，超出部分直接拒绝而非无限堆积。",
  "concurrency.coalesceSameUserMs":
    "大于 0 时，将同一用户在该时长内连续发送的消息合并为一轮处理。",
  "concurrency.turnTimeoutMs":
    "单个轮次从开始到结束的总超时（毫秒），超时强制终止并记为「失败」而不是「已取消」。",

  cancel: "轮次被取消（用户中断 / 超时）时的处理方式。",
  "cancel.commitPartial":
    "取消时是否将尚未发送给用户的部分回复提交进上下文。已发送的内容始终提交（上下文必须与用户所见一致），不受本项控制。",

  prompt: "系统提示词的组装预算。提示词页可逐块预览实际产出。",
  "prompt.maxTokens":
    "系统提示词（人设、记忆、技能、运行时信息等 block 0–6）的总 token 上限，超出时按块的优先级裁剪。",
  "prompt.includeToolCatalog":
    "是否在系统提示词中附加一份工具清单（工具定义本身通过 API 的 tools 字段传递，此处是给模型的额外说明）。",
  "prompt.runtimeBlock.showQuota": "RUNTIME 块中是否向模型提供当前配额用量。",
  "prompt.runtimeBlock.showContextWatermark":
    "RUNTIME 块中是否向模型提供上下文容量（已用条数 / tokens 与各自上限），用于提示接近上限。",
  "prompt.runtimeBlock.showWorkspace":
    "RUNTIME 块中是否向模型提供工作目录的路径。",

  memory: "长期记忆：写入 memory/ 下的 Markdown 文件，每轮注入提示词。",
  "memory.dir": "长期记忆 Markdown 文件所在目录。",
  "memory.pubWriteMinRole":
    "允许写入公开记忆（同群共享）的最低角色。作为防止记忆污染的安全边界，会话级覆盖只能收紧，放宽会被校验器拒绝。",
  "memory.pubWriteRequiresApproval":
    "公开记忆的写入是否需先经 owner 审批。多群部署建议启用。",
  "memory.softLimitTokens":
    "记忆文件超过该 token 数触发异步压缩。必须小于硬上限，否则拒绝启动。",
  "memory.hardLimitTokens":
    "记忆文件超过该 token 数后拒绝写入，避免记忆占满提示词预算。",
  "memory.maxSections": "单个记忆文件允许的小节数上限。",
  "memory.compactCron": "记忆压缩任务的 cron 表达式。",
  "memory.autoApplyCompaction":
    "压缩结果是否自动生效。关闭时压缩产物需 owner 在 WebUI 复核后才写入。",
  "memory.requireSourceTag":
    "写入记忆时是否强制附带来源标注（主体与消息位置），便于事后审计与撤销。",

  agent: "主 agent 与子 agent 的运行边界。子 agent 的具体定义在 Agent 页编辑。",
  "agent.main.modelAlias":
    "主 agent 使用的模型别名。别名到具体模型的映射在模型页维护。",
  "agent.main.maxSteps":
    "主 agent 单轮的步骤上限（一次模型调用及其后续工具执行计为一步）。",
  "agent.main.downgradeAfterStep":
    "超过该步数后自动降级到 low 档模型，避免长循环按高档价格计费。",
  "agent.maxDepth": "子 agent 的最大嵌套深度，防止 agent 无限派生 agent。",
  "agent.maxConcurrentSubagents": "同时运行的子 agent 数上限。",
  "agent.maxSubagentsPerTurn": "单轮内允许派生的子 agent 总数。",
  "agent.askTimeoutMs":
    "子 agent 用 ask_parent 提问后，等待答复的超时（毫秒）。",
  "agent.maxAsksPerRun":
    "单次运行中 ask_parent 的调用次数上限，防止子 agent 持续提问而不执行任务。",
  "agent.askArbiter":
    "是否用 low 档模型自动仲裁 ask_parent 的提问，而不是每次都转人工。",
  "agent.harness.command": "harness 的可执行名，例如 claude 或 codex。",
  "agent.harness.args": "固定参数；任务正文作为最后一个参数追加，不经 shell。",
  "agent.harness.allowedDirs":
    "harness 允许访问的仓库路径白名单。**留空 = 功能整体关闭**，该工具不进入模型的工具目录。",
  "agent.harness.timeoutMs":
    "单次 harness 运行的时间上限，超时先 SIGTERM 再 SIGKILL。",
  "agent.harness.maxOutputBytes":
    "返回给模型的 harness 输出上限，超出部分从中间截断。",
  "agent.acp.enabled":
    "总开关。关闭时 spawn_acp 不进入模型的工具目录。本项与下方的 allowedDirs 任一为空或为假，功能即整体关闭。",
  "agent.acp.allowedDirs":
    "ACP agent 允许访问的仓库路径白名单，语义与 harness 的同名项一致。**留空 = 功能整体关闭**。并发轮次不会在同一目录上各启动一个 agent（按 realpath 互斥，等待时间有上界）。",
  "agent.acp.defaultAgent":
    "模型未指定 agent 时使用的默认 agent（填名称）。留空则使用下方列表中第一个启用的 agent。仅配置一个 agent 时本项无效。",
  "agent.acp.permissionMode":
    "agent 反向请求权限时的应答策略：**默认 auto = 直接放行**（启动该 agent 时已经过一次审批，一次批准覆盖本次运行），deny 全部拒绝，ask 逐条转人工审批（走审批页 / Telegram 按钮，与工具审批同一条链）。逐条审批已实现可用，但**需手动切换到 ask 才生效**。三档代价不同，详见各取值的说明。",
  "agent.acp.maxUpdatesPerPrompt":
    "单次任务接收的进度更新条数上限。达到上限后丢弃后续更新，**不中断 agent**：agent 正在修改真实文件，中断代价更高。",
  "agent.acp.maxTerminals":
    "单次任务中 agent 可同时打开的终端数上限（含已执行完但尚未释放的终端，以促使 agent 及时释放）。达到上限后新建终端被拒绝，并提示 agent 先释放已用完的终端。",
  "agent.acp.progressIntervalMs":
    "将 agent 进度刷新到聊天卡片的最小间隔。**小于 1000 时按 1000 处理**（发送侧本身有 1 秒的最小间隔，更小的取值只增加一次排队）。取值过大则卡片长时间不更新。",
  "agent.acp.maxCostUsd":
    "单次任务的花费上限（美元，0 = 不限）。**这是唯一能约束 ACP 花费的配置**：agent 使用它自己的 provider 凭据，本项目的配额与用量账单不覆盖它。达到上限时按协议取消，已修改的文件不会回滚。",
  "agent.acp.agents":
    "ACP agent 定义数组：名称、可执行名、profile、审批档、允许的工具、模型、会话模式、超时。审批档与工具清单是独立的键，不进自由参数：两者是权限边界，写进自由参数会被一行配置静默移除。approvalMode **默认 yolo**（agent 内部不做拦截）：另两档下实测 bash 不可用，always-ask 另有可复现的 edit 故障。",
  "agent.agentsDir":
    "子 agent 的 markdown 定义目录（agents/<名字>.md）。文件是只读来源，「子 Agent」页中的同名定义会覆盖它。修改 .md 之后需变更一次配置或重启才会重新扫描。",
  "agent.askEscalateToUser":
    "🚧 未接线：仲裁无法作答时转人工，需要「发送选项—等待选择—回灌结果」的阻塞式通道，当前不存在。启用后仅在仲裁失败时额外记录一条日志。",
  "agent.progressThrottleMs": "子 agent 向上回报进度的最小间隔（毫秒）。",
  "agent.agents":
    "子 agent 定义数组：名称、描述、模型别名、步数、最低角色、可用工具、指令。Agent 页有专用编辑器，直接编辑此处的 JSON 容易破坏结构。",

  provider:
    "上游模型服务的重试、超时、健康检查与模型元数据目录。API key 在模型页管理。",
  "provider.maxRetries": "上游请求失败后重试几次。",
  "provider.retryBaseMs": "重试退避的基准毫秒数（指数退避的起点）。",
  "provider.retryMaxMs": "重试退避的上限毫秒数，退避再久也不超过它。",
  "provider.healthCheckCron": "provider 健康检查的 cron 表达式。",
  "provider.healthDownCooldownMinutes":
    "provider 被判定不可用后，冷却多少分钟才重新尝试。",
  "provider.requestTimeoutMs":
    "单次上游尝试从发出请求到收到响应头的超时（毫秒）。超时只中止这一次尝试，重试与别名 fallback 不受影响。",
  "provider.streamIdleTimeoutMs":
    "流式响应无新数据超过该时长即判定为停滞（毫秒）。整体超时覆盖不了连接保持但没有数据输出的情况。",
  "provider.allowPrivateBaseUrl":
    "允许 provider 连通性探测与模型目录访问私网地址和非常规端口。默认关闭：探测接口接受请求体中的 baseUrl，启用后管理端等同于一个带鉴权的 SSRF 代理。仅在自建网关位于内网时启用。",
  "provider.catalog.enabled":
    "是否从 models.dev 拉取模型元数据（上下文窗口、价格、能力）。关闭后拉取模型只能得到上游 /models 返回的信息，配额也无法按价格计算。",
  "provider.catalog.url": "模型元数据目录的地址。",
  "provider.catalog.cacheFile":
    "模型元数据的本地缓存文件路径；etag 与上次拉取时间记在 app_kv。",
  "provider.catalog.ttlHours":
    "缓存超过该小时数才重新发起网络请求，并带 If-None-Match 条件请求（无变化时返回 304，仅数百字节）。",
  "provider.catalog.timeoutMs":
    "单次拉取目录的超时（毫秒）。失败时降级使用旧缓存，而不是阻塞模型页加载。",

  tools:
    "工具层的总体限制：注册上限、单轮调用次数，以及各类工具各自的边界。逐个工具的启停在工具页。",
  "tools.maxRegistered":
    "可注册进工具表的工具数上限，超出部分不下发给模型（工具目录过长会显著降低模型表现）。",
  "tools.maxCallsPerTurn": "单轮内工具调用次数上限。",
  "tools.maxConsecutiveErrors":
    "连续工具报错达到该次数即中止这一轮，防止模型对同一个错误反复重试产生费用。",
  "tools.defaultTimeoutMs":
    "单次工具调用的默认墙钟上限（毫秒）。超时后向模型返回 tool_timeout，避免整轮对话阻塞在不返回的工具上。bash/python/spawn_agent 与两个 web 工具自行管理超时，不受本项约束。",
  "tools.overrides":
    "逐个工具的运维覆盖层（键为工具名），每个工具可写 enabled / minRole / approval / timeoutMs。工具页是更完整的入口，在其中修改会同步到本项，且放宽权限时二次确认。后三项缺省时沿用代码内置的默认策略。禁用为强制约束：工具不出现在目录中，模型直接指定工具名也会在 execute() 被拦截。",
  "tools.catalog.deferExternal":
    "把外部工具（MCP / 插件 / 模型定义的 custom_*）折叠成每组一行的摘要，不在目录里逐个展开描述。默认开启；MCP 与自我扩展出厂关闭、plugins/ 出厂为空目录，因此默认部署下没有可折叠的工具，提示词不变。接入工具较多的 MCP server、或启用第一个带工具的插件之后才出现差异。",
  "tools.catalog.defer":
    "额外要折叠的工具名 glob，一行一条（如 send_* 、container_* ）。仅在 tools.catalog.deferExternal 开启时生效。内建与 agent 类工具默认常驻，列入本项才折叠。search_tools 与 load_skill 不生效：折叠展开入口之后无法再展开任何工具。",
  "tools.catalog.resident":
    "强制常驻的工具名 glob，一行一条。优先级最高，覆盖上面两项，用于把某个 MCP server 的常用工具留在目录中。",
  "tools.catalog.residentDescriptions":
    "常驻工具在目录里是否带描述。关闭后目录只剩名字清单：描述已由 API 的 tools 字段完整传递一次，该处属于请求体前缀（可被缓存），目录中的副本则每步重发。建议先只开折叠、观察一段时间再关闭本项，两项同时变更难以定位模型表现下降的原因。",
  "tools.catalog.maxExpandedPerTurn":
    "一轮内累计展开的工具数上限。真正的代价在展开次数：每展开一次即改写一遍 API 的 tools 字段，本轮剩余步骤全部缓存未命中并重算一次。达到上限时提示模型改用精确名称批量展开（一次展开三个与分三次展开占用同样三个名额，但只产生一次缓存失效）。",
  "tools.fs.maxReadBytes": "read_file 单次读取的字节上限，超出截断。",
  "tools.fs.maxWriteBytes": "write_file 单次写入的字节上限。",
  "tools.fs.showHidden": "list_dir 是否列出以点开头的隐藏文件。",
  "tools.fs.allowHostFsForOwner":
    "允许 owner 的文件工具绕过沙箱直接读写宿主文件系统。★ 高风险：模型将获得宿主文件系统的完整读写权限，确认代价之后再启用。",
  "tools.fs.denyGlobs":
    "文件工具拒绝访问的 glob 列表，一行一条；<root> 表示仓库根。以 /** 结尾的条目同时拒绝该目录本身：写了 X/** 无需再补一条 X，模型既读不到 X 目录下的内容，也无法移动或删除 X 目录（补写 X 仅为冗余，不影响结果）。密钥、私钥、数据库与配置目录默认在内，删除条目即放开对应的读写权限。",
  "tools.fs.trashDir":
    "delete_file 的软删除目录：文件移入该目录而不是直接删除，便于事后恢复。",
  "tools.fs.backupDir": "覆盖写之前把原文件备份到哪个目录。",
  "tools.exec.defaultTimeoutMs":
    "bash / python 没指定超时时用的默认超时（毫秒）。",
  "tools.exec.maxTimeoutMs":
    "调用方可请求的最大执行超时（毫秒），超出请求值一律封顶在这里。",
  "tools.exec.maxOutputBytes":
    "单次执行捕获的输出字节上限，超出部分截断后告知模型。",
  "tools.archive.defaultSearchLimit": "检索历史消息时不指定条数则返回多少条。",
  "tools.archive.maxSearchLimit": "检索历史消息允许请求的最大条数。",
  "tools.archive.defaultReadLimit": "读取历史消息时不指定条数则返回多少条。",
  "tools.archive.maxReadLimit": "读取历史消息允许请求的最大条数。",
  "tools.tg.maxExtraMessagesPerTurn":
    "一轮内 send_message / send_photo / send_file 的调用上限（正常回复不计入），用于防止模型主动发送过多消息。",
  "tools.tg.maxFileSendMb": "send_file / send_photo 单个文件的大小上限（MB）。",
  "tools.web.maxResponseBytes": "web_fetch 单次抓取的响应字节上限。",
  "tools.web.timeoutMs":
    "web_fetch / web_search 单次尝试的超时（毫秒）。缺少该限制时，无响应的地址会持续挂起，整轮对话随之阻塞。",
  "tools.web.retries":
    "web_fetch / web_search 遇到瞬时失败（超时、5xx、429）时的重试次数。重试耗尽后把失败结果返回模型，由模型决定更换 URL 还是如实告知用户。",
  "tools.web.summarizeWithAlias":
    "web_fetch 抓回的长网页用哪个模型别名做摘要。",
  "tools.web.allowlist":
    "web_fetch 的域名白名单，一行一条。留空时 limited 角色用不了 web_fetch。",
  "tools.web.denylist": "web_fetch 的域名黑名单，一行一条。内网后缀默认在内。",
  "tools.web.searchProvider":
    "web_search 使用哪家搜索 API。留空则不注册 web_search。exa 额外请求 highlights（每条带命中片段），其余三家自带摘要。",
  "tools.web.searchApiKey":
    "搜索 API 的密钥。★ 与 provider key 不同，本项以明文存放在配置中，建议写成 ${env:BRAVE_API_KEY} 形式的环境变量引用，不要直接写入数据库。",
  "tools.selfExtend.enabled":
    "自我扩展总开关：模型能否自行编写工具 / skill / plugin，或安装 MCP。默认关闭。关闭后七个自我扩展工具整体不进工具目录，已启用的自定义工具一并失效。",
  "tools.selfExtend.customTools.enabled":
    "允许模型用 define_tool 把一段 bash / python 脚本注册成工具（名称带 custom_ 前缀）。",
  "tools.selfExtend.customTools.autoEnable":
    "模型新定义的工具是否立即可用。★ 默认关闭，需 owner 在扩展页复核正文之后手动启用。启用本项将使「网页或群聊中的一段注入 → define_tool → 下一轮成为持久能力」失去人工复核。",
  "tools.selfExtend.customTools.requireSandbox":
    "启用后，沙箱不生效时（owner 命中 sandbox.bypassRoles，或 sandbox.mode=none）自定义工具一律不可用，其权限严格弱于 bash；关闭时与 bash 同等对待，正文可以直接在宿主上执行。",
  "tools.selfExtend.customTools.maxTools":
    "自定义工具的数量上限。达到上限后 define_tool 在定义期就报错，需先删除已有工具。",
  "tools.selfExtend.customTools.maxBodyChars":
    "单个自定义工具脚本正文的字符上限。",
  "tools.selfExtend.customTools.defaultMinRole":
    "模型未指定时新工具的最低调用角色。无论如何配置都不会低于 bash 的门槛：自定义工具的正文即一段 shell。",
  "tools.selfExtend.customTools.timeoutMs":
    "自定义工具没指定超时时用的默认值（毫秒），最终仍封顶在 tools.exec.maxTimeoutMs。",
  "tools.selfExtend.skills.enabled":
    "允许模型用 write_skill 编写 SKILL.md。skill 是纯文本说明，不含可执行代码。",
  "tools.selfExtend.skills.minRole":
    "模型编写的 skill 的 min-role 下限：可以更严格，不能更宽松。",
  "tools.selfExtend.mcp.enabled":
    "允许模型用 install_mcp 登记 MCP server。登记后一律是禁用状态，需 owner 在扩展页确认后才会连接。",
  "tools.selfExtend.mcp.allowTransports":
    "允许模型登记哪几种 transport。★ stdio 的命令行由模型生成，启用后以 bot 进程的身份运行在沙箱之外；只保留 http 可以整体禁止该类型。",
  "tools.selfExtend.plugins.enabled":
    "允许模型用 write_plugin 写 plugins/<name>/plugin.js。★ plugin 在 bot 进程内以完全信任的方式运行，权限等同 root；写入的文件一律禁用，需 owner 在扩展页阅读源码之后才能启用。",
  "tools.selfExtend.plugins.maxBodyChars": "单个 plugin.js 的字符上限。",

  sandbox:
    "执行类工具（bash / python）的运行位置。工具页有沙箱卡片，可探测当前是否可用。",
  "sandbox.mode":
    "执行类工具的隔离方式：none 关闭执行类工具（bypassRoles 里的角色仍直接在宿主执行）、docker 每次启动一次性容器。",
  "sandbox.bypassRoles":
    "哪些角色不受沙箱约束、直接在宿主上执行。★ 写进这个名单的主体等同于获得宿主 shell。",
  "sandbox.image": "docker 模式使用的镜像。",
  "sandbox.network": "沙箱容器的网络：none 断网，bridge 可出网。",
  "sandbox.memoryMb": "沙箱容器的内存上限（MB）。",
  "sandbox.cpus": "沙箱容器的 CPU 配额（核数，可以是小数）。",
  "sandbox.pidsLimit":
    "沙箱可额外创建的进程数，用于防御 fork 炸弹。docker 模式下对应容器的 --pids-limit。bypassRoles 内的角色（如 owner）不受本项约束。",
  "sandbox.readOnlyRoot":
    "容器根文件系统是否只读（只有工作目录与 tmpfs 可写）。",
  "sandbox.tmpfsMb": "挂给容器的 tmpfs 大小（MB）。",
  "sandbox.workspaceDir":
    "工作目录（本进程视角）。每个会话在它下面有自己的子目录，文件工具与执行工具都只在这个范围内操作。",
  "sandbox.hostWorkspaceDir":
    "同一工作目录在宿主上的路径。仅在「应用自身运行在容器内 + docker 模式」下需要填写：docker run -v 的左半边由宿主解析，填错不报错，只在宿主上创建一个空目录。",
  "sandbox.dockerBin": "docker 可执行文件的名字或绝对路径。",
  "sandbox.persistent.enabled":
    "★ 启用后每个会话一个常驻容器（执行走 docker exec，不再每次新建）。持久容器的网络默认为 bridge，由下方 sandbox.persistent.network 单独控制，与 sandbox.network 不是同一个键。关闭本项不会立刻销毁已有容器，由下一次回收对账清理。",
  "sandbox.persistent.idleTtlMs":
    "容器闲置多久后回收。每执行一次重新计时，因此持续使用的会话容器不会被回收。",
  "sandbox.persistent.maxLifetimeMs":
    "容器自创建起的最长存活时间，不因活跃而延长。0 = 不设上限。「钉住」仅豁免闲置回收，不豁免本项。",
  "sandbox.persistent.maxContainers":
    "同时存在的持久容器数上限。达到上限时新会话的执行类工具直接报错，不会回退到一次性容器。",
  "sandbox.persistent.network":
    "★ 持久容器的网络：none 断网，bridge 可出网。默认 bridge：断网的持久容器用途有限。bridge 下容器可直接访问公网与宿主，且不经过可审计的出站代理。",
  "sandbox.persistent.reapCron":
    "回收到期容器、并与 docker 双向对账的频率（五段式 cron）。",

  approval:
    "高风险工具调用挂起等待人工裁决。规则命中即挂起，裁决在「任务与审批」页进行。",
  "approval.enabled": "高风险工具调用是否需在 WebUI 人工批准后才执行。",
  "approval.ttlMs":
    "单条审批请求等待裁决的上限（毫秒）。超时作废，并把「未获批准」作为工具结果返回模型。",
  "approval.skipForOwner": "owner 自己触发的调用是否免审批。",
  "approval.rememberWithinTurn":
    "同一轮内已批准的同类调用是否不再重复请求审批。",
  "approval.rules":
    "审批规则数组：按工具名、正则、风险级别匹配，命中任一条即挂起等待裁决。正则用 RE2 求值，不存在回溯风险。",

  output: "回复的发送方式。会话级覆盖（perChat）优先于这里的全局值。",
  "output.mode":
    "stream = 生成过程中持续编辑同一条消息；once = 生成完成后一次性发送。",
  "output.replyDelayMs":
    "自用户消息到达算起，至少等待该时长才发第一条回复，用于避免即时回复。模型耗时已经超过该时长时不再额外延迟，0 = 立即回复。",
  "output.streamBufferMs":
    "自上游第一个 chunk 到达算起，再缓冲该时长才发第一条。窗口内的文本只累积不丢弃；流在窗口内结束则立刻发出。0 = 首字先发，其余通过编辑补齐。",
  "output.streamIntervalMs":
    "两次消息编辑之间的最小间隔（毫秒）。首条发出也算一次刷新。",
  "output.streamMinDeltaChars":
    "与编辑间隔**同时满足**才编辑：达到间隔但新增字符不足时不编辑，避免触发 Telegram 的编辑频率限制。收尾一次编辑不受这两项约束。",
  "output.flushOnSentence": "是否优先在句子边界刷新，避免在句子中间截断。",
  "output.maxMessageChars":
    "单条消息的字符上限，超出拆成多条（Telegram 硬限是 4096）。",
  "output.parseMode": "发送时按哪种格式解析：MarkdownV2 / HTML / none。",
  "output.typingWhileWorking": "生成期间是否持续发送「正在输入」状态。",
  "output.placeholderAfterMs":
    "超过该时长仍没有内容可发送时，先发一条占位消息。",
  "output.placeholderTexts":
    "占位消息的备选文案，一行一条。**留空 = 不发占位消息**：placeholderAfterMs 不接受 0，这是关闭占位消息的唯一方式。",
  "output.placeholderPick":
    "random = 每次从备选里随机选取；fixed = 固定使用 placeholderIndex 指定的那条。备选只有一条时两者等价。",
  "output.placeholderIndex":
    "fixed 模式下使用第几条，从 0 起，按**去掉空行后**的列表计算。越界时回落到第一条。",
  "output.maxMentions": "单条回复里 @ 的人数上限，防止模型提及全部群成员。",

  media: "图片与文件的下载、缩放与文本抽取。",
  "media.retentionDays":
    "媒体文件保留多少天，0 = 不清理。到期只删除磁盘上的文件，消息与附件元数据保留（界面上标记「已过期」且不提供下载）。修改后需重启。",
  "media.dir": "下载下来的图片与文件的存放目录。",
  "media.maxImageBytes": "单张图片允许下载的字节上限。",
  "media.maxDocBytes": "单个文档允许下载的字节上限。",
  "media.maxImageEdge":
    "送入模型前把图片最长边缩放到该像素值。图片按面积计费，边长减半可显著降低 token 消耗。",
  "media.maxImagesPerTurn": "单轮最多带几张图片给模型。",
  "media.visionScope":
    "判定本轮是否含图、是否切换到 vision 模型时的统计范围。window = 整个上下文窗口（默认，与既有行为一致）：一张图会把其后每一轮都固定在 vision 别名上，纯文本轮次也切到更贵的档位。turn = 只统计本轮新进入的图片（用户发送的、用户引用的、本轮认领的群发言）；更早轮次留在窗口中的图片，仅在本轮实际落到不支持图像的模型上时替换为占位文本，落到支持图像的模型上原样保留，仍可引用先前的图片。",
  "media.groupDebounceMs":
    "相册（一次发送多张）的合并等待窗口（毫秒），集齐后作为一组处理，而不是逐张开轮。",
  "media.stickerAsImage": "是否把贴纸当图片送给模型看。",
  "media.downloadVoice": "是否下载语音消息。仅存盘，不做语音转文字。",
  "media.extract.enabled": "是否从 PDF / Word 等文档里抽取文本给模型。",
  "media.extract.maxChars": "单个文档抽取的字符上限。",
  "media.extract.inlineChars":
    "直接内联进上下文的字符数。超出部分只保留前 N 字，并提示模型用 read_file 读取全文。",
  "media.extract.codeExtensions": "按纯文本抽取的代码文件扩展名，一行一条。",

  skills: "技能：skills 目录下的 Markdown 能力包，按需注入提示词。",
  "skills.enabled": "技能总开关。",
  "skills.dir": "技能文件所在目录。",
  "skills.watch": "是否监视技能目录，修改文件后无需重启即生效。",
  "skills.defaultMinRole": "WebUI 新建技能时未指定角色的默认值。",
  "skills.package.maxEntries": "安装技能包时，包里允许的文件与目录数上限。",
  "skills.package.maxTotalBytes":
    "技能包解压之后的总字节上限。按实际写出的字节数计算，不采用压缩包声明的大小。",
  "skills.package.maxFileBytes":
    "技能包里单个文件的字节上限。同样按实际写出的字节数计算。",
  "skills.package.allowExecutable":
    "为技能包 scripts/ 与 bin/ 下原本带执行位的文件保留执行权限。关闭后包里的脚本与二进制可以安装但无法执行。",

  plugins: "插件：本地 JS 钩子，可挂载到轮次生命周期上。",
  "plugins.enabled": "插件总开关。",
  "plugins.dir": "插件所在目录。",
  "plugins.watch": "是否监视插件目录热重载。",
  "plugins.hookTimeoutMs": "单个插件钩子的执行超时（毫秒），超时按失败计。",
  "plugins.order": "插件执行顺序（按插件名排），一行一条，决定钩子的调用次序。",
  "plugins.autoDisableAfterErrors":
    "连续报错达到该次数即自动停用该插件，避免单个插件影响每一轮。",

  mcp: "MCP：把外部 MCP server 的工具接进工具表。具体 server 在扩展页编辑。",
  "mcp.enabled":
    "MCP 总开关，出厂关闭。关闭时 servers 里配置的 server 都不会连接。",
  "mcp.connectTimeoutMs": "连接单个 MCP server 的超时（毫秒）。",
  "mcp.healthCheckCron": "MCP 连接健康检查的 cron 表达式。",
  "mcp.defaultMinRole": "MCP 工具在没单独指定时的最低可用角色。",
  "mcp.servers":
    "MCP server 定义数组：stdio（命令 + 参数 + 环境变量）或 http（地址 + 请求头）传输，各带工具黑白名单。扩展页有专用编辑器。",

  schedule:
    "定时任务：模型用 schedule_create 创建的周期/一次性任务。触发时按 mode 开启一轮完整对话（agent）或发送一段预写文本（notify），产出仍进入该会话的上下文。",
  "schedule.enabled":
    "定时任务总开关。关闭后已有任务保留在库里但不再触发（每次跳过记一条 schedule.skipped），不会被删除。",
  "schedule.maxPerChat":
    "单个会话同时存在的活跃任务上限。超出后 schedule_create 直接拒绝：单个会话累积数十个 agent 模式的任务会产生大量消息与费用。",
  "schedule.minIntervalMinutes":
    "cron 任务两次触发之间的最小间隔（分钟）。cron 粒度最细到每分钟，而 agent 模式下即每分钟一次真实模型调用。",
  "schedule.maxPayloadChars":
    "任务正文（agent 的任务描述 / notify 的原文）的字数上限。",
  "schedule.retentionDays":
    "已结束（完成/取消）的任务行保留多少天。活跃任务永不清理。需重启：与 logs.retentionDays 一样在启动时交给 MaintenanceService。",

  maintenance:
    "维护任务清理派生数据的保留期。每日 general.maintenanceCron 触发时按这几项删行。",
  "maintenance.retention.usageDays":
    "usage_ledger（每次模型调用一行）保留多少天。0 = 不清。该表只增不减，VACUUM 也无法减少数据量。需重启：启动时交给 MaintenanceService。",
  "maintenance.retention.quotaCounterDays":
    "quota_counters 里过期账期的行保留多少天（每个 scope×subject×窗口×账期一行，跨天跨月只增）。0 = 不清。当前账期的行永远不会被删。需重启。",
  "maintenance.retention.configRevisionDays":
    "config_revisions（配置变更历史）保留多少天。0 = 不清。删除的是审计记录，不影响当前配置。需重启。",
  "maintenance.retention.memoryRevisionDays":
    "memory_revisions（记忆/提示词文档的完整 diff）保留多少天。0 = 不清。删除之后无法回滚到更早的版本。需重启。",

  db: "SQLite 数据库的位置、备份与整理。",
  "db.path": "SQLite 数据库文件路径。",
  "db.backupKeep": "执行迁移前自动备份，保留最近的份数。",
  "db.vacuumCron": "VACUUM 整理任务的 cron 表达式。",

  logs: "日志级别、留存与请求载荷记录。日志页读取的就是这些文件。",
  "logs.level": "日志级别，低于它的不记录。",
  "logs.dir": "日志文件目录。",
  "logs.captureBodies":
    "是否把发给上游的请求体与响应体存盘。关闭后对话详情里看不到实际发出的载荷，排障能力受限。",
  "logs.bodyMaxBytes": "单条载荷存盘的字节上限，超出截断。",
  "logs.maxFileMb": "单个日志文件的大小上限（MB），超出轮转。",
  "logs.retentionDays": "日志保留天数，超期删除。",
  "logs.gzipAfterDays": "日志文件在多少天之后压缩存放。",
  "logs.console":
    "控制台输出格式：pretty 供人阅读、json 供采集器解析、off 不输出。",
  "logs.redactPatterns":
    "额外的脱敏正则，一行一条。bot token 与 master key 已默认脱敏，这里用于补充自有的密钥形态。",

  quota: "花费与频率的硬性限制。配额页有专用面板，可查看实时计数器。",
  "quota.enabled": "花费配额总开关。关闭后不再拦截，但用量仍记账。",
  "quota.requirePricing":
    "模型没有价格数据时是否拒绝调用。关闭后放行无法计价的模型，那部分花费不计入配额。",
  "quota.minReserveUsd":
    "每轮开始前预扣的最小金额（美元），防止多个并发轮次同时越过同一条额度线。",
  "quota.global.daily": "全局每日花费上限（美元），留空 = 不限。",
  "quota.global.monthly": "全局每月花费上限（美元），留空 = 不限。",
  "quota.perChat.daily": "单个会话的每日花费上限（美元），留空 = 不限。",
  "quota.perChat.monthly": "单个会话的每月花费上限（美元），留空 = 不限。",
  "quota.perUser.daily": "单个用户的每日花费上限（美元），留空 = 不限。",
  "quota.perUser.monthly": "单个用户的每月花费上限（美元），留空 = 不限。",
  "quota.perUser.byRole":
    '按角色覆盖单用户额度，形如 {"trusted":{"daily":2}}。配额页有专用面板，无需手写 JSON。',
  "quota.perTurn.maxCostUsd": "单轮花费上限（美元），超出中止这一轮。",
  "quota.perTurn.maxSteps":
    "单轮步数上限，与 agent.main.maxSteps 取更严格的那个。",
  "quota.rateLimit.turnsPerUserPerHour": "单个用户每小时可触发的轮次数。",
  "quota.rateLimit.turnsPerChatPerHour": "单个会话每小时可触发的轮次数。",
  "quota.rateLimit.concurrentPerUser": "单个用户同时进行中的轮次数上限。",
  "quota.onExceeded.reply": "超额时回复一条说明消息，还是静默忽略。",
  "quota.onExceeded.message":
    "超额回复的文案。{spent} / {limit} / {resetAt} 会被替换为实际数值。",
  "quota.onExceeded.notifyOwner": "超额时是否私信通知 owner。",
  "quota.warnAtRatio":
    "用量达到额度的该比例时发出预警（0.8 = 用量达到 80% 时提醒）。",

  webui: "控制台自身的监听地址、登录与反代设置。",
  "webui.enabled": "WebUI 控制台总开关。",
  "webui.host":
    "WebUI 监听地址。默认 127.0.0.1 仅本机可访问；改成对外地址前必须先设置登录口令，否则拒绝启动。",
  "webui.port": "WebUI 监听端口。",
  "webui.basePath": "反代到子路径时的前缀，如 /luoli。",
  "webui.publicUrl": "对外可访问的完整地址，用于生成 /webui 一次性登录链接。",
  "webui.sessionTtlHours": "登录会话的有效小时数，过期需重新输入口令。",
  "webui.passwordHash":
    "登录口令的 argon2id 哈希。不通过本表单修改：用 pnpm webui:passwd 生成后写入，或首次启动时由 WEBUI_PASSWORD 环境变量生成。",
  "webui.trustProxy":
    "是否信任反代传入的 X-Forwarded-For 作为客户端 IP。直连时必须关闭，否则请求头可被伪造，登录限流失效。",
  "webui.trustedProxyHops":
    "反代追加的跳数。X-Forwarded-For 按该值**从右往左**取；取最左那一跳将允许客户端自行声明身份。trustProxy 关闭时不读取任何请求头，只认连接的远端地址（取不到时记为 local）。",
  "webui.allowOrigins":
    "允许跨源访问 API 的 Origin 列表，一行一条（本机用 vite 开发时需加入 dev 地址，否则登录会被 Origin 中间件拒绝为 403）。",
  "webui.loginRateLimit.attempts": "单个 IP 在窗口内允许的登录失败次数。",
  "webui.loginRateLimit.windowMinutes": "登录失败计数的窗口长度（分钟）。",

  alerts: "故障发生时的通知方式。",
  "alerts.notifyOwner": "告警是否私信 owner。",
  "alerts.dedupeMinutes":
    "同类告警在该时长内只发送一次（分钟），避免单个故障重复通知。",
  "alerts.webhookUrl": "告警额外推送到的 webhook 地址。",
  "alerts.on":
    "哪些事件算告警，一行一条，如 quota_global_exceeded、all_providers_down。",

  perChat:
    "会话级配置覆盖层（键为 context key），不是可直接编辑的配置项：入口在会话页，且只放行白名单内的路径。",
};

/**
 * 逐取值的注解：`{ 点分路径: { 取值: 说明 } }`。随 `CONFIG_DESCRIPTIONS` 一起进入
 * `GET /api/config/schema`，WebUI 将其渲染在每个复选框或选项旁边。
 *
 * 存在的理由只有一个：同一格中的取值并非等价选项。`telegram.allowedUpdates` 的 23 个取值中只有 4 个
 * 有处理器，把这件事写进该格的 `description` 无法表述清楚（一句话装不下 23 条），不写则等于让运维
 * 勾选一个不产生任何效果的选项，而它在界面上与另外四个完全相同。
 *
 * `tests/config.test.ts` 断言这里的键是 schema 叶子、取值与该叶子的 enum 严格一一对应：
 * 新增一个更新类型而遗漏注解，或删除一个取值而注解仍在，都会立即报错。
 */
export const CONFIG_ENUM_NOTES: Record<string, Record<string, string>> = {
  "telegram.allowedUpdates": {
    message:
      "已处理 · 唯一的消息入口，斜杠命令同样经由它。移除后 bot 无法接收任何消息",
    edited_message:
      "已处理 · 用户编辑历史消息时更新归档并记一条修订（不会因此开新轮次）",
    callback_query: "已处理 · inline 按钮回调，目前只有「取消本轮」按钮使用",
    my_chat_member: "已处理 · bot 被加入群 / 被移除 / 权限变化时登记会话主体",
    channel_post:
      "无处理器 · 频道消息属于这一类，而适配器没有接入，trigger.channels 因此不生效",
    edited_channel_post: "无处理器 · 同上，频道里的编辑",
    message_reaction:
      "无处理器 · 他人的表情回应不入库（bot 自己发表情走工具路径，与这里无关）",
    message_reaction_count: "无处理器 · 大群里的匿名表情计数",
    inline_query: "无处理器 · @bot 的行内查询（本 bot 未启用 inline 模式）",
    chosen_inline_result: "无处理器 · 行内结果被选中的回执",
    shipping_query: "无处理器 · Telegram 支付流程",
    pre_checkout_query: "无处理器 · Telegram 支付流程",
    purchased_paid_media: "无处理器 · 付费媒体购买回执",
    poll: "无处理器 · 投票状态变化",
    poll_answer: "无处理器 · 用户投票",
    chat_member:
      "无处理器 · 群成员加入或退出（Telegram 默认不推送，需显式声明）",
    chat_join_request: "无处理器 · 入群申请（Telegram 默认不推送，需显式声明）",
    chat_boost: "无处理器 · 频道 boost",
    removed_chat_boost: "无处理器 · 频道 boost 取消",
    business_connection: "无处理器 · Telegram Business 账号接入",
    business_message: "无处理器 · Business 账号收到的消息",
    edited_business_message: "无处理器 · Business 账号里的编辑",
    deleted_business_messages: "无处理器 · Business 账号里的删除",
  },
  // 三档的代价各不相同，而一句 `description` 容纳不下三条说明，这正是逐值注解存在的理由。
  // `ask` 曾在此标注 🚧（该通道未接入，实际等同 auto）；现已真实生效，只是不再作为默认档。
  "agent.acp.permissionMode": {
    ask: "转人工确认：每一步经 approvals 表 + Telegram 按钮 / WebUI 审批页（与工具审批同一条链、同一套 approval.rules 与 TTL）。**不是默认档，需手动选择**。选用后拦住 agent 的每一步，一次多文件改动可能需要多次确认；agent 提供「以后都这样」一档时，会话内对同一个 (kind, 目录) 记住答案（不跨调用、不写入 approval.rules），审计行仍逐条写入。⚠ 仅能拦住 agent **主动请求**的动作，不是第四道门",
    auto: "**默认**。直接放行：启动该 agent 本身已经过一次审批，一次批准即覆盖本次运行在该目录内的全部操作。本次运行的改动**可见**（进度卡片逐条渲染 tool_call），可见不等于可拦截",
    deny: "全部拒绝。本档不限制 agent 直接执行的操作，仅限制其反向发起的请求；默认的 approvalMode: yolo 下 agent 几乎不发起请求，本档在默认组合中基本不生效（如需禁用某项能力，用 agents[].tools 移除）",
  },
  "tools.web.searchProvider": {
    "": "留空 = web_search 不进入模型的工具目录",
    brave: "api.search.brave.com · 结果自带 description 摘要",
    serper: "google.serper.dev · Google 结果，自带 snippet",
    tavily: "api.tavily.com · 面向 LLM 的搜索，自带 content",
    exa: "api.exa.ai · 语义检索，本实现额外请求 highlights（每条带命中片段，按条计费）",
  },
};

type Node = Record<string, unknown>;

function resolveRef(document_: Node, node: Node): Node {
  const reference = node.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/")) return node;
  let cursor: unknown = document_;
  for (const segment of reference.slice(2).split("/"))
    cursor = (cursor as Node | undefined)?.[segment];
  return resolveRef(document_, (cursor ?? {}) as Node);
}

/**
 * 按 WebUI 表单的同一套规则遍历 JSON Schema，对每个节点回调一次。
 * 只有带 properties 的 object 才继续向下遍历：`additionalProperties` 型的 record
 * （tools.overrides、byRole）与数组没有固定键，整块视为一个叶子。
 */
function walkSchema(
  document_: Node,
  visit: (path: string, raw: Node, leaf: boolean) => void,
): void {
  const step = (raw: Node, path: string): void => {
    const resolved = resolveRef(document_, raw);
    const branch = resolved.type === "object" && Boolean(resolved.properties);
    if (path) visit(path, raw, !branch);
    if (!branch) return;
    for (const [key, child] of Object.entries(resolved.properties as Node))
      step(child as Node, path ? `${path}.${key}` : key);
  };
  step(document_, "");
}

/** 表单会渲染成一格的那些路径。`tests/config.test.ts` 用它与 CONFIG_DESCRIPTIONS 比对。 */
export function configSchemaLeafPaths(
  document_: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  walkSchema(document_ as Node, (path, _raw, leaf) => {
    if (leaf) out.push(path);
  });
  return out;
}

/**
 * `configSchema` 的 JSON Schema，每个节点带上 `description`。
 *
 * 说明挂在原始节点上而非 `$ref` 指向的节点：zodToJsonSchema 对复用的 zod 实例生成 `$ref`，
 * 而 `quota.perChat.daily` 与 `quota.global.monthly` 指向同一个 `nullableMoney`。写入被指向的
 * 节点会导致两者互相覆盖。挂成 `$ref` 的兄弟键与 zodToJsonSchema 自身放置 `default` 的做法一致，
 * 消费端（SchemaForm）同样是先读原始节点再回退到解析后的节点。
 */
export function configJsonSchema(): Record<string, unknown> {
  const document_ = zodToJsonSchema(configSchema, "LuoLiConfig") as Node;
  walkSchema(document_, (path, raw) => {
    const description = CONFIG_DESCRIPTIONS[path];
    if (description) raw.description = description;
  });
  return document_;
}
