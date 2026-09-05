/**
 * `/sdk/v1/*` 的错误契约：`{ok:false, error:{code, message, retryable}}`（docs/12-sdk.md 已定结论 14）。
 * `code` 进契约（`@luoli/sdk-client/schema` 的 `sdkErrorCodeSchema` 枚举），`message` 不进契约。
 *
 * 建在 `apiError()` 之上而不是另起一份同形状的实现（T3.6 交付 6 的「共用」要求）：`/api/*` 的信封
 * 没有 `retryable` 字段，`/sdk/v1/*` 多这一个字段，因此包一层而不是改 `apiError()` 本身的形状——
 * 后者会波及全部既有 `/api/*` 端点与它们的用例。
 */
import type { SdkErrorCode } from "@luoli/sdk-client/schema";
import { apiError } from "../api-error.js";

export const sdkError = (
  code: SdkErrorCode,
  message: string,
  status: 400 | 401 | 404 | 409 | 429 | 500 | 501 | 502 = 400,
  retryable = false,
) => {
  const built = apiError(code, message, status);
  return {
    body: { ok: false as const, error: { ...built.body.error, retryable } },
    status: built.status,
  };
};
