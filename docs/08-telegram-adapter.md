# 08 · Telegram 适配层

技术选型：**grammY**（D20）。默认长轮询，Webhook 可选。

## 1. Bot 初始化

```ts
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';

const bot = new Bot(env.BOT_TOKEN, {
  client: { canUseWebhookReply: () => false },   // 统一走 API 调用，便于限流与日志
});
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
bot.api.config.use(apiThrottler({
  global:  { minTime: 34,   reservoir: 30, reservoirRefreshInterval: 1000, reservoirRefreshAmount: 30 },
  group:   { minTime: 1000, reservoir: 20, reservoirRefreshInterval: 60000, reservoirRefreshAmount: 20 },
  out:     { minTime: 1000 },
}));
bot.api.config.use(loggingTransformer);          // 自建：每次 Bot API 调用记一条 span
```

启动模式：

| 模式 | 配置 | 说明 |
|---|---|---|
| 长轮询（默认） | `telegram.mode: 'polling'` | `bot.start({ allowed_updates, drop_pending_updates })` |
| Webhook | `telegram.mode: 'webhook'` + `telegram.webhook.{url,path,secretToken}` | Hono 挂 `webhookCallback(bot, 'hono')`；校验 `X-Telegram-Bot-Api-Secret-Token`；须 HTTPS（自行前置反代） |

- `allowed_updates: ['message','edited_message','callback_query','my_chat_member','message_reaction']`
- `telegram.dropPendingOnStart`（默认 `false`）：为 true 时启动丢弃积压更新（避免重启后回复一堆旧消息）。
- 启动时 `setMyCommands` 同步命令列表（按 scope 区分 private/group，owner 命令通过 `BotCommandScopeChat` 单独设给 owner）。

---

## 2. 中间件链（顺序即安全语义）

```
1. errorBoundary            捕获全部异常 → 日志 → 不让进程挂
2. traceContext             生成 update span，注入 ctx.trace
3. dedupUpdate              processed_updates 表去重（重启后仍有效）
4. resolvePrincipals        role(user) / role(chat) / effective；写 ctx.access
5. accessGate               effective=blocked → 记 access.denied 日志，return（不入库、不回复）
6. ignoreSelfAndBots        from.is_bot 且不在 telegram.allowBots → return
7. commandRouter            命令（/new /ctx ...）在此分流处理，不进 AI 流程
8. mediaGroupDebounce       同 media_group_id 聚合等待 1.5s
9. downloadAttachments      下载 + 抽取文本（限流、限大小）
10. archive                 messages / attachments 落库 + FTS
11. triggerMatcher          决定是否触发；非触发 → return（消息已入库，等下次被认领为背景）
12. quotaGate               超额 → 回复额度提示 → return
13. concurrencyGate         排队/拒绝
14. turnRunner              进入核心流程（01 §2 步骤 9 起）
```

### 2.1 去重

```ts
// processed_updates(update_id PK, ts)
if (!(await db.updates.tryInsert(ctx.update.update_id))) { log.debug('dup update'); return; }
```
长轮询理论上不会重复投递，但 Webhook 重试、进程重启窗口会。7 天后清理。

### 2.2 主体解析

```ts
const userId = String(ctx.from?.id ?? '');
const chatId = String(ctx.chat?.id ?? '');
const uRole  = await principals.roleOf('user', userId);
const cRole  = ctx.chat?.type === 'private' ? (await principals.roleOf('chat', chatId) ?? uRole)
                                            : await principals.roleOf('chat', chatId);
ctx.access = { userId, chatId, userRole: uRole, chatRole: cRole,
               effective: minRole(uRole, cRole), isPrivate: ctx.chat?.type === 'private' };
```

同时 upsert `principals` 的 `display_name`/`username`/`chat_type`（保持 WebUI 可读性），但**不改 role**。

### 2.3 `my_chat_member`

- bot 被加入新群 → 自动插入 `principals['chat:<id>']` 为 `access.defaultChatRole`（默认 blocked），并**私聊通知 owner**：「已被加入群「X」(id)，当前角色 blocked，是否授权？」附 inline `[授权 limited] [授权 trusted] [忽略]`。
- bot 被移出 → 标记 `principals.note='removed at <ts>'`，不删数据。

---

## 3. 归档

见 [03 §2.2](./03-data-model.md#22-原始消息归档)。要点：

- **无论是否触发都入库**（需求明确）。唯一例外：`effective=blocked`（且 `access.archiveBlocked=false`）。
- `text` 字段 = `message.text ?? message.caption ?? null`。
- `raw_json` 存完整 `ctx.message`（供未来功能演进，不必重新设计表）。
- 出站消息在发送成功后也入库（`direction='out'`, `from_kind='bot'`, `turn_id`），失败则记 `warn` 日志不入库。
- **`edited_message`**：写 `revision+1` 的新行；若原消息已被认领进上下文，**不修改上下文**，仅在下一轮的 RUNTIME 块提示「#12841 已被编辑」（`telegram.notifyEdits`，默认 `true`）。

---

## 4. 触发判定

> 对应决策 D5。

```ts
type TriggerReason = 'private' | 'mention' | 'reply' | 'command' | 'wakeword' | 'ask';

function matchTrigger(ctx, cfg): TriggerReason | null {
  // 0) 命令要先判：私聊分支排在它前面的话，/new 会被当成普通对话（既开一轮，又跑 handler）。
  //    只认 entities type='bot_command' 且 offset=0、名字在 HANDLED_COMMANDS 里、@后缀匹配或缺省。
  const name = commandNameOf(ctx.message, bot.botInfo, cfg.telegram.strictCommandSuffix);
  if (cfg.trigger.command && name === 'ask') return 'ask';            // 唯一进 AI 流程的命令
  if (name && HANDLED_COMMANDS.has(name)) return cfg.trigger.command ? 'command' : null;

  if (ctx.access.isPrivate) return cfg.trigger.private ? 'private' : null;

  // 1) @提及：entities 中 type='mention' 且值 === '@'+botUsername
  //    或 type='text_mention' 且 user.id === botId
  if (cfg.trigger.mention && hasBotMention(ctx.message, bot.botInfo)) return 'mention';

  // 2) 回复 bot 的消息
  if (cfg.trigger.reply && ctx.message?.reply_to_message?.from?.id === bot.botInfo.id) return 'reply';

  // 4) 唤醒词 / 正则。整个 cfg 先经 perChatConfig(cfg, key) 合并，会话级 trigger 覆盖整体替换
  //    同名的全局值（不是并集），所以上面三步用的也是合并后的开关。
  const pats = cfg.trigger.wakewords;   // string[]，以 ^ 开头的条目按正则处理
  if (pats?.length && matchAny(text, pats)) return 'wakeword';

  return null;
}
```

配置：

```yaml
trigger:
  private: true
  mention: true
  reply: true
  command: true
  wakewords: ['洛璃', '^小助手[，,、 ]']     # 字符串按「包含」匹配（忽略大小写）；以 ^ 开头则视为正则
  wakewordMinLength: 2
  requireTextAfterMention: false   # true 时「只 @ 不说话」不触发
  ignoreEditedAsTrigger: true      # 编辑消息不作为新触发
  cooldownMsPerUser: 0             # >0 时同用户在冷却期内的触发被忽略（回一个 reaction 表示已收到）
```

- **唤醒词的可用性**由 `checkWakeword`（`packages/core/src/config/wakeword.ts`）统一判定，运行时匹配与
  WebUI 写入端共用这一份：去掉前导 `^` 后短于 `wakewordMinLength`、正则超过 128 字符、或含回溯风险结构
  （嵌套量词、反向引用、lookahead/lookbehind）的模式**整条跳过且不求值**（ReDoS 防线），正则只扫描消息前 4096 字符。
  跳过是静默的，所以启动时会以 `config.invalid` 告警列出这些模式，写入端（`PUT /api/config`、
  `PATCH /api/chats/:key`）直接返回 400 并说明原因——收下一个永远匹配不上的模式等于让运维以为配好了。
- **包含型唤醒词忽略大小写**（`matchesWakeword`，与 `checkWakeword` 同文件）：`nori` 同时匹配
  `Nori` / `NORI`。手机输入法会把句首自动大写，大小写敏感的话唤醒词就成了「只在特定拼写下生效」的
  暗规则，用户侧只表现为 bot 时灵时不灵。**正则型不改**：按作者写的大小写求值，要忽略大小写就写
  `^(?i)nori`（RE2 支持内联标志）——不替作者改语义，也保住「我就是要区分大小写」这个表达能力。
  判成正则的前缀有两种：`^` 与 `(?i)` 这类内联标志组，两种拼法都认（`(?:` 不会被误判）。
- **频道消息**（`chat.type='channel'`）：默认不参与（`trigger.channels=false`）。
- 匿名管理员发言（`sender_chat` 存在，`from` 为群本身）：`from_user_id` 记为 `chat:<id>`，角色取该 chat 的角色，`from_name` = 群名 + `(匿名管理员)`。
- **反循环**：`from.is_bot === true` 一律不触发（即使 @了我们），除非 `telegram.allowBots` 里显式列出该 bot 的 username。

---

## 5. 输出与流式

> 对应决策 D18。

### 5.1 模式

```yaml
output:
  mode: stream                # stream | once   （可 perChat 覆盖）
  replyDelayMs: 2000          # 第一条回复的最早发出时刻（相对用户那条消息），0 = 立刻回
  streamBufferMs: 2000        # 第一条回复的最早发出时刻（相对上游第一个 chunk），0 = 首个 chunk 到就发
  streamIntervalMs: 2000      # 编辑节流
  streamMinDeltaChars: 24     # 增量太小不编辑
  flushOnSentence: true       # 遇到 。！？\n 提前 flush（更自然）
  maxMessageChars: 3900       # < 4096 留余量给尾注
  parseMode: MarkdownV2       # MarkdownV2 | HTML | none
  typingWhileWorking: true
  maxMentions: 3
```

### 5.2 流式算法

```
sendChatAction('typing')  → 每 4s 续期，直到首次消息发出
首条发出时刻 = max(用户消息到达 + replyDelayMs, 上游首个 chunk 到达 + streamBufferMs)
到点后的第一个 chunk → sendMessage(此刻攒到的全部文本) → 记 messageId → 计入一次刷新
循环：
  累积 buffer
  若 (now - lastEdit ≥ streamIntervalMs) 且 (Δchars ≥ streamMinDeltaChars 或 命中句末)
      → editMessageText(messageId, safeRender(buffer))
  若 buffer 超 maxMessageChars
      → 在安全边界切分（优先 \n\n > \n > 。！？ > 空格 > 硬切）
      → 定稿当前消息（最后一次 edit）→ sendMessage 新消息承接后续
生成结束：
  最后一次 editMessageText（无论节流）
  移除「⏳」类标记
```

- **回复节奏**：两道窗口，锚点不同，取晚的那个；窗口内产出的 chunk **只攒不发**（不是丢弃），
  到点后连同已攒的文本一起作为第一条消息发出；`typing` 动作照常，看起来是在打字而不是卡住。
  - `replyDelayMs` 锚在**用户消息的到达时刻**：防秒回。模型本来就想了 3 秒时不会再多压 2 秒。
  - `streamBufferMs` 锚在**上游第一个 chunk 的到达时刻**：攒够首帧。只有前一道时，模型思考一旦超过
    `replyDelayMs`（几乎总是如此）窗口就已经过期，首个 chunk 会被原样发出去 —— 用户先收到一条
    只有一个字的消息，剩下的全靠编辑补出来。这是这条规则存在的唯一原因。
  - 流在窗口内就跑完时走结尾的一次性 `send`：不再等 `streamBufferMs`（已经没有东西可攒了），
    但仍受 `replyDelayMs` 约束 —— 短回答同样不会秒回。非流式（`mode='once'` 与 agent 直接返回
    字符串）只走 `replyDelayMs` 这一道。
- **编辑节奏**：`streamIntervalMs` 与 `streamMinDeltaChars` 是**同时满足**才编辑。首条消息发出
  （以及超长切分出的每条后续消息）本身算一次刷新，因此紧随其后的那个 chunk 不会立刻触发一次编辑
  —— 那条消息里已经是同一段文本，多出来的两三个字不值一次 `editMessageText`。收尾的最后一次编辑
  不受这两项约束。四项都可在 WebUI「设置 → 输出节奏」里改，保存后下一轮生效；在途那一轮沿用开轮时的值。
- **模型这轮一个字都没吐**（`final` 与流式累积都为空）→ 按失败处理：不提交空的 assistant 消息，
  回一句 `model_returned_empty` 对应的说明 + ref。空正文发不出去（`splitTelegramText('')` 是空数组），
  照旧提交等于让用户面对彻底的沉默，还在上下文里留一条谁都解释不了的空消息，下一轮照样带给模型
  （[16 §5](./16-remediation-plan.md) 「摘除比伪造安全」）。`final` 为空但流里已经发出去了内容时，
  以已经发出去的为准 —— 否则用户盯着屏幕上的回复，却又收到一句「这轮没成」。
- 编辑遇 `400 message is not modified` → 忽略。
- 编辑遇 `429` → **跳过本次增量**（不排队），下次节流窗口再试。
- 编辑遇 `400 can't parse entities` → 用 `parse_mode: undefined` 重试一次；再失败则把内容作为 `.md` 文档发出并回复一句摘要。
- `output.mode='once'`：只在结束时 `sendMessage`（仍做分片），全程 `typing`。

### 5.3 MarkdownV2 安全渲染

模型输出的是通用 Markdown，Telegram MarkdownV2 转义规则极严。实现 `safeRender(text)`：

1. 解析为 AST（`marked` 的 lexer）。
2. 支持的节点：段落、`strong`、`em`、`del`、`code`、`codespan`、`link`、`list`、`blockquote`、`br`。
3. 不支持的节点降级：`heading` → `*粗体*` + 换行；`table` → 等宽代码块；`hr` → `——————`；`image` → `[图片](url)`。
4. 文本节点按 MarkdownV2 规则转义 `_*[]()~\`>#+-=|{}.!`，代码块内只转义 `` ` `` 和 `\`。
5. 未闭合的代码围栏（流式中途很常见）→ 渲染时**临时补上闭合**，下次编辑再更新。
6. 渲染结果做长度校验，超限交给分片器。

单测覆盖：中英混排、嵌套列表、流式截断在代码块中间、链接内含特殊字符（AC-TG-01x）。

---

## 6. 长任务与进度

> 对应决策 D17。

```
用户: @bot 帮我把 /workspace/logs 里所有 error 归类统计
bot:  ⏳ 已接收，正在处理…                      [取消]        ← 占位消息(placeholder)
      ⏳ 检索中（12/40 文件）                    [取消]        ← report_progress 触发编辑
      ⏳ 分析中（researcher）                    [取消]
      ✅ 共 3 类 error，最多的是 …（正文）                     ← 定稿（编辑同一条消息）
```

- **何时出现占位消息**：`spawn_agent` 被调用，或首个 chunk 迟于 `output.placeholderAfterMs`（默认 4000ms）。日常聊天不会看到它。
- **占位消息说什么**：`output.placeholderTexts` 里的备选文案（默认只有一条 `…`），按 `output.placeholderPick`
  随机挑或恒用 `output.placeholderIndex` 那条；三项都能 `perChat` 覆盖，WebUI 在设置页「输出节奏」卡片里
  （[09 §3.13](./09-webui.md)）。**列表清空 = 不发占位消息**，这是关掉它的唯一途径。文案在开轮时就挑定，
  不是在定时器回调里挑 —— 随机档挑在回调里的话，消息内容和渲染基线会分处两个时刻。
  占位消息发出后渲染基线记 0 而不是文案长度：`lastRenderedLength` 量的是「答复渲染了多少字」，
  占位消息里一个字都不是答复；记成文案长度会让长文案把第一次编辑推后十几个字。
- 进度来源：`report_progress` 工具、`spawn_agent` 的 `yield`、内部阶段事件（快照、模型调用、工具执行）。节流 `agent.progressThrottleMs`（默认 3000）。
- 取消按钮：`callback_data = 'c:<turnId>'`（≤64 字节）。点击后：
  - 校验点击者 = turn 发起人 或 owner，否则 `answerCallbackQuery({text:'只有发起人或管理员可以取消', show_alert:true})`；
  - 调 `turnRunner.cancel(turnId, 'user')` → `AbortController.abort()` → 级联子 agent、`docker kill` 沙箱容器；
  - 编辑消息为「⛔ 已取消」，按 `cancel.commitPartial`（默认 false）决定是否提交部分 delta（[02 §3.5](./02-context-engine.md#35-取消cancel)）。
- `/tasks`：列出本会话 `state='running'` 的任务（id、标题、已运行时长、进度）。`/cancel [id]`：无 id 时取消本人最近一个在途 turn。
- 任务超时 `concurrency.turnTimeoutMs`（默认 10 分钟）→ 视为 cancelled，消息编辑为「⛔ 超时中止」。

---

## 7. 多模态

> 对应决策 D16。

| 类型 | 归档 | 下载 | 进上下文 |
|---|---|---|---|
| 文本 | ✓ | — | 正文 |
| 图片 photo | ✓ | ✓（取最大尺寸，`media.maxImageBytes` 默认 8MB） | `file` part + `mediaType:'image/*'`（模型需 vision，否则降级 `[图片: caption]`） |
| 文档 document | ✓ | ✓（`media.maxDocBytes` 默认 20MB） | 见下 |
| 贴纸 sticker | ✓ | 仅静态 webp | `[贴纸 😄]`（`emoji` 字段）；`media.stickerAsImage`（默认 false）时作为图片 |
| 动图 animation | ✓ | ✗ | `[动图]` |
| 语音 voice / 音频 audio | ✓ | ✓（存盘，不解析） | `[语音 12s]`（**不做 STT**，D16） |
| 视频 video / video_note | ✓ | ✗（仅 thumb） | `[视频 0:34]` |
| 位置 location | ✓ | — | `[位置 39.90,116.40]` |
| 投票 poll | ✓ | — | `[投票: 问题 / 选项…]` |
| 联系人等其他 | ✓ | — | `[<type>]` |

### 7.1 文档文本抽取

```yaml
media:
  extract:
    enabled: true
    maxChars: 40000          # 抽取上限，超出截断并标注
    types:
      text/plain: direct
      text/*: direct
      application/json: direct
      application/pdf: pdf-parse
      application/vnd.openxmlformats-officedocument.wordprocessingml.document: mammoth
      text/csv: csv-head      # 只取前 200 行 + 列统计
    codeExtensions: [.ts,.tsx,.js,.py,.go,.rs,.java,.sh,.sql,.yaml,.yml,.toml,.md,.html,.css]
```

- 抽取结果写 `attachments.extracted_text`；进上下文时形态：
  ```
  [文档 report.pdf 1.2MB, 已抽取 8,412 字]
  <untrusted-content id="a1b2c3" source="file:report.pdf">
  …前 N 字…
  </untrusted-content id="a1b2c3">
  ```
- `untrusted-content` 只用于上述文件抽取正文等外部数据。普通聊天触发消息保持可执行请求语义；未触发的群背景消息使用独立 `<group-message>` 标记，表示「他人发言，仅供上下文」，不使用 `untrusted-content`。
- 超 `maxChars` → 只注入前 4000 字 + 提示「完整内容在 /workspace/.luoli-files/report.pdf，可用 read_file 分段读取」，并把文件软链/拷贝进该会话 workspace。
- 抽取失败 → `extract_state='failed'`，上下文只留占位符，不阻塞。

### 7.2 图片处理

- 下载后用 `sharp` 归一化：最长边 ≤ `media.maxImageEdge`（默认 1568，与主流 vision 模型的最优输入吻合），转 JPEG q85，写 `data/files/`。
- 进上下文：`{ type:'file', data: <base64 或 file://>, mediaType:'image/jpeg' }`。
  **不是 `image` part**：AI SDK v7 起 `image` 已废弃，SDK 内部照样把它转成 `file` 再发给 provider，
  只是顺带对每一张图打一条 DeprecationWarning。库里的历史 `image` part 由读出侧
  （`runtime.ts` 的 `contextMessages`）就地转换 —— parts 是持久化的，不兜就得等图片滚出窗口。
- 一轮内图片数上限 `media.maxImagesPerTurn`（默认 4），超出丢最旧并注明。
- 若当前别名模型 `capabilities.vision=false` → `prepareStep` 切 `vision` 别名；无 `vision` 别名则降级为占位符 + 回复末尾提示「当前模型不支持看图」。

### 7.3 媒体组（相册）

同 `media_group_id` 的多条消息会被 Telegram 分成多个 update。`mediaGroupDebounce`：
- 首条到达时建一个 buffer，等 `media.groupDebounceMs`（默认 1500）；
- 期间同组消息合并；
- 超时后作为**一条逻辑消息**继续管线（`messages` 仍逐条入库，触发判定用带 caption 的那条，上下文里合并为一条 `user` 消息含多个图片 part）。

### 7.4 回复中的媒体（被回复消息的取回）

「回复一张图 + 唤醒词」是多模态最常见的用法，而它以前 100% 拿不到图：上下文只有窗口 + 背景认领，
被回复的那条消息**两条路都够不着**（[02 §4.1.1](./02-context-engine.md)）。实测更极端 ——
`access.defaultUserRole=blocked` 的群里，别人发的图从来不进归档（logs/2026-08-16：被回复的
183757 / 183862 / 183865 三条图，`messages` 表里一条都没有）。

关键事实：Telegram 的 update **自带被回复消息的完整副本**（含 `file_id`），所以「库里没有」
不等于「拿不到」。触发消息归档之后（且触发原因不是 `command`）：

1. `reply_to_message.chat.id` 与当前 chat 不同（关联频道、`external_reply`）→ 不取，拉进来只会污染这个 context key。
2. 库里已有该 `tg_message_id`（取最新 revision）→ 直接复用；已有 media part 就不重复下载。
3. 库里没有 → 用 update 里那份副本现场归档，再跑一遍 `TelegramMedia.process` 下载并归一化它的媒体。
   这一行落库时直接标 `claimed_at`（`claimed_by_turn` 留空）：本轮就把它送进上下文了，
   下一轮 `claimBackground` 不能再把它当新的背景发言认领一次，而 `abortTurn` 的 `releaseClaims` 也不该把它放回去。
4. 被回复者的显示名挂到触发消息上（`replyToName`，不落库），渲染成群聊前缀里的 `↩︎回复 <名字>`。

> 这条路径会把 blocked 用户发的图片落进 `attachments` —— 与 `access.archiveBlocked=false` 的取向
> 相反，但触发它的是 owner 自己「回复这条消息并唤醒 bot」的动作，是显式的、单条的引用，
> 而不是持续归档。

`messages.reply_to_tg_message_id` / `media_group_id` 两列建表时就有，此前从未写入；现在两条路径
（触发消息与被回复消息）都写。

---

## 8. 命令

| 命令 | Scope | minRole | 行为 |
|---|---|---|---|
| `/start` | all | limited | 欢迎语 + 能力简介 + 当前权限 |
| `/help` | all | limited | 命令列表（按角色过滤） |
| `/ask <text>` | all | limited | 显式触发（等价 @bot）。**唯一进 AI 流程的命令**，`matchTrigger` 为它返回 `'ask'` 而不是 `'command'`，因此不在 `HANDLED_COMMANDS` 里 |
| `/new` | all | limited | 开新话题（窗口清零，历史保留） |
| `/undo` | all | limited | 撤销上一轮（done 回退一个 commit） |
| `/ctx` | all | limited | 上下文状态；`/ctx export` 导出（owner） |
| `/cancel [id]` | all | limited | 取消在途 turn |
| `/tasks` | all | limited | 在途任务列表 |
| `/model [alias]` | all | trusted | 查看/固定本会话模型别名 |
| `/memory` | private | limited | 查看自己的私有记忆 |
| `/forgetme` | private | limited | 清空自己的私有记忆（可 30 天内恢复） |
| `/whoami` | all | limited | 自己的 user/chat 角色与有效权限 |
| `/whois <id>` | all | owner | 查某主体的角色 |
| `/grant <user\|chat> <id> <role>` | all | owner | 授权 |
| `/revoke <id>` | all | owner | 降为 blocked |
| `/usage [today\|month]` | all | limited | 本会话/本人用量；owner 看全局 |
| `/webui` | owner | 私聊 | 生成一次性控制台登录链接（5 分钟有效、单次使用、进程重启失效）。**群里直接拒绝** —— 登录链接出现在群里等于把 owner 权限递给屏幕前所有人。没配 `webui.publicUrl` 时明说生成不出来，而不是发一条打不开的链接。命令 / handler / 服务端端点三者由 CI 断言锁死（[09 §2.3](./09-webui.md#23-telegram-一次性登录链接)） |
| `/ping` | all | limited | 健康检查：版本、上线时长、模型别名、DB 大小 |

- 命令**不进 AI 流程**（除 `/ask`），直接由 handler 处理并回复；命令消息仍归档（`kind='text'`, `triggered=1`, `trigger_reason='command'`），但**不进上下文**（`commands.archiveToContext=false`，避免污染对话）。
- `/new`、`/undo`、`/model` 等改变状态的命令回复里附当前状态摘要，便于确认。
- 群里带 `@botusername` 后缀的命令（`/new@mybot`）正确解析；不带后缀且群内有多个 bot 时按 Telegram 惯例仍处理（可用 `telegram.strictCommandSuffix` 关掉）。
- 命令归属白名单（`trigger.ts` 的 `HANDLED_COMMANDS`）里**只放已注册 handler 的名字**：判成 `command`
  的消息不进 AI 流程，名字在白名单里却没有 handler，用户发出去就石沉大海。`tests/trigger.test.ts`
  断言「白名单 == `bot.command(...)` 注册集合 == `/help` 命令表」三者一一对应 —— 分成两份就会漂移，
  这正是 `/start` `/help` `/ask` `/whois` `/webui` 五个命令曾经集体静默的原因（docs/20 · W-TG-01）。
  会话唤醒词管理原本设计为 `/wake`、一次性登录链接设计为 `/webui`，两者均已摘除，改在 WebUI 做
  （「摘除比伪造安全」，[16 §5](./16-remediation-plan.md)）。
- **命令判定只认 `bot_command` 实体 + 白名单**，不认裸 `/` 前缀：把「任何以 `/` 开头的文本」都当成命令，
  会绕开白名单与 `trigger.command` 开关，私聊里一句「/home/app 这个目录满了」将得不到任何回应。
- 已注册命令在私聊里同样判成 `command`（不开轮次），否则 `/new` 会既重置上下文又开一轮对话；
  `trigger.command=false` 时这些消息判成 `null`（不触发，但也不当成聊天）。
- **编辑消息永远不开新轮次**，一律按背景消息归档（`triggered=0`）。判成 `triggered=1` 却没人开轮次的话，
  `claimBackground` 的 `triggered=0` 过滤会把它排除 —— 既不触发也不进背景上下文，等于凭空消失
  （docs/20 · W-TG-05）；`trigger.ignoreEditedAsTrigger` 因此标 🚧。
- 同一条规则适用于**所有「判成触发但没开成轮次」的路径**：`cooldownMsPerUser`、`coalesceSameUserMs`、
  `quota.rateLimit`（含 `concurrentPerUser`）、并发队列已满/被取消，都要把这条消息降级成背景消息。
  否则用户那句话既没被回答、也不在下一轮的上下文里。入口并发之后后两条路径才真正可达。

---

## 9. 错误呈现

面向用户的错误文案**不暴露内部细节**，但给出可引用的 turn id：

| 情况 | 文案 |
|---|---|
| 模型全部失败 | `模型暂时不可用，稍后再试。(ref: 01J8…)` |
| 模型未配置（缺 `main` 别名等，见 [04 §5.2](./04-agents-and-providers.md#52-内建别名语义)） | `模型还没配置好，得管理员在 WebUI 里配上 provider 和 main 别名。(ref: 01J8…)` |
| 模型缺定价（`quota.requirePricing`） | `当前模型没配价格，管理员补上定价才能用。(ref: 01J8…)` |
| 配额超限 | `今天的额度用完了（$1.00/$1.00），明天 00:00 重置。` |
| 排队已满 | `我这边排队满了，等会儿再叫我。` |
| 在途轮次达 `quota.rateLimit.concurrentPerUser` | `我同时最多接 2 件事，你手上的还没说完。等它收尾再说这条。`（这一句不受 `quota.onExceeded.reply` 管：它不是额度，等手上那轮说完就能继续） |
| 权限不足（用户显式要求高危操作） | `这个操作需要更高权限，找管理员吧。` |
| 上下文过大中止 | `这轮内容太多，我先停下。用 /new 开个新话题，或把任务拆小些。` |
| 未捕获异常 | `出了点问题，已记录。(ref: 01J8…)` |

所有这些同时写 `log_events(level='error'|'warn')`，`ref` = `turn_id` 前 12 位，owner 可在 WebUI 用它直接检索完整 trace。

运维态失败（模型未配置、缺定价）单独成条而不是并进「模型暂时不可用」：后者暗示「稍后再试」，
而这两种情况用户重试多少次都不会好，必须说清楚该由谁去做什么。
