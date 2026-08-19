# 02 · 上下文引擎（核心规格）

> 本文档是整个系统最关键、也最容易实现错的部分。**所有语义都必须能被 [13 §AC-CTX](./13-acceptance-criteria.md#2-上下文引擎-ac-ctx) 的用例逐条验证。**

## 1. 数据模型：两层结构

上下文不是「一个消息数组」，而是**追加式消息日志 + 不可变 commit 指针**的两层结构（git 类比：blob/tree 与 commit/ref）。

```
Layer 1  context_messages  ── 追加式、永不物理删除
  key      ordinal  turn_id  role       origin        prune_level  parts
  chat:-1  1        t001     user       background    0            [张三 10:01] 今天去哪吃
  chat:-1  2        t001     user       background    0            [李四 10:01] 隆福吧
  chat:-1  3        t001     user       trigger       0            [张三 10:02] @bot 你觉得呢
  chat:-1  4        t001     assistant  assistant     0            隆福不错，……
  chat:-1  5        t002     user       trigger       0            [王五 10:05] @bot 查下天气
  chat:-1  6        t002     assistant  tool_call     2            toolCall(web_fetch)
  chat:-1  7        t002     tool       tool_result   1            {...}
  chat:-1  8        t002     assistant  assistant     0            今天晴，26°C

Layer 2  context_commits  ── 不可变
  id     seq  parent  kind   turn_id  base_commit  rebased  window_start  head_ordinal
  c001   1    -       turn   t001     c000         0        1             4
  c002   2    c001    turn   t002     c001         0        1             8

refs   key=chat:-1  name='done'  commit_id=c002        ← HEAD
```

**核心公式**

```
materialize(commit) = SELECT * FROM context_messages
                      WHERE key = commit.key
                        AND ordinal BETWEEN commit.window_start AND commit.head_ordinal
                      ORDER BY ordinal ASC
```

因此：
- **快照 = 一个 commit id**（O(1) 传递，无需拷贝消息）；
- **裁剪 = 前移 `window_start`**（O(1)，可逆，历史仍在库里给检索工具用）；
- **拼接顺序 = ordinal 顺序**，而 ordinal **在 commit 时分配** ⇒ 天然等于「对话完成的先后顺序」（D1）。

> ⚠️ 实现红线：`ordinal` **绝不可**在 turn 开始时预分配。若预分配，并发轮次的 rebase 语义就会崩坏。

---

## 2. 上下文键

```ts
function contextKey(msg: TgMessage, cfg: Config): string {
  const chatId = String(msg.chat.id);
  if (cfg.context.scope === 'thread' && msg.message_thread_id != null) {
    return `chat:${chatId}:${msg.message_thread_id}`;
  }
  return `chat:${chatId}`;
}
```

- 默认 `context.scope = 'chat'`：整群（含所有 topic）共享一个上下文（D8）。
- `'thread'`：论坛群按 topic 隔离；非论坛群（无 `message_thread_id`）仍退化为 `chat:<id>`。
- **`message_thread_id` 始终写入 `messages` 表**，与 scope 无关；切换 scope 不迁移旧数据，新 key 从空上下文开始（`/ctx` 会显示提示）。
- 私聊：`chat:<userId>`（Telegram 私聊 `chat.id == user.id`）。

---

## 3. 并发与 rebase

### 3.1 生命周期状态机

```
        openTurn()                      run agent                     commitTurn()
 idle ──────────────► snapshotted ────────────────────► completed ──────────────► committed
           │                  │                              │
           │                  ├─ error/timeout ──► failed (delta 丢弃)
           │                  └─ user /cancel ──► cancelled (delta 丢弃, 见 3.5)
           └─ 并发上限 ──► queued ──► snapshotted
```

### 3.2 `openTurn` —— 临界区 A

```ts
// 全程持有 keyedMutex(key)，禁止任何 I/O 之外的等待（无模型调用、无网络）
async function openTurn(key: string, trigger: ArchivedMessage): Promise<TurnCtx> {
  const base = await repo.getRef(key, 'done');          // 可能为 null（首次）
  const ctx  = await repo.ensureContext(key);

  // 认领背景消息：(claim_watermark, trigger.id] 区间内、未触发的入站消息
  const claimed = await repo.claimBackground(key, ctx.claim_watermark, trigger.id, {
    max: cfg.context.background.maxPerTurn,             // 超出则丢最旧
    includeOwnBot: false,
  });
  // 水位只随成功提交推进；openTurn 仅记录待提交的 claimThroughMessageId

  return {
    turnId: newId(),
    key,
    baseCommitId: base?.commit_id ?? null,
    snapshot: await materialize(base),                  // ModelMessage[]（可 LRU 缓存）
    delta: [...claimed.map(toContextMessage), toContextMessage(trigger)],
  };
}
```

- `claim_watermark` 是**已折入已提交上下文的最大原始 `messages.id`**。背景认领与水位推进是两件事：`openTurn` 用 `claimed_at + claimed_by_turn` 原子独占候选行，避免并发 turn 重复折入；`commitTurn` 才在消息/commit/`refs.done` 的同一事务中以 `MAX(old,new)` 前移水位并清除 claim owner。
- 并发 turn 可基于同一水位打开，但 `claimed_at IS NULL` 过滤保证其背景 `sourceMessageId` 集合互不相交；最终仍按完成顺序 rebase 到最新 HEAD。
- 若 turn `failed`/`cancelled`，`abortTurn` 清除该 turn 的 `claimed_at/claimed_by_turn`，水位不变；下一轮可重新认领。进程崩溃恢复同样归还残留 claim。

### 3.3 `commitTurn` —— 临界区 B

```ts
async function commitTurn(t: TurnCtx): Promise<CommitResult> {
  return keyedMutex(t.key, async () => {
    const head = await repo.getRef(t.key, 'done');            // 可能已被别的 turn 前移
    const headCommit = head ? await repo.getCommit(head.commit_id) : null;

    // — 情况 0：base 已失效（被 /new 或 /undo 重置）
    if (t.baseCommitId && !(await repo.commitExists(t.baseCommitId))) {
      t.delta.unshift(noteMessage('上下文已在本轮进行中被重置，以下回复基于旧上下文生成。'));
    }

    const isFastForward = (headCommit?.id ?? null) === t.baseCommitId;

    // — 分配 ordinal（★ 完成顺序在此确立）
    let ord = (headCommit?.head_ordinal ?? 0);
    const rows = t.delta.map(m => ({ ...m, key: t.key, ordinal: ++ord, turn_id: t.turnId }));

    if (!isFastForward) {
      // — rebase：标记，供审计与后续轮次识别
      const skipped = await repo.commitsBetween(t.baseCommitId, headCommit!.id); // 被插队的 commit
      const baseCommit = t.baseCommitId ? await repo.getCommit(t.baseCommitId) : null;
      const unseenStart = (baseCommit?.head_ordinal ?? 0) + 1;
      rows.forEach(r => {
        if (r.role === 'assistant') {
          r.meta = { ...r.meta, rebased: true, unseenOrdinals: [
            unseenStart,
            headCommit!.head_ordinal,
          ]};
        }
      });
      if (cfg.context.rebase.injectNotice) {
        rows.unshift(noteRow('（以下回复由并发轮次产生，作者未看到上方最新消息）'));
      }
      log.event('context.rebase', { key: t.key, turnId: t.turnId,
        base: t.baseCommitId, onto: headCommit!.id, skipped: skipped.map(c => c.id) });
    }

    await repo.insertContextMessages(rows);

    const commit = await repo.insertCommit({
      key: t.key,
      parent_id: headCommit?.id ?? null,          // ← 永远挂在当前 HEAD 之后（线性历史）
      seq: await repo.nextSeq(t.key),             // ← MAX(seq)+1，不按 HEAD 递推（见下）
      kind: 'turn',
      turn_id: t.turnId,
      base_commit_id: t.baseCommitId,
      rebased: isFastForward ? 0 : 1,
      rebase_over_json: isFastForward ? null : JSON.stringify(skipped.map(c => c.id)),
      window_start: headCommit?.window_start ?? rows[0].ordinal,
      head_ordinal: ord,
    });
    await repo.setRef(t.key, 'done', commit.id);
    await repo.setClaimWatermark(t.key, t.claimThroughMessageId); // 与消息、commit、ref 同一事务

    const pruned = await prune(t.key, commit);      // §5，可能再写一个 kind='prune' commit
    return { commit: pruned ?? commit, rebased: !isFastForward };
  });
}
```

### 3.4 三个场景的确定性结果

**场景 A：串行（无并发）**
```
done=c001 ──► A: base=c001 ──► commit parent=c001 ──► done=c002   (fast-forward)
```

**场景 B：并发，A 先完成（D1 主场景）**
```
done=c001
  ├─ A: base=c001, snapshot=[…m1..m4]   finish t=1s
  └─ B: base=c001, snapshot=[…m1..m4]   finish t=3s

t=1s  A commit: fast-forward → c002, ordinals 5,6      done=c002
t=3s  B commit: head(c002) ≠ base(c001) → REBASE
                ordinals 7,8, parent=c002, rebased=1   done=c003

最终日志顺序: m1 m2 m3 m4 | A-user A-assistant | B-user B-assistant
B 的 assistant 消息 meta.rebased=true, unseenOrdinals=[5,6]
```

**场景 C：并发，B 先完成**
```
t=1s  B commit: fast-forward → c002, ordinals 5,6
t=3s  A commit: REBASE → ordinals 7,8, parent=c002
最终顺序: … | B-user B-assistant | A-user A-assistant
```
即 **完成顺序决定历史顺序**，与触发顺序无关。这是 D1 的直接后果。

### 3.5 取消（`/cancel`）

- 取消会 `abort` AI SDK 的 `abortSignal` → agent loop 立即结束。
- `cancel.commitPartial`（默认 `false`）：
  - `false` → delta 全部丢弃，上下文完全不变（用户的触发消息也不进上下文，仅留在归档）。
  - `true` → 提交已生成部分，并追加 `origin='note'` 的「(本轮被用户取消)」。
- 取消权限：turn 发起人本人或 `owner`。其他人点按钮 → `answerCallbackQuery` 提示无权限。

### 3.6 并发限流

| 配置 | 默认 | 行为 |
|---|---|---|
| `concurrency.mode` | `parallel` | `serial` 时同 key 严格 FIFO 串行（rebase 永不发生，作为逃生舱） |
| `concurrency.perKey` | 3 | 同 key 在途 turn 上限；超出进队列 |
| `concurrency.global` | 8 | 全局在途 turn 上限 |
| `concurrency.queueMax` | 20 | 队列长度；再超则回复「当前排队已满，请稍后」 |
| `concurrency.coalesceSameUserMs` | 0（关闭） | >0 时，同用户在该窗口内的连续触发合并为一个 turn（后到消息作为同一 delta 的追加 user 消息） |
| `concurrency.turnTimeoutMs` | 600000 | 单 turn 硬超时，超时按 cancelled 处理 |

---

## 4. 背景消息认领

### 4.1 认领范围

`(claim_watermark, trigger.id]` 内满足以下全部条件的 `messages` 行：
- `direction = 'in'`
- `chat_id` 属于当前 context key（`scope='thread'` 时还需 `message_thread_id` 匹配）
- `from_kind = 'user'`（bot 消息不认领；`triggered=1` 的消息即触发消息本身，单独处理）
- 发送者 `effective role ≠ blocked`（被拉黑者的发言不进上下文，但仍归档）

### 4.1.1 被回复的消息（引用注入）

背景认领**够不着被回复的那条消息**：它的范围只有 `(claim_watermark, trigger.id]`，而被回复的消息
通常更早、可能已被认领过、也可能从未归档（发送者是 blocked、是别的 bot、或发在 bot 入群之前）。
所以「回复一张图 + 唤醒词」这个最常见的多模态用法，模型此前看到的只有那句话，没有图。

因此 `openTurn` 接受一个可选的 `quoted: ArchivedMessage`（适配层负责取到它，见
[08 §7.4](./08-telegram-adapter.md)）。引擎的职责是**去重**与**渲染**：

- 已经看得见就不注入。三种「已经看得见」：窗口里有 `sourceMessageId === quoted.id` 的消息；
  本轮刚认领了它；它是 bot 某一轮的产出而那一轮的消息还在窗口里（bot 消息不带 `source_message_id`，
  只能靠 `turn_id` 反查 —— 判错的代价是每次「回复 bot」都把它上一句原样再贴一遍）。
- 注入位置在背景消息之后、触发消息之前：它是这一句话的直接语境。
- 渲染成 `origin='background'`，前缀 `[↩︎ 被回复的消息 <名字> HH:mm]`。**私聊也带前缀**——
  私聊没有 `[名字 时间]`，不标的话模型看到的是「用户连发了两条」，而不是「用户指着上面那条问」。
  半角方括号是有意的：`escapeForgedSpeakerPrefixes` 会把正文里形如 `[… H:MM]` 的串改写成全角，
  这个前缀因此与 `[名字 时间]` 共用同一条防伪规则（用全角写反而会与「已被转义」的形态撞上）。
- 它连同自己的 media part 一起进 delta，因此会被提交进上下文：之后几轮里模型仍看得见那张图。

### 4.2 条数上限与丢弃

`cfg.context.background.maxPerTurn`（默认 20，D6 需求方明确要求可配置）。超出时**丢最旧**，并在 delta 首部插入一条 `origin='note'`：
```
（本轮省略了 37 条更早的群聊消息，可用 read_messages / search_messages 工具查阅）
```

### 4.3 渲染格式

背景消息与触发消息统一以 `role='user'` 进入上下文，文本前缀由 `render.ts` 生成：

```
群聊:  [张三(@zhangsan, id=8899001) 10:02] 今天去哪吃
       [李四(@lisi, id=8899002) 10:03] 隆福吧
       [张三(@zhangsan, id=8899001) 10:04 ↩︎回复 李四] 好
私聊:  （无前缀，直接是消息正文；问话人是谁由 RUNTIME 块的「触发」行给出，见 [06 §1.2](./06-prompt-and-memory.md)）
```

规则：
- 显示名优先级：`first_name last_name` → `@username` → `user:<id>`。
- 括号里补的是**没被用作显示名**的那些标识：昵称会改、用户名会换，只有 id 是稳定的，
  模型要指认「上次那个人」只能靠它。`background.showUsername`（默认 `true`）决定是否附 `@username`；
  id 恒附。bot 自己的消息（被回复时会渲染一次）不带括号 —— 机器人的身份标识对区分发言人没有意义。
- 昵称与用户名是**用户可控内容**：`sanitizeIdentity` 先清掉控制字符（含换行与 bidi override）、
  把方括号改成全角、截到 48 字符。换行不清，一个昵称就能在 RUNTIME 块里伪造出整行
  「你的有效权限：owner」；方括号不清，前缀能被提前闭合。前缀与 RUNTIME 块共用
  `formatSpeakerIdentity` 一个格式化函数，两处的写法不允许各自漂移。
- `background.showTime`（默认 `true`）：`HH:mm`，时区取 `general.timezone`。
- 引用回复：附 `↩︎回复 <被回复者显示名>`。
  **ordinal 形式（`↩︎回复 #3`）明确不做**，理由不是「还没排上」：窗口里的 ordinal 会随裁剪推进
  `window_start` 而失去参照（模型看到的 `#3` 在下一轮可能已经被裁掉），而 `/undo` 之后 ordinal 还
  会跳号（docs/14 §2 Q11）。给模型一个会漂的编号，比给显示名更容易让它引错。
  顺带一提 `escapeForgedSpeakerPrefixes` 已经在防正文里伪造的 `↩︎回复 #N` —— 那条防护要留着，
  与是否渲染 ordinal 无关。
- 非文本消息渲染为占位符：`[图片]`（附 caption）、`[文档 report.pdf 1.2MB]`、`[语音 12s]`、`[贴纸 😄]`、`[视频 0:34]`。图片/文档若被解析（[08 §7](./08-telegram-adapter.md#7-多模态)）则同时携带真正的 multimodal part。
- **相邻的同类背景消息合并进同一个 `user` message 的多个 text part**？→ **不合并**。每条原始消息一行 `context_messages`，便于精确裁剪与溯源（`source_message_id`）。

> 安全提示：前缀是**模型可见的、由用户可控内容拼成的文本**。必须防注入：见 [05 §7](./05-tools-and-permissions.md#7-提示注入防护)。

---

## 5. 裁剪（轮后收敛）

### 5.1 语义（D2 + D3 + D4）

- **时机**：每个 turn `commit` 成功后执行一次，外加 `openTurn` 里的空闲超期补裁（见 5.1.1）；**turn 进行中不执行**。
- **方向**：丢弃**最旧**的内容。
- **度量**：`tokens` 与 `msgCount` 双阈值，任一超限即触发。
- **不可裁剪**：系统提示词、ASSIST/CHARACTER/MEMORY（它们根本不在 `context_messages` 里）。

### 5.1.1 活跃期（推迟裁剪，`context.active.*`）

**裁剪一次 = 缓存全灭。** 前移 `window_start` 改的是请求体最前面那几条消息，而所有 provider 的
前缀缓存都是「从第一个字节开始逐字节比对」——掉一条最旧的消息，后面**整个**历史的缓存一起作废。
在一场正在进行的对话里这是最糟的时机：命中率本来最高的那一刻，被一次省几百 token 的裁剪打掉了
几万 token 的缓存读。算术是压倒性的：缓存读按 0.1 倍计价，裁掉 2k token 省下的钱，抵不上重新
写入 30k token 前缀的零头。

活跃期把裁剪推迟到**缓存本来就已经凉了**的时刻：

- **判据是滑动的空闲间隔，不是固定截止时刻**：`now - HEAD.created_at <= context.active.windowMs`
  即为「仍在活跃期」。每一轮提交都把它顺延一次，所以只要对话在继续就永远不裁剪；安静满
  `windowMs` 之后的第一轮才裁。固定截止（首次唤醒起算）会在一场长对话的正中间作废热缓存 ——
  恰好是最不该裁的时刻，因此明确不采用。
- **默认 `windowMs` 应与 provider 的缓存 TTL 同量级**（Anthropic ephemeral 5 分钟；OpenAI 系隐式
  前缀缓存的保留期也在这个量级）。取这个值时「推迟裁剪」的代价精确为零：等到真的裁的时候，
  那份缓存早已过期，作废它不损失任何东西。
- **推迟不是取消，必须有天花板**：`context.active.tokens` / `context.active.maxMessages` 是活跃期内
  允许涨到的上限。**撞到天花板时裁剪的目标仍是 `context.limit.*`**，不是天花板本身 ——
  裁到天花板等于此后每一轮都要裁一次、每一轮都作废一次缓存，正是这个特性要消灭的东西。
  一次裁到常规上限，换来接下来许多轮的免裁剪增长，这是有意的摊还。
- **空闲超期补裁在 `openTurn`**：久别重逢的那一轮，上下文可能已经是常规上限的数倍。在开轮前就把
  窗口裁回 `context.limit.*`，这一轮发出去的就已经是小请求。此时缓存已过期，裁剪不损失任何命中，
  而少发的那几万 token 是实打实按全价省下来的。
- `windowMs = 0`（schema 默认）关闭整个特性，裁剪行为与本节其余部分完全一致。

**活跃期不改变任何形状不变式**：它只决定「这一轮要不要推进 `window_start`」，推进时走的仍是
5.2 / 5.3 那一套（turn 边界、分级降级、硬截断、收敛告警）。推迟的方向永远是**多留**，
所以孤儿 `tool-result`、`minKeepTurns`、认领水位这些约束不可能因为它被破坏。

### 5.2 裁剪单位：exchange（一个 turn 的 delta）

裁剪的最小单位是**一个完整 turn 的 delta**，即 `window_start` 只能落在某个 turn 的第一条消息上。理由：这样永远不会产生「孤儿 `tool` 结果」（缺少对应 `tool_call` 的 tool 消息会被大多数 provider 直接拒绝）。

### 5.3 算法

```ts
async function prune(key: string, commit: Commit, deferrable: boolean): Promise<Commit | null> {
  const lim = cfg.context.limit;                      // { tokens, maxMessages }
  let msgs = await materialize(commit);
  let tokens = sum(msgs, m => m.tokens);
  // 触发阈值与裁剪目标是两个数：活跃期内按放宽后的天花板决定「要不要裁」，
  // 一旦决定要裁，目标恒为 lim ——裁到天花板等于每轮都裁、每轮都作废缓存（5.1.1）。
  const gate = deferrable && cfg.context.active.windowMs > 0
    ? { tokens: max(cfg.context.active.tokens, lim.tokens), count: max(cfg.context.active.maxMessages, lim.maxMessages) }
    : { tokens: lim.tokens, count: lim.maxMessages };
  if (tokens <= gate.tokens && msgs.length <= gate.count) return null;       // 无需裁剪

  let windowStart = commit.window_start;
  const turnBoundaries = await repo.turnStartOrdinals(key, windowStart, commit.head_ordinal);

  // 步骤 1：按 turn 丢最旧，但至少保留 minKeepTurns 个（含刚提交的这个）
  for (const b of turnBoundaries) {
    if (remainingTurns <= lim.minKeepTurns) break;
    if (tokens <= lim.tokens && count <= lim.maxMessages) break;
    windowStart = nextBoundaryAfter(b);
    ({ tokens, count } = recompute(key, windowStart, commit.head_ordinal));
  }

  // 步骤 2：仍超限（单个巨型 turn） → 分级 prune，只清空载荷，绝不改变 part 结构
  //   level 2: tool-call 保留 type/toolCallId/toolName，input 替换为 {elided:true}
  //   level 1: tool-result 保留 type/toolCallId/toolName，output 替换为省略说明
  //   level 0: user 文本 / assistant 最终文本 → 永不省略
  for (const level of [2, 1]) {
    if (tokens <= lim.tokens) break;
    await repo.markPruned(key, windowStart, commit.head_ordinal, level);
    ({ tokens, count } = recompute(...));
  }

  // 步骤 3：仍超限 → 按当前生效 token 选择最大消息并字符级硬截断
  // 终止性不变式：每次成功截断必须使该消息的生效 token 严格递减；已到 1 token 的行不再参与。
  // 迭代次数上限为窗口消息数；全部到下限仍超限时退出并记录 context.hardcap，绝不空转。
  // 形状不变式：硬截断只削减载荷字符串。判别字段（type/toolCallId/toolName/mediaType…）绝不参与
  // 字符预算；图片等不透明 part 要么原样保留，要么整体换成占位文本，绝不留下截半的 data URI。
  // 违反这条会产出 provider 拒收的消息，且截断结果持久化在 meta_json，等于会话级永久损坏。
  for (let guard = 0; guard <= msgs.length && tokens > lim.tokens; guard += 1) {
    if (!await repo.hardTruncateLargest(key, windowStart, commit.head_ordinal, lim.tokens)) break;
    ({ tokens, count } = recompute(...));
  }

  return repo.insertCommit({          // 裁剪本身也是一个 commit，可审计、可 /undo
    key, parent_id: commit.id, seq: await repo.nextSeq(key), kind: 'prune',
    window_start: windowStart, head_ordinal: commit.head_ordinal,
    tokens_total: tokens, msg_count: count,
    meta: { reason: 'over_limit', from: commit.window_start, to: windowStart },
  }).then(c => (repo.setRef(key, 'done', c.id), c));
}
```

**分级 prune 是「就地降级」**：修改 `context_messages.prune_applied`，原始 `parts_json` 保留。结构不变式：降级只能清空载荷，必须保留 `type`、`toolCallId`、`toolName`；每条 `role='tool'` 消息仍含 `tool-result`，每个 `tool-result` 在窗口内此前必须存在同 id 的 `tool-call`。`materialize()` 在出口执行该断言，违反时记 `ctx.invalid_shape` 并拒绝把非法消息交给 provider。

### 5.4 硬天花板（轮内临时裁剪，D3 第二句）

轮内不做永久裁剪，但必须防止「工具输出把上下文顶爆模型窗口」：

```ts
// AgentFactory 装配的 prepareStep
prepareStep: async ({ messages, model }) => {
  const cap = modelInfo(model).contextWindow * cfg.context.hardCapRatio;   // 默认 0.85
  if (estimateTokens(messages) <= cap) return {};
  return {
    messages: pruneMessages(messages, {                 // ← AI SDK 原生 API，仅影响本次调用
      reasoning: 'all',
      toolCalls: 'before-last-3-messages',
      empty: 'remove',
    }),
  };
}
```

- 该裁剪**只作用于内存中的 message 数组**，不写库、不影响 `delta`（delta 保留完整内容，供审计与 WebUI）。
- 若 prune 后仍超 cap → 对最大的 tool result 做字符截断；再不行 → 中止 loop 并回复「本轮上下文过大，已中止；请拆分任务」。
- 记 `log.event('context.hardcap', {...})`。

### 5.5 Token 估算与校准

估算器与校准是同一件事的两半，写在一起是因为**它们的量纲必须对齐**——这条对齐关系断过一次，
把整条裁剪链路推高了一个数量级（见下方「已修复的失效模式」）。

**估算器**（`@luoli/shared` 的 `estimateTextTokens`，全局唯一入口）：

- 按字符类分档：`ceil(0.8 × CJK字符数 + 0.3 × 其他字符数) + 4`。系数由真实请求体回归得出
  （2026-08-16，grok，六次调用：真实 12,991 / 13,113 / 9,644 token，估算落在 ±1%~6%）。
- **单一系数做不到**：同一个 `chars × 0.6` 没法同时描述「一个汉字≈0.8 token」与「一个 ASCII 字符≈0.3 token」，
  对混合内容整体高估约 65%。
- 非文本 part 走 `estimatePartTokens`：图片按 `w*h/750`，无尺寸时固定 1500；其余结构按 JSON 遍历估。
  **base64 载荷绝不按字符估**——一张图 40 万字符，按字符算是几十万 token 的假水位。
- 记忆文档（`memory_docs.tokens`）、提示词块预算、上下文水位共用这一个函数：不一致的话
  「还剩多少额度」在两个页面上会给出两个数。
- `estimateTextTokens` 的 `+4` 是**一条消息**的框架开销；`estimateStructureTokens` 遍历 JSON 时
  走不带这一项的内部版本。两者必须同尺 —— 校准系数是拿「整段请求的估算」除出来的，估算器自带的
  常数偏差会被原样吸收进系数、再乘回消息级估算。实测：逐字符串 +4 让工具 schema（全是三五个字符的
  键名）整体高估三成，系数跌到 0.74，消息因此被反向低估四分之一；同尺之后系数是 0.89~0.94。

**校准**（`contexts.token_ratio`，α = `context.tokenRatioAlpha`，默认 0.2）：

- 两端必须是**同一段内容**：右边取 `usage.inputTokens`，左边就必须取**整个请求体**的估算
  （`estimateStructureTokens(step.request.body)`），而不是「窗口内消息的估算」。
- `estimated < 200` 时跳过采样：小样本的相对误差被常数项主导，校准它只会引入噪声。
- 系数被夹在 `[0.5, 2]`，单次采样值先夹在 `[0.25, 4]`。它只用来吸收分词器差异，不该有更大的量级。
- 系数在 `openTurn` 时快照到 `turn.tokenRatio`，`buildTurn` 与 `appendDelta` 共用它 ——
  只缩放其中一半，窗口里就会同时存在两种量纲的 tokens。
- `context.limit.tokens` 的判定使用**校准后**的估算值。

**已修复的失效模式**（logs/2026-08-16 实测，回归见 `tests/tokens.estimate.test.ts`）：
左边曾是「窗口内消息的估算」、右边是含系统提示词与工具 schema 的真实用量（本机约 12,000 token
里有 9,500 是这两样）。首轮空上下文时左边只有几十，一次采样把 ratio 推到约 26，而 `tokens` 是
持久化的 —— 此后每条消息按 26 倍存库，水位虚高一个数量级，裁剪提前触发，RUNTIME 里报给模型的
「上下文水位」也跟着错。修复同时附带一次性数据修复（`recomputeMessageTokens`，`app_kv` 标记只跑一次）：
按新估算器重算 `context_messages.tokens` 并把所有 `token_ratio` 归 1。`context_commits` 不动
（不可变），其 `tokens_total` 只用于展示，下一次提交按 `effectiveStats` 自然重算。

---

## 6. 物化与缓存

```ts
type MaterializeResult = {
  messages: ModelMessage[];      // AI SDK 格式，已含 multimodal parts
  ordinals: number[];            // 与 messages 一一对应，供溯源
  tokens: number;
  windowStart: number;
  headOrdinal: number;
};
```

- LRU 缓存：`Map<commitId, MaterializeResult>`，容量 `context.cacheCommits`（默认 64），进程内。
- commit 不可变 ⇒ 缓存永不失效（唯一例外：分级 prune 就地改写了消息 ⇒ prune 时必须 `cache.invalidateKey(key)`）。
- 相邻 commit 的物化结果差异极小，可用「基线 + 增量」优化；**第一版不做**，先保证正确。

---

## 7. 上下文操作命令

| 命令 | 语义 | 实现 |
|---|---|---|
| `/new` | 开新话题：不删历史，仅把窗口收缩到空 | 写 `kind='reset'` commit，`window_start = head_ordinal + 1` |
| `/undo` | 撤销上一轮：done 指针回退一个 commit | `setRef(key,'done', head.parent_id)`；`context_messages` 不删（后续新 turn 的 ordinal 仍从当前最大值继续，不复用）。**`seq` 同理按 `MAX(seq)+1` 分配**：`ux_commits_key_seq` 是唯一索引，按 `head.seq+1` 递推会让撤销之后的下一次写入撞唯一约束 —— 表现是「撤销过的会话，下一条消息直接失败」，且 WebUI 的「回滚到此」一并 500 |
| `/ctx` | 显示上下文状态 | commit seq、窗口 `[start,head]`、消息数、token 数/上限、最近一次 rebase/prune、claim 水位 |
| WebUI「回滚到此 commit」 | 任意 commit 设为 done（owner） | `setRef` + 写 `kind='manual'` 审计 commit |

`/undo` 之后若有并发 turn 正基于被撤销的 commit 运行，其 commit 会走 §3.3 情况 0（base 失效 → 挂到当前 HEAD + note）。

> **没有 `/ctx export`。** 这张表此前列过一行「导出当前窗口为 `.md`（仅 owner）」，但它从未实现过 ——
> `/ctx` 只回统计摘要。[14 §2 Q12](./14-open-questions.md) 已拍板**不做**上下文导出/导入（导入等于给
> 上下文引擎开一个不受信入口，§9 那 20 条红线多一个防守面，而「把会话搬到另一个部署」的收益几乎
> 用不上），所以那行被删掉而不是补实现。完整时间线看 WebUI 的会话页。

---

## 8. 接口契约（供实现直接照抄）

```ts
export interface ContextEngine {
  /** 临界区 A：读 HEAD、认领背景消息、物化快照 */
  openTurn(key: string, trigger: ArchivedMessage, opts?: { extraNote?: string }): Promise<TurnCtx>;

  /** 供 agent loop 追加产物（纯内存，无 I/O） */
  appendDelta(t: TurnCtx, m: NewContextMessage): void;

  /** 临界区 B：commit / rebase / prune */
  commitTurn(t: TurnCtx): Promise<CommitResult>;

  /** 丢弃 delta，只记日志 */
  abortTurn(t: TurnCtx, reason: 'failed' | 'cancelled', err?: unknown): Promise<void>;

  materialize(commitId: string | null): Promise<MaterializeResult>;
  stats(key: string): Promise<ContextStats>;

  reset(key: string, by: Actor): Promise<Commit>;                 // /new
  undo(key: string, by: Actor): Promise<Commit | null>;           // /undo
  setHead(key: string, commitId: string, by: Actor): Promise<void>; // WebUI 回滚
}

export interface TurnCtx {
  turnId: string;
  key: string;
  chatId: string;
  threadId: number | null;
  initiatorUserId: string;
  effectiveRole: Role;
  baseCommitId: string | null;
  snapshot: MaterializeResult;
  delta: NewContextMessage[];
  readonly abortSignal: AbortSignal;
}

export interface CommitResult {
  commit: Commit;
  rebased: boolean;
  pruned: { fromOrdinal: number; toOrdinal: number; levels: number[] } | null;
}
```

---

## 9. 实现红线清单（Code Review 必查）

1. ✅ `ordinal` 只在 `commitTurn` 内分配，绝不预分配。
2. ✅ `openTurn` / `commitTurn` 的临界区内**没有** `await` 模型调用、HTTP、Telegram API。
3. ✅ agent loop 期间**没有任何** `context_messages` / `refs` 写操作。
4. ✅ `claim_watermark` 仅在 `commitTurn` 的消息/commit/ref 事务内以 `MAX(old, new)` 单调前移；失败/取消轮次不推进。
5. ✅ 裁剪只前移 `window_start`，**不 DELETE** `context_messages`。
6. ✅ 裁剪边界必须落在 turn 起点（不产生孤儿 tool 消息）。
7. ✅ 所有 `context_*` 查询都带 `key = ?`（Repository 层强制）。
8. ✅ `prune` 就地降级后必须失效物化缓存。
9. ✅ rebase 只改 `parent_id` 归属与标记，**绝不重排已有 ordinal**。
10. ✅ 私聊上下文永不包含背景消息渲染前缀（避免模型学会给私聊也加前缀）。
11. ✅ 硬截断每次使当前生效 token 严格递减，并有窗口消息数级迭代上限；无法继续收敛时告警退出。
12. ✅ 背景认领在 `openTurn` 独占、成功提交清 owner、失败/取消/崩溃归还；同一 `sourceMessageId` 在上下文中至多出现一次。
13. ✅ 分级 prune 保留工具 part 类型与配对 ID；`materialize()` 对 tool 形状和顺序做运行时断言。
14. ✅ 每个 part 的 `type` 必须属于已知判别集合（text / image / image_url / file / reasoning / tool-call / tool-result）。`openTurn`、`materialize()` 与 `commitTurn` 三处都断言——读出侧和写入侧都要挡，坏形状要在产生它的那一轮报错。
15. ✅ `tool-result` 的 `output` 必须是 provider SDK 认的**带类型形状** `{ type: 'json' | 'text' | 'error-json' | …, value }`，不能是裸对象。
    这条不是风格问题：裸对象过不了 `ModelMessage` 校验，整个 prompt 被拒，AI SDK 随后在流的 flush 里抛出
    **无人接管的** `NoOutputGeneratedError` —— 不是一次可捕获的轮次失败，是直接带走整个进程。
    而 parts 是持久化的，所以「调过一次工具的会话，之后每一轮都会崩」，且日志里一个字都不留。
    写入端（`runtime.ts` 的 `toolResultPart`）与读出端（`contextMessages`）都做归一化：只改 `output`，
    判别字段一个不碰；读出端兜底是为了让已经写坏的历史会话不必 `/new` 就能恢复。降级路径
    （`packages/db/src/context.ts` 的 `elidePart`）本来就写的是 `{type:'text', value:'[已省略工具结果]'}`，与此一致。
16. ✅ **可发送给 provider 的消息 role 只能是 `user` / `assistant` / `tool`；`system` 只存在于 `instructions`。**
    系统旁白（`load_skill` 正文、「省略了 N 条群聊消息」、「上下文已被重置」、并发轮次说明）一律
    `role:'user'` + `origin:'note'`，靠 `origin` 而不是 role 区分——WebUI 与裁剪逻辑本来就按 `origin` 走。
    这条规则**不是我们定的**：AI SDK v7 的 `standardizePrompt` 在 `allowSystemInMessages` 未开启时
    直接拒收 messages 里的任何 system 消息（`AI_InvalidPromptError`），而上下文是持久化的 ——
    一次 `load_skill`、一次群聊积压、一次在途轮次期间的 `/new`，都会让该会话在 `/new` 之前每轮都失败。
    `assertValidShape` 的 role 白名单在 `openTurn` / `materialize` / `commitTurn` 三处都断言，
    `contextMessages()` 再对历史坏数据兜一层降级（迁移 `0006` 已把库里的存量改回 `user`）。
    **不变量要从下游契约推导，而不是自己定义**：`tests/context.contract.test.ts` 把引擎产出的上下文
    真的交给 `ToolLoopAgent`，这类「本地自洽、交出去被拒」的缺陷只有跨过那一跳才抓得住。
17. ✅ **token 估算与校准的两端必须是同一段内容。** 右边是 `usage.inputTokens`（含系统提示词与
    全部工具 schema），左边就必须是**整个请求体**的估算，不能是「窗口内消息的估算」。这条断过一次：
    首轮空上下文时左边只有几十、右边上万，一次采样把 `token_ratio` 推到约 26，而 `tokens` 是持久化的
    —— 此后每条消息按 26 倍存库，水位虚高一个数量级、裁剪提前触发、RUNTIME 报给模型的水位也跟着错。
    另有三条配套：base64 载荷绝不按字符估（一张图 40 万字符）；系数夹在 `[0.5, 2]`；同一轮里
    `buildTurn` 与 `appendDelta` 用同一个系数（只缩放其中一半，窗口里就会有两种量纲）。见 §5.5。
18. ✅ **被回复的消息要么已经在模型眼前，要么被注入，不能两者都不是、也不能重复。** 背景认领只覆盖
    `(claim_watermark, trigger.id]`，够不着被回复的消息；而它可能从未归档（发送者 blocked / 别的 bot /
    bot 入群之前）。去重的三种「已经看得见」见 §4.1.1 —— 其中 bot 自己的产出只能靠 `turn_id` 反查，
    漏判的表现是每次「回复 bot」都把它上一句原样再贴一遍。补写进归档的那一行必须带 `claimed_at`，
    否则下一轮会把它当成新的背景发言再认领一次。
19. ✅ **活跃期只推迟裁剪，永不取消裁剪。** `context.active.*` 必须同时给出天花板
    （`tokens` / `maxMessages`），且撞到天花板时裁剪目标仍是 `context.limit.*`。少了天花板，
    一场不结束的对话就是一条没有上界的增长曲线：先撞 `context.hardCapRatio` 的轮内应急裁剪
    （在内存里挖掉中间的工具调用 —— 那**同样**会打掉前缀缓存，还额外丢内容），再撞模型窗口被
    provider 整个拒收。裁剪目标若取天花板而不是常规上限，则此后每一轮都恰好在天花板上再裁一次，
    等于把「每轮作废一次缓存」原样搬到了更高的水位上。推迟的方向永远是多留，因此所有形状不变式
    （turn 边界、tool 配对、`minKeepTurns`）自动继续成立；`tests/context.active.test.ts` 断言
    「活跃期内 `window_start` 一动不动」与「撞天花板后裁回常规上限」两侧。
20. ✅ **tool 配对是双向的：`tool-call` 也必须有配对的 `tool-result`。** 红线 13 与
    `assertValidShape` 长期只查了 orphan tool-**result** 那一个方向（provider 会当场拒收），而反方向
    同样致命，只是晚一轮才暴露：畸形请求体让上游 0 步返回 → AI SDK 在 flush 里用
    `NoOutputGeneratedError` reject 结果 promise → 进程被带走（与红线 15 完全同一条下坡路，
    实测 logs/2026-08-18 两次）。产生它的路径是 AI SDK 的 `step.toolResults` ——
    那是 `content.filter(p => p.type === 'tool-result')`，**工具输入校验失败或工具抛错时产出的
    `tool-error` part 被整个滤掉**，于是只有 call 进了 delta。轮内看不出来（SDK 自己的
    `responseMessages` 会把错误转成合法的 tool-result 发上线），下一轮起该会话每次请求都是畸形的。
    三处收口：`runtime.ts` 的 `stepToolResults` 同时收 `tool-result` 与 `tool-error`（后者映射成
    `output: {type:'error-text', value}`，与上线那份一致）；`commitTurn` 的 `assertPairedToolCalls`
    只查 **delta**（查 snapshot 会让已经损坏的会话彻底锁死，比现在更糟）；`contextMessages` 在读出侧
    给孤儿补一条 `[工具结果缺失…]`，并记 `ctx.orphan_tool_call` —— 库里存量不必 `/new` 就能恢复。

---

## 10. 定时轮次的上下文归属

> [14 §2 Q4](./14-open-questions.md) 要求的「单独设计一节」。需求方已拍板：**照常进上下文**。
> 实现在 `packages/core/src/schedule/runner.ts`，工具在 [05 §3.8](./05-tools-and-permissions.md)。

### 10.1 归属规则

定时任务触发时**开一条完整轮次**，走的是和用户消息一样的那条路：

```
cron 到点 ──► 重算有效角色 ──► 合成触发消息（落归档）──► openTurn
                                                          │
                              mode='agent' ──► runMainAgent ──┤
                              mode='notify' ─► 预写文本 ──────┤
                                                          ▼
                                        投递 ──► appendDelta ──► commitTurn
```

- 触发消息是一条**真实的归档行**：`direction='in'`、`from_kind='system'`、
  `from_user_id` = 任务创建者、`triggered=1`、`trigger_reason='schedule'`，
  正文是 `[定时任务 <名字>] <正文>`。它在上下文里是一条 `role='user'` / `origin='trigger'` 的消息。
- 产出照常 `appendDelta`（`role='assistant'` / `origin='assistant'`）并 `commitTurn`。
  历史里因此就是一次正常对话，**用户可以直接接着 bot 那句话往下说**。
- 背景消息认领照常发生（`claim_watermark` 正常推进），所以「汇总一下昨天群里聊了什么」这类任务
  拿得到未进上下文的那批发言。
- 这条轮次照常进 `turns` 表、照常注册进 `TurnRegistry`（可 `/cancel`、出现在
  `GET /api/turns/active`）、照常记账与占配额。**金额额度全部生效**（global / perChat / perUser 的
  daily / monthly 与 `perTurn`），但**不计入 `quota.rateLimit` 的按小时轮次数**
  （`turnsPerUserPerHour` / `turnsPerChatPerHour`）：它不是「人在刷」，频率已经由
  `schedule.minIntervalMinutes` / `schedule.maxPerChat` 在创建时管住了，而实测一天 38 次定时触发
  把创建者自己挡在了门外（docs/28 · L-QUOTA-02）。`concurrentPerUser` 照旧数它 —— 在跑的定时
  轮次真的占着一个槽，且它只挡几十秒。
- 失败照常计入 `consecutive_turn_failures`（docs/10 §6，判据同 `docs/04 §5.3`：超时算、`/cancel`
  不算）。这份计数**跨会话也跨入口**：装配方建一份 `TurnFailureStreak` 同时交给 Telegram 入口和
  定时执行器。此前它只存在于 Telegram 那边的闭包里，于是「上游变黑洞、每次定时触发都超时」
  在没人聊天的部署里一次告警都不响（docs/28 · L-SCH-02）。
- **投递通道不在就不开轮。** `telegram()` 返回 null 时这一次只记一条
  `schedule.skipped{reason:'telegram_unavailable'}`，任务留存 —— 判据必须排在配额预留、并发闸与
  `openTurn` **之前**：发不出去的一轮开了也白开，模型钱花掉、上下文一个字都留不下。
  所以那个 getter 必须在 bot **真的起来之后**才非空（拿「有 `BOT_TOKEN` 就非空」的外层对象会让
  这条分支变成死代码，而 HTTP 手动触发端点从 `serve()` 起就够得着它，docs/28 · L-SCH-01）；
  `POST /api/schedules/:id/trigger` 另有一道 `runner.loaded` 的 400 兜在前面。

**`notify` 也开轮提交。** 只发不提交更省事，但那条消息只会进 `messages` 归档
（`claimBackground` 不认领 `direction='out'`），于是模型下一轮不知道自己刚提醒过什么 ——
用户回「知道了」时它一脸茫然。省下的是一次 commit，代价是一次说不清的失忆。

**`mode='agent'` 用 `runMainAgent` 而不是 `streamMainAgent`。** 没有人盯着屏幕，也没有
Telegram 流消费者；流式的占位消息与进度编辑在这条路上只是白花 Bot API 调用。

### 10.2 合成触发消息的 id 分配

`messages.tg_message_id` 是 `NOT NULL` 且有 `UNIQUE(chat_id, tg_message_id, revision)`，
而定时轮次没有真实的 Telegram 消息号。分配规则：**保留高位段**
`SYNTHETIC_TG_MESSAGE_ID_BASE = 2_000_000_000` 起，按会话取 `MAX(tg_message_id)+1`。

两条被否掉的做法，理由要留着：

- **负数**（`-1` 递减）：负号会让它排在该会话全部真实消息之前，
  `claimThroughMessageId` 的认领窗口 `(claim_watermark, trigger.id]` 因此恒为空区间 ——
  定时轮次永远认领不到背景消息，而表现只是「摘要里什么都没有」。
- **`MAX(tg_message_id)+1`（不限高位段）**：可能正好等于下一条真实消息的号。
  `ScopedArchiveRepository.append` 是 `INSERT OR IGNORE`，撞号时**静静返回既有那一行** ——
  一条真实用户消息凭空消失，且日志里一个字都没有。

所以分配之后必须**核对 `append` 的返回值**：`inserted` 为假就抛 `schedule_trigger_conflict`
让这次触发失败。静默走下去比失败难查一个数量级。

**判 `inserted`，不要比 `tgMessageId`。** 这条核对一度写成「返回行的 `tgMessageId` 与分配值不等
就抛」——而 `append` 回读既有那一行用的是 `WHERE chat_id=? AND tg_message_id=? AND revision=?`，
绑的就是入参那个 id，于是返回值恒等于分配值，比较**永远为假**（docs/28 · L-SCH-03）。
`ScopedArchiveRepository.append` 因此在返回值上带一个 `inserted`（取 `INSERT OR IGNORE` 那次
`run()` 的 `changes`）：只有它能区分「我刚写的」和「本来就在那儿的」。

### 10.3 不补跑

进程启动时 `ScheduledJobRunner.load()` 把活跃任务装回 cron，并对每条判一次「上次触发之后
是否有已经过去的触发点」：

| 任务类型 | 错过时的处理 |
|---|---|
| 一次性（`run_at`） | 置 `state='done'`、`last_state='missed'`，记一条 `schedule.missed` warn |
| 周期（`cron`） | 记一条 `schedule.missed` warn，然后照常排下一次 |

**一次都不补。** 9 点补发一条 4 点的早报比不发更让人困惑，跟 `telegram.dropPendingOnStart`
是同一个取舍。但错过必须**说出来** —— 否则「今天早报没发」查无实据。

### 10.4 触发时重算权限

任务是在创建那一刻的角色下被允许的，而它会在此后每天触发。所以每次触发都重算
`resolveEffectiveRole`（用户角色 ∩ 会话角色）：

| 触发时的有效角色 | 处理 |
|---|---|
| ≥ `trusted` | 正常执行 |
| `limited`（低于 `schedule_create` 的 `minRole`） | **跳过这一次**，记 `schedule.skipped`；任务留着，权限恢复后照跑 |
| `blocked` | **整条停用**（`state='cancelled'`）并从调度器摘掉 |

降级只跳过、封禁才停用：临时降权不该销毁用户排了很久的任务，而封禁是永久判定。
