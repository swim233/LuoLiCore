# 11 · 配置参考

配置有三个来源，优先级 **环境变量 > `config_kv`(WebUI 写入) > `config/config.yaml` > 代码内默认值**。

- 全部配置由 `packages/core/config` 的 zod schema 定义，`config.schema.json` 由它生成，WebUI 表单也由它生成 —— **单一数据源**。
- 启动时校验；校验失败**拒绝启动**并打印具体路径与原因。
- 热更新：标 `热更新` 的项保存后立即生效（下一个 turn）；标 `需重启` 的项保存后 WebUI 显示待重启徽标。

## 1. 环境变量（`.env`）

`.env` 由 `pnpm dev` / `pnpm start` / `pnpm db:migrate` 经 node 的 `--env-file-if-exists=.env` 加载，
生产走 `docker-compose.yml` 的 `env_file`。**已存在于 shell 里的同名变量优先**，`.env` 不会覆盖它们。

| 变量 | 必需 | 说明 |
|---|---|---|
| `BOT_TOKEN` | ✓ | Telegram Bot token |
| `LUOLI_OWNER_ID` | ✓ | owner 的 Telegram user id（首次启动写入 `principals`）。缺失则拒绝启动 |
| `LUOLI_MASTER_KEY` | ✓ | 32+ 字节随机串，用于加密 provider API key。缺失则 provider 功能禁用 |
| `WEBUI_PASSWORD` | ✗ | 首次启动时用它生成 `webui.passwordHash`（之后可删除该变量） |
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

当前白名单（按模块分组）。**每一行都以 🚧 起头，测试 `config.test.ts` 要求白名单里的每个键都能在本文件里找到一行同时含该键与 🚧**，否则视为文档未同步：

- 🚧 general / Telegram / trigger：`general.locale` · `telegram.dropPendingOnStart` · `telegram.webhook.url` · `telegram.webhook.path` · `telegram.webhook.secretToken` · `telegram.notifyEdits` · `trigger.cooldownMsPerUser`
- 🚧 context / concurrency / cancel：`context.background.showUsername` · `context.background.showTime` · `context.background.includeNonText` · `context.rebase.markMeta` · `context.cacheCommits` · `concurrency.coalesceSameUserMs` · `cancel.commitPartial`
- 🚧 prompt / memory：`prompt.includeToolCatalog` · `prompt.runtimeBlock.showQuota` · `prompt.runtimeBlock.showContextWatermark` · `prompt.runtimeBlock.showWorkspace` · `memory.pubWriteRequiresApproval` · `memory.autoApplyCompaction` · `memory.requireSourceTag`
- 🚧 agent / provider：`agent.maxConcurrentSubagents` · `agent.askArbiter` · `agent.askEscalateToUser` · `agent.progressThrottleMs` · `provider.healthDownCooldownMinutes` · `provider.requestTimeoutMs` · `provider.streamIdleTimeoutMs`
- 🚧 tools / approval：`tools.fs.allowHostFsForOwner` · `tools.archive.defaultSearchLimit` · `tools.archive.maxSearchLimit` · `tools.archive.defaultReadLimit` · `tools.archive.maxReadLimit` · `tools.tg.maxExtraMessagesPerTurn` · `tools.tg.maxFileSendMb` · `tools.web.summarizeWithAlias` · `tools.web.allowlist` · `tools.web.denylist` · `approval.allowInitiator`
- 🚧 output / media：`output.flushOnSentence` · `output.parseMode` · `output.typingWhileWorking` · `output.placeholderAfterMs` · `output.maxMentions` · `media.maxImagesPerTurn` · `media.groupDebounceMs` · `media.stickerAsImage` · `media.downloadVoice` · `media.extract.codeExtensions`
- 🚧 extensions / persistence / logs：`skills.enabled` · `plugins.enabled` · `plugins.watch` · `mcp.enabled` · `mcp.connectTimeoutMs` · `db.ftsTokenizer` · `logs.gzipAfterDays` · `logs.redactPatterns`
- 🚧 quota / WebUI / alerts：`quota.perTurn.maxToolCalls` · `quota.perTurn.maxSubagents` · `quota.perTurn.maxDurationMs` · `quota.onExceeded.notifyOwner` · `quota.warnAtRatio` · `webui.enabled` · `webui.basePath` · `webui.publicUrl` · `alerts.notifyOwner` · `alerts.dedupeMinutes` · `alerts.webhookUrl` · `alerts.on`

```yaml
# ============================================================ general
general:
  name: 洛璃                      # 热更新 · bot 自称（仅用于日志与 WebUI 标题）
  timezone: Asia/Shanghai         # 需重启 · 影响配额 bucket 与时间渲染
  locale: zh-CN                   # 热更新
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
  wakewords: ['洛璃']              # 热更新 · 字符串=包含匹配；以 ^ 开头=正则（见下方可用性规则）
  wakewordMinLength: 2
  requireTextAfterMention: false
  ignoreEditedAsTrigger: true
  cooldownMsPerUser: 0

# 唤醒词可用性（checkWakeword，运行时匹配与 WebUI 写入端共用一份）：
#   · 去掉前导 ^ 后短于 wakewordMinLength → 整条跳过
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
  hardCapRatio: 0.85              # 热更新 · 轮内硬天花板 = 模型窗口 × 该比例
  background:                     # D6：未触发的群消息进入上下文
    enabled: true                 # 热更新
    maxPerTurn: 20                # 热更新 · ★ 需求方明确要求可配置
    showUsername: true
    showTime: true
    includeNonText: true          # 图片/文档等以占位符入上下文
  rebase:                         # D1
    injectNotice: false           # 热更新 · rebase 时是否插入可见的说明消息
    markMeta: true                # 热更新 · 是否在消息 meta 标记 rebased（建议保持 true）
  cacheCommits: 64                # 需重启 · 物化结果 LRU 容量
  tokenRatioAlpha: 0.2            # 热更新 · 估算校准 EMA 系数

# ============================================================ concurrency
concurrency:
  mode: parallel                  # 热更新 · parallel（D1）| serial（逃生舱）
  perKey: 3                       # 热更新
  global: 8                       # 热更新
  queueMax: 20                    # 热更新
  coalesceSameUserMs: 0           # 热更新 · >0 时合并同用户连续触发
  turnTimeoutMs: 600000           # 热更新
cancel:
  commitPartial: false            # 热更新 · 取消时是否提交已生成部分

# ============================================================ prompt & memory（D11, D12）
prompt:
  maxTokens: 12000                # 热更新 · block 0–6 总上限
  includeToolCatalog: true        # 热更新
  runtimeBlock:
    showQuota: true
    showContextWatermark: true
    showWorkspace: true
memory:
  dir: ./memory                   # 需重启
  pubWriteMinRole: trusted        # 热更新 · ★ D12 安全阀
  pubWriteRequiresApproval: false # 热更新 · 多群部署建议 true
  softLimitTokens: 1500           # 热更新 · 超出触发异步压缩
  hardLimitTokens: 3000           # 热更新 · 超出拒绝写入
  maxSections: 12
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
  maxDepth: 3                     # 热更新
  maxConcurrentSubagents: 3
  maxSubagentsPerTurn: 10
  askTimeoutMs: 120000
  maxAsksPerRun: 5
  askArbiter: true                # 热更新 · 用 low 档模型仲裁 ask_parent
  askEscalateToUser: false        # 热更新 · 仲裁失败时是否转人工
  progressThrottleMs: 3000
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
  healthDownCooldownMinutes: 30
  requestTimeoutMs: 120000        # 热更新
  streamIdleTimeoutMs: 60000      # 热更新 · 流式无数据超时

# ============================================================ tools（D10）
tools:
  maxRegistered: 80               # 热更新
  maxCallsPerTurn: 40             # 热更新
  maxConsecutiveErrors: 3         # 热更新
  defaultTimeoutMs: 60000
  fs:
    maxReadBytes: 262144
    maxWriteBytes: 5242880
    showHidden: false
    allowHostFsForOwner: false    # 热更新 · ★ 危险，WebUI 有红色警告
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
    trashDir: .luoli-trash
    backupDir: .luoli-bak
  exec:
    defaultTimeoutMs: 60000
    maxTimeoutMs: 300000
    maxOutputBytes: 65536
  archive:
    defaultSearchLimit: 20
    maxSearchLimit: 100
    defaultReadLimit: 50
    maxReadLimit: 200
  tg:
    maxExtraMessagesPerTurn: 3
    maxFileSendMb: 50
  web:
    maxResponseBytes: 2097152
    summarizeWithAlias: low       # 热更新 · web_fetch 的 prompt 摘要用哪个别名
    allowlist: []                 # 热更新 · 空则 limited 角色不可用 web_fetch
    denylist: ['*.local', '*.internal']
    searchProvider: ''            # brave | serper | tavily | ''（空则不注册 web_search）
    searchApiKeyRef: ''           # ${env:...}

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
```

**`hostWorkspaceDir` 只在「应用自己跑在容器里 + `mode: docker`」时需要。** `docker run -v` 的左半边
由**宿主** daemon 解析，而 `run()` 拿到的是本进程视角的路径（容器里是 `/app/data/workspace/<chatId>`）。
两者不一致时 docker 不报错，只是在宿主上默默建一个空目录 —— 结果 `bash` 写的文件 `read_file` 读不到，
反过来也一样。因此 `Sandbox` 在检测到自己位于容器内（`/.dockerenv` 或 `/run/.containerenv`）
且该项为空时**直接禁用执行类工具**并报 `sandbox.unavailable`，而不是挂一个错的目录上去。

`docker-compose.yml` 已通过 `LUOLI_HOST_WORKSPACE_DIR: ${PWD}/data/workspace` 提供该值。
换算越界（传入的 workspace 不在 `workspaceDir` 之下）同样拒绝执行，不做兜底。

```yaml
# ============================================================ approval
approval:
  enabled: true                   # 热更新
  ttlMs: 180000
  skipForOwner: true
  allowInitiator: false
  rememberWithinTurn: true
  rules:                          # 热更新（WebUI 可编辑）
    - tool: bash
      pattern: '(?i)\b(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|:\(\)\{|chmod\s+777\s+/)'
      risk: high
    - tool: bash
      pattern: '(?i)\b(curl|wget|nc|ssh|scp)\b'
      risk: medium
    - tool: [write_file, move_file]
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
  replyDelayMs: 2000              # 距离用户那条消息至少等这么久才发第一条回复（0 = 立刻回）；
                                  # 窗口内流式产出的文本只攒不发，typing 动作照常
  streamIntervalMs: 2000          # 两次消息编辑之间的最小间隔
  streamMinDeltaChars: 24
  flushOnSentence: true
  maxMessageChars: 3900
  parseMode: MarkdownV2           # MarkdownV2 | HTML | none
  typingWhileWorking: true
  placeholderAfterMs: 4000
  maxMentions: 3

# ============================================================ media（D16）
media:
  dir: ./data/files               # 需重启
  maxImageBytes: 8388608
  maxDocBytes: 20971520
  maxImageEdge: 1568
  maxImagesPerTurn: 4
  groupDebounceMs: 1500
  stickerAsImage: false
  downloadVoice: true             # 存盘但不解析（不做 STT）
  extract:
    enabled: true
    maxChars: 40000
    inlineChars: 4000             # 超出时只注入前 N 字 + 提示用 read_file
    codeExtensions: [.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.kt,.sh,.sql,.yaml,.yml,
                     .toml,.json,.md,.html,.css,.c,.cpp,.h]

# ============================================================ skills / plugins / mcp（D14）
skills:
  enabled: true                   # 热更新
  dir: ./skills                   # 需重启
  watch: true                     # 需重启
  defaultMinRole: trusted         # 热更新
plugins:
  enabled: true                   # 热更新
  dir: ./plugins                  # 需重启
  watch: false
  hookTimeoutMs: 5000
  order: []                       # 热更新 · plugin 名顺序，决定 hook 执行序
  autoDisableAfterErrors: 3
mcp:
  enabled: false                  # 热更新
  connectTimeoutMs: 15000
  healthCheckCron: '*/5 * * * *'
  defaultMinRole: trusted
  servers: []                     # 见 07 §4.1

# ============================================================ db
db:
  path: ./data/luoli.db           # 需重启
  backupKeep: 5
  vacuumCron: '0 5 * * 0'         # 需重启
  ftsTokenizer: trigram           # 需重启 · trigram | unicode61

# ============================================================ logs（见 10）
logs:
  level: info                     # 热更新
  dir: ./logs                     # 需重启
  captureBodies: true             # 热更新
  bodyMaxBytes: 262144
  maxFileMb: 128
  retentionDays: 30
  gzipAfterDays: 3
  console: pretty                 # pretty | json | off
  redactPatterns: []

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
    maxToolCalls: 40
    maxSubagents: 10
    maxDurationMs: 600000
  rateLimit:
    turnsPerUserPerHour: 30
    turnsPerChatPerHour: 100
    concurrentPerUser: 2
  onExceeded:
    reply: true
    message: '今天的额度用完了（已用 {spent}/{limit}），{resetAt} 重置。'
    notifyOwner: true
  warnAtRatio: 0.8

# ============================================================ webui（D15）
webui:
  enabled: true                   # 需重启
  host: 127.0.0.1                 # 需重启 · ★ 默认回环
  port: 8787                      # 需重启
  basePath: /
  publicUrl: ''                   # 用于 /webui 一次性登录链接
  sessionTtlHours: 168
  passwordHash: ''                # 由首次启动向导或 `pnpm webui:passwd` 写入
  trustProxy: false
  allowOrigins: []
  loginRateLimit: { attempts: 5, windowMinutes: 15 }

# ============================================================ alerts
alerts:
  notifyOwner: true               # 热更新
  dedupeMinutes: 30
  webhookUrl: ''
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
context.limit.*        context.background.*      context.scope
trigger.*
agent.main.*
character（指向 memory/ 下的替代人设文件）
memory.pubWriteMinRole（只允许比全局更严格）
```

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
- 需重启项的判定写在 zod schema 的 `.describe()` 元数据里（`{ hot: false }`），WebUI 与文档同源。

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
