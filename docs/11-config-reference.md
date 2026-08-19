# 11 · 配置参考

配置有三个来源，优先级 **环境变量 > `config_kv`(WebUI 写入) > `config/config.yaml` > 代码内默认值**。

- 全部配置由 `packages/core/config` 的 zod schema 定义，`config.schema.json` 由它生成，WebUI 表单也由它生成 —— **单一数据源**。
- **每一项的作用说明**（WebUI「全部配置」逐格显示的那句话）住在
  `packages/core/src/config/descriptions.ts` 的 `CONFIG_DESCRIPTIONS`：点分路径 → 一句话，
  由 `configJsonSchema()` 注入生成出的 JSON Schema 的 `description`。`GET /api/config/schema` 与
  `pnpm config:schema` 走同一个函数，所以界面上看到的和仓库里那份文件永远是同一批说明。
  没有逐个写 `.describe()` 是因为 `role`、`nullableMoney` 这些 zod 实例被多处复用，挂上去会让
  `quota.global.daily` 和 `quota.perUser.monthly` 共用同一句话。`tests/config.test.ts` 断言这张表与
  schema 叶子**严格一一对应**：新增配置项时必须顺手写一句，删配置项时残留的说明也会被点名。
  本文件仍是唯一的完整参考（含热更新判定、校验规则、`perChat` 白名单）；`CONFIG_DESCRIPTIONS`
  是它在界面上的一句话摘要，两者的分工是「手册 vs. 控件旁边的提示」，不是两份清单。
- 启动时校验；校验失败**拒绝启动**并打印具体路径与原因。
- 热更新：标 `热更新` 的项保存后立即生效（下一个 turn）；标 `需重启` 的项保存后 WebUI 显示待重启徽标。
  判据是**运行时读的是 getter（`configStore.snapshot()` / `turn.config` / bot 的 config Proxy）而不是启动时那份快照**；
  白名单是 `HOT_RELOADABLE_CONFIG_KEYS`（`packages/core/src/config/schema.ts`），`GET /api/config/schema`
  以 `hotReloadable` 一并返回，`tests/config.test.ts` 断言本文件里标 `热更新` 的每个键都在白名单内。
  上一轮有十组键标着热更新而实际冻在启动时，其中 `sandbox.mode`、`approval.enabled`、`approval.rules`
  三组是「出事时运维会去点的那个开关」—— 点了没用而界面还说成功（[20 · W-CFG-02](./reviews/20-review-round5.md)）。
  设置页的「全部配置」表单覆盖全部已接线叶子（热更新与需重启都能改），徽标直接照 `hotReloadable`
  打，保存后的 Toast 会点名其中需重启的那几项；新增可编辑项时按 `hotReloadable` 判定。
- **被环境变量钉住的键**（`ENV_PINNED_CONFIG_KEYS`）：env 层在 `config_kv` 之后合并，所以这些键的
  覆盖行注定无效。`GET /api/config/schema` 以 `envPinned` 返回当前真的被钉住的那几条，表单据此
  禁用控件并点名该改哪个变量，写入端一律 400（`config_pinned_by_env`）——「保存成功但运行时没变」
  是最误导的一类反馈（[21 · G-CFG-03](./21-webui-coverage-gaps.md)）。清单：
  `db.path`←`LUOLI_DATA_DIR` · `access.bootstrapOwnerId`←`LUOLI_OWNER_ID`（必填，所以恒被钉住）
  · `sandbox.hostWorkspaceDir`←`LUOLI_HOST_WORKSPACE_DIR` · `webui.host`←`LUOLI_WEBUI_HOST`
  · `webui.passwordHash`←`WEBUI_PASSWORD`。后两条由 `apps/bot` 的 `envOverlay` 叠（口令要先过 argon2）。

## 1. 环境变量（`.env`）

`.env` 由 `pnpm dev` / `pnpm start` / `pnpm db:migrate` 经 node 的 `--env-file-if-exists=.env` 加载，
生产走 `docker-compose.yml` 的 `env_file`。**已存在于 shell 里的同名变量优先**，`.env` 不会覆盖它们。

| 变量 | 必需 | 说明 |
|---|---|---|
| `BOT_TOKEN` | ✓ | Telegram Bot token |
| `LUOLI_OWNER_ID` | ✓ | owner 的 Telegram user id（首次启动写入 `principals`）。缺失则拒绝启动 |
| `LUOLI_MASTER_KEY` | ✓ | 32+ 字节随机串，用于加密 provider API key。缺失则 provider 功能禁用 |
| `WEBUI_PASSWORD` | ✗ | 用它生成 `webui.passwordHash`。**不只是首次启动**：`envOverlay` 每次启动都会叠一遍，所以只要它还在环境里，口令就由它钉住 —— 设置页的改口令表单会直接 409（改了重启就回退），要换口令得改这个变量。配好之后删掉它，口令才回到 `config_kv` 管 |
| `LUOLI_CONFIG` | ✗ | 配置文件路径，默认 `./config/config.yaml` |
| `LUOLI_DATA_DIR` | ✗ | 数据目录，默认 `./data` |
| `LUOLI_HOST_WORKSPACE_DIR` | ✗ | 映射到 `sandbox.hostWorkspaceDir`。**应用跑在容器里且 `sandbox.mode: docker` 时必填**，见 [§2 sandbox](#sandbox) |
| `DOCKER_GID` | ✗ | 只被 `docker-compose.yml` 的 `group_add` 消费（不进配置）。容器以非 root 跑，不加入宿主 docker 组就读不到挂进来的 `/var/run/docker.sock`。取值 `stat -c '%g' /var/run/docker.sock`；不用 docker 沙箱时填 `0`。未设置时 compose 直接拒绝启动而不是让沙箱在运行时静默失效 |
| `TZ` | ✗ | 建议显式设置，如 `Asia/Shanghai` |
| `NODE_ENV` | ✗ | `production` 时关闭 pretty 日志与 dev 代理 |
| 其他 `${env:X}` 引用 | ✗ | 配置里的 `${env:NAME}` 会在加载时替换（用于 MCP headers 等） |

`.env.example`：

```dotenv
BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LUOLI_OWNER_ID=8899001
LUOLI_MASTER_KEY=change-me-to-32-bytes-of-random-data
WEBUI_PASSWORD=change-me
TZ=Asia/Shanghai
NODE_ENV=production
```

---

## 2. `config/config.yaml` 全量参考

> `🚧 未实现` 表示该键仍由 schema 接受，便于未来兼容，但当前运行时不会读取；WebUI 必须置灰，不能宣称保存后生效。显式白名单由 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 维护，测试要求这里逐项列出。

### 2.0 第五轮摘除的键

以下 5 个键已**从 schema 删除**，不再是「未实现」而是「不存在」。留着它们的代价是运维在一个
永远不生效的格子里改东西，或者在两个同义键里改错那一个：

| 键 | 摘除理由 | 想要这件事的话改哪儿 |
|---|---|---|
| `general.locale` | i18n 在 [14 §4](./14-open-questions.md) 明确「第一版不做」，运行时从不读它 | 真做 i18n 时与 `webui/src/i18n` 一起加回来 |
| `approval.allowInitiator` | WebUI 只有一个 owner 身份（[14](./14-open-questions.md) A15），裁决权下放不到发起人，当前架构里没有能实现它的落点 | 先答 [14 §2](./14-open-questions.md) Q7（WebUI 多用户） |
| `quota.perTurn.maxToolCalls` | 真正生效的是 `tools.maxCallsPerTurn` | `tools.maxCallsPerTurn` |
| `quota.perTurn.maxSubagents` | 真正生效的是 `agent.maxSubagentsPerTurn` | `agent.maxSubagentsPerTurn` |
| `quota.perTurn.maxDurationMs` | 真正生效的是 `concurrency.turnTimeoutMs` | `concurrency.turnTimeoutMs` |

**升级不会卡住**：顶层 config schema 不带 `.strict()`，老 `config.yaml` 里残留这些键会被 zod
静默剥掉；`config_kv` 里的残留行由 `loadConfig` 的 `onInvalidOverride` 逐条剔除并告警。

### 2.0.1 未实现键白名单

当前白名单。**每一行都以 🚧 起头，测试 `config.test.ts` 要求白名单里的每个键都能在本文件里找到一行同时含该键与 🚧**，否则视为文档未同步。第五轮把这张表从 65 条压到 13 条；[14 §2](./14-open-questions.md) 全部答复之后（2026-08-18）又降到 **10 条** —— `agent.askArbiter` / `agent.askTimeoutMs` 随 A7 接线，`db.ftsTokenizer` 随 Q3 直接从 schema 摘除，而 `agent.askEscalateToUser` 留下（原因见下）。**剩下的每一条都写明为什么留着** —— 「暂时没做」和「做不了 / 不该在这一层做」是两回事：

| 🚧 键 | 为什么还没接 |
|---|---|
| 🚧 `telegram.webhook.url` · `telegram.webhook.path` · `telegram.webhook.secretToken` | webhook 模式整体没实现。`main.ts` 在 `mode !== 'polling'` 时**显式抛错**，不会出现「配成 webhook 后静默收不到消息」 |
| 🚧 `telegram.notifyEdits` | 要把「上一轮之后有哪些编辑」带进 RUNTIME 块，得给 `RuntimeTurnContext` 加一块会话级瞬时状态 —— 那是上下文引擎的表面 |
| 🚧 `trigger.ignoreEditedAsTrigger` | 先要定「编辑触发的那一轮与原轮次什么关系」：重开一轮还是改写历史，两种都会动到 rebase 与认领水位。[14 §2](./14-open-questions.md) 那一轮**没有覆盖这一条** —— 它不在 Q1–Q12 里 |
| 🚧 `memory.autoApplyCompaction` | **记忆压缩本身没实现**（`compactCron` 只统计超过软上限的文档数）。给一个不存在的产物配「是否自动应用」是假开关 |
| 🚧 `agent.askEscalateToUser` | 转人工要一条**阻塞式人机通道**：在 Telegram 发一条带 inline 选项的消息、等人点、把结果回灌给正在等的那个子 agent。那条通道整体不存在（同一个缺口也挡着 inline keyboard 审批，`docs/25 §8`）。仲裁本身（`agent.askArbiter` + `askTimeoutMs`）已接线；这个键为真时仲裁失败只会多记一条 `agent.ask_unarbitrated` warn（带 `escalationRequested: true`），**不会真的去问人** |
| 🚧 `tools.web.summarizeWithAlias` | 要在 `web_fetch` 里插一次模型调用：计费、配额、取消、失败降级都得跟着走一遍。**A7 的仲裁调用已经趟过同一条路**（见 `agent/ask-arbiter.ts`），要接的话照那个形状抄 |
| 🚧 `media.groupDebounceMs` | 相册合并要按 `media_group_id` 在触发路径上缓冲 update，与并发和认领水位有交互（`concurrency.coalesceSameUserMs` 做的是按人合并） |
| 🚧 `webui.basePath` | 子路径挂载：要给所有路由加前缀、改静态资源 base、改 SPA 的 router base，三处一起动 |

```yaml
# ============================================================ general
general:
  name: 洛璃                      # 热更新 · WebUI 品牌位与标签页标题；启动日志那一行是启动时盖的章
  timezone: Asia/Shanghai         # 需重启 · 影响配额 bucket 与时间渲染
  maintenanceCron: '0 4 * * *'    # 需重启 · 每日维护任务
  shutdown:
    graceMs: 30000                # 需重启

# ============================================================ telegram
telegram:
  mode: polling                   # 需重启 · polling | webhook
  dropPendingOnStart: false       # 需重启
  allowedUpdates:                 # 需重启
    [message, edited_message, callback_query, my_chat_member, message_reaction]
  webhook:
    url: ''                       # 需重启 · https://example.com/webhook/telegram
    path: /webhook/telegram
    secretToken: ''
  allowBots: []                   # 热更新 · 允许触发的 bot username 列表
  notifyEdits: true               # 热更新 · 消息被编辑时在下一轮 RUNTIME 提示
  strictCommandSuffix: false      # 热更新 · 群内命令是否必须带 @botusername
  throttle:
    globalPerSecond: 30           # 需重启
    perChatPerMinute: 20

# ============================================================ access（权限，D9）
access:
  defaultUserRole: blocked        # 热更新 · owner|trusted|limited|blocked
  defaultChatRole: blocked        # 热更新
  archiveBlocked: false           # 热更新 · blocked 主体的消息是否仍入库
  bootstrapOwnerId: ''            # 需重启 · 通常由 LUOLI_OWNER_ID 提供

# ============================================================ trigger（D5）
trigger:
  private: true                   # 热更新
  mention: true
  reply: true
  command: true
  channels: false                 # 热更新 · 是否响应 channel_post
  wakewords: ['洛璃']              # 热更新 · 字符串=包含匹配（忽略大小写）；以 ^ 开头=正则（见下方可用性规则）
  wakewordMinLength: 2
  requireTextAfterMention: false
  ignoreEditedAsTrigger: true
  cooldownMsPerUser: 0            # 热更新 · >0 时同一个人在窗口内只开第一轮，其余降级成背景消息

# 唤醒词可用性（checkWakeword，运行时匹配与 WebUI 写入端共用一份）：
#   · 去掉前导 ^ 后短于 wakewordMinLength → 整条跳过
#   · 包含型（不以 ^ 开头）忽略大小写：'nori' 同时匹配 Nori / NORI —— 手机输入法会自动大写句首，
#     大小写敏感等于让唤醒词只在特定拼写下生效，用户只看到「bot 时灵时不灵」
#   · 正则型按作者写的大小写求值，要忽略大小写自己写 '^(?i)nori'（RE2 支持内联标志）
#   · 判成正则的前缀有两种：'^' 与 '(?i)' 这类内联标志组 —— 后者是写「不敏感正则」最自然的拼法，
#     当成包含匹配的话用户拿到的是一个永远匹配不上、面板还标着「包含」的模式
#   · 以 ^ 开头按正则处理（u 标志，只扫描消息前 4096 字符）；正则超 128 字符、含嵌套量词
#     / 反向引用 / lookahead / lookbehind 的一律不求值直接跳过（ReDoS 防线）
#   · 被跳过是静默的，因此启动时以 config.invalid 告警列出；WebUI 与 API 写入时直接 400 拒绝
#   · 会话级 trigger 覆盖整体替换全局同名字段，且在触发判定时就已生效（[08 §4]）

# ============================================================ context（D1–D4, D6, D8）
context:
  scope: chat                     # 需重启* · chat | thread（*切换后新 key 从空上下文开始）
  limit:
    tokens: 32000                 # 热更新 · 单轮次上下文上限（轮后裁剪判定，D3/D4）
    maxMessages: 200              # 热更新 · 消息条数上限（副阈值）
    minKeepTurns: 1               # 热更新 · 裁剪时至少保留的最近轮次数
  active:                         # 活跃期：把裁剪推迟到缓存本来就已过期的时刻（02 §5.1.1）
    windowMs: 0                   # 热更新 · 距上一轮提交多久之内算「仍在活跃期」；0 = 关闭（滑动窗口，每轮顺延）
    tokens: 128000                # 热更新 · 活跃期内允许涨到的 token 天花板（撞到就裁回 limit.tokens）
    maxMessages: 1000             # 热更新 · 活跃期内允许涨到的条数天花板（撞到就裁回 limit.maxMessages）
  hardCapRatio: 0.85              # 热更新 · 轮内硬天花板 = 模型窗口 × 该比例
  background:                     # D6：未触发的群消息进入上下文
    enabled: true                 # 热更新
    maxPerTurn: 20                # 热更新 · ★ 需求方明确要求可配置
    showUsername: true            # 热更新 · 群聊前缀里附 `@用户名`；id 恒附（02 §4.3）
    showTime: true                # 热更新 · 关掉后前缀收成 [名字]
    includeNonText: true          # 热更新 · 关掉后纯图片/文件的背景发言不进上下文（触发与被回复的不受管）
  rebase:                         # D1
    injectNotice: false           # 热更新 · rebase 时是否插入可见的说明消息
    markMeta: true                # 热更新 · 是否在消息 meta 标记 rebased（建议保持 true）
  cacheCommits: 64                # 热更新 · 物化结果 LRU 容量；0 = 不缓存（排查「读出来的窗口和库里对不上」时用）
  tokenRatioAlpha: 0.2            # 热更新 · 估算校准 EMA 系数
  # 热更新 · 清空上下文（/new 与 WebUI「清空上下文窗口」）之后，归档检索要不要也挡在那一刻之后。
  # 关（默认）= 只挪 done 指针：窗口空了，而 read_messages / search_messages / get_message 读的是
  #   messages 归档表、不受窗口约束 —— 实测清空后模型第一步就 read_messages 把 20 条历史整段捞回来，
  #   那份工具结果又落进新窗口（logs/2026-08-19 · 01M0CKK6W018B5KS9613SNEX5J）。清空于是形同没生效。
  # 开 = 清空那一刻的 messages.id 记进 reset commit 的 meta.archiveFloor，三个归档工具只看得到它
  #   之后的消息（被挡住时如实回 recall_barrier，不伪装成「这条不存在」）；同时把背景认领水位一并
  #   推到那里，否则清空前那些没被认领的群发言会从另一扇门进新窗口。owner 的
  #   admin_search_messages 不受管（跨会话，按 key 记的水位对它没有意义）；/undo 撤回那次清空会
  #   一并解除，而 WebUI 的「回滚到此」解除不了（它插的是 seq 更大的 manual commit）。02 §7.1
  recallBarrier: false

# ============================================================ concurrency
concurrency:
  mode: parallel                  # 需重启 · parallel（D1）| serial（逃生舱）
  perKey: 3                       # 需重启 · 信号量在启动时建好，改了要重启才换（docs/20 · W-CFG-02）
  global: 8                       # 需重启
  queueMax: 20                    # 需重启
  coalesceSameUserMs: 0           # 热更新 · >0 时只为窗口内最后一条开轮次，先到的降级成背景消息
  turnTimeoutMs: 600000           # 热更新
cancel:
  commitPartial: false            # 热更新 · 取消时是否提交**没投递给用户**的那部分（已发到屏幕上的一律提交，见 04 §5.3）

# ============================================================ prompt & memory（D11, D12）
prompt:
  maxTokens: 12000                # 热更新 · block 0–6 总上限
  includeToolCatalog: true        # 热更新
  runtimeBlock:
    showQuota: true               # 热更新 · 有本轮预留时才有这一行
    showContextWatermark: true    # 热更新
    showWorkspace: true           # 热更新
memory:
  dir: ./memory                   # 需重启
  pubWriteMinRole: trusted        # 热更新 · ★ D12 安全阀。memory_write 读的是本轮那份合并配置
                                  #   （turn.config），所以 perChat 覆盖真的生效；而 configSchema 只放行
                                  #   比全局**更严格**的值，往松了改会被校验器挡下（22 · D-CFG-01）
  pubWriteRequiresApproval: false # 热更新 · 多群部署建议 true
  softLimitTokens: 1500           # 需重启 · 超出触发异步压缩（MemoryStore 构造时吃的是快照）
  hardLimitTokens: 3000           # 需重启 · 超出拒绝写入
  maxSections: 12                 # 需重启
  compactCron: '0 3 * * 0'        # 需重启
  autoApplyCompaction: false      # 热更新 · false 时压缩结果需 owner 审阅
  requireSourceTag: true          # 热更新 · 强制写入来源标注
  forgetMeRetentionDays: 30

# ============================================================ agent（D13）
agent:
  main:
    modelAlias: main              # 热更新
    maxSteps: 12                  # 热更新
    downgradeAfterStep: 8         # 热更新 · 超过该步数自动降到 low 档
  maxDepth: 3                     # 需重启 · AgentManager 构造时吃的是快照（docs/20 · W-CFG-02）
  maxConcurrentSubagents: 3       # 热更新 · 同一轮里同时在跑的子 agent 数上限
  maxSubagentsPerTurn: 10         # 需重启 · 同上
  askTimeoutMs: 120000            # 热更新 · 子 agent 等仲裁答复的上限，超时按「仲裁不可用」降级
  maxAsksPerRun: 5                # 需重启 · registerBuiltins 构造时吃的是快照
  askArbiter: true                # 热更新 · 用 low 档模型仲裁 ask_parent；false = 工具直接回「无人应答」
  askEscalateToUser: false        # 🚧 转人工缺一条阻塞式人机通道，打开也只会多记一条 warn
  progressThrottleMs: 3000        # 热更新 · report_progress 广播到 SSE 的节流窗口（库里那行照常更新）
  agentsDir: ./agents             # 热更新 · agents/<name>.md 的目录（14 §2 Q5）。文件是**只读**
                                  # 来源，下面这份 agents 里的同名定义覆盖它。目录不存在 = 没有
                                  # 文件定义，不报错。没有文件监听：改 .md 要动一次配置或重启
  harness:                        # M11 · 起外部 coding harness 改宿主仓库（14 §2 Q8）
    command: claude               # 需重启位面无关：每次调用现读。CLI 可执行名
    args: [-p]                    # 任务正文作为 argv 最后一项追加，**不经 shell**
    allowedDirs: []               # 热更新 · **空 = 整个功能关闭**，工具不进模型的工具目录。
                                  # 只能在这里列出的路径（或其子目录）里跑
    timeoutMs: 900000             # 热更新 · 单次上限；超时 SIGTERM，5s 后 SIGKILL
    maxOutputBytes: 65536         # 热更新 · 交回模型的输出上限，中间截断
  agents:                         # 子 agent 定义（WebUI 可编辑，见 04 §3.1）
    - name: researcher
      description: 在聊天记录/文件/网络中检索资料并给出带引用的结论
      modelAlias: low
      maxSteps: 20
      minRole: limited
      tools: [read_file, list_dir, grep, glob, search_messages, read_messages,
              get_message, web_fetch, web_search]
      resultMaxChars: 4000
      instructions: |
        你是检索型子 agent…
    - name: coder
      description: 在工作目录内完成多文件读写与脚本执行类任务
      modelAlias: high
      maxSteps: 30
      minRole: trusted
      tools: [read_file, write_file, edit_file, move_file, list_dir, grep, glob, bash, python]
      resultMaxChars: 6000
      instructions: |
        你是编码型子 agent…
    - name: summarizer
      description: 把大段文本压缩为结构化摘要
      modelAlias: low
      maxSteps: 3
      minRole: limited
      tools: []
      resultMaxChars: 3000
      instructions: |
        你把输入压缩为：结论 / 要点 / 数据 / 不确定项。

# ============================================================ provider
provider:
  maxRetries: 2                   # 热更新
  retryBaseMs: 1000
  retryMaxMs: 30000
  healthCheckCron: '*/10 * * * *' # 需重启
  healthDownCooldownMinutes: 30   # 热更新 · 判成 down 的 provider 冷却这么久后重新参与模型链
  requestTimeoutMs: 120000        # 热更新 · 单次尝试「发出请求 → 拿到响应头」的上限。到点后只中止
                                  #   这一次尝试（重试与别名 fallback 照常走），并且**不再等** ——
                                  #   provider 实现不认 abort 时光中止是没用的（04 §5.3）
  streamIdleTimeoutMs: 60000      # 热更新 · 流开着但不吐字的上限。整体超时管不了这种情况：连接是活的，
                                  #   只是一个 token 都不来。只计「在等下一个 chunk」的时间，本轮正在
                                  #   跑工具不算。中途断掉不重试（正文可能已经发出去一半）
  allowPrivateBaseUrl: false      # 热更新 · ★ 允许 provider 探测 / 模型目录打到私网地址与非常规端口。
                                  #   默认关：`POST /api/providers/:id/test` 收请求体里的 baseUrl，
                                  #   开着等于把管理端变成一个带鉴权的 SSRF 代理（22 · V-SSRF-01）。
                                  #   自建网关跑在内网是合理场景，但必须运维显式打开。
  catalog:                        # 热更新 · 模型元数据目录（models.dev），见 04 §5.4.1
    enabled: true                 # 热更新 · 关掉之后拉取模型只剩上游 /models 给的那点信息
    url: https://models.dev/api.json
    cacheFile: ./data/cache/models.dev.json   # 热更新 · 缓存文件；etag 与拉取时间在 app_kv
    ttlHours: 168                 # 热更新 · 超过这个年龄才出网，且带 If-None-Match（304 只有几百字节）
    timeoutMs: 30000              # 热更新 · 单次拉取超时；失败时降级用旧缓存

# ============================================================ tools（D10）
tools:
  maxRegistered: 80               # 热更新
  maxCallsPerTurn: 40             # 热更新
  maxConsecutiveErrors: 3         # 热更新 · 同一工具连续失败到这个数就在本轮停用；之后再调返回
                                  #   `tool_disabled_after_errors`（成功一次即清零，见 05 §8.1）
  defaultTimeoutMs: 60000         # 热更新 · 单次工具调用的默认墙钟上限，到点返回 `tool_timeout` 给模型。
                                  #   bash/python/spawn_agent 与两个 web 工具自己管超时，不受这一项约束
  overrides: {}                   # 热更新 · 逐个工具的运维覆盖层，键为工具名。工具页是它的入口（09 §3.7）
                                  #   <name>.enabled     缺省 true；false = 硬边界（目录里没有 + execute 二次拦截）
                                  #   <name>.minRole     覆盖 TOOL_POLICY 的最低角色
                                  #   <name>.approval    覆盖审批基准档：never | conditional | always
                                  #   <name>.timeoutMs   覆盖该工具的单次超时（毫秒）
                                  # 后三项**没有默认值**：字段缺席 = 沿用代码里 `TOOL_POLICY` / 工具自己声明的那份。
                                  #   写死一个默认值等于把每条历史覆盖行钉在写它那天的策略上，此后改代码推不动它们。
                                  # 三条不变量：① 覆盖只动角色闸与审批闸，绕不过 `available()`（`spawn_harness`
                                  #   仍然只有 owner 且只在私聊）；② `approvalFor` 的抬档只升不降，基准改成 never
                                  #   也照样抬；③ `timeoutMs: null` 的工具（bash/python/spawn_agent/spawn_harness/
                                  #   ask_parent）不吃超时覆盖 —— 它们各有自己的硬期限，套外层 race 会提前砍断。
                                  # 「放宽（minRole 调低 / 审批降档）需二次确认」是 `PATCH /api/tools/:name` 的
                                  #   端点行为（409 `relax_requires_confirmation`），**不是 schema 约束** ——
                                  #   直接改 YAML 或整块写 `PUT /api/config` 绕得过去，那是有意的：schema 只管形状。
  fs:
    maxReadBytes: 262144
    maxWriteBytes: 5242880
    showHidden: false
    allowHostFsForOwner: false    # 热更新 · ★ 危险，WebUI 有红色警告。放开的只是**边界**：owner 的
                                  #   绝对路径可达整机（仍受 denyGlobs 约束），而相对路径与回给模型的
                                  #   路径仍以会话 workspace 为基点（05 §3.1 的 base）。开着时下面那几条
                                  #   `<root>/…` 才真正起作用 —— 默认模式下它们先撞 path_outside_workspace
    denyGlobs:
      - '**/.env*'
      - '**/*.pem'
      - '**/*.key'
      - '**/id_rsa*'
      - '**/.ssh/**'
      - '**/.git/config'
      - '<root>/config/**'
      - '<root>/data/luoli.db*'
      - '<root>/memory/**'
      - '<root>/skills/**'          # 自撰写通道的落点：只能经 write_skill / write_plugin 写，
      - '<root>/plugins/**'         #   它们各自带校验与「改了就重置 enabled」。不堵掉旁路，
                                    #   改一个**已启用** plugin 的文件就是不经复审拿到 root。
                                    #   ★ 这两条只是默认值里的字面量；真正生效的那道由
                                    #   skills.dir / plugins.dir 推出来（selfAuthoringDenyGlobs），
                                    #   **叠加**在你这份数组之上 —— 删掉它们也关不掉
    trashDir: .luoli-trash
    backupDir: .luoli-bak
  exec:
    defaultTimeoutMs: 60000       # 热更新 · bash/python 不传 timeoutMs 时用它
    maxTimeoutMs: 300000          # 热更新 · timeoutMs 的上界，同时写进模型看到的 schema（05 §3.3）。
                                  #   到点 SIGKILL 整个进程组
    maxOutputBytes: 65536         # 热更新 · 交回模型的单流输出上限，超出保留头尾各半并标注省略字节数。
                                  #   ★ 还有第二道：**单条流累计到本值的两倍时子进程当场 SIGKILL**
                                  #   （截断是收集完在内存里做的，不设第二道等于没有上界）。那一次带
                                  #   truncated:true 与一条 hint，但 ok 只看退出码 —— 进程已自己退出 0
                                  #   时不因截断改判成失败（28 · L-TOOL-01）。
                                  #   结果里的 killed 对「输出超限 / 超时 / 被取消」三种原因不可分：
                                  #   同一个 kill()。要分辨看 truncated 与 durationMs 是否贴着 timeoutMs
  archive:
    defaultSearchLimit: 20        # 热更新
    maxSearchLimit: 100           # 热更新
    defaultReadLimit: 50          # 热更新
    maxReadLimit: 200             # 热更新
  tg:
    maxExtraMessagesPerTurn: 3    # 热更新 · 一轮内 send_message/send_photo/send_file 的调用上限
    maxFileSendMb: 50             # 热更新 · send_file/send_photo 的单文件上限
  web:
    maxResponseBytes: 2097152
    timeoutMs: 15000              # 需重启 · web_fetch / web_search 单次尝试的上限（含 DNS 与全部重定向跳）。
                                  #   `http.request` 默认没有任何超时：黑洞地址会一直挂着，卡住的是整轮对话
    retries: 2                    # 需重启 · 瞬时失败（超时 / 5xx / 429 / TCP 重置）的重试次数，退避带抖动。
                                  #   耗尽后交回 `{ok:false, error, attempts, hint}`，由模型决定换 URL 还是
                                  #   如实告诉用户；语义性拒绝（SSRF、端口、404）一次都不重试（05 §8.1）
    summarizeWithAlias: low       # 热更新 · web_fetch 的 prompt 摘要用哪个别名
    allowlist: []                 # 热更新 · 域名 glob（`*.x.com` 只配子域）；非空时只放行命中的。空则 limited 角色不注册 web_fetch
    denylist: ['*.local', '*.internal']  # 热更新 · 命中即拒，优先于 allowlist；每一跳重定向都复验
    searchProvider: ''            # 需重启 · brave | serper | tavily | ''（空则不注册 web_search）。
                                  #   与 searchApiKey 一起在启动时读进 registerBuiltins 的依赖，
                                  #   `web_search` 的 available() 判的就是那份快照
    searchApiKey: ''              # 需重启 · **明文**存在 config.yaml / config_kv 里（不是引用，
                                  #   与 provider key 的 Secrets 加密不同）。建议写 ${env:BRAVE_API_KEY}
                                  #   之类的 env 引用，别直接落库；日志与 GET /api/config 会脱敏
  # 自我扩展（14 §2 Q13 / 07 §6）：模型给自己写工具 / 写 skill / 写 plugin / 装 MCP。
  # 整块默认关，与 mcp.enabled、agent.harness.allowedDirs 同一形态 —— 这几件事都是「打开之后
  # 模型能改变自己下一轮的能力」。整段热更新：main.ts 的 config.changed 订阅在 tools.selfExtend.*
  # 变化时重跑 customTools.reconcile()，关掉之后下一轮那批工具就从目录里消失。
  selfExtend:
    enabled: false                # 热更新 · 总闸。关着时那七个工具仍然注册（否则启动断言会抛）但一个都不进目录
    customTools:
      enabled: false              # 热更新 · 允许 define_tool 把一段 bash/python 脚本注册成 custom_<name>
      autoEnable: false           # 热更新 · ★ 打开 = 定义完下一轮就能用。默认关着的理由：网页 / 群聊里的
                                  #   一段注入 → define_tool → owner 因 approval.skipForOwner 无感放行 →
                                  #   立刻成为持久能力，这条链上本来没有人（14 T18）
      requireSandbox: false       # 热更新 · 打开后沙箱不生效时（owner 命中 bypassRoles，或 mode=none）
                                  #   自定义工具一律不可用，此时它**严格弱于** bash。默认关是 Q13-d 的
                                  #   拍板（与 bash 一视同仁），代价见 14 T19
      maxTools: 20                # 热更新 · 数量上限，撞上之后 define_tool 在定义期就报错
      maxBodyChars: 8000          # 热更新 · 单个脚本正文的字符上限
      defaultMinRole: owner       # 热更新 · 模型没指定时新工具的最低调用角色。无论怎么配都不低于 bash 的门槛
      timeoutMs: 60000            # 热更新 · 没指定超时时的默认值，最终仍封顶在 tools.exec.maxTimeoutMs
    skills:
      enabled: false              # 热更新 · ★ 允许 write_skill 写 SKILL.md（纯文本），以及 install_skill
                                  #   装一个带 scripts/ 与 bin/ 的 skill 包。包落地一律停用，要 owner
                                  #   在扩展页看过文件清单才启用（07 §6.1）。一个开关管两件事：
                                  #   都是「往 skills/ 里写东西」，分成两个只会多出「开了一半」的状态
      minRole: trusted            # 热更新 · 模型写出来的 skill 的 min-role **下限**：能写得更严，不能更松。
                                  #   装包时同样按它抬高包里写的那个值
    mcp:
      enabled: false              # 热更新 · 允许 install_mcp 登记 server。落地一律 enabled:false，要 owner 点开
      allowTransports: [stdio, http]  # 热更新 · ★ stdio 是一条模型发明的命令行，启用后以 bot 进程的身份跑在
                                  #   沙箱之外。只留 http 可以把这一类整体挡掉
    plugins:
      enabled: false              # 热更新 · ★ 允许 write_plugin 写 plugins/<name>/plugin.js。plugin 在 bot
                                  #   进程里全信任运行 = root（14 A27）；写下来的文件一律禁用，
                                  #   只有 owner 在扩展页读过源码才能启用
      maxBodyChars: 200000        # 热更新 · 单个 plugin.js 的字符上限

# ============================================================ sandbox（D10）
sandbox:
  mode: docker                    # 热更新 · none | jail | docker
  bypassRoles: [owner]            # 热更新 · ★ owner 宿主直跑
  image: luoli-sandbox:latest     # 热更新
  network: none                   # 热更新 · none | bridge
  memoryMb: 512
  cpus: 1
  pidsLimit: 128
  readOnlyRoot: true
  tmpfsMb: 64
  workspaceDir: ./data/workspace  # 需重启 · 本进程视角
  hostWorkspaceDir: ''            # 需重启 · 同一目录的宿主视角路径；本进程也在宿主上跑时留空
  dockerBin: docker
  persistent:                     # 会话级持久容器（05 §5.5）；只在 mode: docker 下有意义
    enabled: false                # 热更新 · ★ 打开后每个会话一个常驻容器，且默认能出网
    idleTtlMs: 86400000           # 热更新 · 滑动 24h：每次执行重新计时
    maxLifetimeMs: 0              # 热更新 · 绝对上限，从创建算起；0 = 不设
    maxContainers: 16             # 热更新 · 撞上限直接报错，不退回一次性容器
    network: bridge               # 热更新 · ★ 持久容器的网络。与上面的 sandbox.network 是两个键
    reapCron: '*/5 * * * *'       # 热更新 · 回收 / 对账的频率（改了会重挂那条 cron）
```

**`reapCron` 是这一段里唯一需要额外接线才算热更新的键。** cron 是「构造即排期」，改配置不会自己
重挂 —— `mcp.healthCheckCron` 正是因为没接这条线，整段 `mcp` 才被移出热更新白名单。这里选了
另一条路：`config.changed` 里判到它变了就 `scheduler.remove('sandbox-reap')` 再按新表达式
`add` 回去，于是整段 `sandbox` 留在白名单里仍然是真话。

**`persistent.network` 与 `sandbox.network` 是两个键，不要合并着看。** 上面那个管一次性容器
（默认 `none`），这个管持久容器（默认 `bridge`）。分开是因为一个开关不能悄悄改两件事，
而一个不能出网的持久容器基本没有意义 —— 持久化本来就是为「后台进程 + 出网」做的。
`enabled: true` 且 `network: bridge` 时**启动会打一条 warn**：bridge 实测能直达公网与宿主
`172.17.0.1`，而 [05 §5.3](./05-tools-and-permissions.md) 里那个「注入 HTTP_PROXY 指向可审计
出站代理」至今没有实现。

**`maxLifetimeMs: 0` = 不设上限**，与 `maintenance.retention.*` 同一套约定 —— 本文档里
**0 一律是「不清」而不是「立刻过期」**。`container_keep` 的「钉住」只豁免 `idleTtlMs` 那一档，
豁免了绝对上限它就不是上限了。

`persistent` 打开时才注册 `container_*` 那六个 owner 工具（[05 §3.11](./05-tools-and-permissions.md)）。

**`hostWorkspaceDir` 只在「应用自己跑在容器里 + `mode: docker`」时需要。** `docker run -v` 的左半边
由**宿主** daemon 解析，而 `run()` 拿到的是本进程视角的路径（容器里是 `/app/data/workspace/<chatId>`）。
两者不一致时 docker 不报错，只是在宿主上默默建一个空目录 —— 结果 `bash` 写的文件 `read_file` 读不到，
反过来也一样。因此 `Sandbox` 在检测到自己位于容器内（`/.dockerenv` 或 `/run/.containerenv`）
且该项为空时**直接禁用执行类工具**并报 `sandbox.unavailable`，而不是挂一个错的目录上去。

`docker-compose.yml` 已通过 `LUOLI_HOST_WORKSPACE_DIR: ${PWD}/data/workspace` 提供该值。
换算越界（传入的 workspace 不在 `workspaceDir` 之下）同样拒绝执行，不做兜底。

```yaml
# ============================================================ approval
# ⚠ enabled: true 只表示「审批流水线开着」，**判定完全由 rules 决定**：规则表为空时
#   ApprovalRules.evaluate() 恒回「不需要审批」，于是 TOOL_POLICY 里标 conditional 的六个工具
#   （bash / python / write_file / edit_file / move_file / memory_write）一个都不会停下来问
#   —— 面板显示「审批已启用」、[05] 的工具表写着「条件审批」，而门是开着的（docs/27 · S-02）。
#   出厂默认是空表；空表时启动记一条 approval.no_rules 警告，WebUI 的审批页顶上也会说明。
#   config/config.yaml 里带了注释掉的示例规则，取舍留给部署方（开箱就弹审批 = 每次 bash 都要人点）。
approval:
  enabled: true                   # 热更新
  # 命中规则的调用挂起等待 WebUI 裁决的上限；到点落 expired 并把「未获批准」还给模型
  ttlMs: 180000                   # 热更新
  skipForOwner: true              # 热更新
  rememberWithinTurn: true        # 热更新
  # pattern 走 **RE2**（线性时间，不支持反向引用 / lookaround），上界 128 字符，`(?i)` 前缀原生支持。
  # 求值对象是模型给的整份工具参数 JSON —— 用 JS 引擎时一条 `(a+)+` 撞上合适输入就是指数回溯，
  # 而这是单线程进程，卡住的是整个 bot（docs/27 · S-03；grep 与唤醒词早已换 RE2）。
  # 写入端（WebUI / PUT /api/config）用同一份判据，不兼容的模式当场 400 而不是存下来永不命中。
  rules:                          # 热更新（WebUI 可编辑）
    - tool: bash
      pattern: '(?i)\b(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|chmod\s+777\s+/)'
      risk: high
    - tool: bash
      pattern: '(?i)\b(curl|wget|nc|ssh|scp)\b'
      risk: medium
    # edit_file 与 write_file 同档：edit() 最后一步就是 write()，且能把整份文件换掉，
    # 而它恰好**只**作用于已存在的文件 —— 漏了它等于给覆盖审批留一条绕道（docs/27 · C-03）。
    - tool: [write_file, edit_file, move_file]
      when: target_exists
      risk: medium
    - tool: delete_file
      always: true
      risk: high
    - tool: 'mcp__*'
      risk: medium

# ============================================================ output（D18）
output:
  mode: stream                    # 热更新 · stream | once（可 perChat 覆盖）
  replyDelayMs: 2000              # 热更新 · 距离用户那条消息至少等这么久才发第一条回复（0 = 立刻回）；
                                  # 窗口内流式产出的文本只攒不发，typing 动作照常
  streamBufferMs: 2000            # 热更新 · 收到上游第一个 chunk 后再攒这么久才发第一条（0 = 首个
                                  # chunk 到就发）。锚点与 replyDelayMs 不同，两者取晚的那个
  streamIntervalMs: 2000          # 热更新 · 两次消息编辑之间的最小间隔
  streamMinDeltaChars: 24         # 热更新 · 与上一项同时满足才编辑
  flushOnSentence: true           # 热更新 · 一句话说完就刷，不等满 streamIntervalMs（编辑次数会上升）
  maxMessageChars: 3900
  parseMode: MarkdownV2           # 热更新 · 三档各有自己的渲染器与分片规则（08 §5.3）：MarkdownV2 转义 |
                                  #   HTML 走 Telegram 标签子集 | none 原样发（因此也没有解析失败那一跳）
  typingWhileWorking: true        # 热更新 · 关掉后整轮一次 typing 都不发
  placeholderAfterMs: 4000        # 热更新 · 上游这么久还没吐第一个 chunk 就先发一条占位（就是后面被编辑的那条）
  placeholderTexts: ['…']         # 热更新 · 占位消息的备选文案，可多条（可 perChat 覆盖）。
                                  # **空数组 = 不发占位消息** —— placeholderAfterMs 是 positive，
                                  # 填不了 0，这是关掉它的唯一途径。空白行在挑选时滤掉
  placeholderPick: random         # 热更新 · random = 每轮随机挑一条；fixed = 恒用 placeholderIndex 那条
  placeholderIndex: 0             # 热更新 · fixed 用第几条，0 起，按去掉空行后的列表算；越界回落到第一条
  maxMentions: 3                  # 热更新 · 一条消息最多几个 @用户名，多的去掉 @ 只留名字；0 = 不限

# ============================================================ media（D16）
media:
  dir: ./data/files               # 需重启
  retentionDays: 90               # 需重启 · 媒体**文件**保留天数，0 = 不清。到期删盘上的文件、
                                  # 保留 attachments 行（download_state 写 'expired'）——
                                  # 历史消息里的「[图片]」还在，只是点不开（14 §2 Q9-a / T16）。
                                  # 需重启的原因同 maintenance.retention.*：启动时交给
                                  # MaintenanceService，不是每次 cleanup 现读
  maxImageBytes: 8388608
  maxDocBytes: 20971520
  maxImageEdge: 1568
  maxImagesPerTurn: 4             # 需重启 · 超出的图片在装配时换成占位文本
  # 热更新 · 判断「这一轮含图、该切 vision 别名」时看哪些图（04 §5.2 / 08 §7.2）。
  # window（默认，一直以来的行为）= 整个上下文窗口（snapshot + delta）。代价是**一张图会把它之后的
  #   每一轮都钉在 vision 别名上**：实测一个私聊里 4 条带图消息留在窗口内，此后每一轮纯文本都记
  #   provider.fallback … vision_required（logs/2026-08-19），而一个能看图的别名都没配时，那些轮次的
  #   回复末尾还会挂一句「这张图我没能真的看到」—— 用户那一轮根本没发图。
  # turn = 只算本轮新进来的图（触发消息、被回复的那条、本轮认领的群背景发言）。更早轮次留在窗口里的
  #   图片：这一轮真落在看不了图的模型上时才整体换成占位文本（换的文本写明「重新发一次或引用那条
  #   消息」，那两种都会被算成本轮的图），落在能看图的模型上则原样带着 —— 「再看一遍上面那张图」
  #   在 vision 模型上仍然可用。降档到 low 的那一步同样按当步别名兜一次。记一条 ctx.image_placeholder
  visionScope: window
  groupDebounceMs: 1500
  stickerAsImage: false           # 需重启 · 开了之后贴纸按图片下载并归一化
  downloadVoice: true             # 需重启 · 存盘但不解析（不做 STT）；关掉后语音一律不下载
  extract:
    enabled: true
    maxChars: 40000
    inlineChars: 4000             # 超出时只注入前 N 字 + 提示用 read_file
    codeExtensions: [.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.kt,.sh,.sql,.yaml,.yml,
                     .toml,.json,.md,.html,.css,.c,.cpp,.h]

# ============================================================ skills / plugins / mcp（D14）
skills:
  enabled: true                   # 需重启 · 关掉后不扫盘、不监听，SKILL.md 一个都不进工具目录
  dir: ./skills                   # 需重启
  watch: true                     # 需重启
  # WebUI 新建 Skill 未显式选择角色时使用；SkillLoader 每次创建都读当前快照
  defaultMinRole: trusted         # 热更新
  # 装 skill 包（zip / 目录）时的解包上限，install_skill 与 POST /api/skills/package 共用。
  # 07 §2.5 那张表列了每一道各挡什么。
  package:
    maxEntries: 2000              # 热更新 · 包里最多多少个条目
    maxTotalBytes: 67108864       # 热更新 · 解包后总字节上限（64 MiB）。**按实际写出的累计判**，
                                  #   不信 zip 头里的 uncompressedSize —— 那个字段是打包方填的
    maxFileBytes: 33554432        # 热更新 · 单个文件上限（32 MiB）。同样按实际写出的判
    allowExecutable: true         # 热更新 · ★ 给 scripts/ 与 bin/ 下原本带执行位的文件保留 0700。
                                  #   关掉 = 包退化成纯文本，附带的脚本与二进制装进来也跑不了
plugins:
  enabled: true                   # 需重启 · 关掉后不 reconcile，钩子链为空
  dir: ./plugins                  # 需重启
  watch: false                    # 需重启 · 开了等于让磁盘写入直接热加载一份全信任 JS
  hookTimeoutMs: 5000
  order: []                       # 需重启 · plugin 名顺序，决定 hook 执行序（PluginManager 在构造时就把它拿走了，reconcile 读的还是旧值）
  autoDisableAfterErrors: 3
mcp:
  # 总开关，出厂就是 false：`McpManager.reconcile` 一上来就对它 early-return，关着的时候
  # `servers` 里配了多少个都不会连。WebUI 扩展页在它关着时给一条横幅（docs/09 §3.8）。
  enabled: false                  # 热更新
  connectTimeoutMs: 15000         # 需重启 · 握手与 listTools 的上界，卡住的 server 不会拖住启动
  # 需重启：`scheduler.add(config.mcp.healthCheckCron, …)` 在启动时就把表达式拿走了，Scheduler
  # 没有重配入口。这一项曾因为白名单里写的是整段 `mcp` 而被 WebUI 标成「热更新」（docs/21 · G-CFG-05）。
  healthCheckCron: '*/5 * * * *'  # 需重启
  defaultMinRole: trusted         # 热更新
  servers: []                     # 热更新 · 见 07 §4.1（改完立刻 reconcile）

# ============================================================ schedule（见 02 §10、05 §3.8）
# 定时任务：模型用 schedule_create 自己排的周期 / 一次性任务（14 §2 Q4 已拍板）。
# 注意这一段管的是**用户任务**，不是上面那些 *Cron 维护任务：
#   · 用户任务按任务行上记的 timezone 触发（创建时取 general.timezone 存进 scheduled_jobs.timezone）；
#   · `general.maintenanceCron` / `db.vacuumCron` / `memory.compactCron` / 两个 healthCheckCron
#     仍按**进程本地时区**触发 —— 宿主是 UTC 时 `0 4 * * *` 的清理实际发生在北京时间正午。
#     这是既有行为，没有跟着改：挪动线上备份 / VACUUM 的时间点不该是加一个工具的副作用。
schedule:
  # 总开关。关掉之后已有任务留在库里但不再触发（每次跳过记一条 schedule.skipped），不会被删。
  enabled: true                   # 热更新 · 每次触发时现读
  maxPerChat: 20                  # 热更新 · 单会话活跃任务上限，超了 schedule_create 直接拒绝
  # cron 两次触发之间的最小间隔。cron 最细能到每分钟，而 agent 模式下那就是每分钟一次真实模型调用。
  # **这一项与 maxPerChat 就是定时轮次的频率闸**：定时轮次不计入 quota.rateLimit 的按小时次数
  # （docs/28 · L-QUOTA-02），所以这两个值是「机器一天最多开多少轮」的唯一上界。
  # 金额那一侧仍由 quota 的 daily / monthly / perTurn 兜着。
  minIntervalMinutes: 5           # 热更新
  maxPayloadChars: 2000           # 热更新 · 任务正文上限，同时写进模型看到的 inputSchema
  # 已结束（done / cancelled）的任务行保留多久。活跃任务永不清理（见 03 §4）。
  # 需重启：跟 logs.retentionDays 一样在启动时交给 MaintenanceService。
  retentionDays: 30               # 需重启

# ============================================================ maintenance（保留期，见 10 §5）
# 每日 general.maintenanceCron 触发时按这几项删行。MaintenanceService.cleanup() 此前只清
# log_events / processed_updates / sessions / approvals / 子 agent 结果 / scheduled_jobs，
# 而下面这四张表只涨不落 —— 读端点都有 LIMIT，所以症状不是慢查询而是**库文件只涨不落**，
# 且 VACUUM 帮不上（数据还在，docs/27 · R-05）。
# **turns 与 tasks 刻意不在其列**：它们是 trace 的骨架（/api/turns/:id/detail 靠 turn 行把日志、
# 用量与上下文串起来），删掉等于历史轮次凭空消失 —— [14 §2 Q9-c] 已确认永久保留。
# 媒体**文件**的过期在 media.retentionDays（不在这一段下，但由同一次 cleanup() 执行）。
# 每一项 **0 = 不清**；四项都在启动时交给 MaintenanceService，因此都需重启。
maintenance:
  retention:
    usageDays: 400                # 需重启 · usage_ledger，每次模型调用一行
    quotaCounterDays: 400         # 需重启 · quota_counters 里过期账期的行（当前账期永不删）
    configRevisionDays: 180       # 需重启 · config_revisions，配置变更审计
    memoryRevisionDays: 180       # 需重启 · memory_revisions，存完整 diff；删了就回滚不到更早的版本

# ============================================================ db
db:
  path: ./data/luoli.db           # 需重启
  backupKeep: 5
  vacuumCron: '0 5 * * 0'         # 需重启 · VACUUM 之后立刻 wal_checkpoint(TRUNCATE)：WAL 模式下
                                  # VACUUM 把整库重写一遍**进 WAL**，不 checkpoint 就要等下一次
                                  # 自动 checkpoint 攒够写入 —— 实测 37MB 的库 84 秒后 WAL 仍是
                                  # 38MB，于是每次周维护之后以整库大小挂约 23 小时（28 · L-OPS-05）
                                  # 没有 ftsTokenizer：tokenize='trigram' 写死在 0001_init.sql 的建表
                                  # 语句里，换它必须追加迁移重建 messages_fts，配置项换不动（14 §2 Q3）

# ============================================================ logs（见 10）
logs:
  level: info                     # 热更新
  dir: ./logs                     # 需重启
  captureBodies: true             # 热更新
  bodyMaxBytes: 262144
  maxFileMb: 128
  retentionDays: 30
  gzipAfterDays: 3                # 需重启 · 比这么多天更早的 jsonl 压成 .gz（blobs/ 不动）；0 = 不压
  console: pretty                 # pretty | json | off
  redactPatterns: []              # 热更新 · 追加到内置脱敏规则上的正则；写坏的那条整条跳过

# ============================================================ quota（D19）
quota:
  enabled: true
  requirePricing: true
  minReserveUsd: 0.02
  global:  { daily: 5.00, monthly: 100.00 }
  perChat: { daily: 1.00, monthly: null }
  perUser:
    daily: 0.50
    monthly: null
    byRole:
      owner:   { daily: null, monthly: null }
      trusted: { daily: 2.00 }
      limited: { daily: 0.30 }
  perTurn:
    maxCostUsd: 0.50
    maxSteps: 12
  # 与金额无关的防滥用（docs/10 §5.1），**不受 `quota.enabled` 影响**。窗口是滚动一小时
  # （数 `turns.started_at >= now-1h`），不是整点重置。
  # **定时任务的轮次不计入下面这两项**：它不是「人在刷」，频率已由 schedule.minIntervalMinutes /
  # schedule.maxPerChat 在创建时管住，而实测一天 38 次定时触发把 owner 自己挡在了门外
  # （docs/28 · L-QUOTA-02）。金额额度照旧全部生效；concurrentPerUser 照旧数它。
  rateLimit:
    turnsPerUserPerHour: 30
    turnsPerChatPerHour: 100
    concurrentPerUser: 2
  onExceeded:
    # 这三项只管**金额**那一档。频率（rateLimit 的按小时次数）与并发拒绝各有自己的文案，
    # 也都不受 `reply` 管 —— 那个开关的语义是「额度用光了就别再回话」，而对一句正常的话沉默
    # 等于 bot 装没看见。套额度文案更糟：占位符会原样漏给用户（docs/28 · L-QUOTA-02）。
    reply: true
    message: '今天的额度用完了（已用 {spent}/{limit}），{resetAt} 重置。'
    notifyOwner: true             # 热更新 · 只有 global 档超限才私聊 owner；chat/user 超限只回发起人
  warnAtRatio: 0.8                # 热更新 · 跨线时在成功那一轮的回复后补一句，每个 bucket 只提示一次

# ============================================================ webui（D15）
webui:
  # 关掉之后整个 HTTP 面不监听。代价要说清楚：**没有 WebUI 就没有审批裁决通道**，
  # 命中审批规则的调用会被当场拒绝（`EventBus.channelCount === 0`，docs/24 · R-APPR-01）。
  enabled: true                   # 需重启
  host: 127.0.0.1                 # 需重启 · ★ 默认回环
  port: 8787                      # 需重启
  basePath: /
  publicUrl: ''                   # 热更新 · /webui 生成登录链接时的前缀；没填就明说生成不出来，而不是发一条打不开的链接
  # 下面这几项都是**每请求**从 `currentConfig()` 现读的（`requestIp` / `allowedOrigin` / 登录限流 /
  # `createSession` / `activePasswordHash`），改完下一个请求就按新值走 —— 只有 host / port 例外，
  # 它们在 `serve()` 时就绑定了。WebUI 一度把这几项标成「需重启」，让人白重启一次（docs/21 · G-CFG-05）。
  sessionTtlHours: 168            # 热更新 · 只影响此后新建的会话，已签发的不变
  passwordHash: ''                # 热更新 · 由首次启动向导、设置页的改口令表单或 `pnpm webui:passwd` 写入
  trustProxy: false               # 热更新 · **false 时一个请求头都不看**，见下
  trustedProxyHops: 1             # 热更新 · 反代自己追加的跳数。XFF 按这个数**从右往左**取：
                                  #   最左那一跳是客户端自己写的，取它等于限速形同虚设
                                  #   （每次换一个 X-Forwarded-For 就是一个新桶，22 · V-AUTH-01）。
                                  # trustProxy=false（默认，直连）时**只认连接的远端地址**：
                                  #   X-Real-IP / X-Forwarded-For 一概不参与。桶键要是请求头，限流的
                                  #   代价就只是「再换一个头值」—— 18 · N-WEB-02 修过一次，后来丢了
                                  #   这一半，27 · S-01 实测 12 次轮换 X-Real-IP 全部 401、一次 429
                                  #   都没有。拿不到远端地址（无底层 socket）时全落进常量桶 `local`，
                                  #   fail-closed 的那一侧是「一起锁」。回归用例在 tests/server.test.ts。
  allowOrigins: []                # 热更新
  loginRateLimit: { attempts: 5, windowMinutes: 15 }   # 热更新
                                  # 单 IP 桶之外还有一个全局失败窗口：达到 attempts×20 之后所有登录
                                  # 请求延迟 250ms 再校验 —— 换 IP 绕过的成本被拉高，而不是把 owner
                                  # 一起锁在门外。失败表上限 1024 条，超出按最久未命中淘汰。

# ============================================================ alerts
alerts:
  notifyOwner: true               # 热更新 · 私聊 bootstrapOwnerId；BOT_TOKEN 缺失时这条通道不存在
  dedupeMinutes: 30               # 热更新 · 同一个 (类型, 对象) 在窗口内只发一次
  webhookUrl: ''                  # 热更新 · POST JSON，走 net/outbound.ts（不另开出网路径）
  # 只有这六个字符串是有效值；写别的进去不报错，但永远匹配不上。
  on: [quota_global_exceeded, all_providers_down, db_write_failed,
       plugin_auto_disabled, sandbox_unavailable, consecutive_turn_failures]

# ============================================================ perChat 覆盖
# 键为 context key；只允许覆盖白名单内的字段
perChat:
  'chat:-1001234567':
    output: { mode: once }
    context: { limit: { tokens: 16000 }, background: { maxPerTurn: 10 } }
    trigger: { wakewords: ['洛璃', '^璃酱[，,、 ]'] }   # '^璃' 会因短于 wakewordMinLength 被跳过
    agent: { main: { modelAlias: low } }
    character: CHARACTER.-1001234567.md
```

### 2.1 `perChat` 可覆盖字段白名单

只有下列路径允许在 `perChat` 下出现（其他路径出现即校验失败，避免出现「某个群单独关掉了权限检查」这类危险配置）：

```
output.*
context.limit.*        context.background.*      context.scope        context.active.*
trigger.*
agent.main.*
character（memory/ 下的替代人设**文件名**）
memory.pubWriteMinRole（只允许比全局更严格）
```

> `character` 已接线（docs/27 · C-08）：`assembleMainPrompt` 从本轮合并后的配置里读它，交给
> `PromptDocuments.paths(userId, characterOverride)`，于是这个会话的人格块换成 `memory/<那个文件>`。
> 在此之前它是一个**存得下、过得了校验、什么都不做**的键 —— 白名单里的路径不是 schema 叶子键
> （`perChat` 是 `z.record(z.unknown())`），所以「每个叶子要么被引用、要么进 KNOWN_UNIMPLEMENTED」
> 那条 CI 断言看不见它。现在 `tests/config.test.ts` 另有一条断言把这个盲区补上：白名单里的每条路径
> 要么对应 schema 叶子，要么登进 `PER_CHAT_NON_SCHEMA_KEYS` 且真的被代码读到。
>
> **只收纯文件名**（`^[\w.-]{1,96}\.md$`，且不含 `..`）：它会被当成 `memory/` 下的路径段用，
> 而这是自由字符串（同 `S-08` 的教训）。不合格时**静默退回全局 `CHARACTER.md`** —— 一个拼错的
> 文件名不该让整个会话开不了轮次，而用回全局人格是安全的默认。

覆盖在 `openTurn` 时由 `perChatConfig(config, key)` 合并进本轮配置，`onTurn` 用的是 `turn.config` 而不是全局快照，因此 agent 运行时看到的也是合并后的值。
`trigger.*` 还要更早一步：`matchTrigger` 在 `openTurn` 之前就跑，所以触发判定处（`bot.ts` 的消息与
`edited_message` 两条路径）各自先算一次 `perChatConfig`——否则会话唤醒词能存住却永远匹配不上。

#### 谁可以写 `perChat`

| 写入方 | 校验 |
|---|---|
| `PUT /api/config`（键形如 `perChat.<key>`） | 走 `configSchema`，白名单外的路径返回 400 |
| `PATCH /api/chats/:key` | 走 `configSchema`，白名单外的路径返回 400 |
| 其他任何写入方 | **不允许**。`config_kv` 的每一行都会成为启动时的配置覆盖层，写入非法路径等于给下次启动埋雷 |

会话级模型别名（`/model` 命令）**不走 `perChat`**，它写的是 `app_kv` 的 `modelAlias:<contextKey>`——`config_kv` 只放合法配置路径。

启动时若持久化覆盖层仍含非法路径（历史遗留数据），`loadConfig` 会逐条剔除并把被丢弃的键与清理 SQL 打进 stderr / `config.invalid` 事件，而不是让进程起不来。

---

## 3. 热更新实现要点

```ts
config.onChange(keys => {
  if (keys.some(k => k.startsWith('providers') || k.startsWith('models')
                  || k.startsWith('model_aliases')))  registry.rebuild();
  if (keys.some(k => k.startsWith('skills')))          skills.rescan();
  if (keys.some(k => k.startsWith('plugins')))         plugins.reconcile();
  if (keys.some(k => k.startsWith('mcp')))             mcp.reconcile();
  if (keys.some(k => k.startsWith('logs.level')))      logger.setLevel(...);
  // 其余项在下一个 turn 读取 config 快照时自然生效
});
```

- **配置快照**：每个 turn 在 `openTurn` 时抓一次不可变快照（`Object.freeze` 深冻结），整轮使用同一份，避免中途配置变更导致行为不一致。
- 需重启项的判定**不在 schema 里**，而是 `HOT_RELOADABLE_CONFIG_KEYS` 这张前缀白名单
  （`packages/core/src/config/schema.ts`）：`GET /api/config/schema` 以 `hotReloadable` 一并返回，
  WebUI 据此给每一项打「热更新 / 需重启」徽标，本文件里标 `热更新` 的键由 `tests/config.test.ts`
  逐条对表。schema 的 `description` 只承载作用说明，不重复这件事 —— 抄进正文只会多一处会漂的副本。

## 4. 配置校验规则（超出类型之外的约束）

| 规则 | 失败行为 |
|---|---|
| `context.limit.tokens` ≥ 4000 且 ≤ 500000 | 拒绝启动 |
| `context.hardCapRatio` ∈ (0.3, 0.95] | 拒绝启动 |
| `concurrency.perKey` ≤ `concurrency.global` | 拒绝启动 |
| `quota.perUser.daily` ≤ `quota.perChat.daily` ≤ `quota.global.daily`（null 视为 ∞） | 警告（不阻塞） |
| `sandbox.mode='docker'` 但 `docker` 不可执行 | 启动时警告 + 标记沙箱不可用（非 owner 的执行工具消失） |
| `webui.host != '127.0.0.1'` 且 `passwordHash` 为空 | 拒绝启动 |
| `model_aliases` 缺 `main` | 拒绝启动 |
| `memory.softLimitTokens` < `memory.hardLimitTokens` | 拒绝启动 |
| `perChat` 出现白名单外的路径 | 拒绝启动，指出具体路径 |
| `trigger` 全部为 false 且没有可用唤醒词 | 警告（bot 永不会被触发） |
| `trigger.wakewords` 里有不可用的模式（过短 / 正则过长 / 有回溯风险） | 警告并列出被跳过的模式；经 WebUI 与 API 写入时直接拒绝（400 `invalid_wakeword`） |
| `logs.captureBodies=true` 且 `logs.dir` 不可写 | 拒绝启动 |
