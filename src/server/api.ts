import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Events } from './events.js';
import type {
  ConversationResponse,
  ConversationRow,
  ConversationsResponse,
  ErrorResponse,
  MessagesResponse,
  TodaySummary,
} from './types.js';
import { defaultMessages, maxMessages, type Views } from './views.js';

/**
 * 读数据的接口（挂在 /api 下，经过访问控制），返回的类型见 types.ts：
 * - GET  /conversations                        ConversationsResponse
 * - GET  /conversations/:id                    ConversationResponse
 * - GET  /conversations/:id/messages?before=&limit=   MessagesResponse
 * - POST /conversations/:id/read  { seq }      ConversationRow（同时推给所有面板）
 * - GET  /today                                TodaySummary
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
