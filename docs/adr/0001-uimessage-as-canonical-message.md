# 会话历史以 UIMessage 为正本

会话历史以 AI SDK 的 `UIMessage` 存储，每次调用模型前用 `convertToModelMessages` 转换。前身项目直接存 `ModelMessage`，工具结果、混入的 system 消息、未知 part 类型多次产出不合法的消息，被 provider 整轮拒绝（前身项目 docs/reviews 第 3–5 轮）。`UIMessage` 是 AI SDK 推荐的持久化格式，保留工具状态、审批与 metadata，发言人和中止标记记在 metadata 上。

## Considered Options

- `ModelMessage`：前身项目的做法，可直接送模型，但它是给模型的输入格式，不是给存储的记录格式。
- 自定义格式：需要自己维护到 `ModelMessage` 的转换，重复 AI SDK 已有的工作。

## Consequences

- 每轮都要执行一次异步的 `convertToModelMessages`。
- Chat SDK 的 `toAiMessages` 产出 `ModelMessage`，不能作为历史来源（见 ADR-0003）。
