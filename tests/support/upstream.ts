import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 进程内假 upstream：`@ai-sdk/openai-compatible` 发出的请求落在 `{baseURL}/chat/completions`
 * （`node_modules/@ai-sdk/openai-compatible/dist/index.js` 的 `postJsonToApi`），本文件按它的
 * `OpenAICompatibleChatResponseSchema` / `chunkBaseSchema` 原样接住，不引入 mock 框架
 * （同 `tests/provider.health.test.ts` 的先例：真实 `node:http`，不是打桩的 fetch）。
 *
 * `tests/support/runtime.ts` 用它顶替真实模型 provider：`composeRuntime` 建出的 `ModelRegistry`
 * 通过 DB 里的 `providers.base_url` 发起真实 HTTP 请求，没有等价的注入点（`agent.model-wiring.test.ts`
 * 那种直接喂 `LanguageModel` 的写法在这里走不通）。
 */

export interface FakeUpstreamRequest {
  path: string;
  body: { model?: string; stream?: boolean; messages?: unknown[] };
}

/** 一次待脚本化的工具调用（`queueToolCallStep` 用），对应 OpenAI 兼容格式里的一个 `tool_calls[]` 项。 */
export interface FakeUpstreamToolCall {
  id: string;
  name: string;
  /** 直接落 `function.arguments`（JSON 字符串，AI SDK 侧再解析），调用方传对象即可。 */
  arguments: Record<string, unknown>;
}

export interface FakeUpstream {
  /** `baseURL`：provider 行的 `base_url` 直接填它，`/chat/completions` 由 SDK 自己拼。 */
  url: string;
  /** 到达的每一次请求，按到达顺序；用于断言模型确实被调用过。 */
  requests: FakeUpstreamRequest[];
  /** 换一个固定回复：多步轮次里后续请求要返回不同文本时使用。 */
  setReply(text: string): void;
  /**
   * 按到达顺序排一步「返回工具调用而非文本」的响应。用一次即出队，之后的请求回落到
   * `setReply` 设置的固定文本。**两条分支都认它**：非流式回一条带 `tool_calls` 的完整消息，
   * 流式回一段 `delta.tool_calls` 增量 + `finish_reason:'tool_calls'`。
   */
  queueToolCallStep(calls: FakeUpstreamToolCall[]): void;
  close(): Promise<void>;
}

let counter = 0;

/**
 * 启动一个假 upstream，固定回复 `reply`。非流式请求回一条完整 JSON；`stream:true` 时回一段
 * SSE（`delta.content` 一次性给全文，随后 `finish_reason:'stop'` 带 usage，`[DONE]` 收尾）——
 * AI SDK 的 `ToolLoopAgent` 走哪一条由调用方（`generateText` / `streamText`）决定，两条都要接得住。
 */
export async function startFakeUpstream(reply = 'ok'): Promise<FakeUpstream> {
  let currentReply = reply;
  const requests: FakeUpstreamRequest[] = [];
  const toolCallSteps: FakeUpstreamToolCall[][] = [];
  const id = `fake-upstream-${(counter += 1)}`;

  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: FakeUpstreamRequest['body'] = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as FakeUpstreamRequest['body'];
      } catch {
        /* 空 body 按 {} 处理，不因此拒收 —— 探测式请求（无 body）不该让测试莫名其妙地失败 */
      }
      requests.push({ path: url.pathname, body });
      const text = currentReply;
      if (body.stream === true) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const created = Math.floor(Date.now() / 1000);
        const send = (payload: Record<string, unknown>): void =>
          void response.write(`data: ${JSON.stringify(payload)}\n\n`);
        // 脚本里排了工具调用就走 tool_calls 增量：OpenAI 兼容格式下每个调用一条
        // `delta.tool_calls[]`（`index` 定位、`function.arguments` 可分片，这里一次给全），
        // 以 `finish_reason:'tool_calls'` 收尾。没排就回落到固定文本。
        const streamStep = toolCallSteps.shift();
        if (streamStep) {
          send({ id, object: 'chat.completion.chunk', created, model: body.model ?? 'fake',
            choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
          send({ id, object: 'chat.completion.chunk', created, model: body.model ?? 'fake',
            choices: [{ index: 0, delta: { tool_calls: streamStep.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })) }, finish_reason: null }] });
          send({ id, object: 'chat.completion.chunk', created, model: body.model ?? 'fake',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
          response.write('data: [DONE]\n\n');
          response.end();
          return;
        }
        send({ id, object: 'chat.completion.chunk', created, model: body.model ?? 'fake',
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
        send({ id, object: 'chat.completion.chunk', created, model: body.model ?? 'fake',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      // 非流式分支：先出队一步脚本化的工具调用（若有），否则回落固定文本。
      const step = toolCallSteps.shift();
      response.end(JSON.stringify({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'fake',
        choices: step
          ? [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: step.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              },
              finish_reason: 'tool_calls',
            }]
          : [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });

  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', settle));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setReply: (text: string) => { currentReply = text; },
    queueToolCallStep: (calls: FakeUpstreamToolCall[]) => { toolCallSteps.push(calls); },
    close: () => new Promise<void>((settle) => server.close(() => settle())),
  };
}

export interface HangingUpstream {
  url: string;
  /** 已到达但尚未回复的请求数——测试用它作同步点（轮询它变化，不用固定延时）。 */
  readonly arrived: number;
  /** 放行全部当前挂起、以及此后到达的请求，各回一条固定文本。 */
  release(): void;
  close(): Promise<void>;
}

/**
 * 请求到达后不立即回复，直到 `release()` 才统一放行——用于测试客户端断连（`AbortController`）
 * 中途取消一个仍在等待模型响应的轮次（qa-T3-6 verify-1 FAIL-2：T3.7 验收 5「断连 → interrupt()」）。
 * `startFakeUpstream` 立即回复，无法制造出「轮次正卡在等模型」这个窗口，因此单独一个工厂，
 * 不改 `startFakeUpstream` 的签名（后者已有约十个调用方）。
 */
export async function startHangingUpstream(reply = 'ok'): Promise<HangingUpstream> {
  const pending: ServerResponse[] = [];
  let released = false;
  let arrived = 0;
  const answer = (response: ServerResponse): void => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'hanging-upstream', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  };
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      arrived += 1;
      if (released) answer(response);
      else pending.push(response);
    });
  });
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', settle));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get arrived() { return arrived; },
    release() {
      released = true;
      while (pending.length) answer(pending.shift()!);
    },
    close: () => new Promise<void>((settle) => {
      released = true;
      while (pending.length) answer(pending.shift()!);
      server.closeAllConnections?.();
      server.close(() => settle());
    }),
  };
}
