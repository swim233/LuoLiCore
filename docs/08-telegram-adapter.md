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
type TriggerReason = 'private' | 'mention' | 'reply' | 'command' | 'wakeword';

function matchTrigger(ctx, cfg): TriggerReason | null {
  if (ctx.access.isPrivate) return cfg.trigger.private ? 'private' : null;

  // 1) @提及：entities 中 type='mention' 且值 === '@'+botUsername
  //    或 type='text_mention' 且 user.id === botId
  if (cfg.trigger.mention && hasBotMention(ctx.message, bot.botInfo)) return 'mention';

  // 2) 回复 bot 的消息
  if (cfg.trigger.reply && ctx.message?.reply_to_message?.from?.id === bot.botInfo.id) return 'reply';

  // 3) bot 命令（entities type='bot_command' 且在 offset 0，命令属于我们且 @后缀匹配或缺省）
  if (cfg.trigger.command && isOurCommand(ctx.message, bot.botInfo)) return 'command';

  // 4) 唤醒词 / 正则（会话级覆盖 > 全局）
  const pats = cfg.perChat[key]?.wakewords ?? cfg.trigger.wakewords;   // string[] | /re/
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
  wakewords: ['洛璃', '^小助手[，,、 ]']     # 字符串按「包含」匹配；以 ^ 开头则视为正则
  wakewordMinLength: 2
  requireTextAfterMention: false   # true 时「只 @ 不说话」不触发
  ignoreEditedAsTrigger: true      # 编辑消息不作为新触发
  cooldownMsPerUser: 0             # >0 时同用户在冷却期内的触发被忽略（回一个 reaction 表示已收到）
```

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
  streamIntervalMs: 1500      # 编辑节流
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
首个 chunk 到达（或 1.2s 后仍无内容）→ sendMessage(占位或首段) → 记 messageId
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
| 图片 photo | ✓ | ✓（取最大尺寸，`media.maxImageBytes` 默认 8MB） | `image` part（模型需 vision，否则降级 `[图片: caption]`） |
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
- 进上下文：`{ type:'image', image: <base64 或 file://>, mediaType:'image/jpeg' }`。
- 一轮内图片数上限 `media.maxImagesPerTurn`（默认 4），超出丢最旧并注明。
- 若当前别名模型 `capabilities.vision=false` → `prepareStep` 切 `vision` 别名；无 `vision` 别名则降级为占位符 + 回复末尾提示「当前模型不支持看图」。

### 7.3 媒体组（相册）

同 `media_group_id` 的多条消息会被 Telegram 分成多个 update。`mediaGroupDebounce`：
- 首条到达时建一个 buffer，等 `media.groupDebounceMs`（默认 1500）；
- 期间同组消息合并；
- 超时后作为**一条逻辑消息**继续管线（`messages` 仍逐条入库，触发判定用带 caption 的那条，上下文里合并为一条 `user` 消息含多个 image part）。

---

## 8. 命令

| 命令 | Scope | minRole | 行为 |
|---|---|---|---|
| `/start` | private | limited | 欢迎语 + 能力简介 + 当前权限 |
| `/help` | all | limited | 命令列表（按角色过滤） |
| `/ask <text>` | group | limited | 显式触发（等价 @bot） |
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
| `/wake [add\|del\|list] [pattern]` | group | trusted | 管理本会话唤醒词 |
| `/usage [today\|month]` | all | limited | 本会话/本人用量；owner 看全局 |
| `/webui` | private | owner | 返回带一次性 token 的 WebUI 登录链接（可选，见 [09 §2.3](./09-webui.md#23-可选telegram-一次性登录链接)） |
| `/ping` | all | limited | 健康检查：版本、上线时长、模型别名、DB 大小 |

- 命令**不进 AI 流程**（除 `/ask`），直接由 handler 处理并回复；命令消息仍归档（`kind='text'`, `triggered=1`, `trigger_reason='command'`），但**不进上下文**（`commands.archiveToContext=false`，避免污染对话）。
- `/new`、`/undo`、`/model` 等改变状态的命令回复里附当前状态摘要，便于确认。
- 群里带 `@botusername` 后缀的命令（`/new@mybot`）正确解析；不带后缀且群内有多个 bot 时按 Telegram 惯例仍处理（可用 `telegram.strictCommandSuffix` 关掉）。

---

## 9. 错误呈现

面向用户的错误文案**不暴露内部细节**，但给出可引用的 turn id：

| 情况 | 文案 |
|---|---|
| 模型全部失败 | `模型暂时不可用，稍后再试。(ref: 01J8…)` |
| 配额超限 | `今天的额度用完了（$1.00/$1.00），明天 00:00 重置。` |
| 排队已满 | `我这边排队满了，等会儿再叫我。` |
| 权限不足（用户显式要求高危操作） | `这个操作需要更高权限，找管理员吧。` |
| 上下文过大中止 | `这轮内容太多，我先停下。用 /new 开个新话题，或把任务拆小些。` |
| 未捕获异常 | `出了点问题，已记录。(ref: 01J8…)` |

所有这些同时写 `log_events(level='error'|'warn')`，`ref` = `turn_id` 前 12 位，owner 可在 WebUI 用它直接检索完整 trace。
