/**
 * `/api/*` 统一错误信封，`app.ts` / `packages/server/src/sdk/admin.ts` /
 * `packages/server/src/sdk/*`（`/sdk/v1/*` 的错误在此基础上叠加 `retryable`，见 `sdk/errors.ts`）
 * 共用同一份实现（原在 `app.ts` 内定义，本次抽出为独立模块以消除 admin.ts ⇄ app.ts 的循环 import，
 * docs/12-sdk.md T3.6 交付 6）。
 */
export const apiError = (
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 501 | 502 = 400,
) => ({ body: { ok: false as const, error: { code, message } }, status });
