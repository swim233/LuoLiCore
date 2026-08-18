# 26 · 第八轮：工具系统专项复审

> ❄️ **已冻结（2026-08-17 快照）** —— 本文只记录当轮的发现与整改，**不再更新**。文中所有
> 「未实现 / 未接线 / 仍然开着的」都是**当时**的状态，不代表现在；当前状态见
> [`00-state.md`](../00-state.md)。条目编号（`V-SSRF-01` 之类）是 240 处源码注释的溯源凭据，
> **不得重编号、不得删除**。

> 范围只有一处：`packages/core/src/tools/`（注册表、策略表、文件工具、web 工具、jail）加上
> `builtins.ts` 里注册的 **31 个内建工具**逐个过一遍。不是「再审一遍整个系统」。
>
> 判据是 [05](../05-tools-and-permissions.md) 与 [07](../07-skills-plugins-mcp.md)：文档是权威来源，
> 所以「文档说了、代码没做」和「代码做了、文档没说」都算缺陷，前者改代码、后者改文档。
>
> **每一条都是实测过的失败形态**，不是读代码觉得不对 —— 下面每张表的「实测」一栏写的就是
> 复现方式。回归用例全部落在 `tests/tools.round8.test.ts`（21 条）。

---

## 1. 结论

31 个工具里 **12 个有问题**，分三类：

| 类 | 条数 | 性质 |
|---|---|---|
| A · 实现错误 | 6 | 代码与文档不一致，且不一致的那一侧是错的 |
| B · 能力缺口 | 4 | 文档定了参数/格式，实现只做了一半 |
| C · 假开关 | 2 | 配置项收下了、没有任何地方读 |

没有发现权限绕过：`minRole`、`available()`、运维禁用、子 agent 的 `memory_write` 四道
在 `execute()` 里都复查得住（`docs/20 · W-TOOL-01` 那次整改是有效的）。**熔断计数漏了两种失败**
（A-5）是这一轮唯一一条带安全面的：它让「模型原地重试到步数耗尽」这件事重新变得可能。

---

## 2. A 类 · 实现错误

### A-1 `list_dir` 没有 realpath 去重，且把软链显示成空串

`glob`/`grep` 在 `docs/20 · W-FS-01` 加过已访问目录去重，`list_dir` 当时漏了。它的 `depth`
只挡递归层数、挡不住同一棵树被反复走进去。

**实测**：`a/b/f.txt` 三条目的树 + `ln -s . loop`，`list_dir(depth=5)` 交回 **17 条**，其中 5 条
`path` 是空串 —— `loop` 的 realpath 就是搜索根，`relative(root, root)` = `''`。重复项还会把
500 条的预算占满，而模型拿空串去 `read_file` 就读到了目录本身。

**修**：三个遍历工具共用 `#enter()` 去重；另外把「显示路径」与「校验路径」分开带 ——
显示取软链名那一侧，校验取 realpath。

### A-2 一个越界软链让整次 `list_dir` / `glob` / `grep` 失败

`docs/22 · I-03` 修的是**断链**软链（`statSync` 抛 ENOENT）。但遍历里 `jail.resolve()` 在
`statSync` **之前**，而它对指向 workspace 外的软链抛 `path_outside_workspace` —— 那一抛没人接。

**实测**：workspace 里 `ln -s /etc escape` 之后，`list_dir` / `glob` / `grep` 全部返回
`{ok:false, error:'path_outside_workspace'}`。同目录里另外几百个好文件一并看不见，而
`bash` 一行就能建出这个软链。

**修**：两种都跳过并计入 `skipped`，与 I-03 同一套处置。

### A-3 `delete_file` 能删整棵目录树，没有 `recursive` 也没有深度闸

doc §3.1 写的是 `{path, recursive?}` + 「`recursive` 时必须审批且路径深度 ≥2」。实现只有
`{path}`，而 `remove()` 用 `rename` 搬进回收站 —— `rename` 一个目录就是把整棵树搬走。

**实测**：`delete_file({path:'one'})` 把 `one/two/three/f.txt` 整棵搬进 `.luoli-trash`。这个工具是
`approval: 'always'`，但审批弹窗上只有一个路径，owner 分不出这一下删的是一个文件还是半个
工作目录。

**修**：目录必须显式 `recursive: true`（否则 `path_is_directory`），且深度 ≥2
（否则 `recursive_delete_too_shallow`）。

### A-4 `read_file` 走 `skill://` 时不受 `tools.fs.maxReadBytes` 管

工作目录那一支 `Math.min(limit, maxReadBytes)`；`skill://` 那一支写死 256KB 且照收模型传的任意
`limit`。两条读路径的预算必须是同一份 —— skill 目录里放什么文件是运维的事，而 skill 可以在
WebUI 里编辑。

**修**：`skill://` 也按本轮配置里的 `maxReadBytes` 夹。

### A-5 `invalid_input` 与「未获批准」不计入熔断，模型可以无限重试

`tools.maxConsecutiveErrors` 是「模型别原地重试到步数耗尽」的**唯一**硬边界（doc §8.1），而它
此前只数 `execute()` 的失败。参数写错和审批被拒 —— 两种最常见的失败 —— 一次都不计。

**实测**：注册一个 `approval: 'always'` 的工具、审批一律拒绝，连发 6 次全部照收
`{ok:false, error:'未获批准'}`，既不计次也不熔断；`invalid_input` 连发 5 次同样。审批那一侧尤其
要紧：每一次被拒的重试都是一条推给 owner 的通知。

**修**：两者都走 `#failed()`。门槛仍是**连续**失败，成功一次即清零。

### A-6 `python` 用 heredoc 传代码

doc §3.3 写的是「把 `code` 写入 `workspace/.luoli-tmp/<id>.py` 再执行」。实现拼的是
`python3 - <<'PY'\n${code}\nPY`。

**后果**：正文里只要出现一行 `PY` 就把脚本从那里截断（模型写解析器、写测试数据都可能撞上）；
stdin 整条被 heredoc 占着，脚本里的 `input()` 读到的是自己的后半截；`sys.argv[0]` 是 `-`，
traceback 里的文件名是 `<stdin>` 且没有源码行 —— 模型看着一个没有行号的 traceback 猜错在哪。

**修**：照文档落成临时文件再执行，跑完删掉。

> 这一处的修法本身有个坑，值得记下来：临时文件的路径要按 **`context.workspace`** 拼，**不能**走
> `filesFor()`。`tools.fs.allowHostFsForOwner` 打开时 owner 的 jail 根是 `/`，
> `.luoli-tmp/x.py` 会落到 `/.luoli-tmp/` 去，而沙箱的 cwd 仍是 workspace —— 写得进去也跑不到
> （还大概率因为 `/` 不可写直接失败）。交给沙箱的则必须是 workspace 内的**相对**路径：宿主与
> 容器（cwd=`/workspace`）两种形态下它才指同一个文件。回归用例按同一顺序做这两件事，
> 所以路径这一步再写错会红。

---

## 3. B 类 · 能力缺口

### B-1 `read_messages` 只有 `{limit}`

doc §3.2 定的是 `{anchor?, direction?, limit?}`，`anchor` 可为消息 id 或 ISO 时间，
`direction: before | after | around`。实现只能取「最近 N 条」，DB 层也只有 `recent(limit)`。

**后果**：模型要找一句三天前的话，除了把 `limit` 一路加到上限（200）没有别的手段 —— 而那正是
把上下文吃满的做法。`AC-TOOL-011` 就是这一条。

**修**：`ScopedArchiveRepository.window()` + 工具侧的锚点解析。数字串一律按 id 认而不是当日期：
模型十有八九把 `#12841` 里的数字当字符串递过来，而 `Date.parse('12841')` 在某些运行时会解析成
一个年份，于是它读到一段完全不相干的记录还以为那就是自己要的位置。解析不出来交回
`invalid_anchor`，**不悄悄退回「最近 N 条」**。

### B-2 `search_messages` 没有 `from` / `after` / `before` / `kind`

doc §3.2 定了这四个。四个条件写成 `@x IS NULL OR …` 的常量 SQL（本文件 `recent()` 已有的写法）
而不是按传了哪几个拼串：语句文本固定才吃得到预编译缓存，而「没传的参数不出现在 SQL 里」还得在
绑定侧同步剔掉，漏一处就是一个运行时的 `missing named parameter`。

`admin_search_messages` **不给**这组参数：`adminSearchAll` 不认它们，而收下一个参数再默默忽略比
没有这个参数更糟 —— 模型会以为自己已经按人过滤过了（[16 §5](./16-remediation-plan.md)）。

### B-3 三个检索工具交回原始行对象，不是 doc §3.2 那个格式

doc §3.2 给了统一格式 `#12841 [2026-08-14 10:02] 张三(@zhangsan): 今天去哪吃`，实现交回的是
行对象。`read_messages` 默认 50 条，用行对象要多花两千多 token 在 `chatId` / `direction` /
`fromKind` / `triggered` / `triggerReason` 这些每条都一样、或者对模型压根没用的字段上。

**修**：`citeArchivedMessage()`。一处要小心：**`↩︎#` 后面必须是归档 id**，而
`reply_to_tg_message_id` 是 Telegram 的编号，两套不通用 —— 原样当 `#` 渲染出去，模型照着
`get_message` 回查会取到另一条消息或者什么都取不到，而它没有办法知道自己拿错了。换算一次查完
整批（`archiveIdsByTgMessageIds`），换不到就不渲染这个标记。`get_message` 照旧交回结构化的
一条：那才是「放大看一条」的工具。

### B-4 `web_fetch` 把原始 HTML 整份交给模型

doc §3.6 写的是「响应上限 2MB → 转 markdown」。一个普通页面九成是 script / style / 导航，
按 `tools.maxOutputBytes`（64KB）截断之后经常连正文的第一段都没进去 —— 模型「取回来了但什么
也没读到」。

**修**：单趟扫描抽成纯文本。**不用正则**：输入是最多 2MB 的不可信文本，而
`<script[^>]*>[\s\S]*?</script>` 这类形状在「一堆开标签、没有闭标签」的输入上是 O(n²) 回溯，
与 `docs/24 · R-SEC-01`（grep 换 RE2）同一条教训 —— 接受任意输入就必须有线性上界。回归用例拿
8 万个 `<script>` 打这条路径。抽过的响应带 `extracted: 'text'`：这一点要交出去，否则模型会以为
页面上本来就没有那些表格和脚本里的数据。

`tools.web.summarizeWithAlias`（抓回来先用 low 档摘要）仍是 🚧，仍在
`KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里 —— 所以 schema 里也**没有** doc 原先写的 `prompt` 参数。

---

## 4. C 类 · 假开关与被漏掉的边界

### C-1 `agent.askTimeoutMs` 一路传进 `registerBuiltins`，没有任何地方读

`ask_parent` 从来不等答复（当场返回 `ask_parent_not_implemented`，或用调用方自带的 `default`），
所以「等多久」无处可用。这个键此前既不在 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里、`docs/11` 也没标 ——
`tests/config.test.ts` 那条「每个叶子键要么有路径级引用、要么进白名单」的断言之所以过，正是因为
`main.ts` 把它传了进来。运维改它、以为改了什么。

**修**：摘掉那个死参数，进白名单，`docs/11` 标 🚧。同一件事的第三个键，和
`askArbiter` / `askEscalateToUser` 并列。

### C-2 `spawn_agent` 的并发排队不认 `abortSignal`

`agent.maxConcurrentSubagents` 超出时排队，而那个 promise 只由前一个子 agent 释放槽位来唤醒。
于是 `/cancel` 之后排在后面的 `spawn_agent` 照样会醒过来、照样真的去派一个子 agent —— 一轮已经
取消的对话继续烧 token，而没有任何人还在等它的结果。这个工具是 `timeoutMs: null`，注册表那道
兜底的 race 也不会砍它。

**修**：排队时挂 `abort` 监听，取消就出队并交回 `{ok:false, error:'turn_cancelled'}`，对应的 task
行落 `failed`。出队时要把自己从队列里摘掉，否则 `releaseSlot` 会把一个已经放弃的等待者当成
「唤醒了一个」，而真正在排队的那个继续等 —— 槽位就这么漏掉一个。

### C-3 skill 的 `allowed-tools` 把追发工具一起关掉了（doc §07 的「核心工具集」没实现）

`docs/07 §4` 的收窄公式里有 `∪ 核心工具集`，代码里不存在这一项 —— `prepareStep` 与
`ToolRegistry.execute` 只豁免 `load_skill`。

**后果**：载入一个 `allowed-tools: [bash]` 的 skill 之后，模型这一轮再也看不到 `send_message` /
`report_progress` / `context_stats` —— 跑完 skill 连一句话都追发不出去，子 agent 连进度都报不了。

另一半反过来错了：**「未声明 `allowed-tools` 则不收窄」= 对并集贡献空集**，而
`SkillLoader.load()` 在这一档交回的 `allowedTools` 等于「此刻全部可用工具」，调用方无条件把它
并进本轮允许集 —— 于是先载入一个 `allowed-tools: [read_file]` 的 skill、再载入一个不声明的，
前一个的收窄就被整个抹掉了。

**修**：核心工具集落成 `SKILL_NARROWING_EXEMPT`（`policy.ts`，两处都读它，单一数据源）；
`load()` 另外交回 `narrows` 标志，只有它为真才动允许集 —— 调用方分不清「收窄到这些」和
「没收窄，这些是全部」，就必然会犯这个错。

豁免不是放权：`allowed-tools` 只能是角色白名单的子集（`docs/07 §2`），交回去的仍然是该角色
本来就有的东西。

---

## 5. 顺手收掉的小口子

| 处 | 问题 | 修法 |
|---|---|---|
| `glob` / `grep` | 恰好命中 500 / 200 条而后面本来就没有了，也报 `truncated: true` | 改成「还想再放一条却放不下」才算截断。报成截断模型会去缩范围重查一次已经完整的结果，白跑一步且它会以为自己没看全 |
| `grep` | 超过读取预算的文件和读不出来的文件静静跳过，`skipped` 恒为 0 | 都计入 `skipped`。doc §3.1 立的规矩是「条数必须交出去，否则模型会以为自己看全了」 |
| `write_file` | 备份名只按毫秒（`${Date.now()}-${basename}`），同一毫秒里两次写入互相覆盖 | 加 ulid。`edit_file` 连续改同一个文件正好落在这个窗口里，而备份存在的意义恰恰是「上一版还在」 |
| `move_file` | 交回模型原样传进来的 `from` / `to`，不是解析后的路径 | 交回 jail 内的相对路径，与其它文件工具一致 |
| `bash` / `python` | `timeoutMs` 在 schema 里没有上界 | 按 `tools.exec.maxTimeoutMs` 夹进 schema。`sandbox.run` 反正会夹一次，但只夹在里面模型永远不知道自己要的 30 分钟被改成了 5 分钟，然后据此去解释「命令没跑完」 |
| `edit_file` | `read_file` 交回带行号的正文（本轮新增），模型容易把 `12\t` 一起抄进 `oldString` | `old_string_not_found` 在 `oldString` 形如 `12\t…` 时补一句「去掉行号前缀」。只报「没找到」的话模型通常只会换一段文字再试一次 |
| `docs/11` | `tools.web.searchProvider` 与 `agent.maxAsksPerRun` 没有热更新/需重启标注 | 都标 `需重启`。两者都在启动时读进 `registerBuiltins` 的依赖，`web_search` 的 `available()` 判的就是那份快照 |

---

## 6. 查过、没问题的地方

留个记录，免得下一轮重复查：

- **权限复查**：`execute()` 里 `minRole` / 运维禁用 / 本轮熔断 / `available()` / 子 agent 的
  `memory_write` / `context.allow` / `skillAllowedTools` 七道都在，与 `active()` 的过滤集合对得上。
- **`PathJail`**：`../` 穿越、绝对路径、越界软链、`denyGlobs`、NUL 字节都挡得住；不存在的路径按
  「最近的存在祖先 + 剩余段」判，也在界内。（唯一的冗余：`resolve()` 末尾那次
  `lstatSync().isSymbolicLink()` 永远为假 —— 前面已经 realpath 过了。留着无害。）
- **`untrusted()` 包裹顺序**：`untrusted(source, htmlToText(body))` —— 抽取在前、转义在后，所以
  页面里写 `&lt;/untrusted-content&gt;` 解码出来的闭合标记仍然会被转义。
- **超时账**：`bash` / `python` / `spawn_agent` 是 `timeoutMs: null`（自己管），两个 web 工具报的是
  `(retries+1) × timeoutMs + 5s`，上传是 300s。兜底那道 race 不会砍到正常的长任务。
- **`react` / `pin_message` 不占追发预算**：doc §3.7 说的是「三个**发送类**工具共用一份」，
  reaction 不是消息。
- **`edit_file` 的审批档位**（`never`，而 `write_file` 是覆盖时需审批）：doc §4 的权威矩阵就是
  这么定的，不是漏配。

---

## 7. 回归用例

`tests/tools.round8.test.ts`（21 条）。每条用例名写的就是那个失败形态，注释里写复现方式与
「旧实现会怎样」—— 下一轮改这几处时，红掉的那条会直接告诉你踩的是哪个坑。

`docs/13` 因此新勾 4 条：`AC-TOOL-006`（`delete_file` 四种情形）、`AC-TOOL-007`（`edit_file`
唯一性与行号前缀）、`AC-TOOL-011`（`read_messages` 锚点与格式）、`AC-TOOL-023`（软链成环 +
越界软链 + 断链，从人工条目改成 `(自动)`）。签署表：工具/沙箱/审批 11 → 15，合计 101 → 105。
