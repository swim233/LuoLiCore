import {
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type ToolSet,
} from 'ai';
import type { Author, Message, MessageChunk } from './message.js';
import { createMemoryStore, type ConversationStore } from './store.js';

export type Conversation = {
  /** 记录一条用户消息，不产生回复 */
  append(input: { author: Author; text: string }): Promise<Message>;
  /**
   * 根据当前历史生成回复。错误以 error chunk 出现在流中，不会抛出。
   * 流读完时回复已写入历史；出错或被取消则不写入。
   * 上一个回复的流还没结束时调用会立即抛错。
   */
  reply(): ReadableStream<MessageChunk>;
  messages(): Promise<Message[]>;
};

export function createConversation({
  model,
  instructions,
  store = createMemoryStore(),
}: {
  model: LanguageModel;
  instructions: string;
  store?: ConversationStore;
}): Conversation {
  let replying = false;

  return {
    async append({ author, text }) {
      const message: Message = {
        id: generateId(),
        role: 'user',
        metadata: { author, createdAt: new Date().toISOString() },
        parts: [{ type: 'text', text }],
      };
      await store.add(message);
      return message;
    },

    reply() {
      if (replying) throw new Error('上一个回复还没结束');
      replying = true;

      // onEnd 的 outcome 判断不了是否出错：外层流没声明 outcome 时正常结束也是 unknown，
      // 内层在错误事件之后收到 finish 又会记成 completed。所以自己记一次是否出过错
      let failed = false;
      const describeError = (error: unknown) => {
        failed = true;
        return error instanceof Error ? error.message : String(error);
      };

      // 外层 createUIMessageStream 让 reply() 能同步返回流（历史要异步读），
      // 并把任何抛出的错误（读历史失败、连接中途断开）都转成 error chunk
      return createUIMessageStream<Message>({
        generateId,
        execute: async ({ writer }) => {
          const history = await store.list();
          const result = streamText({
            model,
            instructions,
            messages: await convertToModelMessages(history.map(withAuthorName)),
            // 错误经 stream 进入 UI 流；不传时 SDK 默认把整个错误对象打到 stderr
            onError: () => {},
          });
          writer.merge(
            toUIMessageStream<ToolSet, Message>({
              stream: result.stream,
              messageMetadata: ({ part }) =>
                part.type === 'start' ? { createdAt: new Date().toISOString() } : undefined,
              onError: describeError,
            }),
          );
        },
        onError: describeError,
        onEnd: async ({ responseMessage, isAborted, isCancelled }) => {
          try {
            if (!failed && !isAborted && !isCancelled) await store.add(responseMessage);
          } finally {
            replying = false;
          }
        },
      });
    },

    messages: () => store.list(),
  };
}

// 群聊里有多个发言人，送模型前在用户消息正文前加上名字
function withAuthorName(message: Message): Message {
  const author = message.metadata?.author;
  if (message.role !== 'user' || !author) return message;
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'text' ? { ...part, text: `${author.name}: ${part.text}` } : part,
    ),
  };
}
