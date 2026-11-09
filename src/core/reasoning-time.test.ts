import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createConversation,
  createMemoryFileStore,
  defineTool,
  installTools,
  ToolDefinitionError,
  type Conversation,
  type Message,
  type MessageChunk,
} from './index.js';
import { testPrompts } from './test-prompts.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
/** 模型输出的一段；pause 停一会儿再接着，hang 一直等到请求被中止 */
type Item = StreamPart | { pause: number } | { hang: true };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const finish = (reason: 'stop' | 'tool-calls'): StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage,
});

/** 一段思考，想 ms 毫秒 */
function thinking(id: string, ms: number): Item[] {
  return [
    { type: 'reasoning-start', id },
    { type: 'reasoning-delta', id, delta: '想' },
    { pause: ms },
    { type: 'reasoning-end', id },
  ];
}

function text(id: string, value: string): Item[] {
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: value },
    { type: 'text-end', id },
  ];
}

function call(toolName: string, id: string): Item[] {
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: '{}' },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: '{}' },
  ];
}

/** 依次处理每次请求 */
function scripted(...attempts: Item[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const items = [...(attempts[index++] ?? [])];
      return {
        stream: new ReadableStream<StreamPart>(
          {
            async pull(controller) {
              for (let item = items.shift(); item !== undefined; item = items.shift()) {
                if ('pause' in item) await new Promise((r) => setTimeout(r, item.pause));
                else if ('hang' in item) {
                  await new Promise((_, reject) =>
                    abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), {
                      once: true,
                    }),
                  );
                } else {
                  controller.enqueue(item);
                  return;
                }
              }
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      };
    },
  });
}

const tools = installTools(
  [
    defineTool({
      name: 'noop',
      description: '什么也不做',
      input: z.object({}),
      execute: () => 'ok',
    }),
  ],
  {},
).tools;

const opened: Conversation[] = [];
afterEach(async () => {
  for (const conversation of opened.splice(0)) await conversation.close();
});

async function replyWith(
  model: MockLanguageModelV4,
  {
    abortWhen,
    maxRetries = 0,
  }: { abortWhen?: (chunk: MessageChunk) => boolean; maxRetries?: number } = {},
): Promise<Message | undefined> {
  const conversation = createConversation({
    model,
    prompts: testPrompts('你是测试助手'),
    tools,
    maxRetries,
  });
  opened.push(conversation);
  await conversation.append({ author: { name: 'Alice' }, text: '你好' });
  const controller = new AbortController();
  for await (const chunk of conversation.reply({ abortSignal: controller.signal })) {
    if (abortWhen?.(chunk)) controller.abort();
  }
  const messages = await conversation.messages();
  return messages.at(-1)?.role === 'assistant' ? messages.at(-1) : undefined;
}

describe('思考时长（metadata 的 reasoningMs）', () => {
  it('每段思考从开始到结束的毫秒数，按 reasoning 段的顺序；多步各段都记', async () => {
    const message = await replyWith(
      scripted(
        [...thinking('r', 60), ...call('noop', 'c1'), finish('tool-calls')],
        [...thinking('r', 20), ...text('t', '好了'), finish('stop')],
      ),
    );

    expect(message?.parts.filter((part) => part.type === 'reasoning')).toHaveLength(2);
    const [first, second] = message!.metadata!.reasoningMs!;
    expect(first).toBeGreaterThanOrEqual(55);
    expect(second).toBeGreaterThanOrEqual(15);
    expect(second!).toBeLessThan(first!);
  });

  it('没有思考的回复没有这一项', async () => {
    const message = await replyWith(scripted([...text('t', '好'), finish('stop')]));
    expect(message?.metadata).not.toHaveProperty('reasoningMs');
  });

  it('中止时还在想的那段为 null，已经结束的照记', async () => {
    const message = await replyWith(
      scripted([
        ...thinking('a', 30),
        ...text('t', '先说一句'),
        { type: 'reasoning-start', id: 'b' },
        { type: 'reasoning-delta', id: 'b', delta: '再想想' },
        { hang: true },
      ]),
      { abortWhen: (chunk) => chunk.type === 'reasoning-delta' && chunk.id === 'b' },
    );

    expect(message?.metadata?.aborted).toBe(true);
    expect(message?.parts.filter((part) => part.type === 'reasoning')).toHaveLength(2);
    const [done, open] = message!.metadata!.reasoningMs!;
    expect(done).toBeGreaterThanOrEqual(25);
    expect(open).toBeNull();
  });

  it('出错时只写完成的步：时长也只有那几步的', async () => {
    const message = await replyWith(
      scripted(
        [...thinking('r', 20), ...call('noop', 'c1'), finish('tool-calls')],
        [...thinking('r', 20), { type: 'error', error: { message: '服务端过载' } }],
      ),
    );

    expect(message?.metadata?.failed).toBe(true);
    expect(message?.parts.filter((part) => part.type === 'reasoning')).toHaveLength(1);
    expect(message?.metadata?.reasoningMs).toHaveLength(1);
  });

  it('流中途出错、重新生成：作废那次的思考不算，记的是重新生成的那段', async () => {
    const message = await replyWith(
      scripted(
        [...thinking('r', 80), { type: 'error', error: { message: '服务端过载' } }],
        [...thinking('r', 10), ...text('t', '好了'), finish('stop')],
      ),
      { maxRetries: 1 },
    );

    expect(message?.parts.filter((part) => part.type === 'reasoning')).toHaveLength(1);
    const [only] = message!.metadata!.reasoningMs!;
    expect(only).toBeGreaterThanOrEqual(5);
    expect(only).toBeLessThan(80);
  });
});

describe('已经在文件存储里的图片', () => {
  it('append 直接引用地址，不再存；新的图片照旧先存', async () => {
    const fileStore = createMemoryFileStore();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const uploaded = await fileStore.save({ data: png, mediaType: 'image/png' });
    const conversation = createConversation({
      model: scripted(),
      prompts: testPrompts('你是测试助手'),
      fileStore,
    });
    opened.push(conversation);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

    const message = await conversation.append({
      author: { name: 'Alice' },
      text: '看图',
      files: [
        { url: uploaded, mediaType: 'image/png' },
        { data: jpeg, mediaType: 'image/jpeg' },
      ],
    });

    const files = message.parts.filter((part) => part.type === 'file');
    expect(files.map((part) => [part.url === uploaded, part.mediaType])).toEqual([
      [true, 'image/png'],
      [false, 'image/jpeg'],
    ]);
    expect(await fileStore.has(files[1]!.url)).toBe(true);
  });
});

describe('工具给界面看的摘要', () => {
  it('defineTool 把摘要带在定义上，参数与结果原样交给它', () => {
    const tool = defineTool({
      name: 'echo',
      description: '原样返回',
      input: z.object({ word: z.string() }),
      summary: ({ input, output }) =>
        output === undefined ? input.word : `${input.word} → ${output}`,
      execute: ({ word }) => word.toUpperCase(),
    });

    expect(tool.summary?.({ input: { word: 'hi' } })).toBe('hi');
    expect(tool.summary?.({ input: { word: 'hi' }, output: 'HI' })).toBe('hi → HI');
    const plain = defineTool({
      name: 'plain',
      description: '没写摘要',
      input: z.object({}),
      execute: () => 1,
    });
    expect(plain.summary).toBeUndefined();
  });

  it('摘要不是函数时装配报错', () => {
    const bad = {
      ...defineTool({ name: 'bad', description: '坏的', input: z.object({}), execute: () => 1 }),
      summary: '一句话',
    } as never;
    expect(() => installTools([bad], {})).toThrow(ToolDefinitionError);
    expect(() => installTools([bad], {})).toThrow('summary 只能是函数');
  });
});
