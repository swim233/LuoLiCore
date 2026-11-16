import { zValidator } from '@hono/zod-validator';
import { createUIMessageStreamResponse } from 'ai';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { limitBody } from './body-limit.js';
import { heartbeatMs } from './events.js';
import { withHeartbeat } from './heartbeat.js';
import { maxAuthorChars, maxFiles, maxTextChars, type Chats } from './chat.js';
import type { Events } from './events.js';
import type { TaskService } from './tasks/service.js';
import type {
  AbortResponse,
  CancelTaskResponse,
  CommandEvent,
  CommandRequest,
  ConversationResponse,
  ConversationRow,
  ConversationsResponse,
  ErrorResponse,
  MessagesResponse,
  TasksResponse,
  TodaySummary,
} from './types.js';
import { defaultMessages, maxMessages, type Views } from './views.js';

/**
 * 对话的接口（挂在 /api 下，经过访问控制），网页会话与 CLI 会话共用，见 types.ts 的 ChatRequest：
 * - POST /chat  ChatRequest → 回复的 UI message stream（ChatChunk），响应头 X-Conversation-Id
 * - POST /chat/:id/abort  {} → AbortResponse
 * - POST /conversations/:id/compact、/clear  CommandRequest → 指令的事件流（CommandEvent），
 *   见 types.ts 的 CommandRequest；现在只收 CLI 会话
 * 请求体最多 1 MB；参数不对 400。回复与指令的流每 heartbeat 毫秒（默认 25 秒，与 SSE 相同）插一行
 * 注释 `: ping`，排队等别人的回复时也有数据，客户端可以设一个有限的读取超时
 */
export function chatRoutes({
  chats,
  heartbeat = heartbeatMs,
}: {
  chats: Chats;
  heartbeat?: number;
}) {
  const conversationId = z.string().min(1).max(200);
  // 先上传得到的文件存储地址
  const fileRef = z.string().regex(/^luoli-file:[0-9a-f]{64}\.(jpg|png|webp|gif)$/);
  const chatBody = z.union([
    z.object({ conversationId, retry: z.literal(true) }),
    z.object({
      platform: z.enum(['web', 'cli']).optional(),
      conversationId: conversationId.optional(),
      author: z.string().max(maxAuthorChars).optional(),
      clientId: z.string().min(1).max(100).optional(),
      text: z.string().max(maxTextChars).optional(),
      files: z.array(fileRef).max(maxFiles).optional(),
      retry: z.undefined().optional(),
    }),
  ]);
  // 指令的执行人：去掉首尾空白后不能是空的，由 chats.command 判断
  const commandBody = z.object({
    author: z.string().min(1).max(maxAuthorChars),
  }) satisfies z.ZodType<CommandRequest>;
  return new Hono()
    .post(
      '/chat',
      limitBody(1024 * 1024, () =>
        Response.json({ error: '请求体太大' } satisfies ErrorResponse, { status: 413 }),
      ),
      zValidator('json', chatBody, invalid),
      async (c) => {
        const body = c.req.valid('json');
        const signal = c.req.raw.signal;
        const result =
          body.retry === true
            ? await chats.retry(body.conversationId, signal)
            : await chats.send(body, signal);
        if (!result.ok) return c.json<ErrorResponse>({ error: result.error }, result.status);
        const response = createUIMessageStreamResponse({
          stream: result.stream,
          headers: { 'X-Conversation-Id': result.conversationId },
        });
        return new Response(withHeartbeat(response.body!, heartbeat), {
          status: response.status,
          headers: response.headers,
        });
      },
    )
    .post('/chat/:id/abort', zValidator('param', z.object({ id: conversationId }), invalid), (c) =>
      c.json<AbortResponse>({ aborted: chats.abort(c.req.valid('param').id) }),
    )
    .post(
      '/conversations/:id/:command{compact|clear}',
      limitBody(1024 * 1024, () =>
        Response.json({ error: '请求体太大' } satisfies ErrorResponse, { status: 413 }),
      ),
      zValidator(
        'param',
        z.object({ id: conversationId, command: z.enum(['compact', 'clear']) }),
        invalid,
      ),
      zValidator('json', commandBody, invalid),
      async (c) => {
        const { id, command } = c.req.valid('param');
        const result = await chats.command(
          id,
          command,
          c.req.valid('json').author,
          c.req.raw.signal,
        );
        if (!result.ok) return c.json<ErrorResponse>({ error: result.error }, result.status);
        return new Response(withHeartbeat(eventStream(result.stream), heartbeat), {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          },
        });
      },
    );
}

/**
 * 指令的事件流写成 SSE 的字节：一个事件一行 `data: {JSON}`，事件之间空一行，结束时一行
 * `data: [DONE]`（和对话接口的流一样）。对面不读了时取消原来的流（即取消这条指令）
 */
function eventStream(events: ReadableStream<CommandEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return events.pipeThrough(
    new TransformStream<CommandEvent, Uint8Array>({
      transform(event, controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      },
      flush(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      },
    }),
  );
}

/**
 * 读数据的接口（挂在 /api 下，经过访问控制），返回的类型见 types.ts：
 * - GET  /conversations                        ConversationsResponse
 * - GET  /conversations/:id                    ConversationResponse
 * - GET  /conversations/:id/messages?before=&limit=   MessagesResponse
 * - POST /conversations/:id/read  { seq }      ConversationRow（同时推给所有面板）
 * - GET  /today                                TodaySummary
 * - GET  /tasks                                TasksResponse
 * - GET  /files/:name                          图片本身
 * 参数不对返回 400，会话不存在返回 404，都是 ErrorResponse
 */
export function apiRoutes({ views, events }: { views: Views; events: Events }) {
  const conversationId = z.object({ id: z.string().min(1).max(200) });
  const pageQuery = z.object({
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(maxMessages).default(defaultMessages),
  });
  const readBody = z.object({ seq: z.number().int().min(0) });
  // 文件存储的文件名：内容的哈希加扩展名，拼不出目录外的路径
  const fileName = z.object({ name: z.string().regex(/^[0-9a-f]{64}\.(jpg|png|webp|gif)$/) });

  const notFound = (c: Context) => c.json<ErrorResponse>({ error: '没有这个会话' }, 404);

  return new Hono()
    .get('/conversations', async (c) =>
      c.json<ConversationsResponse>({ conversations: await views.conversations() }),
    )
    .get('/conversations/:id', zValidator('param', conversationId, invalid), async (c) => {
      const detail = await views.conversation(c.req.valid('param').id);
      return detail ? c.json<ConversationResponse>(detail) : notFound(c);
    })
    .get(
      '/conversations/:id/messages',
      zValidator('param', conversationId, invalid),
      zValidator('query', pageQuery, invalid),
      async (c) => {
        const page = await views.messages(c.req.valid('param').id, c.req.valid('query'));
        return page ? c.json<MessagesResponse>(page) : notFound(c);
      },
    )
    .post(
      '/conversations/:id/read',
      zValidator('param', conversationId, invalid),
      zValidator('json', readBody, invalid),
      async (c) => {
        const row = await views.markRead(c.req.valid('param').id, c.req.valid('json').seq);
        if (!row) return notFound(c);
        events.broadcast('conversation', row);
        return c.json<ConversationRow>(row);
      },
    )
    .get('/today', async (c) => c.json<TodaySummary>(await views.today()))
    .get('/tasks', async (c) => c.json<TasksResponse>({ tasks: await views.tasks() }))
    .get('/files/:name', zValidator('param', fileName, invalid), async (c) => {
      const file = await views.file(c.req.valid('param').name);
      if (!file) return c.json<ErrorResponse>({ error: '没有这个文件' }, 404);
      return c.body(new Uint8Array(file.data), 200, {
        'Content-Type': file.mediaType,
        // 按内容的哈希命名，内容不会变
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    });
}

/**
 * 任务的接口（挂在 /api 下，经过访问控制）：
 * - POST /tasks/:id/cancel  {} → CancelTaskResponse（取消后的那一行；task 事件由存储的通知推）
 * 没有这个任务 404，已经结束的 409，id 不是数字 400，都是 ErrorResponse
 */
export function taskRoutes({ tasks, views }: { tasks: Pick<TaskService, 'cancel'>; views: Views }) {
  const taskId = z.object({ id: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
  return new Hono().post('/tasks/:id/cancel', zValidator('param', taskId, invalid), async (c) => {
    const result = await tasks.cancel(c.req.valid('param').id);
    if (!result.ok) {
      return result.reason === 'missing'
        ? c.json<ErrorResponse>({ error: '没有这个任务' }, 404)
        : c.json<ErrorResponse>({ error: '任务已经结束了' }, 409);
    }
    const row = await views.task(result.task.id);
    return row
      ? c.json<CancelTaskResponse>(row)
      : c.json<ErrorResponse>({ error: '没有这个任务' }, 404);
  });
}

/** 参数校验失败：400，说明哪一项不对（只有参数名与原因，不回显值） */
function invalid(
  result:
    | { success: true }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }> };
      },
  c: Context,
) {
  if (result.success) return;
  const detail = result.error.issues
    .map((issue) => [issue.path.map(String).join('.'), issue.message].filter(Boolean).join(' '))
    .join('；');
  return c.json<ErrorResponse>({ error: `请求参数不对：${detail}` }, 400);
}
