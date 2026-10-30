import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createConversation, type Message, type MessageChunk } from './index.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const alice = { id: 'u-alice', name: 'Alice' };
const bob = { id: 'u-bob', name: 'Bob' };
const instructions = '你是测试助手';

function finish(reason: 'stop' | 'error' = 'stop'): StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
  };
}

function textParts(...deltas: string[]): StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    ...deltas.map((delta): StreamPart => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
  ];
}

/** 每次调用依次给出一段回复，每段由若干文本增量组成 */
function replyingModel(...replies: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: replies.map((deltas) => ({
      stream: simulateReadableStream({ chunks: [...textParts(...deltas), finish()] }),
    })),
  });
}

async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function textOf(message: Message | undefined): string {
  return (message?.parts ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function isIsoTime(value: string | undefined): boolean {
  return value !== undefined && new Date(value).toISOString() === value;
}

describe('会话', () => {
  it('append 记录带发言人与时间的用户消息，按顺序返回，不调用模型', async () => {
    const model = replyingModel();
    const conversation = createConversation({ model, instructions });

    const first = await conversation.append({ author: alice, text: '早' });
    await conversation.append({ author: bob, text: '早上好' });

    const messages = await conversation.messages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(first);
    expect(messages.map((m) => [m.role, m.metadata?.author?.name, textOf(m)])).toEqual([
      ['user', 'Alice', '早'],
      ['user', 'Bob', '早上好'],
    ]);
    expect(messages.every((m) => isIsoTime(m.metadata?.createdAt))).toBe(true);
    expect(new Set(messages.map((m) => m.id)).size).toBe(2);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('修改 messages() 或 append() 的返回值不影响会话历史', async () => {
    const conversation = createConversation({ model: replyingModel(), instructions });
    const appended = await conversation.append({ author: alice, text: '原文' });

    appended.parts = [{ type: 'text', text: '改过' }];
    const messages = await conversation.messages();
    messages.pop();

    const again = await conversation.messages();
    expect(again).toHaveLength(1);
    expect(textOf(again[0])).toBe('原文');
  });

  it('reply 流式输出文本增量，读完后历史末尾是完整的助手消息', async () => {
    const conversation = createConversation({
      model: replyingModel(['你', '好', '！']),
      instructions,
    });
    await conversation.append({ author: alice, text: '嗨' });

    const chunks = await readAll(conversation.reply());

    const deltas = chunks.flatMap((c) => (c.type === 'text-delta' ? [c.delta] : []));
    expect(deltas).toEqual(['你', '好', '！']);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);

    const messages = await conversation.messages();
    expect(messages).toHaveLength(2);
    const reply = messages[1];
    expect(reply?.role).toBe('assistant');
    expect(textOf(reply)).toBe('你好！');
    expect(reply?.id).toBeTruthy();
    expect(reply?.id).not.toBe(messages[0]?.id);
    expect(isIsoTime(reply?.metadata?.createdAt)).toBe(true);
  });

  it('模型收到 instructions 作 system、带名字前缀的用户消息，以及包括上一轮回复在内的全部历史', async () => {
    const model = replyingModel(['早上好'], ['都在']);
    const conversation = createConversation({ model, instructions });

    await conversation.append({ author: alice, text: '早' });
    await readAll(conversation.reply());
    await conversation.append({ author: alice, text: '在吗' });
    await conversation.append({ author: bob, text: '我也在' });
    await readAll(conversation.reply());

    const prompt = model.doStreamCalls[1]?.prompt ?? [];
    const simplified = prompt.map((m) => ({
      role: m.role,
      text:
        typeof m.content === 'string'
          ? m.content
          : m.content.map((part) => (part.type === 'text' ? part.text : `<${part.type}>`)).join(''),
    }));
    expect(simplified).toEqual([
      { role: 'system', text: instructions },
      { role: 'user', text: 'Alice: 早' },
      { role: 'assistant', text: '早上好' },
      { role: 'user', text: 'Alice: 在吗' },
      { role: 'user', text: 'Bob: 我也在' },
    ]);
  });

  it('回复进行中再次 reply 立即抛错，结束后可以再次回复', async () => {
    const conversation = createConversation({
      model: replyingModel(['一'], ['二']),
      instructions,
    });
    await conversation.append({ author: alice, text: '说两句' });

    const first = conversation.reply();
    expect(() => conversation.reply()).toThrow('上一个回复还没结束');
    await readAll(first);

    await readAll(conversation.reply());
    const messages = await conversation.messages();
    expect(messages.map(textOf)).toEqual(['说两句', '一', '二']);
  });

  it('模型调用报错：流中出现 error chunk，不写入助手消息，用户消息保留，之后可以再次回复', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('模型不可用');
      },
    });
    const conversation = createConversation({ model, instructions });
    await conversation.append({ author: alice, text: '在吗' });

    const chunks = await readAll(conversation.reply());

    expect(chunks).toContainEqual({ type: 'error', errorText: '模型不可用' });
    const messages = await conversation.messages();
    expect(messages.map((m) => [m.role, textOf(m)])).toEqual([['user', '在吗']]);
    expect(() => conversation.reply()).not.toThrow();
  });

  it('输出途中服务端报错：已输出的半截文本不写入历史', async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            ...textParts('半截'),
            { type: 'error', error: new Error('服务端过载') },
            finish('error'),
          ],
        }),
      },
    });
    const conversation = createConversation({ model, instructions });
    await conversation.append({ author: alice, text: '在吗' });

    const chunks = await readAll(conversation.reply());

    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: '半截' }));
    expect(chunks).toContainEqual({ type: 'error', errorText: '服务端过载' });
    expect((await conversation.messages()).map((m) => m.role)).toEqual(['user']);
  });

  it('连接中途断开：转成 error chunk 而不是让流抛错，不写入助手消息，之后可以再次回复', async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of textParts('半截')) controller.enqueue(part);
            controller.error(new Error('连接中途断开'));
          },
        }),
      },
    });
    const conversation = createConversation({ model, instructions });
    await conversation.append({ author: alice, text: '在吗' });

    const chunks = await readAll(conversation.reply());

    expect(chunks).toContainEqual({ type: 'error', errorText: '连接中途断开' });
    expect((await conversation.messages()).map((m) => m.role)).toEqual(['user']);
    expect(() => conversation.reply()).not.toThrow();
  });

  it('读到一半取消流：不写入助手消息，之后可以再次回复', async () => {
    const conversation = createConversation({
      model: replyingModel(['一', '二', '三']),
      instructions,
    });
    await conversation.append({ author: alice, text: '数数' });

    const reader = conversation.reply().getReader();
    await reader.read();
    await reader.cancel();

    expect((await conversation.messages()).map((m) => m.role)).toEqual(['user']);
    expect(() => conversation.reply()).not.toThrow();
  });
});
