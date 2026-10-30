import type { Message } from './message.js';

export type ConversationStore = {
  list(): Promise<Message[]>;
  add(message: Message): Promise<void>;
};

// 存取都复制一份：外部改动拿到的消息不影响存储，行为与日后的持久化实现一致
export function createMemoryStore(): ConversationStore {
  const messages: Message[] = [];
  return {
    async list() {
      return structuredClone(messages);
    },
    async add(message) {
      messages.push(structuredClone(message));
    },
  };
}
