import { zodToJsonSchema } from 'zod-to-json-schema';
import { configSchema } from './schema.js';

/**
 * 每个配置键一行的作用说明。**这是说明文字的唯一来源**：`configJsonSchema()` 把它注入
 * `GET /api/config/schema` 返回的 JSON Schema，WebUI 的「全部配置」表单直接渲染 `description`
 * —— 前端不维护第二份清单，`config/config.schema.json` 也由同一个函数生成。
 *
 * 放在 schema.ts 之外而不是逐个 `.describe()`：一来那边是每行一个模块的密集写法，塞进 200 多段
 * 中文会彻底读不动；二来 `nullableMoney`、`role` 这些 zod 实例被多处复用，`.describe()` 挂上去
 * 会让 `quota.global.daily` 和 `quota.perUser.monthly` 共用同一句话。按点分路径给，才能一键一句。
 *
 * 说明写「这一项管什么、改了会怎样」，不写「热更新 / 未接线」—— 那两件事由徽标表达，
 * 抄进正文只会多一处会漂的副本。`tests/config.test.ts` 断言这里的键与 schema 叶子严格一一对应，
 * 新增配置项时会撞上它。
 */
export const CONFIG_DESCRIPTIONS: Record<string, string> = {
  general: '实例级的基本信息：名字、时区、维护窗口。',
  'general.name': '机器人对外显示的名字，用于日志与 WebUI 标题。',
  'general.timezone': '一切时间行为的基准时区（IANA 名，如 Asia/Shanghai）：配额的日/月账期何时翻篇、给模型看的时间戳都按它算。拼错的时区只会在群聊分支炸。',
  'general.maintenanceCron': '每日维护任务的 cron 表达式（清理过期数据、轮转日志、备份）。',
  'general.shutdown.graceMs': '收到停止信号后，留给在途轮次收尾的毫秒数；超时就强制退出。',

  telegram: '与 Telegram 服务端对接的方式：收哪些更新、发送速率、命令识别。',
  'telegram.mode': '怎么拿更新：polling 由本进程主动轮询（不需要公网地址），webhook 由 Telegram 回调（需要可访问的 https 地址）。',
  'telegram.dropPendingOnStart': '启动时是否丢弃离线期间堆积的更新。关着的话重启后会把积压的消息全部补跑一遍。',
  'telegram.allowedUpdates': '向 Telegram 声明只接收哪几类更新，一行一条。漏写一类，那类事件就永远收不到（例如去掉 message_reaction 后表情回应不再入库）。',
  'telegram.webhook.url': 'webhook 模式下告诉 Telegram 往哪儿回调的完整 https 地址。',
  'telegram.webhook.path': '本进程监听 webhook 回调的路径。',
  'telegram.webhook.secretToken': 'Telegram 回调时携带的密钥头，用来确认请求确实来自 Telegram 而不是别人伪造的。',
  'telegram.allowBots': '允许触发本 bot 的其他 bot 的 username 列表，一行一条。默认所有 bot 消息都不触发，免得两个 bot 互相接话刷屏。',
  'telegram.notifyEdits': '用户改过历史消息时，是否在下一轮的 RUNTIME 块里告诉模型「这条被编辑过」。',
  'telegram.strictCommandSuffix': '群里的斜杠命令是否必须写成 /cmd@botusername 才认。一个群里有多个 bot 时打开，否则谁都会抢同名命令。',
  'telegram.throttle.globalPerSecond': '全局发送速率上限（条/秒）。超出的请求排队而不是被丢弃，用来躲 Telegram 的 429。',
  'telegram.throttle.perChatPerMinute': '单个会话的发送速率上限（条/分钟）。',

  access: '谁能用这台 bot。有效角色 = min(用户角色, 会话角色)，两边任一为 blocked 就不回。',
  'access.defaultUserRole': '没在主体页登记过的用户拿到的角色。默认 blocked = 陌生人不能用，要逐个放行。',
  'access.defaultChatRole': '没登记过的群 / 频道拿到的角色。它与用户角色取更低的那个作为本轮的有效角色。',
  'access.archiveBlocked': 'blocked 主体的消息是否仍然入库归档（只存不回）。打开可以事后检索，代价是给不受信任的人留了写库入口。',
  'access.bootstrapOwnerId': '首次启动写进 principals 表的 owner 的 Telegram user id，通常由环境变量 LUOLI_OWNER_ID 提供。',

  trigger: '什么样的消息会开一轮对话。群里默认只在被点名时说话，其余消息作为背景旁听。',
  'trigger.private': '私聊里是否每条消息都触发回复。',
  'trigger.mention': '群里被 @ 到时是否触发。',
  'trigger.reply': '有人回复 bot 的某条消息时是否触发。',
  'trigger.command': '是否响应斜杠命令。',
  'trigger.channels': '是否响应频道消息（channel_post）。频道里没有「@ 谁」的概念，打开等于对每条频道消息都表态。',
  'trigger.wakewords': '群聊唤醒词，一行一条。普通字符串按「包含」匹配且忽略大小写（nori 同时匹配 Nori）；以 ^ 开头按正则处理，按你写的大小写求值，要忽略就写 ^(?i)nori（只扫消息前 4096 字符，过长或有回溯风险的正则会被静默跳过）。',
  'trigger.wakewordMinLength': '唤醒词的最短长度（按去掉前导 ^ 之后的字符数算）。短于它的整条忽略，避免单字满群误触发。',
  'trigger.requireTextAfterMention': '只 @ 了 bot 却没说别的内容时不触发。',
  'trigger.ignoreEditedAsTrigger': '用户编辑一条旧消息时，是否不重新开一轮。',
  'trigger.cooldownMsPerUser': '同一用户两次触发之间的最小间隔（毫秒），0 = 不限。',

  context: '每轮送进模型的对话历史怎么攒、怎么裁。改动前先读 docs/02-context-engine.md 的不变量清单。',
  'context.scope': '上下文按什么粒度分隔：chat = 整个会话共用一份历史，thread = 每个话题各一份。换过之后新 key 从空上下文开始，旧记录不会迁移。',
  'context.limit.tokens': '单轮送进模型的上下文 token 上限。超出后按 turn 边界推进窗口起点，裁掉最旧的整轮而不会切开一轮。',
  'context.limit.maxMessages': '上下文保留的消息条数上限，与 token 上限一起作为裁剪判据，先撞上哪个算哪个。',
  'context.limit.minKeepTurns': '裁剪时至少保留的最近轮次数，保证当前这段对话本身不会被裁没。',
  'context.active.windowMs': '活跃期长度：距上一轮提交多久之内算「对话还在进行」，期间即使超过上面的上限也不裁剪，让前缀缓存一直命中。每一轮都会顺延，安静满这么久之后的第一轮才裁。0 = 关闭。建议与 provider 的缓存有效期同量级（多数是 5 分钟 = 300000）。',
  'context.active.tokens': '活跃期内允许涨到的 token 天花板。撞到它照样裁剪，且一次裁回上面的 context.limit.tokens —— 只裁到天花板的话此后每一轮都要再裁一次，等于白推迟。',
  'context.active.maxMessages': '活跃期内允许涨到的消息条数天花板，与 token 天花板先撞上哪个算哪个。',
  'context.hardCapRatio': '轮内硬天花板 = 模型上下文窗口 × 该比例。撞顶后先降级工具调用参数、再降级工具结果，最后才做字符级硬截断。',
  'context.background.enabled': '群里没有触发 bot 的那些消息是否也作为背景发言进上下文，让 bot 听得懂「你们刚才在聊什么」。',
  'context.background.maxPerTurn': '一轮最多带多少条背景发言进上下文。',
  'context.background.showUsername': '背景发言前缀里是否附上 @用户名（数字 id 恒附，用户名可能重名或随时改）。',
  'context.background.showTime': '背景发言前缀里是否附上发言时间。',
  'context.background.includeNonText': '图片、文档之类的非文本背景消息是否以占位符形式进上下文。',
  'context.rebase.injectNotice': '上下文被 rebase（改写历史）之后，是否往会话里插一条可见的说明消息。',
  'context.rebase.markMeta': '是否在被 rebase 影响到的消息 meta 上打标记，WebUI 的上下文视图据此标红。',
  'context.cacheCommits': '物化后的上下文结果的 LRU 缓存容量（按 commit 数算）。调大省 CPU，代价是常驻内存。',
  'context.tokenRatioAlpha': 'token 估算校准的 EMA 系数：越大越快跟上上游报回来的真实用量，越小越平滑抗抖动。',

  concurrency: '同时能跑几个轮次、排多长的队、单轮多久算超时。',
  'concurrency.mode': 'parallel = 不同会话并行跑轮次；serial = 全局串行，出问题时的逃生舱。',
  'concurrency.perKey': '同一个会话最多同时跑几个轮次。必须 ≤ global，否则拒绝启动。',
  'concurrency.global': '全进程最多同时跑几个轮次。',
  'concurrency.queueMax': '并发满了之后还能排多少个轮次等位，再多的直接拒绝而不是无限堆积。',
  'concurrency.coalesceSameUserMs': '大于 0 时，把同一用户在这段时间内连着发的几条消息合并成一轮处理。',
  'concurrency.turnTimeoutMs': '单个轮次从开始到收尾的总超时（毫秒），到点强制取消。',

  cancel: '轮次被取消（用户打断 / 超时）时怎么收场。',
  'cancel.commitPartial': '取消时是否把已经生成的那半截回复提交进上下文。关着 = 当这一轮没发生过。',

  prompt: '系统提示词的组装预算。提示词页可以逐块预览实际产出。',
  'prompt.maxTokens': '系统提示词（人设、记忆、技能、运行时信息等 block 0–6）的总 token 上限，超出时按块的优先级裁。',
  'prompt.includeToolCatalog': '是否在系统提示词里再附一份工具清单（工具定义本身走 API 的 tools 字段，这是给模型的额外说明）。',
  'prompt.runtimeBlock.showQuota': 'RUNTIME 块里是否告诉模型当前配额用量，让它自己收着点。',
  'prompt.runtimeBlock.showContextWatermark': 'RUNTIME 块里是否告诉模型上下文水位，提示它「快满了，别再翻旧账」。',
  'prompt.runtimeBlock.showWorkspace': 'RUNTIME 块里是否告诉模型工作目录的路径。',

  memory: '长期记忆：写进 memory/ 下 Markdown 文件、每轮注入提示词的那部分。',
  'memory.dir': '长期记忆 Markdown 文件所在目录。',
  'memory.pubWriteMinRole': '允许写入公开记忆（同群共享）的最低角色。这是记忆污染的安全阀：会话级覆盖只能往更严格的方向改，往松了改会被校验器挡下。',
  'memory.pubWriteRequiresApproval': '公开记忆的写入是否要先经 owner 审批。多群部署建议打开。',
  'memory.softLimitTokens': '记忆文件超过这个 token 数就触发异步压缩。必须小于硬上限，否则拒绝启动。',
  'memory.hardLimitTokens': '记忆文件超过这个 token 数就直接拒绝再写，避免记忆把提示词预算吃光。',
  'memory.maxSections': '单个记忆文件允许的小节数上限。',
  'memory.compactCron': '记忆压缩任务的 cron 表达式。',
  'memory.autoApplyCompaction': '压缩结果是否自动生效。关着时压缩产物要 owner 在 WebUI 审阅后才落盘。',
  'memory.requireSourceTag': '写入记忆时是否强制带来源标注（谁、在哪条消息里说的），方便事后追责与撤销。',
  'memory.forgetMeRetentionDays': '用户请求「忘记我」之后，数据在被真正清除前还保留多少天（给误操作留后悔期）。',

  agent: '主 agent 与子 agent 的运行边界。子 agent 的具体定义在 Agent 页编辑。',
  'agent.main.modelAlias': '主 agent 用哪个模型别名。别名到具体模型的映射在模型页维护。',
  'agent.main.maxSteps': '主 agent 一轮最多走几步（一次模型调用 + 随之而来的工具执行算一步）。',
  'agent.main.downgradeAfterStep': '超过这个步数后自动降到 low 档模型，避免长循环按高档价格一直烧。',
  'agent.maxDepth': '子 agent 的最大嵌套深度，防止 agent 无限往下派生 agent。',
  'agent.maxConcurrentSubagents': '同时运行的子 agent 数上限。',
  'agent.maxSubagentsPerTurn': '单轮内允许派生的子 agent 总数。',
  'agent.askTimeoutMs': '子 agent 用 ask_parent 提问后，等待答复的超时（毫秒）。',
  'agent.maxAsksPerRun': '单次运行里 ask_parent 的调用次数上限，防止子 agent 一直反问而不干活。',
  'agent.askArbiter': '是否用 low 档模型自动仲裁 ask_parent 的提问，而不是每次都打断真人。',
  'agent.askEscalateToUser': '仲裁也答不上来时，是否把问题转给真人。',
  'agent.progressThrottleMs': '子 agent 向上回报进度的最小间隔（毫秒）。',
  'agent.agents': '子 agent 定义数组：名字、描述、模型别名、步数、最低角色、可用工具、指令。Agent 页有专用编辑器，在这里直接改 JSON 容易写坏结构。',

  provider: '上游模型服务的重试、超时、健康检查与模型元数据目录。API key 在模型页管理。',
  'provider.maxRetries': '上游请求失败后重试几次。',
  'provider.retryBaseMs': '重试退避的基准毫秒数（指数退避的起点）。',
  'provider.retryMaxMs': '重试退避的上限毫秒数，退避再久也不超过它。',
  'provider.healthCheckCron': 'provider 健康检查的 cron 表达式。',
  'provider.healthDownCooldownMinutes': '某个 provider 被判定不可用后，冷却多少分钟才重新尝试。',
  'provider.requestTimeoutMs': '单次上游尝试从发出请求到拿到响应头的超时（毫秒）。到点后只中止这一次尝试，重试与别名 fallback 照常走。',
  'provider.streamIdleTimeoutMs': '流式响应多久没有新数据就判定为卡死（毫秒）。整体超时管不了「连着但不吐字」这种情况。',
  'provider.allowPrivateBaseUrl': '允许 provider 连通性探测与模型目录访问私网地址和非常规端口。默认关着 —— 探测接口收的是请求体里的 baseUrl，开着等于把管理端变成一个带鉴权的 SSRF 代理。自建网关在内网时才打开。',
  'provider.catalog.enabled': '是否从 models.dev 拉取模型元数据（上下文窗口、价格、能力）。关掉之后拉取模型只剩上游 /models 给的那点信息，配额也就没法按价格算。',
  'provider.catalog.url': '模型元数据目录的地址。',
  'provider.catalog.cacheFile': '模型元数据的本地缓存文件路径；etag 与上次拉取时间记在 app_kv。',
  'provider.catalog.ttlHours': '缓存超过这个小时数才重新出网，且带 If-None-Match 条件请求（没变化时 304 只有几百字节）。',
  'provider.catalog.timeoutMs': '单次拉取目录的超时（毫秒）。失败时降级用旧缓存，而不是让模型页转圈。',

  tools: '工具层的总闸门：注册上限、单轮调用次数，以及各类工具各自的边界。逐个工具的启停在工具页。',
  'tools.maxRegistered': '能注册进工具表的工具数上限，超出的不下发给模型（模型的工具目录太长会显著变笨）。',
  'tools.maxCallsPerTurn': '单轮内工具调用次数上限。',
  'tools.maxConsecutiveErrors': '连续多少次工具报错就中止这一轮，防止模型对着同一个错误反复重试烧钱。',
  'tools.defaultTimeoutMs': '单次工具调用的默认墙钟上限（毫秒）。到点后把 tool_timeout 交回模型，让它换个做法，而不是让整轮对话挂在一个不返回的工具上。bash/python/spawn_agent 与两个 web 工具自己管超时，不受这一项约束。',
  'tools.overrides': '逐个工具的启停开关（键为工具名）。工具页有更好的入口 —— 那里改完这里会同步，禁用是硬边界：目录里看不到，模型硬猜工具名也会在 execute() 被拦下。',
  'tools.fs.maxReadBytes': 'read_file 单次读取的字节上限，超出截断。',
  'tools.fs.maxWriteBytes': 'write_file 单次写入的字节上限。',
  'tools.fs.showHidden': 'list_dir 是否列出以点开头的隐藏文件。',
  'tools.fs.allowHostFsForOwner': '允许 owner 的文件工具越过沙箱直接读写宿主文件系统。★ 危险：等于把宿主的文件系统交给模型，只在你完全清楚代价时打开。',
  'tools.fs.denyGlobs': '文件工具一律拒绝访问的 glob 列表，一行一条；<root> 指仓库根。密钥、私钥、数据库与配置目录默认在内，删条目等于放开对应的读写。',
  'tools.fs.trashDir': 'delete_file 的软删目录 —— 文件挪进去而不是真删，便于事后找回。',
  'tools.fs.backupDir': '覆盖写之前把原文件备份到哪个目录。',
  'tools.exec.defaultTimeoutMs': 'bash / python 没指定超时时用的默认超时（毫秒）。',
  'tools.exec.maxTimeoutMs': '调用方能请求的最大执行超时（毫秒），模型要得再多也封顶在这里。',
  'tools.exec.maxOutputBytes': '单次执行捕获的输出字节上限，超出部分截断后告知模型。',
  'tools.archive.defaultSearchLimit': '检索历史消息时不指定条数则返回多少条。',
  'tools.archive.maxSearchLimit': '检索历史消息允许请求的最大条数。',
  'tools.archive.defaultReadLimit': '读取历史消息时不指定条数则返回多少条。',
  'tools.archive.maxReadLimit': '读取历史消息允许请求的最大条数。',
  'tools.tg.maxExtraMessagesPerTurn': '一轮内 send_message / send_photo / send_file 的调用上限（正常回复不计入）。挡的是模型自己给自己加戏刷屏。',
  'tools.tg.maxFileSendMb': 'send_file / send_photo 单个文件的大小上限（MB）。',
  'tools.web.maxResponseBytes': 'web_fetch 单次抓取的响应字节上限。',
  'tools.web.timeoutMs': 'web_fetch / web_search 单次尝试的超时（毫秒）。没有它时黑洞地址会一直挂着，整轮对话跟着卡死。',
  'tools.web.retries': 'web_fetch / web_search 遇到瞬时失败（超时、5xx、429）时的重试次数。耗尽后把失败结果交给模型，由它决定换 URL 还是如实告诉用户。',
  'tools.web.summarizeWithAlias': 'web_fetch 抓回的长网页用哪个模型别名做摘要。',
  'tools.web.allowlist': 'web_fetch 的域名白名单，一行一条。留空时 limited 角色用不了 web_fetch。',
  'tools.web.denylist': 'web_fetch 的域名黑名单，一行一条。内网后缀默认在内。',
  'tools.web.searchProvider': 'web_search 走哪家搜索 API。留空则根本不注册 web_search 这个工具。',
  'tools.web.searchApiKey': '搜索 API 的密钥。★ 与 provider key 不同，它明文存在配置里，建议写成 ${env:BRAVE_API_KEY} 这样的环境变量引用而不是直接落库。',

  sandbox: '执行类工具（bash / python）跑在哪儿。工具页有沙箱卡片，还能探测当前是否真的可用。',
  'sandbox.mode': '执行类工具的隔离方式：none 直接在宿主跑（危险）、jail 只做路径隔离、docker 每次起一次性容器。',
  'sandbox.bypassRoles': '哪些角色不受沙箱约束、直接在宿主上执行。★ 写进这个名单的人等于拿到了宿主 shell。',
  'sandbox.image': 'docker 模式使用的镜像。',
  'sandbox.network': '沙箱容器的网络：none 断网，bridge 可出网。',
  'sandbox.memoryMb': '沙箱容器的内存上限（MB）。',
  'sandbox.cpus': '沙箱容器的 CPU 配额（核数，可以是小数）。',
  'sandbox.pidsLimit': '沙箱能额外开多少进程，用来挡 fork 炸弹。docker 模式是容器的 --pids-limit；jail 模式按「当前系统占用 + 这个数」折算成 ulimit -u。owner 等 bypassRoles 角色不受它约束。',
  'sandbox.readOnlyRoot': '容器根文件系统是否只读（只有工作目录与 tmpfs 可写）。',
  'sandbox.tmpfsMb': '挂给容器的 tmpfs 大小（MB）。',
  'sandbox.workspaceDir': '工作目录（本进程视角）。每个会话在它下面有自己的子目录，文件工具与执行工具都只在这里活动。',
  'sandbox.hostWorkspaceDir': '同一个工作目录在宿主上的路径。只有「应用自己跑在容器里 + docker 模式」时才需要填 —— docker run -v 的左半边由宿主解析，填错不会报错，只会在宿主上默默建一个空目录。',
  'sandbox.dockerBin': 'docker 可执行文件的名字或绝对路径。',

  approval: '高风险工具调用挂起等人裁决。规则命中即挂起，裁决在「任务与审批」页做。',
  'approval.enabled': '高风险工具调用是否需要人在 WebUI 里批准后才执行。',
  'approval.ttlMs': '一条审批请求等待裁决的上限（毫秒）。到点作废，并把「未获批准」作为工具结果还给模型。',
  'approval.skipForOwner': 'owner 自己触发的调用是否免审批。',
  'approval.rememberWithinTurn': '同一轮内批准过的同类调用是否不再重复问。',
  'approval.rules': '审批规则数组：按工具名、正则、风险级别匹配，命中任一条就挂起等裁决。正则用 RE2 求值，写不出回溯炸弹。',

  output: '一条回复怎么送出去。会话级覆盖（perChat）优先于这里的全局值。',
  'output.mode': 'stream = 边生成边编辑同一条消息；once = 整段生成完一次性发出。',
  'output.replyDelayMs': '从用户那条消息到达算起，至少等这么久才发第一条回复（防秒回）。模型本来就想了这么久时不再额外压时间，0 = 立刻回。',
  'output.streamBufferMs': '从上游第一个 chunk 到达算起，再攒这么久才发第一条。窗口内的文本只攒不丢；流在窗口内就结束则立刻发出。设成 0 会退回「先蹦一个字、剩下靠编辑补」的观感。',
  'output.streamIntervalMs': '两次消息编辑之间的最小间隔（毫秒）。首条发出也算一次刷新。',
  'output.streamMinDeltaChars': '与编辑间隔**同时满足**才编辑：到点了但只多出两三个字就先不动，免得撞 Telegram 的编辑频率限制。收尾那次编辑不受这两项约束。',
  'output.flushOnSentence': '是否优先在句子边界处刷新，避免把一句话切在半截。',
  'output.maxMessageChars': '单条消息的字符上限，超出拆成多条（Telegram 硬限是 4096）。',
  'output.parseMode': '发送时按哪种格式解析：MarkdownV2 / HTML / none。',
  'output.typingWhileWorking': '生成期间是否持续发送「正在输入」状态。',
  'output.placeholderAfterMs': '超过这么久还没有内容可发时，先发一条占位消息，免得看起来像没反应。',
  'output.placeholderTexts': '占位消息的备选文案，一行一条。**留空 = 不发占位消息** —— placeholderAfterMs 填不了 0，这是关掉它的唯一途径。',
  'output.placeholderPick': 'random = 每次从备选里随机挑一条；fixed = 恒用 placeholderIndex 指的那条。备选只有一条时两者没区别。',
  'output.placeholderIndex': 'fixed 模式下用第几条，0 起，按**去掉空行后**的列表算。越界时回落到第一条。',
  'output.maxMentions': '单条回复里最多 @ 几个人，防止模型把整群都点一遍。',

  media: '图片与文件的下载、缩放与文本抽取。',
  'media.dir': '下载下来的图片与文件的存放目录。',
  'media.maxImageBytes': '单张图片允许下载的字节上限。',
  'media.maxDocBytes': '单个文档允许下载的字节上限。',
  'media.maxImageEdge': '送进模型前把图片最长边缩到这个像素数。图片按面积计费，缩一半省一大半 token。',
  'media.maxImagesPerTurn': '单轮最多带几张图片给模型。',
  'media.groupDebounceMs': '相册（一次发多张）的合并等待窗口（毫秒），等齐了当一组处理而不是逐张开轮。',
  'media.stickerAsImage': '是否把贴纸当图片送给模型看。',
  'media.downloadVoice': '是否下载语音消息。只存盘，不做语音转文字。',
  'media.extract.enabled': '是否从 PDF / Word 等文档里抽取文本给模型。',
  'media.extract.maxChars': '单个文档抽取的字符上限。',
  'media.extract.inlineChars': '直接内联进上下文的字符数。超出的部分只给前 N 字，并提示模型用 read_file 自己去读全文。',
  'media.extract.codeExtensions': '按纯文本抽取的代码文件扩展名，一行一条。',

  skills: '技能：skills 目录下的 Markdown 能力包，按需注入提示词。',
  'skills.enabled': '技能总开关。',
  'skills.dir': '技能文件所在目录。',
  'skills.watch': '是否监视技能目录，改完文件不重启就生效。',
  'skills.defaultMinRole': '在 WebUI 新建技能时没显式选角色则用它。',

  plugins: '插件：本地 JS 钩子，能在轮次生命周期上挂逻辑。',
  'plugins.enabled': '插件总开关。',
  'plugins.dir': '插件所在目录。',
  'plugins.watch': '是否监视插件目录热重载。',
  'plugins.hookTimeoutMs': '单个插件钩子的执行超时（毫秒），超时按失败计。',
  'plugins.order': '插件执行顺序（按插件名排），一行一条；决定钩子的调用先后。',
  'plugins.autoDisableAfterErrors': '连续报错多少次就自动停用该插件，免得一个坏插件拖垮每一轮。',

  mcp: 'MCP：把外部 MCP server 的工具接进工具表。具体 server 在扩展页编辑。',
  'mcp.enabled': 'MCP 总开关，出厂关着。关着时 servers 里配了多少个都不会连。',
  'mcp.connectTimeoutMs': '连接单个 MCP server 的超时（毫秒）。',
  'mcp.healthCheckCron': 'MCP 连接健康检查的 cron 表达式。',
  'mcp.defaultMinRole': 'MCP 工具在没单独指定时的最低可用角色。',
  'mcp.servers': 'MCP server 定义数组：stdio（命令 + 参数 + 环境变量）或 http（地址 + 请求头）传输，各带工具黑白名单。扩展页有专用编辑器。',

  schedule: '定时任务：模型自己用 schedule_create 排的周期/一次性任务。触发时按 mode 起一轮完整对话（agent）或只发一句预写文本（notify），产出照常进这个会话的上下文。',
  'schedule.enabled': '定时任务总开关。关掉之后已有任务留在库里但不再触发（每次跳过记一条 schedule.skipped），不会被删。',
  'schedule.maxPerChat': '单个会话最多同时有多少个活跃任务。超了 schedule_create 直接拒绝 —— 一个会话攒上几十个 agent 模式的任务等于让 bot 自己刷屏并烧钱。',
  'schedule.minIntervalMinutes': 'cron 任务两次触发之间的最小间隔（分钟）。cron 最细能到每分钟，而 agent 模式下那就是每分钟一次真实模型调用。',
  'schedule.maxPayloadChars': '任务正文（agent 的任务描述 / notify 的原文）的字数上限。',
  'schedule.retentionDays': '已结束（完成/取消）的任务行保留多少天。活跃任务永不清理。需重启：跟 logs.retentionDays 一样在启动时交给 MaintenanceService。',

  db: 'SQLite 数据库的位置、备份与整理。',
  'db.path': 'SQLite 数据库文件路径。',
  'db.backupKeep': '执行迁移前自动备份，保留最近几份。',
  'db.vacuumCron': 'VACUUM 整理任务的 cron 表达式。',
  'db.ftsTokenizer': '全文检索的分词器：trigram 对中文友好，unicode61 更省空间。改了要重建索引，已有数据不会自动迁移。',

  logs: '日志级别、留存与请求载荷抓取。日志页读的就是这些文件。',
  'logs.level': '日志级别，低于它的不记录。',
  'logs.dir': '日志文件目录。',
  'logs.captureBodies': '是否把发给上游的请求体与响应体存盘。排障时最有用的就是它 —— 关掉之后对话详情里看不到实际发出去的载荷。',
  'logs.bodyMaxBytes': '单条载荷存盘的字节上限，超出截断。',
  'logs.maxFileMb': '单个日志文件的大小上限（MB），超出轮转。',
  'logs.retentionDays': '日志保留天数，超期删除。',
  'logs.gzipAfterDays': '日志文件多少天之后压缩存放。',
  'logs.console': '控制台输出格式：pretty 给人看、json 给采集器看、off 不输出。',
  'logs.redactPatterns': '额外的脱敏正则，一行一条。bot token 与 master key 已经默认脱敏，这里加的是你自己的密钥形态。',

  quota: '花费与频率的硬闸门。配额页有专用面板，还能看实时计数器。',
  'quota.enabled': '花费配额总开关。关掉之后不再拦截，但用量仍然照常记账。',
  'quota.requirePricing': '模型没有价格数据时是否拒绝调用。关掉等于放行无法计价的模型，那部分花费在配额里是漏算的。',
  'quota.minReserveUsd': '每轮开始前预扣的最小金额（美元），防止多个并发轮次同时挤过同一条额度线。',
  'quota.global.daily': '全局每日花费上限（美元），留空 = 不限。',
  'quota.global.monthly': '全局每月花费上限（美元），留空 = 不限。',
  'quota.perChat.daily': '单个会话的每日花费上限（美元），留空 = 不限。',
  'quota.perChat.monthly': '单个会话的每月花费上限（美元），留空 = 不限。',
  'quota.perUser.daily': '单个用户的每日花费上限（美元），留空 = 不限。',
  'quota.perUser.monthly': '单个用户的每月花费上限（美元），留空 = 不限。',
  'quota.perUser.byRole': '按角色覆盖单用户额度，形如 {"trusted":{"daily":2}}。配额页有专用面板，不用在这里手写 JSON。',
  'quota.perTurn.maxCostUsd': '单轮花费上限（美元），超出中止这一轮。',
  'quota.perTurn.maxSteps': '单轮步数上限，与 agent.main.maxSteps 取更严的那个。',
  'quota.rateLimit.turnsPerUserPerHour': '单个用户每小时可触发的轮次数。',
  'quota.rateLimit.turnsPerChatPerHour': '单个会话每小时可触发的轮次数。',
  'quota.rateLimit.concurrentPerUser': '单个用户同时进行中的轮次数上限。',
  'quota.onExceeded.reply': '超额时是回一条消息说明，还是干脆静默不理。',
  'quota.onExceeded.message': '超额回复的文案。{spent} / {limit} / {resetAt} 会被替换成实际数值。',
  'quota.onExceeded.notifyOwner': '超额时是否私信通知 owner。',
  'quota.warnAtRatio': '用量达到额度的这个比例时发出预警（0.8 = 用掉八成就提醒）。',

  webui: '控制台自身的监听地址、登录与反代设置。',
  'webui.enabled': 'WebUI 控制台总开关。',
  'webui.host': 'WebUI 监听地址。默认 127.0.0.1 只有本机连得上；改成对外地址必须先设好登录口令，否则拒绝启动。',
  'webui.port': 'WebUI 监听端口。',
  'webui.basePath': '反代到子路径时的前缀，如 /luoli。',
  'webui.publicUrl': '对外可访问的完整地址，用于生成 /webui 一次性登录链接。',
  'webui.sessionTtlHours': '登录会话的有效小时数，过期要重新输口令。',
  'webui.passwordHash': '登录口令的 argon2id 哈希。不在这里改：用 pnpm webui:passwd 生成后写入，或首次启动时由 WEBUI_PASSWORD 环境变量生成。',
  'webui.trustProxy': '是否信任反代传来的 X-Forwarded-For 作为客户端 IP。直连时必须关着，否则任何人伪造一个头就换了个身份，登录限速形同虚设。',
  'webui.trustedProxyHops': '反代自己追加的跳数。X-Forwarded-For 按这个数**从右往左**取 —— 取最左那一跳等于让客户端自己声明自己是谁。直连或 trustProxy 关着时读 X-Real-IP，再没有就记为 direct。',
  'webui.allowOrigins': '允许跨源访问 API 的 Origin 列表，一行一条（本机用 vite 开发时把 dev 地址加进来，否则登录会被 Origin 中间件挡成 403）。',
  'webui.loginRateLimit.attempts': '单个 IP 在窗口内允许的登录失败次数。',
  'webui.loginRateLimit.windowMinutes': '登录失败计数的窗口长度（分钟）。',

  alerts: '出事时怎么通知人。',
  'alerts.notifyOwner': '告警是否私信 owner。',
  'alerts.dedupeMinutes': '同类告警在这段时间内只发一次（分钟），避免一个故障刷屏。',
  'alerts.webhookUrl': '告警额外推送到的 webhook 地址。',
  'alerts.on': '哪些事件算告警，一行一条，如 quota_global_exceeded、all_providers_down。',

  perChat: '会话级配置覆盖层（键为 context key），不是一个能直接编辑的配置项 —— 它的入口在会话页，且只放行白名单内的路径。',
};

type Node = Record<string, unknown>;

function resolveRef(document_: Node, node: Node): Node {
  const reference = node.$ref;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return node;
  let cursor: unknown = document_;
  for (const segment of reference.slice(2).split('/')) cursor = (cursor as Node | undefined)?.[segment];
  return resolveRef(document_, (cursor ?? {}) as Node);
}

/**
 * 按 WebUI 表单的同一套规则走一遍 JSON Schema，对每个节点回调一次。
 * 只有「带 properties 的 object」才继续往下走 —— `additionalProperties` 型的 record
 * （tools.overrides、byRole）和数组没有固定键，整块当一个叶子。
 */
function walkSchema(document_: Node, visit: (path: string, raw: Node, leaf: boolean) => void): void {
  const step = (raw: Node, path: string): void => {
    const resolved = resolveRef(document_, raw);
    const branch = resolved.type === 'object' && Boolean(resolved.properties);
    if (path) visit(path, raw, !branch);
    if (!branch) return;
    for (const [key, child] of Object.entries(resolved.properties as Node)) step(child as Node, path ? `${path}.${key}` : key);
  };
  step(document_, '');
}

/** 表单会渲染成一格的那些路径。`tests/config.test.ts` 拿它跟 CONFIG_DESCRIPTIONS 对表。 */
export function configSchemaLeafPaths(document_: Record<string, unknown>): string[] {
  const out: string[] = [];
  walkSchema(document_ as Node, (path, _raw, leaf) => { if (leaf) out.push(path); });
  return out;
}

/**
 * `configSchema` 的 JSON Schema，每个节点带上 `description`。
 *
 * 说明挂在**原始节点**上而不是 `$ref` 指向的那个：zodToJsonSchema 对复用的 zod 实例发 `$ref`，
 * 而 `quota.perChat.daily` 与 `quota.global.monthly` 指的是同一个 `nullableMoney`。写进被指向的
 * 节点会让它们互相覆盖。挂成 `$ref` 的兄弟键与 zodToJsonSchema 自己安置 `default` 的做法一致，
 * 消费端（SchemaForm）也是先读原始节点再回退到解析后的节点。
 */
export function configJsonSchema(): Record<string, unknown> {
  const document_ = zodToJsonSchema(configSchema, 'LuoLiConfig') as Node;
  walkSchema(document_, (path, raw) => {
    const description = CONFIG_DESCRIPTIONS[path];
    if (description) raw.description = description;
  });
  return document_;
}
