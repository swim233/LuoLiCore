import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createConversation,
  createMemoryStore,
  defineTool,
  installTools,
  type Conversation,
  type Logger,
  type MessageChunk,
} from './index.js';
import { testPrompts } from './test-prompts.js';

// 回复的「丢掉」口子（ReplyOptions.discard）：正常完成时拿最后一步的文字问一次，说丢掉就不写入历史

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const alice = { id: 'u-alice', name: 'Alice' };
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const finish = (reason: 'stop' | 'tool-calls'): StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const text = (value: string, id = 't'): StreamPart[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: value },
  { type: 'text-end', id },
];
const answer = (value: string): StreamPart[] => [...text(value), finish('stop')];
const toolCall = (input: unknown): StreamPart[] => [
  { type: 'tool-call', toolCallId: 'call-1', toolName: 'note', input: JSON.stringify(input) },
  finish('tool-calls'),
];

/** 依次给出每次请求的段；{ hang } 给出这些段后挂起，直到被中止 */
type Turn = StreamPart[] | { hang: StreamPart[] } | { error: StreamPart[] };
function scripted(...turns: Turn[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const turn = turns[index++];
      if (turn === undefined) throw new Error('mock 模型没有更多脚本');
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            if (Array.isArray(turn)) {
              for (const part of turn) controller.enqueue(part);
              controller.close();
            } else if ('error' in turn) {
              for (const part of turn.error) controller.enqueue(part);
              controller.enqueue({ type: 'error', error: { message: '服务端过载' } });
              controller.close();
            } else {
              for (const part of turn.hang) controller.enqueue(part);
              abortSignal?.addEventListener(
                'abort',
                () =>
                  controller.error(new DOMException('This operation was aborted', 'AbortError')),
                { once: true },
              );
            }
          },
        }),
      };
    },
  });
}

async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

type LogEntry = { msg: string; fields: Record<string, unknown> };

const opened: Conversation[] = [];
afterEach(async () => {
  for (const conversation of opened.splice(0)) await conversation.close();
});

function setup(...turns: Turn[]) {
  const entries: LogEntry[] = [];
  const record = (fields: object, msg: string) =>
    entries.push({ msg, fields: fields as Record<string, unknown> });
  const logger: Logger = { info: record, warn: record, error: record };
  const store = createMemoryStore();
  // 记一笔的工具：看副作用发生没有
  const notes: string[] = [];
  const note = defineTool({
    name: 'note',
    description: '记一笔',
    input: z.object({ text: z.string() }),
    execute: ({ text }) => {
      notes.push(text);
      return '记下了';
    },
  });
  const conversation = createConversation({
    model: scripted(...turns),
    prompts: testPrompts('你是测试助手'),
    store,
    logger,
    conversationId: 'c1',
    maxRetries: 0,
    tools: installTools([note], {}).tools,
  });
  opened.push(conversation);
  /** 写一条用户消息，回复一次；asked 记下每次问到的文字 */
  const asked: string[] = [];
  async function round(answerDiscard: boolean | ((text: string) => boolean), abort?: AbortSignal) {
    await conversation.append({ author: alice, text: '有新的预警' });
    const discard = (value: string) => {
      asked.push(value);
      return typeof answerDiscard === 'function' ? answerDiscard(value) : answerDiscard;
    };
    return readAll(conversation.reply({ discard, abortSignal: abort }));
  }
  const replyEnds = () => entries.filter(({ msg }) => msg === 'reply.end');
  return { conversation, store, notes, asked, round, replyEnds, entries };
}

const finishOf = (chunks: MessageChunk[]) =>
  chunks.find(
    (chunk): chunk is Extract<MessageChunk, { type: 'finish' }> => chunk.type === 'finish',
  );

describe('回复的丢掉口子', () => {
  it('正常完成、说丢掉：不写入历史；模型调用表照常一行；流正常结束，finish 段带着 discarded', async () => {
    const s = setup(answer('看了一下，不用说。[不回复]'));
    const chunks = await s.round(true);

    expect(s.asked).toEqual(['看了一下，不用说。[不回复]']);
    expect((await s.conversation.messages()).map(({ role }) => role)).toEqual(['user']);
    expect(chunks.some(({ type }) => type === 'error' || type === 'abort')).toBe(false);
    expect(finishOf(chunks)?.messageMetadata).toMatchObject({ discarded: true });
    expect(await s.store.calls()).toMatchObject([{ purpose: 'reply', outcome: 'completed' }]);
    expect(s.replyEnds()).toHaveLength(1);
    expect(s.replyEnds()[0]!.fields).toMatchObject({ outcome: 'completed', discarded: true });
    // 不记正文
    expect(JSON.stringify(s.replyEnds()[0]!.fields)).not.toContain('不用说');
  });

  it('不丢：和以前一样写入，finish 段没有 discarded', async () => {
    const s = setup(answer('有一条新的预警。'));
    const chunks = await s.round(false);

    expect(s.asked).toEqual(['有一条新的预警。']);
    const [, reply] = await s.conversation.messages();
    expect(reply).toMatchObject({ role: 'assistant', metadata: { usage: { input: 10 } } });
    expect(reply!.metadata).not.toHaveProperty('discarded');
    expect(finishOf(chunks)?.messageMetadata).not.toHaveProperty('discarded');
    expect(s.replyEnds()[0]!.fields).not.toHaveProperty('discarded');
  });

  it('多步的回复（先说话、调工具，最后一步回标记）：只拿最后一步的文字问，整条连同工具调用都不写入；工具做了的事不撤回', async () => {
    const s = setup(
      [...text('我查一下。'), ...toolCall({ text: '看过了' })],
      answer('[不回复]'),
      answer('好的'),
    );
    await s.round((value) => value.trim().endsWith('[不回复]'));

    expect(s.asked).toEqual(['[不回复]']);
    expect(s.notes).toEqual(['看过了']);
    expect((await s.conversation.messages()).map(({ role }) => role)).toEqual(['user']);
    expect(await s.store.calls()).toMatchObject([{ outcome: 'completed', steps: 2, toolCalls: 1 }]);

    // 下一次回复照常：丢掉的那条不在历史里，序号空着也不影响
    const t = await s.round(false);
    expect(t.some(({ type }) => type === 'error')).toBe(false);
    expect((await s.conversation.messages()).map(({ role }) => role)).toEqual([
      'user',
      'user',
      'assistant',
    ]);
  });

  it('最后一步的几段文字用换行连起来问；最后一步没有文字时不问', async () => {
    const s = setup(
      [...text('第一段', 'a'), ...text('第二段', 'b'), finish('stop')],
      [...text('先说一句'), ...toolCall({ text: 'x' })],
      [finish('stop')],
    );
    await s.round(false);
    expect(s.asked).toEqual(['第一段\n第二段']);
    await s.round(true);
    expect(s.asked).toHaveLength(1);
    // 最后一步没说话：照普通的写入
    expect((await s.conversation.messages()).map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('出错、中止时不问，照原来的规则写入', async () => {
    const failing = setup([...text('先说一句'), ...toolCall({ text: 'x' })], {
      error: text('写到一半'),
    });
    const chunks = await failing.round(true);
    expect(chunks.some(({ type }) => type === 'error')).toBe(true);
    expect(failing.asked).toEqual([]);
    const [, failed] = await failing.conversation.messages();
    expect(failed).toMatchObject({ role: 'assistant', metadata: { failed: true } });

    const aborting = setup({ hang: text('说到一半') });
    const controller = new AbortController();
    const reading = aborting.round(true, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await reading;
    expect(aborting.asked).toEqual([]);
    const [, aborted] = await aborting.conversation.messages();
    expect(aborted).toMatchObject({ role: 'assistant', metadata: { aborted: true } });
  });

  it('问的函数抛错：当作不丢，照常写入，记一行日志', async () => {
    const s = setup(answer('[不回复]'));
    await s.round(() => {
      throw new Error('坏了');
    });
    expect((await s.conversation.messages()).map(({ role }) => role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(s.entries.some(({ msg }) => msg === 'reply.discard_failed')).toBe(true);
  });
});
