---
name: writing-skills
description: 用 write_skill 给自己写一份 SKILL.md 时读这份：frontmatter 有哪些字段、渐进式披露是什么意思、allowed-tools 的收窄语义。
min-role: owner
requires-tools: [write_skill]
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

（`write_skill` 目前只写 SKILL.md 本身；附件要用 `write_file` 落到能写的地方再由运维放进去。）

## 退休一份 skill

没有删除工具。`write_skill` 同名再写一次、把 `enabled` 置 `false` 就行 —— 它会从目录里消失，
但文件还在，改回来很容易。随包发的四份说明书（本文件在内）不允许覆写。
