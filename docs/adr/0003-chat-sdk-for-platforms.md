---
status: accepted（未实现，CLI MVP 之后执行）
---

# 平台前端使用 Chat SDK，会话正本仍归核心

CLI 之后的平台前端（第一个是 Telegram）使用 Vercel Chat SDK（`chat` 与 `@chat-adapter/*`），不再自写 grammY 接入层。前身项目手写的 Telegram 接入层（轮询派发、节流编辑、媒体、触发判定、按 chat 加锁）是范围膨胀的主要来源之一，Chat SDK 已覆盖这些能力。

会话正本仍由核心保存，不使用 Chat SDK 保存的线程历史：它的 `toAiMessages` 不保留工具调用，流式发送也只保留正文文本。

## Considered Options

- 自写 grammY 接入层：前身项目的做法，控制力最强，维护成本也最高。

## Consequences

- Chat SDK 默认并发策略为 `drop`，会静默丢弃回复期间的新消息，接入时需改为 `queue` 或 `burst`。
- 工具进度、reasoning 不会出现在 Telegram 输出里，需要时自行实现。
