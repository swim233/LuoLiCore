# 00 · 当前态

> 这份文档回答三个问题：**现在还欠什么**、**哪些地方查过没问题**（免得下一轮重复查）、
> **权威清单在哪儿**。它是活的，跟着代码走。
>
> 复审报告（[`reviews/`](./reviews/)）是**历史快照**，写完即冻结，它们的结论一律不代表现在 ——
> 想知道现在的状态只看本文。反过来，本文**不重抄**别处已经由测试焊住的清单，只指过去：
> 同一个事实有两份副本，迟早会漂。上一次漂的代价是「未接线配置键」在四个地方有三个数字。
>
> 核对时间：**2026-08-30**（权限模型改口径 + 审批按钮改发 owner 私聊，见下）／2026-08-27（§2 的体例清理：从 35 行里搬走 18 行不是欠账的，剩下的每条挂上活性探针，
> 见 §4 末两条；同一批还纠正了本文与 [21](./21-webui-coverage-gaps.md) / [README](./README.md) 里
> 六处对不上代码的数字）／2026-08-25（手动验收台账 [29](./29-manual-acceptance-log.md) 开张 —— 排场次时逐条回代码核对，
> §2.3 末尾那四条是这次数出来的）／2026-08-21（定时任务静默 / 编辑 / 硬删 + 任务与审批页补齐）／2026-08-20（扩展页重设计 + MCP 登录落地）／2026-08-19（第九轮整改后 + M12 自我扩展落地 + 8-18 两次进程崩溃的收口
> + **第十轮停机活体测试的 30 条整改全部落地**）。
> 每一条都回代码查过，不采信文档自述。
>
> 第十轮那 30 条已经**从本文删干净**了 —— 做完就不留在这儿，历史在
> [`reviews/28`](./reviews/28-round10-live-system-test.md) 里。它换的是手段而不是判据：
> 真进程 / 真 Telegram / 真 docker / 真时钟 / 真上游，只找单元测试**结构性**看不见的问题，
> 而找到的东西几乎全部落在「每一半都有测试、没有一条跨过边界」的位置上 —— 前后端边界、
> 写入侧与读出侧的边界（trace 那条读出侧修过一次，修完之后正确地读着一个永远是 NULL 的列）、
> 以及被整体替换掉的依赖（所有既有用例都把 `bot.api` 换掉，节流器从没进过测试回路）。
> **下一轮要找同一类东西，先读那份报告的 §6（跑过没问题的）与 §8（排除掉的 8 条假象）。**
>
> **2026-08-30 · 有效角色改口径（不是欠账，登记在此是因为它改掉了别处一批既有表述）。**
> 判据仍只有一份（`packages/core/src/access.ts` 的 `resolveEffectiveRole`），规格在
> [05 §2.2](./05-tools-and-permissions.md#2-角色与判定)，配置语义在 [11](./11-config-reference.md) 的
> `access` 段：私聊 = `role(user)`；群 / 频道任一侧 `blocked` 即 `blocked`，其余取
> `min(max(role(user), role(chat)), 'trusted')`。三处变化 ——
> ①**会话角色从上限翻成下限**（取两侧较高者：把群的授信借给没单独登记的成员，而不是把成员拖回默认档）；
> ②**群内封顶 `trusted`**，由此得两条不变量：`effectiveRole === 'owner'` ⟹ `isPrivate`，
> 群里的有效角色只可能是 `blocked` / `limited` / `trusted` —— 旧的取小规则原本要守的
> 「防群内注入借权」（[14 §3](./14-open-questions.md) T8）由这条接手；
> ③**私聊只占 `principals` 的 `user:` 一行**，不再写也不再读 `chat:<正数 id>`（迁移
> `0015_principals_drop_private_chat.sql` 删存量并把 `kind='chat' AND role='owner'` 的行降为
> `trusted`；`/grant chat <正数 id>` 与把群设成 `owner` 一律拒收）。
> `blocked` 是任一侧一票否决且**先于**抬升判定，所以 `access.defaultChatRole` 出厂 `blocked`
> 仍表示「未登记的群整群静默」、`defaultUserRole` 出厂 `blocked` 仍保证陌生人不会因为进了受信群
> 而提权 —— 抬升语义没有把它变成一扇默认敞开的门。审批按钮的落点随之改到 owner 私聊，见 §2.2。

---

## 1. 权威清单在哪儿

本文不复制这四张表，改了它们不用回来改这里。

| 问题 | 权威 | 由什么焊住 |
|---|---|---|
| 哪些配置键还没接线 | [11 §2.0.1](./11-config-reference.md)（当前 10 条，每条写明为什么留着） | `tests/config.test.ts` —— 白名单每条必须在 `docs/11` 标记，且标注要跟着 `HOT_RELOADABLE_CONFIG_KEYS` |
| 验收条目的勾选状态 | [13](./13-acceptance-criteria.md)（当前 **325 / 522**） | `tests/acceptance.test.ts` —— `(自动)` 要点名真实用例文件、`(手动)` 要点名日期与场次且 [29](./29-manual-acceptance-log.md) 里真有那一条，签署表分子分母自动核对 |
| 某条手动验收项谁在哪天跑的 | [29](./29-manual-acceptance-log.md)（装置 / 逐场剧本 / 实测值 / 豁免登记） | 同上 —— 打了勾而台账里没有对应小节会报错 |
| WebUI 控制面够不着什么 | [21](./21-webui-coverage-gaps.md) | 无自动约束（人工复算，方法见其 §1） |
| 某行代码为什么长这样 | [`reviews/`](./reviews/) 里的条目编号 | `tests/docs.test.ts` —— **保护是部分的，不要当成全覆盖**：源码里 503 处引用、`reviews/` 里 288 个编号，而「删掉这一条就报错」实测只对 **18 个（6.3%）**成立。三层松弛：判据用 `corpus.includes()` 裸子串（`S-01` 被 `L-OPS-01` 满足、`I-01` 被 `D-UI-01` 满足，于是 `27` 的 `S-*`/`T-*` 与 `22` 的 `I-*` 两整个家族没有保护）、只认 `· 编号` 形式（裸写的 `` `L-OPS-01` `` 不进判据）、正则要求带连字符（`Z4`/`Z5`、`T17`、`A27` 全在覆盖外）。且是**单向**的：文档里多出零引用条目查不出来 |

---

## 2. 还欠什么

按「挡着别人 / 单独可做」分组。**每条都实测过**，括号里是核对时的实际值。

**这一节只放欠账。** 「刚落地的能力」「已解决问题的形态记录」「知情的边界」都不属于这里 ——
它们的归属是专题文档，本文最多留一句指针。判据很简单：**一条能被「补完」的才是欠账**，
补不完的（有意为之 / 修不了 / 已经做完了）不是。这条纪律是 2026-08-27 立的，
那次清理从 35 行里搬走了 18 行 —— 一张叫「还欠什么」的表，一半以上不是欠什么。

每一条都带一个 **⟨探针⟩**（形态见 §4 末条）：一句必须无命中的 grep，补完了就会响。

> **2026-08-27**：手测缺陷（[`29 §4`](./29-manual-acceptance-log.md) 那张表）的 **28 条已全部处置完毕**。
> 25 条修好了，按 §4 的规矩已从本文删除，「怎么发现的 / 怎么修的」留在那张表里；另 3 条各有归宿：
> `M-WEB-04` 转 [21](./21-webui-coverage-gaps.md)、`M-WEB-03` 已被实测推翻、`M-SNAP-01` 是装置问题。
> **它们挂着的验收项仍是 `[ ]`** —— `(手动)` 条目要勾得有一场新的手测台账（`## S9 · 修复回归场`），
> 见 `docs/13` 与 `tests/acceptance.test.ts`。那 19 条待回归的清单现成躺在 `29` 的场内小节里。
>
> ⚠ 这条注记本身踩过一次坑：三条已修的缺陷在这里挂了三天没删（`M-WEB-05` / `M-LOG-02` / `M-MEM-02`），
> 而**没有任何判据会因此变红** —— `tests/acceptance.test.ts` 只核本文的两个数字（勾选分子分母），
> §2 整个是裸的手工区。补闸的形态见 §4 末尾那条。

### 2.1 结构性的三条（[`reviews/27` §8](./reviews/27-full-scope-review.md) 的 `Z4`/`Z5`，需求方拍板留到下一轮）

有依赖顺序，不要并行：

| 编号 | 欠什么 | 实测 | 前置 / 影响 |
|---|---|---|---|
| `D-01` | 裸 SQL 散在仓储层之外 | **165 条语句 / 16 个文件**（`app.ts` 一个就占 76 条）。`reviews/27` 记的是「40+」，已经涨了；M12 把 `writeConfigRows` 下沉进了 `packages/db`，`custom_tools` 也是从头就走 `CustomToolRepository`，这一条没有再被加高 | 先做这条。`tests/db.isolation.test.ts` 的按 chat 隔离断言只覆盖得到 `packages/db` 里的查询，仓储外的这 165 条**一条都没被那道断言覆盖** ⟨探针：无 —— 判据是「165 条裸 SQL 分布在哪些文件」，一个 grep 表达不了「已经收拢」；复算方法见实测列⟩ |
| `D-04` | `composeRuntime` 没抽出来 | 函数不存在；`apps/bot/src/main.ts` 445 行全是装配 | 依赖 `D-01`。抽出来之后集成测试才装得起运行时 —— 现在 `I-10` 那条改动就是因此没有用例覆盖 ⟨探针：apps/bot/src/main.ts !~ composeRuntime⟩ |
| `D-02` | `ConsoleView.vue` 拆分 | **3097 行**（2026-08-27 实测。`reviews/25 §8` 记的是「1700+」；抽走扩展页从 3366 减到 3054、再抽走任务页减 133 行 —— 然后又涨回来了：手测那批修复往里加了原始 JSON 对话框与两个删除入口。**抽出去的比加回来的少**，这一条在变坏而不是变好）。渲染用例：`console.render.test.ts` **19 条**，抽出去的三张卡另有自己的一份 —— `tasks.card.test.ts` 10 条 + `schedules.card.test.ts` 12 条 | 前置条件是渲染用例，**这一条仍然是硬前置**：上一次没有用例就拆，14 个控制台页面全变空白（`reviews/24 · D-UI-01`）。这个形状已经走通两遍 —— 先补非空 fixture 让行模板真的被渲染，再抽页面壳 + `components/<页面>/` 的纯呈现子组件，然后补结构相关的用例。**再抽下一个页面照这个顺序**。第二遍（任务页）多两条经验：拆出去的卡各自带 loader 与分页游标，不要照抄扩展页「父层管所有写操作」（那条防的是跨卡共享 busy，这里没有，提到父层反而又造出一个争用点）；`DataGrid` 的 `row-click` 挂在 `<tr>` 上，行内按钮必须 `@click.stop`，否则「点取消同时弹出详情框」。另外记一条只有真浏览器发现得了的：WebUI 不能 import `@luoli/shared`（它拉 `node:crypto`，vite 会 externalize 成一调用就抛的桩；而 vitest 别名到 `src/` 并跑在 node 里，用例是绿的） ⟨探针：packages/webui/src/views/ConsoleView.vue !~ components/console/⟩ |

### 2.2 阻塞式人机通道：通道已落地，转人工仍未接线

「发一条带选项的消息、等人点、把结果回灌给正在等的调用方」这条通道**已经有了**：
`packages/core/src/interaction/prompts.ts`（`PendingPrompts`，等待者注册表 + 有界最近裁决表 +
撤键盘用的宽限 timer）＋ `packages/telegram/src/prompts.ts`（`TelegramPromptChannel`，渲染与
Bot API 调用），照 `TelegramToolBridge` 的形状注入、presence 即开关。规格在
[05 §6.1](./05-tools-and-permissions.md)，用例在 `tests/interaction.prompts.test.ts`。

- **Telegram inline keyboard 审批 —— 已落地，裁决入口在 owner 私聊（2026-08-30 拍板）。**
  〔批准〕〔拒绝〕发往 `access.bootstrapOwnerId` 的私聊，owner 点了走 `callback_query` 的
  `a:` 命名空间，落库 `decision_channel='telegram'`；**发起人会话只留一条不含倒计时、不含状态的
  纯文本报信**（因此没有要收的场，不需要收场编辑）。判 owner 用的是**有效角色**
  （`resolveEffectiveRole`），不是 `/cancel` 那条只取用户角色的窄口径 —— 新规则下
  `effectiveRole === 'owner'` ⟹ `isPrivate`，而按钮本来就发在私聊里，两者对得上。
  `request()` 的可用性判据是「WebUI 没有 SSE 通道 **且** Telegram 通道也不可用」才当场拒 ——
  只改一半的话新通道在没人开浏览器的部署里永远走不到，而那正是它唯一有用的场景。
  那道闸判的是**放行那一刻**：回执发不出去（owner 私聊不可达 / bot 被拉黑 / 429）而 WebUI 也没有
  SSE 时，由 `#receiptUndeliverable` 走同一条「无通道」口径当场拒，不留一条谁都裁决不了的 pending
  行干等 180 秒（`AC-APV-012` 的形状不变）。
  启动时扫 `approvals` 里 `tg_message_id IS NOT NULL` 的行收尾并清列，裁决落定时也清 —— 但
  **只在那次编辑真回来之后**：它是待办队列不是历史记录。收尾 = 撤键盘 + 把正文换成结局的
  **同一次** `editMessageText`（`AC-APV-004`），撤的目标取 `COALESCE(tg_chat_id, chat_id)`
  （迁移 `0016`）—— 那条带按钮的消息在 owner 私聊里，而 `chat_id` 记的是发起人会话，少这一列
  就是拿群 id 配私聊的 message_id 去编辑，全部 400。
  **这次推翻的是 2026-08-21 那次适用面拍板**：当时的前提是「会话角色是**上限**，所以 `trusted`
  群里连 owner 本人也只有 `trusted`」，于是按钮只在 owner 的私聊与 owner 档的群里出现。
  权限模型改口径之后那个前提没了 —— 群内一律封顶 `trusted`，`decidableBy:'owner'` 在**任何**群里
  都无人可满足，按钮留在发起人会话里只能是一排点不动的东西（而审批基本只在群里发生，
  `skipForOwner` 默认真）。
  **当初否掉它的两条代价仍然成立，各有兜底**：①每条审批两条消息（owner 私聊那条带按钮的 +
  发起人会话那条报信的）—— 报信那条无状态无倒计时，所以多出来的是一条消息，不是一条消息加一串
  编辑；②owner 从没跟 bot 说过话时私聊发不出去（403）—— 此时**不往群里贴点不动的按钮**，只发报信，
  审批退回 WebUI，连 SSE 也没有就走上面那条「无通道」当场拒。这两条都不挡任何已规划的功能：
  ACP / `HarnessAgent` 那条路本身就是 owner + 仅私聊（[14 §2](./14-open-questions.md) Q8-a），
  它的逐条 permission（机制已接、**默认档不用它**，[05 §3.5.3](./05-tools-and-permissions.md)）
  正好落在按钮能用的格子里。理由与代价见 [05 §6](./05-tools-and-permissions.md) 那个警示块。
- **`agent.askEscalateToUser`（转人工）—— 仍未接线**，仍留在 [11 §2.0.1](./11-config-reference.md)
  的 🚧 白名单里。通道不再是障碍（`PromptRequest.kind` 里已留 `agent_ask` 这一档），欠的是语义：
  问谁（子 agent 的发起人还是 owner）、选项从哪儿来（自由文本答复 vs 固定选项）、以及等人期间
  那个子 agent 占着的并发槽与 `askTimeoutMs` 怎么算。这三条没定之前接线就是又一个假开关。

### 2.3 零散的

| 欠什么 | 实测 | 备注 |
|---|---|---|
| **`PUT /api/sandbox` 收下 schema 里不存在的键并落进 `config_kv`** | `PUT /api/sandbox {"notAKey":123}` 回 **200**，`config_kv` 里多出一行 `sandbox.notAKey = 123`。成因是两层都不挡：端点无条件给每个键加 `sandbox.` 前缀（`app.ts:3336-3338`），而 `configSchema` 的 `z.object` 没有 `.strict()`，`safeParse` 把未知键**静默剥掉**后返回 success —— 于是校验通过，`writeConfigRows` 写的却是**原始**那份 dotted 条目 | 补 `M-WEB-10` 的用例时量出来的（2026-08-27）。`CLAUDE.md` 点名的那个雷：「`config_kv` 的每一行都会被 `loadConfig` 当成配置覆盖层解析」。目前不至于炸 —— `loadConfig` 对非法路径逐条剔除并经 `onInvalidOverride` 上报 —— 所以这是**一条静默积累的垃圾**而不是启动失败。同类的 `PUT /api/config` 走的是 `mergeDotted` + 白名单，不受影响。修法：写库前先拿 dotted 键对 schema 路径核一遍，未知键回 `invalid_key`（`invalidKey()` 已经在那儿了） ⟨探针：packages/server/src/app.ts !~ configSchemaLeafPaths⟩ |
| **`/usage` 的 `minRole` 与 `docs/08 §8` 对不上** | 那张表写的是 `all \| limited \| 本会话/本人用量；owner 看全局`，命令注册表里是 `minRole: "owner"`（`bot.ts` 命令表）。放宽是权限变更，不当作缺陷顺手改 | 需求方 2026-08-27 拍板：**先不管**，后期在 WebUI 单开一个 tab 统一管理所有命令（届时一并解决权限与文档口径）。记在这里是为了那时不必重新发现它 ⟨探针：无 —— 已拍板先不管，等 WebUI 命令管理 tab 一并收；那时改的是命令表的一格，没有哪个符号会因此出现⟩ |
| trace 树上还有两处**知情的**不对称（第十轮整改留下的） | ①`tool.error` **只覆盖主 agent**：子 agent 的 `onStepEnd` 不走 `stepToolResults`，同一个盲区在那边还开着（事故起点在主路径，`docs/10 §2` 那行也没承诺子 agent）；②运维禁用某个工具时 `tool.disabled` 与 `tool.denied` **同时落两行**（前者是既有 kind + 既有断言，后者是统一流水）。〔原来还有第三处 —— `sandbox.run` 没有 `parentSpanId`、在 trace 里是 depth 0 —— **已修**（`M-LOG-02`，`sandbox/index.ts` 的 `run()` 收 `parentSpanId`，三条工具路径各穿一遍）〕 | 两条都在 `docs/10 §2` 的表里写明了边界，所以不是「以为有其实没有」。①是唯一有实际排障代价的一条：子 agent 反复用错工具参数仍然只在上下文里留一条下一轮就被抹掉的 `error-text`。②要合成一条的话 `tests/regression.round9.test.ts` 那条 `warn: true` 断言要跟着改 ⟨探针：packages/core/src/agent/subagent.ts !~ stepToolResults⟩ |
| `pnpm dev`（tsx）下 plugin 热重载**永远跑旧代码**，且修不了 | tsx 的 ESM loader 按文件路径缓存、忽略 URL 上的 `?v=`，于是 `PluginManager` 的 cache-busting 整体失效：11 次 reload 每次都真跑 reconcile（`onLoad`/`onUnload` 都调、DB 更新、无 `load_error`），而**每次 `onLoad` 打印的都是 v1**。最小复现：`node probe.mjs` → `v1 → v2`；`node --import tsx/loader probe.mjs` → `v1 → v1` | **不假装修好**（`docs/16 §5`）：启动落一条 `plugin.hot_reload_unreliable` warn、reload 端点的响应带同一句话、`docs/07 §3.2` 与 `CLAUDE.md` 各写一句。生产（`pnpm start` 跑 `dist/` 的纯 node）不受影响，但 `plugins.watch` 的既定用途正是「本机写 plugin」—— 唯一该用它的场景恰好是它失效的场景。界面上现在显示了：reload 的响应带 `hotReloadReliable`，为假时弹**不自动消失**的 warn 并在 plugin 卡片上常驻一条提示（`G-API-26` 已闭合）。**底层那件事仍然修不了** —— 这一条留在这里是因为它是「不假装修好」的活样本 ⟨探针：无 —— 修不了（tsx 的 ESM loader 按路径缓存，忽略 URL 上的 ?v=）。这一行留着是「不假装修好」的活样本⟩ |
| MCP 子进程死后 `mcp_servers.state` 最长 5 分钟才纠正 | 判活性已经修好（死 client 不再被缓存命中，cron 与「重连」按钮都真的能重连），但库里那一行要等下一次 `mcp-health` reconcile 才从 `up` 改过来 | **不是在 `onclose` 里写库就能解决**：那个回调从子进程的 `'close'` 事件同步跑，`closeDatabase()` 之后一条泄漏子进程自然死亡会让裸 `db.prepare` 抛在 handler 里 → `uncaughtException`（`LogSink.event` 保证不抛，所以那条路只记日志）。要秒级反映得先给它加一个「库还开着吗」的判据。**界面这一半本轮补了**：MCP 表多一列「上次核对」，超过一个 `healthCheckCron` 周期就标「可能已陈旧」（`G-API-27` 的界面部分闭合）—— 陈旧还在，但读得出来了 ⟨探针：packages/core/src/mcp/manager.ts !~ databaseOpen⟩ |
| 分段回复的归档文本在**真的切开时**是近似字面 | 段与 `message_id` 的对应是**精确**的；不精确的是字面形态：渲染在分片之前、分片点是渲染后码点数组上的下标，反推源文本下标要把 offset 穿过两个递归渲染器（`**粗**`→`*粗*`、`###` 降级、列表符替换都不是 1:1）。只有一片时（绝大多数消息）那一片就是整条源文本，口径一字未变 | 切开时按 `toPlainText` 逐段反推 —— 它本来就是解析失败降级时**真正发出去**的那一份。要字面也精确得单独给 `safeRender` 加一张 offset map，而它的空行保真是有 55 条用例焊住的既有契约（`tests/output.render.test.ts`），不该为这件事去动它 ⟨探针：packages/telegram/src/output.ts !~ offsetMap⟩ |
| `health` 事件没有周期心跳 | 只在 provider 测试与 MCP 重连后 emit（`app.ts:727` / `1400`） | **有意为之**：顶栏新鲜度依据业务事件，不把连接状态伪装成周期健康检查。要改先想清楚这一点 ⟨探针：无 —— 有意为之：顶栏新鲜度依据业务事件，不把连接状态伪装成周期健康检查。要改先推翻这条取舍⟩ |
| 解析失败的第二级兜底（发 `.md` 文档）没实现 | `sendWithFallback` / `TelegramOutput.edit` 只做了第一级：`can't parse entities` 时以纯文本重发/重编辑一次（`output.ts:161`、`stream-output.ts:98`）。[08 §5.2](./08-telegram-adapter.md) 那条「再失败则把内容作为 `.md` 文档发出并回复一句摘要」压根没有实现，而 AC-OUT-005 一直挂着 `[x]`（**已改回 `[ ]`**） | 第一级现在**记 `tg.parse_fallback` warn** 了（见 [10](./10-logging-and-observability.md) 的事件表），纯文本重发那一跳也包了 try —— 此前它是裸调，第二次失败照样打穿整轮，正是 `sendWithFallback` 的 docstring 说要防的事。**只剩第二级**：再失败则把正文作为 `.md` 文档发出并回复一句摘要 ⟨探针：packages/telegram/src/output.ts !~ sendDocument⟩ |
| [08 §6](./08-telegram-adapter.md) 的占位消息上那个 `[取消]` 按钮**从来没有实现过** —— 这一轮才有了第一个生产者，而它挂在别的消息上 | 那一节的示意图里三行占位消息各带一个 `[取消]`，`callback_data = 'c:<turnId>'`。判据那一侧全是真的：`bot.ts:452` 的 handler 在、`TurnRegistry.cancel` 的「发起人或 owner」判据在、收尾那次 `editMessageText` 写「⛔ 已取消」也在（`bot.ts:832`）。**缺的只是键盘本身**：`output.ts` / `stream-output.ts` 一处 `reply_markup` 都没有，全仓 `reply_markup` 只出现在 `prompts.ts`（审批）与 M13 的 `acp-card.ts`。所以 M13 之前那条 handler 是**活着但不可达**的代码 —— 全仓零个 `c:` 生产者 | M13 的 ACP 进度卡片是第一个真生产者（[08 §6.1](./08-telegram-adapter.md) 规则 8），它复用同一条通道而不是新开一种 callback。**因此那条判据路径至今没有被真的点过一次** —— 第一次真实 ACP 调用时值得手点一下。占位消息那一侧要不要补键盘是 D17 占位消息规格的事，比这一条大：`report_progress` 编辑占位消息时得把键盘一起带上（不带就等于撤掉），而那要排 `perChatPerMinute` 的队 ⟨探针：packages/telegram/src/stream-output.ts !~ reply_markup⟩ |
| `trigger.channels` 点不亮：频道消息一条都进不来 | 频道消息是 `channel_post` 更新，而 `packages/telegram/src/bot.ts` 里没有这个处理器（`bot.on('message')` 不匹配它），`telegram.allowedUpdates` 的默认值里也没有它。`trigger.ts:45` 那半条判断（`chat.type === 'channel' && !config.channels → null`）因此永远等不到输入 | 不是「以为有其实没有」：那个更新类型在 WebUI 的复选框里标着「无处理器」，配置手册也写了。真要接得先定频道语义 —— 频道里没有「@ 谁」，打开等于对每条频道消息都表态（`descriptions.ts` 里那句话），而 `my_chat_member` 之外还要处理 `channel_post` 的作者身份（频道消息可以没有 `from`） ⟨探针：packages/telegram/src/bot.ts !~ channel_post⟩ |
| **一条被开关关掉的通道，模型无从知道它存在** | `tools.selfExtend.*` 出厂全关，于是 `write_skill` 压根不在模型的工具目录里 —— **而它拿不到任何说明为什么没有**。实测后果（[07 §2.5](./07-skills-plugins-mcp.md)）：用户丢了一个 skill 包，模型解到工作目录一路 `bash scripts/invoke.sh` 用了起来，全程没有一次 `write_skill`（`logs/2026-08-18/tool.jsonl` ts 1787036340–1787036441）。**已闭合的是另外两件事**：通道本身（`install_skill`）与运维侧的提示条（[21 · `G-EXT-07`](./21-webui-coverage-gaps.md)）；模型侧至今没有对策 | 形状上已有先例：`tools.maxRegistered` 截断时会在 RUNTIME 块告知（`prompt/assembler.ts:282`），那条从此是承诺而不是欠账。同样的办法对「被闸关掉的通道」适用，但**要先定边界** —— 把所有关着的开关都报给模型等于给它一张「去求人开这些」的清单。也可以明确拍板「不做」，那就从这里删掉 ⟨探针：packages/core/src/prompt/assembler.ts !~ selfExtend⟩ |
| 验收条目 197 条未勾 | 其中人工条目一律保持未勾（要人签字，不是测试的事）；其余是没有对应 vitest 用例的 `(自动)` 条目 | 勾选形式由 `tests/acceptance.test.ts` 定死，勾之前先写用例 ⟨探针：无 —— 由 tests/acceptance.test.ts 焊住（分子分母自动核对），本文只指过去⟩ |
| 10 条配置键未接线 | 见 [11 §2.0.1](./11-config-reference.md)，每条写明「暂时没做」还是「不该在这一层做」 | 摘键之前先看 [21 §1](./21-webui-coverage-gaps.md) 的复算方法 ⟨探针：无 —— 由 tests/config.test.ts 与 docs/11 §2.0.1 双向焊住，本文只指过去⟩ |
| **`data/workspace/<chatId>` 至今没有任何回收**，而持久容器不改变这一点 | `MaintenanceService` 一行都没管它，唯一的可见性是 `GET /api/health` 的 `workspaceBytes`。容器到期被回收**不动这里的文件**（那是 `container_reset` 默认不清文件的同一条取舍：容器是环境，workspace 是数据）| 要清只能人工，或用 `container_reset` 的 `wipeWorkspace` 单会话清（挪进 `.luoli-trash`，不真删）。真要做全局回收，判据不能是「多久没动」—— 一个季度不说话的群，它的工作区仍然是它的资料 ⟨探针：packages/core/src/maintenance.ts !~ gcWorkspace⟩ |
| `web_fetch` 现在会抽标题 / 链接 / 图片，图片也真的进上下文 —— **JS 渲染与反爬仍然没有** | 此前三样东西是「页面上有、模型看不见」：`<title>`（`head` 整棵在 `DROP_TAGS` 里）、`<a href>` 的地址（只留锚文本，模型没法顺着页面走，只能退回 `web_search` 再搜一遍）、`<img>` 的 alt 与 src（`img` 既不在 `DROP_TAGS` 也不在 `BLOCK_TAGS`，扫到它一个字都不 push）。另外**非 HTML 响应被无条件 `toString('utf8')`**：`image/png` 之类产出最多 2MB 乱码再被 64KB 截断塞进上下文，比「取不到」更糟 —— 整个工具输出预算烧在噪声上，而模型以为自己读到了页面。而图片走不通是**三处各自独立**地挡着：抽取层丢掉 img、工具结果被 `JSON.stringify` + 截断 + 包成不可信文本、`isImagePart` 只认顶层 part 所以 vision 切换 / `capImages` / `degradeImages` 一个都认不出它。同一条管道让 **MCP 的截图也是坏的**（`browser_screenshot` 变成一坨截半 base64） | 规格在 [05 §3.6](./05-tools-and-permissions.md)，红线进了 [02 §9](./02-context-engine.md) 第 21/22 条，表在 [03 §2.4](./03-data-model.md)（`web_assets`）。三处最容易踩：① **`gcFiles()` 的 `referenced` 现在要并两张表** —— 漏一张的表现不是报错，是那张表的文件被静默当孤儿删掉（本仓踩过两次）；② **图片有两条通道**，跨轮靠 `webasset://` 顶层 part、本轮靠骑在工具结果上的 `media`，缺一条就是「这一轮看不见」或「下一轮看不见」，而 base64 **绝不许**落进 `parts_json`（`tool-result` 不在 `OPAQUE_PART_TYPES` 里，硬截断会把它切半，而截断结果是持久化的）；③ **vision 判据是轮首快照**，轮内注入的图靠 `turn.mediaInjected` 补，改成「每步重扫 messages」不管用（扫的是同一个认不出它的判据）。**仍然欠的**：JS 渲染（SPA 只能取到空壳）与反爬（UA 是 `LuoLiCore/0.1`，不少站点直接 403）。形态已经定了 —— 接一台浏览器 MCP 而**不是**把渲染引擎接进 `web_fetch`（那会绕开 `guardedFetch` 整套 SSRF 防护，而它还执行页面 JS，URL 预校验挡不住页面自己去打元数据地址），候选与那一整套警告见 [07 §4.4.1](./07-skills-plugins-mcp.md)。值不值得深度集成没拍板 ⟨探针：packages/core/src/tools/web.ts !~ renderJs⟩ |
| ACP agent 的花费**落库了，但它不进配额、也不进用量页的聚合** | 一次 ACP 调用跑完后在 `agent_runs` 上留一行（`kind='sub'` + `agent_name='acp:<name>'` + `model_alias='external'`），外部花费与用量进迁移 `0014` 新加的 `external_cost_usd` / `external_usage_json`，而**同一行的 `cost_usd` 恒写 0** —— 结构上把那个数字挡在每一个 `SUM(cost_usd)` 之外。**这是「落库」不是「记账接上了」**：`usage_ledger` / `quota_counters` / `turns.cost_usd` 里仍然一分钱都没有，唯一的闸仍是 `agent.acp.maxCostUsd`。三条理由各自成立：`usage_ledger` 的行有 provider 身份（`provider_id` / `model_id` 必填、用量页按它分桶，塞一条 `provider_id='omp'` 等于凭空造一个我们不拥有的 provider）；计价只有一份判据，而 ACP 给的是**已经算好的**金额、没有 tokens × prices 可以重算；`quota` 的分母是本系统的 key，掺进外部花费后那个比例看起来权威、实际无意义。**那个数不是我们的钱、口径由外部 agent 定、我们无法核对 —— 把它摆在自己的成本旁边就是邀请人把两者相加**（照 `PUT /api/quota → not_implemented` 那条先例：摘除比伪造安全）。那一行**不占**本轮的子 agent 名额：`AgentManager.spawn()` 判 `agent.maxSubagentsPerTurn` 的那条 `COUNT(*)` 排掉 `agent_name GLOB 'acp:*' AND model_alias='external'` 的行 —— 那个数管的是本系统自己的 fan-out 成本，而它此前数行不看 `agent_name`，给出的是一个**取决于调用顺序**的上界（行是跑完之后才插的，只压得住同轮里排在它后面的 `spawn_agent`），比「占」与「不占」两种一致的选择都更坏| DDL 与口径在 [03 §2.7](./03-data-model.md)，两条路的记账分工在 [04 §6.2](./04-agents-and-providers.md)，写入侧在 `packages/core/src/acp/runs.ts` ⟨探针：packages/core/src/acp/runs.ts !~ UsageLedger⟩ |
| 模型猜错一个工具名，**整份可用工具名单被抄进上下文并持久化** | AI SDK 的 `NoSuchToolError` 把 `availableTools: Object.keys(tools)` 写进 `message`，实测文本 `AI_NoSuchToolError: Model tried to call unavailable tool 'nope_nope'. Available tools: search_tools.`（`tests/tools.catalog.wiring.test.ts` 量到）。而 `stepToolResults`（`packages/core/src/agent/runtime.ts`）把 `error.message` 原样拼进 `error-text` 落进 `context_messages`，`pruneLevel: 1` —— 一次猜错就按当时的常驻工具数写一份名单进去，此后每轮重发直到被裁剪。**改动前就是这样**，不是折叠引入的：折叠工具的误调被 `repairToolCall` 改写成一次检索，走不到这条路，只有**纯幻觉的名字**才会 | 挡着的是「按需暴露省下来的那部分被这条路吐回去一些」—— 每步省下 1003–3064 token（[04 §2.1](./04-agents-and-providers.md#21-prompt-缓存) 那张表），而一次幻觉写进去的名单是常驻工具数 × 十几个字符、且**持久**。修的位置在 `stepToolResults`：那里已经在决定落进上下文的文本，把 `NoSuchToolError` 换成一句不枚举名单的短句即可（模型该看的目录在 block 3 与 tools 数组里，错误里再抄一份是纯噪声）。**没有顺手改**：它改的是所有工具的错误文本、属既有行为，按房规要先改 [05 §4](./05-tools-and-permissions.md) 的错误契约再动代码 ⟨探针：packages/core/src/agent/runtime.ts !~ Available tools⟩ |
| 归档检索翻页：搜索分支**多取回 `page*size` 行**（性能，不是正确性） | `adminSearchAll(query, page*size)` 取回前 N 条再切片。**上一轮把它记成缺陷是误判**：`total` 走的是单独的 `adminSearchCount(query)`（`app.ts:2531`），而 `ORDER BY bm25(messages_fts), m.tg_date DESC LIMIT ?` 是确定全序，切片结果与 `LIMIT/OFFSET` 等价 —— 2026-08-26 S2 实测 page 1/2/3 无交集、首尾相接、`total` 恒定 | `AC-WEB-025` 已判**过**（[29 · `M-WEB-03`](./29-manual-acceptance-log.md) 有推翻过程）。剩下的是代价：翻到第 N 页要取回 `N×size` 行，深页线性变差。真改成 `LIMIT/OFFSET` 之前**先定 FTS 命中上限之下 total 的口径**，否则页码不漂了而总数开始说谎 ⟨探针：packages/db/src/archive.ts !~ OFFSET⟩ |

---

## 3. 查过、没有发现问题的地方

**下一轮先读这三节再决定查什么**，它们是给复审省时间的，每一项都逐文件读过。

| 范围 | 在哪 | 覆盖了什么 |
|---|---|---|
| **真环境跑过的**（第十轮活体测试） | [`reviews/28` §6](./reviews/28-round10-live-system-test.md) | **这一节是读码复审给不出来的**：docker 沙箱真执行（argv/OOM/pids/网络/超时 kill/卷映射/只读根，此前零执行覆盖）、cron 真到点触发与停机错过不补跑（此前全靠手动 `trigger()`）、真人 + 真 Telegram 的毒 markdown 渲染与 `/cancel` 与媒体全类型与 vision 别名切换、真并发 rebase、provider 健康全周期含冷却恢复、审批三条路、SSRF 五类含 DNS rebinding 与重定向、skill 包「装一半整棵回滚」、7 路并发压 SQLite、真浏览器跑 14 页、SSE 四条硬约束、**日志脱敏 400 MB 全量扫描零命中（阳性对照 9/9）**、`reviews/27 · S-01` 复验未回归 |
| 第十轮**排除**掉的 8 条假象 | [`reviews/28` §8](./reviews/28-round10-live-system-test.md) | 下一轮若沿用同一套装置会再撞上：假上游的固定 usage / 非流式判据 / 跨轮复用 toolCallId、`fetch()` 探针的 450 ms 基线、以及两条属历史而非现状的日志形态 |
| 全维度（OWASP / SOLID / JS·TS） | [`reviews/27` §7](./reviews/27-full-scope-review.md) | 13 个面：SQL 注入、原型污染、CSRF + 会话、SSRF 主路径、密钥、提示词注入、ReDoS、权限模型、上下文引擎 §9 的 19 条红线、优雅关停、并发闸与互斥、WebUI 前端 XSS |
| 工具系统 | [`reviews/26` §6](./reviews/26-round8-tool-review.md) | 七道权限闸、`PathJail` 的五类穿越、`untrusted()` 包裹顺序、超时账、追发预算、`edit_file` 审批档位 |
| WebUI 控制面 | [21 §5](./21-webui-coverage-gaps.md) | 判定为「不是缺口」的三类：运行时没接线的配置项、被取代的重复端点、有意做成只读的地方 |

---

## 4. 怎么维护这份文档

- **发现新缺口** → 写进 §2，带实测值和 `file:line`。不要只写「XX 没实现」，写清楚**挡着什么**。
- **§2 只放欠账** —— 判据是「它能被补完吗」。「刚落地的能力」「已解决问题的形态记录」
  「有意为之 / 修不了的边界」都不是欠账，写进对应的专题文档，本文最多一句指针。
  2026-08-27 那次清理从 35 行里搬走 18 行，就是因为这条纪律此前只在头脑里：
  一行「XX 刚落地，三处最容易踩」读起来像欠账，于是它永远不会被删 —— **没有完成条件的条目
  不会退休**，而一张退不了休的清单会一直变长，直到没人读它。
- **补完一条** → 从 §2 删掉。历史留在当轮的复审报告里，不在这儿堆。
- **做完一轮复审** → 报告写进 [`reviews/`](./reviews/)，加 frozen header，然后**把结论折进本文**。
  报告本身从此不再改 —— 它的条目编号是源码注释的凭据（`tests/docs.test.ts` 焊住）。
- **§1 那四张表永远不要抄到这里来**。想知道具体哪 10 个配置键、哪 272 条验收项，点进去看。
- **§2 的每一条都要带一个活性探针**（`⟨探针：…⟩`），由 `tests/docs.test.ts` 执行。
  探针是一句 grep：`⟨探针：<相对路径> !~ <正则>⟩` 断言那个文件里**找不到**这个模式。
  一条欠账被补完，模式就会出现，探针当场变红 —— 于是「修好了但忘了从 §2 删掉」不再可能。
  这是本文 2026-08-27 那次漏删（三条已修缺陷在 §2 挂了三天）之后加的：那次**一个判据都没响**，
  而 §2 恰恰是全库最需要保鲜的一节。写不出探针的条目（纯语义欠账、跨文件的「没接线」）
  写 `⟨探针：无 —— 理由⟩`，测试放行但要求理由不为空 —— **一条都不许沉默地跳过**。
