---
name: writing-skills
description: 给自己写一份 SKILL.md（write_skill）或装一个别人给的 skill 包（install_skill）时读这份：frontmatter 有哪些字段、渐进式披露是什么意思、allowed-tools 的收窄语义、装包为什么装完还用不了。
min-role: owner
requires-tools: [write_skill, install_skill]
---

# 给自己写一份 skill

skill 是**一份 Markdown 说明书**，不是代码。它解决的是「这套做法我每次都要重新想一遍」。

关键机制叫**渐进式披露**：平时每份 skill 在你的提示词里只占一行（名字 + description），
只有你调 `load_skill(name)` 之后正文才进上下文。所以：

- **description 是全部的入口**。它要写成「什么情况下该载入我」，而不是「我是什么」。
  写「导出对账单时用：字段顺序、四舍五入规则、常见坑」，别写「对账单相关说明」。
- 正文可以写长，反正不载入不花钱。但别把参考表塞进正文 —— 放同目录的附件里（见下）。

## frontmatter

```yaml
---
name: export-invoice          # 必填，kebab-case，必须与目录名一致
description: ...              # 必填，≤500 字符，决定你以后会不会想起来载入它
min-role: trusted             # 谁能载入它。不能低于配置里的下限
allowed-tools: [read_file]    # 可选，见下面那一节
enabled: true                 # 置 false = 退休这份 skill
---
```

`write_skill` 会替你生成这段 frontmatter，你只要给对应的参数。

## allowed-tools 的收窄语义

**声明了就收窄，不声明就完全不收窄。** 这条容易搞反：

- 不给 `allowedTools` → 载入后本轮可用工具**不变**。
- 给 `allowedTools: ["read_file", "grep"]` → 载入后本轮**只剩**这两个（外加
  `load_skill` / `send_message` / `report_progress` / `context_stats` 这四个永远保留的）。

收窄只能收窄到你**本来就有**的工具的子集，它不会给你新权限。如果声明的工具在本轮一个都不可用，
`load_skill` 会直接失败并告诉你 —— 那说明这份 skill 的 `allowed-tools` 写错了或环境不对。

除非你确实想约束自己「这件事只准用这几个工具」，否则**别给 `allowed-tools`**。

## 附件

skill 目录里可以放别的文件，用 `read_file("skill://<name>/<相对路径>")` 读，只读。
长参考表、模板、样例数据都该放这里，让 SKILL.md 正文保持短。

`write_skill` 只写 SKILL.md 本身，**它没有办法带附件**。要装一个自带 `scripts/` / `bin/` /
`references/` 的包，用下面的 `install_skill`。

## 装一个别人给的 skill 包（install_skill）

用户在聊天里丢来一个 zip、或者你已经把它解到工作目录里了 —— 用 `install_skill` 装，
**不要**自己解到工作目录里然后靠 `bash` 去调它。后者能跑，但那不是一个 skill：
它不进你的 skill 目录、不能 `load_skill`、`skill://` 读不到、运维在 WebUI 上也看不见它。

```
install_skill({ source: "music-cli.zip" })                     # 工作目录里的相对路径
install_skill({ source: "/…/data/files/<chatId>/xxx.zip" })    # 本会话收到的附件
```

`source` **只认这两处**（本轮工作目录、本会话的附件目录），别的路径一律拒。

三件事要有心理准备：

1. **装完是停用的，你还用不了它。** 包里可能带可执行文件，所以要 owner 在 WebUI 的扩展页
   看过 SKILL.md 与文件清单再点启用。这一点和只写一段正文的 `write_skill` 不同 ——
   别装完就去 `load_skill`，那时它还不在目录里。**该做的是告诉用户去点一下启用。**
2. **一个包里可能有好几份 SKILL.md**（常见的是 windows / linux 各一套）。这时会报
   `skill_ambiguous_root` 并把候选列出来，带 `subdir` 挑一个重试。
3. **包里写的 `name` / `enabled` / `min-role` 不算数**，会被改写成安装名、停用、以及不低于
   配置下限的角色。想装成别的名字就自己给 `name`。

装失败一律是整棵回滚，不会在目录里留下半成品，放心重试。

## 退休一份 skill

没有删除工具。`write_skill` 同名再写一次、把 `enabled` 置 `false` 就行 —— 它会从目录里消失，
但文件还在，改回来很容易。随包发的四份说明书（本文件在内）不允许覆写，装包也不许占这四个名字。
