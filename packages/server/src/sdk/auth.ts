/**
 * `/sdk/v1/*` 的 Bearer 认证中间件（docs/12-sdk.md T3.6，A6）。
 *
 * 与 `/api/*` 的 cookie 会话是两条完全独立的鉴权通道，互不识别对方的凭据：本中间件只读
 * `Authorization` 头，从不读 `luoli_sid` cookie（`app.ts` 的 cookie 闸只挂在 `/api/*` 下，
 * `/sdk/v1/*` 从未经过它，天生不认 cookie）。`verifyApiKey` 的 `ok:false` 一律回 401，
 * 不反推「id 不存在 / secret 不对 / 已停用 / 已过期」中的具体原因——这四种在 T3.3 的
 * `verifyApiKey` 内部已收敛为同一个无区分返回值，中间件层不应该也无法拆分。
 */
import type { Context, MiddlewareHandler } from "hono";
import { verifyApiKey } from "@luoli/core";
import type { ServerDependencies, ServerEnv } from "../app.js";
import { sdkError } from "./errors.js";

const BEARER_PREFIX = "Bearer ";

function bearerToken(ctx: Context<ServerEnv>): string | null {
  const header = ctx.req.header("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token || null;
}

export function sdkBearerAuth(
  dependencies: ServerDependencies,
): MiddlewareHandler<ServerEnv> {
  return async (ctx, next) => {
    if (!dependencies.apiKeys || !dependencies.secrets)
      return ctx.json(
        sdkError(
          "not_implemented",
          "这个部署没有装配 SDK 认证",
          500,
        ).body,
        500,
      );
    const token = bearerToken(ctx);
    const verified = token
      ? verifyApiKey({
          apiKeys: dependencies.apiKeys,
          secrets: dependencies.secrets,
          token,
        })
      : { ok: false as const };
    if (!verified.ok)
      return ctx.json(
        sdkError("unauthorized", "未提供有效的 Bearer token", 401).body,
        401,
      );
    // sourceId 只来自已认证密钥：本中间件是它唯一的写入点，`/sdk/v1/*` 下任何端点都不接受
    // 请求体 / 查询串传入 sourceId 覆盖它（跨来源隔离的判据只有这一处）。
    ctx.set("sourceId", verified.key.sourceId);
    ctx.set("apiKeyId", verified.key.id);
    await next();
  };
}
