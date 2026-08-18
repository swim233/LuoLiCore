---
name: writing-plugins
description: 用 write_plugin 写一个进程内 plugin 时读这份：模块形状、只认 .js、哪些 hook 的返回值真的被消费、以及为什么写完必须等人点启用。
min-role: owner
requires-tools: [write_plugin]
---

# 写一个 plugin

plugin 是**在 bot 进程里直接 import 的 JS 模块**。它能注册工具、挂消息与轮次的 hook，
拿得到宿主的一切 —— 文件系统、网络、环境变量。

> **plugin 是全信任的，装一个 plugin 等于给它 root。** 系统里没有任何沙箱能拦住它。
> 所以你写完之后它是**禁用**状态，必须 owner 在 WebUI 的扩展页读过源码再点启用。
> 这一步没有捷径，也不要试图绕过它 —— 如实告诉用户「写好了，等你复审」。

**先问自己能不能用自定义工具做。** `define_tool` 写的脚本跑在沙箱里、不需要人工复审、
改起来也快。只有需要挂 hook（改写发出去的文本、拦截消息）或者需要跨轮持久状态时才值得写 plugin。

## 模块形状

```js
// plugins/weather/plugin.js  —— 目录名、文件名、definePlugin 的 name 三者必须一致
import { definePlugin, tool, z } from '@luoli/plugin-sdk';

export default definePlugin({
  name: 'weather',
  version: '1.0.0',
  minRole: 'trusted',
  tools: (ctx) => ({
    // 注册后的工具名是 `weather_now`（自动加 `<plugin>_` 前缀）
    now: tool({
      description: '查当前天气',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        const cached = await ctx.storage.get(`last:${city}`);
        return { ok: true, city, cached };
      },
    }),
  }),
  hooks: {
    beforeSend: ({ text }) => ({ text: text.replace(/：\)/g, '🙂') }),
  },
  onLoad: async (ctx) => { await ctx.storage.set('loadedAt', Date.now()); },
  onUnload: () => { /* 清定时器、关连接 */ },
});
```

## 硬性约束

- **只认 `plugins/<name>/plugin.js`，没有转译步骤。** 写 `.ts` 的结果是一个静默不存在的 plugin。
  要用 TypeScript 就自己先编译成 js 再写进来。
- ESM。`import` 可以，`require` 不行。
- `definePlugin` 的 `name` 必须等于目录名，否则加载时报 `plugin name mismatch`。
- 改一个**已启用** plugin 的源码会把它打回未启用，要重新复审。
- 语法错误不会在写入时报出来，会在 owner 点启用时以 `load_error` 出现在扩展页上。

## hook 的返回值，哪些真的被消费

这张表很重要 —— 有几个 hook 的返回值目前是被丢弃的，照着写会得到「代码没错但什么都没发生」：

| hook | 时机 | 返回值 |
|---|---|---|
| `onMessage` | 收到消息、入库之前 | **`{drop: true}` 会丢弃这条消息** |
| `beforeSend` | 发出之前 | **`{text}` 会替换掉要发的文本** |
| `beforeTurn` | 开轮 | 忽略 |
| `beforeModelCall` | 调模型之前 | 忽略 |
| `onToolCall` | 工具执行之前 | 忽略（还不能用它拦工具） |
| `onToolResult` | 工具返回之后 | 忽略 |
| `afterCommit` | 轮次提交之后 | 忽略 |

hook 有超时（`plugins.hookTimeoutMs`，默认 5s），连续出错到阈值会被自动禁用并告警。
别在 hook 里做慢 IO。

## 持久化

`ctx.storage.get/set` 是一份以 plugin 名为前缀的 KV，落在 `app_kv` 表里。
**不要自己去写配置表** —— 那会让下一次进程启动失败。

## `commands` 与 `agents` 目前是空转

`PluginDefinition` 的类型里有这两个字段，但加载器不消费它们。写了不会报错，也不会生效。
