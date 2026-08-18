---
name: writing-tools
description: 用 define_tool 给自己写一个可复用的工具时读这份：参数怎么声明、脚本怎么拿到参数、上限是多少、为什么写完还调不到。
min-role: owner
requires-tools: [define_tool]
---

# 给自己写一个工具

一个自定义工具 = **一段带参数声明的 bash / python 脚本**。定义之后它像内建工具一样出现在工具目录里，
按 JSON 参数调用，输出是脚本的 stdout / stderr。

它跑在和 `bash` 完全相同的沙箱与角色下 —— 也就是说：**能用 `bash` 一次做完的事不必造工具**。
值得造工具的是那种「同一套步骤要在很多轮里重复、每次只换几个参数」的事。

## 最小例子

```
define_tool({
  name: "weather",
  description: "查一个城市的当前天气，返回一行摘要。",
  runtime: "bash",
  params: { type: "object", properties: { city: { type: "string", description: "城市名，英文" } }, required: ["city"] },
  body: 'curl -fsS "https://wttr.in/$LUOLI_ARG_CITY?format=3"'
})
```

注册后的名字是 `custom_weather`（`custom_` 前缀是自动加的，不用自己写）。

## 参数怎么进脚本

**参数永远不会被拼进命令行**，有两条取用通道：

| 通道 | 拿到什么 | 什么时候用 |
|---|---|---|
| `$LUOLI_ARG_<参数名大写>` | 顶层的**标量**参数（字符串 / 数字 / 布尔） | 绝大多数情况 |
| `$1`（也等于 `$LUOLI_PARAMS`） | 一个 JSON 文件的路径，内容是完整入参 | 参数里有数组或嵌套对象 |

python 里同样：`sys.argv[1]` 是那个 JSON 文件，`os.environ["LUOLI_ARG_CITY"]` 是标量参数。

```
# runtime: python
import json, sys
args = json.load(open(sys.argv[1]))
print(args["items"][0])
```

**框架保证的是「注入不进你的脚本」，不保证你安全地使用参数。** `curl "https://api/$1"` 里的 `$1`
如果来自一条群消息，那就是你自己写出来的洞 —— 和你直接用 `bash` 拼一条命令是同一类问题。
参数用双引号包起来，别拿它拼 URL 路径以外的东西。

## 参数 schema 的写法

标准 JSON Schema，顶层必须是 `{"type": "object"}`：

```json
{ "type": "object",
  "properties": {
    "city":  { "type": "string",  "description": "城市名" },
    "days":  { "type": "integer", "description": "预报天数", "default": 1 },
    "units": { "type": "string",  "enum": ["metric", "imperial"] }
  },
  "required": ["city"] }
```

`description` 会原样交给你自己下一轮看，写清楚点。上限：顶层最多 12 个参数、最多嵌套 4 层。

## 写完为什么还调不到

**默认情况下，新定义的工具是禁用状态**，要 owner 在 WebUI 的扩展页看过正文再点「启用」。
这不是 bug：这段正文会在此后很多轮里被执行，而那时它已经不在任何人的视野里了。

`define_tool` 的返回值里有 `enabled`，`list_tools` 也能看到。如果是 `false`，
如实告诉用户「已经写好了，等你在 WebUI 里启用」，不要反复重试。

**改正文或改参数会把它打回未启用**，需要重新复审 —— 所以别把一个已经启用的工具当草稿反复改。

## 其余的坑

- 名字：小写字母开头的 `[a-z0-9_]`，2–41 位。与已有 plugin / MCP 工具重名会被直接拒绝。
- 数量上限默认 20 个。撞上了先 `delete_tool` 腾位置，别换个名字硬塞。
- 描述上限 200 字符、单行。它进每一轮的提示词，写长了是所有人一起付钱。
- 超时按 `timeoutMs` 走，上限是 `tools.exec.maxTimeoutMs`。长任务要自己在脚本里分段。
- 工作目录、网络、可用命令与 `bash` 完全一致。先用 `bash` 试通了再固化成工具，这是最快的路。
