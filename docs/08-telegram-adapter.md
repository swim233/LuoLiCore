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

**回复一律引用触发消息**（`reply_parameters: { message_id }`），群聊私聊一视同仁。
[14 §2 Q10](./14-open-questions.md) 拍板保持这个行为，**不引入 `output.replyToTrigger`** ——
那个键从来没进过 schema，加一个只为了在私聊里少一层引用块的开关不值得。

多条分片时**只有第一条带引用**，后续分片直接跟发；否则一条长回复会在群里刷出一串引用块。
两条投递路径（流式 `TelegramOutput` 与非流式的字符串兜底）**必须一致** —— 它们曾经不一致：
兜底路径不带引用，于是「没配可用模型」那句提示在群里飘着，没人知道它在回谁。

### 5.2 流式算法

```
sendChatAction('typing')  → 每 4s 续期，直到首条消息发出；之后放宽到 15s，
                            且本轮有正文在途或刚落地时整拍跳过（typing 给正文让路）
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
- **typing 给正文让路**：`typing` 与正文的 `sendMessage` / `editMessageText` 共用同一份 per-chat
  预算（`telegram.throttle.perChatPerMinute`，默认 20/分钟），而两者的可丢性完全不同 ——
  typing 只在「现在」有意义（Telegram 那边约 5 秒过期），丢一拍谁都看不出来；一次 `editMessageText`
  丢掉就是用户永远看不到那一段字。**让一个可丢的请求占住不可丢请求的槽位本身就是错的**，所以：
  - 本轮有正文**在途**（含被节流器压着排队的那段时间）→ 整拍跳过。
  - 首条消息发出**之后**节拍放宽到 15s，且 15s 内有正文落地过就整拍跳过 —— 屏幕上的字在长本来
    就是最好的 typing，这一档 typing 只剩「还在写」这一层意思（长工具调用期间指示器会闪断，
    这是有意的取舍）。首条消息**之前**照旧 4s 一拍：那时屏幕上一个字都没有，typing 是唯一的信号。
  - **不动 grammY 的桶** —— 那是 Telegram 侧的真实限制，不是我们的节流策略。
  上一版只做了「上一拍没落地就跳过这一拍」，减少的是 typing 的**数量**，而那个计数器是
  per `TelegramOutput` 实例（= per 轮次）的 —— 「队列不再增长」只在单轮成立。实测同一个群里
  6 轮并发时 20/分钟 的储备 17 秒被吃光，随后**整整 14 秒零投递**，排在队首的 `sendChatAction`
  排了 14455ms，占的正是后面那条 `editMessageText`（14028ms）要用的槽位，用户视角是「bot 打字
  打到一半不动了」（[reviews/28](./reviews/28-round10-live-system-test.md) · `L-TG-04`）。
- **一条消息的那一批分段按 chat 串行**：每一段各自过一次 `apiThrottler`（`out: { minTime: 1000 }`），
  段与段之间因此有一个「上一段落地了才排下一段」的空档，别的轮次的 `sendMessage` 会在空档里挤进
  队列 —— 实测一条 9469 字的回复切成 3 条，Telegram 给的 id 是 1458 / 1459 / **1467**，中间隔着三轮
  后续对话，真人在屏幕上确认第三段是在后面三条回复之后才冒出来的（`L-TG-02`）。三条出站路径
  （流式定稿、非流式兜底、`send_message` 工具）都把那一批分段包在同一把按 `chatId` 分键的
  `KeyedMutex` 里（`packages/telegram/src/output.ts` 的 `deliveryOrder`，模块级单例 —— 同一个 chat
  的所有轮次必须排同一条队）。**只盖那一批分段，绝不盖流中途的增量编辑**：盖整轮会让同一个群里的
  并发轮次变成实质串行（前一轮跑完才能看到后一轮的字），那是把一个投递顺序问题换成一个吞吐问题。
- **编辑节奏**：`streamIntervalMs` 与 `streamMinDeltaChars` 是**同时满足**才编辑。首条消息发出
  （以及超长切分出的每条后续消息）本身算一次刷新，因此紧随其后的那个 chunk 不会立刻触发一次编辑
  —— 那条消息里已经是同一段文本，多出来的两三个字不值一次 `editMessageText`。收尾的最后一次编辑
  不受这两项约束。四项都可在 WebUI「设置 → 输出节奏」里改，保存后下一轮生效；在途那一轮沿用开轮时的值。
- **模型这轮一个字都没吐**（`final` 与流式累积都为空）→ 按失败处理：不提交空的 assistant 消息，
  回一句 `model_returned_empty` 对应的说明 + ref。空正文发不出去（`splitTelegramText('')` 是空数组），
  照旧提交等于让用户面对彻底的沉默，还在上下文里留一条谁都解释不了的空消息，下一轮照样带给模型
  （[16 §5](./reviews/16-remediation-plan.md) 「摘除比伪造安全」）。
- **归档（`messages.text`）与上下文一律存「真正发出去的那份」，即流里攒到的全文**；
  `generated.final` 只当失败信号用。它是 AI SDK 的 `result.text` = **最后一步**的正文，而多步轮次
  发出去的是「旁白段落 + 结论」整条消息 —— 拿 `final` 落库的话，屏幕上有三段而 `read_messages`
  与 WebUI 会话页只有最后一段，下一轮模型也看不见自己的旁白，用户一句「你上面第二段说的」就无从
  对应（实测两轮真实多步都是这个差异）。只有流里一个字都没有时才回落到 `final`。
- **分段时每个 `message_id` 一行，各存自己那一段**（`L-TG-03`）。`messages` 是「这个 chat 里发生过
  什么」的归档，一条被切成 3 条的回复在 Telegram 那边就是 3 条消息，归档里也该是 3 行不同的正文。
  此前三条出站路径都给每一段存一份**完整全文**：实测一条 9469 字的回复在 `messages` 里躺三行、
  每行 `length(text)` 都是 9469，连带 `messages_fts` 三份 → `search_messages` 把同一条回复搜出三次、
  归档体积按分段数翻倍。**上下文侧不变，仍是一条整全文**（`context_messages` 只有一条）——
  分段是投递侧的事，模型看到的应当是它说过的那一整段话。
  - 归档存的是**渲染前**的正文（`safeRender` 的转义符不进库），而**渲染在分片之前**：分片点是渲染后
    码点数组上的下标，反推不回源文本里的下标（转义、`###` 降级成粗体、列表符号替换都不是可逆的
    1:1 映射）。所以只有一片时直接存整条源文本（口径一个字未变），真的切开时按 `toPlainText` 逐段
    反推 —— 它是解析失败降级时**真正发出去**的那一份，同样不含转义符。近似的只是几个标记的字面
    形态（`**粗**` → `*粗*`、`- 项` → `• 项`），段与 `message_id` 的对应关系是精确的。
    实现见 `segmentTelegramText`。
  - **存量的重复全文不回填**：`messages` 是只追加的归档，历史行按当时的行为留着。
- **`send_message` 工具那条路归档的是 `capMentions` 之后的文本**（此前存收口**前**的原文）：这条路上
  「真正发出去的那份」就是收口后的那份，非流式兜底一直如此，而分段行本来也只能从收口后的文本算出来。
  流式那条路**单条消息**仍存模型原话 —— 那是上下文的口径，这两处刻意一致。
- **两道投递侧改写的时机不同**：`output.maxMentions`（`capMentions`）是同步、廉价的一道，
  **每次刷新都跑**；插件的 `beforeSend` 钩子**只在定稿时跑一次**。此前两者合在一个 async 闭包里、
  只被 `send()` 调用，而流式编辑路径直接调 `splitTelegramText` —— 于是「@ 全群上限」在每个流式
  轮次都没生效。反过来把插件钩子挂到每帧上是改语义（一条消息一次 → 一次编辑一次），不是修 bug。
  **上下文存的是模型原话**，不是改写后的文本；归档也是 —— 只有上面那条「分段时逐段存」的例外：
  分段是在改写并渲染之后算出来的，所以那几行带着 `capMentions` / `beforeSend` 的改写。
  这与本节第一条（归档存真正发出去的那份）一致，不与「上下文存原话」冲突。
- **模型这一轮的最后一步没有正文**（以工具调用或纯 reasoning 收尾）时，`generated.final` 是空串
  —— AI SDK v7 的 `result.text` 语义是「最后一步的正文」，不是全轮拼接。这时先由
  `runMainAgentInternal` 的收尾补跑（`wrapUpIfNeeded`：禁工具、最多一次、上游故障与超预算都不跑）
  让模型自己写一句结论；补不出来才回落到流里攒到的文本，并记一条 `turn.no_final_text` warn。
  没有这一层时，用户收到的「回复」就是工具调用之间的过程旁白，而且它会被提交进上下文
  （logs/2026-08-18 · turn `01M09QBZVK…`）。
- **跨 step 的正文之间恰好一个空行**，由 `stepSeparatedText` 归一化，不看模型自己写了什么。
  `result.textStream` 只透出 `text-delta`，step 边界在 `toTextStream` 里就丢了，投递侧那一行
  `text +=` 于是把每一步的旁白无缝粘成一段；改成从 `result.stream` 走之后，反过来又出现空行爆炸
  —— 模型被提示词教成每一步都以 `\n\n\n` 收尾，纯工具步的「正文」就是 `\n\n\n`，一条 11 步的回复
  开头 10 个换行、中段 12 连换行（logs/2026-08-18 · turn `01M0AKMXG4…`）。所以判据是**扣住尾部
  空白 + 到点补齐**：
  - 一段正文的尾部空白先扣住不发，跨过 step 边界就丢掉，换成恰好一个 `\n\n`；没跨过边界就原样
    发出去 —— 同一步内的增量、列表缩进、围栏代码块里的空行一个字都不动。
  - 纯空白的「正文」不算说过话：不透传、不触发分隔（连续多个纯工具步只补一个空行）。
  - 第一段非空白正文之前什么都不发，流结束时扣住的尾部空白丢弃 —— 整条消息首尾无空白。
  - 流里的 `error` 部件也从这里透出去（`onError` → `streamFailure`），不再被静默跳过。
  见 `stepSeparatedText` 与 `tests/agent.stream-separator.test.ts`。渲染器侧**不做**收窄：
  `safeRender` 的空行保真是既有契约（`tests/output.render.test.ts`）。
- 编辑遇 `400 message is not modified` → 忽略。
- 编辑遇 `429` → **跳过本次增量**（不排队），下次节流窗口再试。
- 编辑遇 `400 can't parse entities` → 用 `parse_mode: undefined` 重试一次；再失败则把内容作为 `.md` 文档发出并回复一句摘要。
- `output.mode='once'`：只在结束时 `sendMessage`（仍做分片），全程 `typing`。

### 5.3 安全渲染

`output.parseMode` 有三档，**每一档都要有自己的渲染出口**。这不是可选的对称性：渲染出的文本与
发出去时挂的 `parse_mode` 必须是同一种语言，否则用户看到的是转义符本身。曾经三档只实现了一个
（`splitTelegramText` 无条件跑 MarkdownV2 渲染器），后果是：

- `none` —— MarkdownV2 文本按纯文本发出去，`C:\temp - 见 issue #3 (1.5x)` 到用户那儿是
  ``C:\\temp \- 见 issue \#3 \(1\.5x\)``；
- `HTML` —— 同一份 MarkdownV2 文本挂 `parse_mode=HTML` 发出去，`\>` 之类原样显示，而 `<` 与 `&`
  一个都没转成实体，Telegram 直接 `can't parse entities`。

所以分档由 `splitTelegramText(text, max, parseMode)` 收口，渲染与分片一起分档 —— 分片必须在
渲染**之后**做（转义会让长度翻倍，按源文本切没法保证渲染后不超 `maxMessageChars`），因此每一档
的分片器都要认自己那套不可切开的构造。

#### 5.3.1 MarkdownV2（默认）

模型输出的是通用 Markdown，Telegram MarkdownV2 转义规则极严。实现 `safeRender(text)`：

1. 解析为 AST（`marked` 的 lexer，显式传 `{gfm:true, breaks:false, pedantic:false}` —— 不吃全局 `marked.use()`）。
2. 支持的节点：段落、`strong`、`em`、`del`、`code`、`codespan`、`link`、`image`、`list`、`blockquote`、`br`、`escape`。
3. 不支持的节点降级：`heading` → `*粗体*` + 换行；`table` → 等宽代码块（按 `raw` 原样塞进去，
   不重排列宽 —— 中英混排下按码点补齐只会更歪）；`hr` → `——————`；`image` → `[alt 或「图片」](url)`；
   `html` 与任何未知节点 → 按字面转义显示。
4. 文本节点按 MarkdownV2 规则转义 ``\_*[]()~`>#+-=|{}.!``，`pre`/`code` 实体内只转义 `` ` `` 和 `\`，
   `[…](url)` 的 URL 部分只转义 `)` 和 `\`。**`\` 必须在文本转义集里**：漏掉它时 `C:\x` 会被
   Telegram 当成「转义 x」，反斜杠静静消失。
5. 未闭合的代码围栏（流式中途很常见）→ lexer 本身就把它归成 `code` 节点，渲染时**补上闭合**，
   下次编辑再更新。未闭合的行内反引号 / `**` 留在文本节点里按字面显示，不猜配对。
6. 渲染结果做长度校验，超限交给分片器。
7. **绝不能成为投递失败的新来源**：整段渲染包在 `try` 里，lexer 真抛了就退回「全文按字面转义」
   —— 格式丢掉，消息还在。

三条实现约束，改这块之前对着看：

- **不许再用「全量转义 + 反解白名单」那条路**。旧实现是逐行 `replace(SPECIAL, '\\$&')` 之后只把
  `\*\*x\*\*` 反解回 `*x*`，于是每一个不在白名单里的构造都降级成字面转义符：行内代码从来没被
  反解过（用户看到的是 `` `x` `` 两个反引号），而 `heading` 的 `*粗体*` 因为生成在转义**之前**、
  又只有双星号那一条反解规则，同样被自己的转义吃掉。同源缺陷出了两个才被发现，因为「漏一个构造」
  在这条路上不会报错、只会看起来朴素。转义**只发生在文本节点上**是这一节的红线。
- **可点链接按 scheme 白名单**（`http` / `https` / `tg` / `mailto`），其余退回字面 raw。回复正文里
  可能带被注入的内容（工具输出、网页），可点链接必须是白名单而不是黑名单。
- **引用块内含围栏时整段退掉 `>` 前缀**：`>` 逐行前缀会把 `pre` 实体拆开，Telegram 直接判解析失败。
  宁可丢掉引用样式，不要让整条消息掉回纯文本。

单测覆盖见 `tests/output.render.test.ts`：中英混排、嵌套列表、流式截断在代码块中间、
链接内含特殊字符、行内代码与标题两条同源回归（AC-OUT-004 / AC-OUT-013）。

#### 5.3.2 HTML

`safeRenderHtml(text)`，走 §5.3.1 那棵同样的 AST（`marked` 的 lexer，同一份 `LEXER_OPTIONS`）。
节点降级也与 MarkdownV2 一致（`heading` → 粗体、`table` → 等宽块、`hr` → `——————`、
`image` → 带 alt 的链接、`html` 与未知节点按字面显示），差别只在输出的标签与转义规则：

1. **标签只用 Telegram 认的那个子集**：`b` / `i` / `u` / `s` / `tg-spoiler` / `a` / `code` / `pre` /
   `blockquote`。写别的进去 Telegram 一律 `can't parse entities` —— 这是白名单，不是「大概支持」。
2. **转义只发生在文本节点上**（与 MarkdownV2 同一条红线）：`&` → `&amp;`、`<` → `&lt;`、
   `>` → `&gt;`。**`&` 必须第一个替换**，否则后两条产出的 `&lt;` 会被自己再转一遍成 `&amp;lt;`。
   `pre` / `code` 实体内部转的是同样这三个（Telegram 的 HTML 模式在代码实体里也解析实体）。
3. 代码块是 `<pre>` 或带语言的 `<pre><code class="language-xxx">…</code></pre>`；行内代码是 `<code>`。
   语言名按 `[A-Za-z0-9+#._-]` 过滤后才拼进 class —— 它来自模型写的围栏标记，是外部输入。
4. **引用块用真的 `<blockquote>`**，不再有 MarkdownV2 那条「内含围栏就退掉前缀」的妥协：
   那条妥协的起因是 `>` 逐行前缀会把 `pre` 实体拆开，而 HTML 的嵌套是显式的，`<pre>` 待在
   `<blockquote>` 里没有问题。
5. 强调实体不做「同种不自嵌套」的抑制（那是 MarkdownV2 的限制）；但 `heading` 仍按 §5.3.1 那样
   把 `strong` 记成已张开，免得 `### **小标题**` 输出一层空的 `<b><b>`。
6. 与 MarkdownV2 同款的两条兜底：整段渲染包在 `try` 里，lexer 抛了就退回「全文按字面转义」；
   可点链接按同一份 scheme 白名单，`href` 里的 `"` 与 `&<>` 一并转义。

#### 5.3.3 none

不渲染、不转义，只摘掉 NUL（正文里的 NUL 没有任何显示意义），然后按 `maxMessageChars` 分片。
发出去时不挂 `parse_mode`，因此**也不存在解析失败那一跳**（`sendWithFallback` 直接返回）。

#### 5.3.4 分片器的三档约束

分片在渲染之后做，所以每一档的切口都不能落在自己那套不可切开的构造里：

| 档 | 不可切开的构造 | 跨片处理 |
|---|---|---|
| MarkdownV2 | ` ``` ` 围栏 | 切口在围栏内时本片补 `` \n``` `` 收口，下一片以 ` ```\n ` 重开 |
| HTML | `<…>` 标签、`&…;` 实体 | 切口回退到标签/实体之外；本片按栈逆序补闭合标签，下一片原样重开这些开标签 |
| none | 无 | 直接切 |

HTML 那一档的切口回退是必需的，不是保险：`<a href="…">` 与 `<pre><code class="…">` 里都有空格，
而断点候选里就有 `' '` —— 不回退就会切出一个 `<a` 加一个 `href="…">`。

三条实现约束（都是 8000 轮随机用例逼出来的，`tests/output.test.ts` 各有一条焊住）：

- **不给收尾预留固定余量。** 按最坏情况（白名单每个标签都张着 = 59 字符）悲观预留过一版，
  结果 `maxMessageChars: 100` 时窗口只剩 41，一个 `<a href="…">` 都放不下，切口退无可退只能硬切
  —— 预留量本身成了「把标签切开」的原因。收尾长度按**真实**的开标签栈算，超了再回退断点。
- **重开前缀一旦决定要带就必须带到底。** 试过「装不下就放弃重开」：不重开的那一片是纯文本没错，
  但流里后面**仍然会来那个 `</b>`**，它于是变成下一片开头一个没有配对的闭合标签。
- **超上限比不成对更严重。** 前缀几乎占满一整片时宁可丢格式：超长会被 Telegram 以
  `message is too long` 硬拒，而 `sendWithFallback` 只兜得住 `can't parse entities`。

还有一条不可避免的：**单个元素连祖先的闭合标签一起就比整片长**（几千字符的 URL）时没有任何切法
能既装进一片又保持成对，那时硬切，靠 §5.2 的纯文本降级把话说出去 —— `toPlainText` 因此**只剥完整
标签**，被切开的半截标签故意留着，因为 `<a href="` 后面跟的就是那条 URL 本身。丢几个字面尖括号
远不如「消息还在」重要。

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
| 图片 photo | ✓ | ✓（取最大尺寸，`media.maxImageBytes` 默认 8MB） | `file` part + `mediaType:'image/*'`（模型需 vision，否则自动切 `vision` 别名；一个都没有才换成文本占位） |
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
- 若当前别名模型 `capabilities.vision=false` → `prepareStep` 切 `vision` 别名（优先级见 [04 §5.2](./04-agents-and-providers.md#52-内建别名语义)：
  vision 压过 `downgradeAfterStep` 与 `set_model`）。一个能看图的别名都没有时才降级：
  图片整体换成 `[图片：当前模型不支持看图，本轮没能查看]`，并在回复末尾追加
  「（当前模型不支持看图，这张图我没能真的看到。）」。
  **不许把不透明 part 原样发给一个不认它的模型**：宽容的 provider 静默忽略、严格的直接 400，
  而模型不知道自己没看见图 —— 实测它会去 cp 文件、python 读尺寸、开本地 http 服务器、
  拿 agent-browser 截图，绕 11 步也没看到那张图（logs/2026-08-18 · turn `01M0AKMXG4…`）。

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
  （「摘除比伪造安全」，[16 §5](./reviews/16-remediation-plan.md)）。
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
