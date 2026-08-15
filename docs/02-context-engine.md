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
      seq: (headCommit?.seq ?? 0) + 1,
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

### 4.2 条数上限与丢弃

`cfg.context.background.maxPerTurn`（默认 20，D6 需求方明确要求可配置）。超出时**丢最旧**，并在 delta 首部插入一条 `origin='note'`：
```
（本轮省略了 37 条更早的群聊消息，可用 read_messages / search_messages 工具查阅）
```

### 4.3 渲染格式

背景消息与触发消息统一以 `role='user'` 进入上下文，文本前缀由 `render.ts` 生成：

```
群聊:  [张三 10:02] 今天去哪吃
       [李四(@lisi) 10:03] 隆福吧
       [张三 10:04 ↩︎回复 李四] 好
私聊:  （无前缀，直接是消息正文）
```

规则：
- 显示名优先级：`first_name last_name` → `@username` → `user:<id>`。
- `background.showUsername`（默认 `true`）决定是否附 `@username`。
- `background.showTime`（默认 `true`）：`HH:mm`，时区取 `general.timezone`。
- 引用回复：附 `↩︎回复 <被回复者显示名>`；若被回复消息也在当前窗口内，附其 ordinal：`↩︎回复 #3`。
- 非文本消息渲染为占位符：`[图片]`（附 caption）、`[文档 report.pdf 1.2MB]`、`[语音 12s]`、`[贴纸 😄]`、`[视频 0:34]`。图片/文档若被解析（[08 §7](./08-telegram-adapter.md#7-多模态)）则同时携带真正的 multimodal part。
- **相邻的同类背景消息合并进同一个 `user` message 的多个 text part**？→ **不合并**。每条原始消息一行 `context_messages`，便于精确裁剪与溯源（`source_message_id`）。

> 安全提示：前缀是**模型可见的、由用户可控内容拼成的文本**。必须防注入：见 [05 §7](./05-tools-and-permissions.md#7-提示注入防护)。

---

## 5. 裁剪（轮后收敛）

### 5.1 语义（D2 + D3 + D4）

- **时机**：每个 turn `commit` 成功后立即执行一次；**turn 进行中不执行**。
- **方向**：丢弃**最旧**的内容。
- **度量**：`tokens` 与 `msgCount` 双阈值，任一超限即触发。
- **不可裁剪**：系统提示词、ASSIST/CHARACTER/MEMORY（它们根本不在 `context_messages` 里）。

### 5.2 裁剪单位：exchange（一个 turn 的 delta）

裁剪的最小单位是**一个完整 turn 的 delta**，即 `window_start` 只能落在某个 turn 的第一条消息上。理由：这样永远不会产生「孤儿 `tool` 结果」（缺少对应 `tool_call` 的 tool 消息会被大多数 provider 直接拒绝）。

### 5.3 算法

```ts
async function prune(key: string, commit: Commit): Promise<Commit | null> {
  const lim = cfg.context.limit;                      // { tokens, maxMessages }
  let msgs = await materialize(commit);
  let tokens = sum(msgs, m => m.tokens);
  if (tokens <= lim.tokens && msgs.length <= lim.maxMessages) return null;   // 无需裁剪

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
    key, parent_id: commit.id, seq: commit.seq + 1, kind: 'prune',
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

- 估算器：`tokenizer.ts` 用 `gpt-tokenizer`/`js-tiktoken` 的 `o200k_base` 作通用近似；CJK 按 `chars * 0.6 + 4` 的经验式作为兜底（无 tokenizer 时）。
- **校准**：每次真实 API 返回 `usage.inputTokens` 后，与本地估算比对，把 `ratio = real/estimated` 以指数移动平均（α=0.2）存入 `contexts.token_ratio`，后续估算乘以该系数。日志记录偏差 >20% 的情况。
- `context.limit.tokens` 的判定使用**校准后**的估算值。

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
| `/undo` | 撤销上一轮：done 指针回退一个 commit | `setRef(key,'done', head.parent_id)`；`context_messages` 不删（后续新 turn 的 ordinal 仍从当前最大值继续，不复用）|
| `/ctx` | 显示上下文状态 | commit seq、窗口 `[start,head]`、消息数、token 数/上限、最近一次 rebase/prune、claim 水位 |
| `/ctx export` | 导出当前窗口为 `.md`（仅 owner） | 走 `sendDocument` |
| WebUI「回滚到此 commit」 | 任意 commit 设为 done（owner） | `setRef` + 写 `kind='manual'` 审计 commit |

`/undo` 之后若有并发 turn 正基于被撤销的 commit 运行，其 commit 会走 §3.3 情况 0（base 失效 → 挂到当前 HEAD + note）。

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
