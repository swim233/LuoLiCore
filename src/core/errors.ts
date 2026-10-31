import { APICallError, RetryError, StreamProviderError } from 'ai';

// 只取摘要字段，不把原始错误对象交给 logger：APICallError 的 requestBodyValues 含对话正文
export function summarizeError(error: unknown): object {
  if (RetryError.isInstance(error)) {
    return { ...summarizeError(error.lastError), retries: error.errors.length - 1 };
  }
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    type: error.name,
    message: error.message,
    ...(APICallError.isInstance(error)
      ? { statusCode: error.statusCode, responseBody: summarizeResponseBody(error.responseBody) }
      : {}),
    ...(StreamProviderError.isInstance(error) ? { statusCode: error.statusCode } : {}),
    cause: error.cause instanceof Error ? error.cause.message : undefined,
  };
}

/**
 * 模型调用表的 error 列：错误类型，有状态码时加一个空格和状态码，如 `APICallError 429`、
 * `TimeoutError`。RetryError 取最后一次的错误；SDK 错误名的 `AI_` 前缀去掉。不含错误信息
 */
export function errorKind(error: unknown): string {
  if (RetryError.isInstance(error)) return errorKind(error.lastError);
  if (!(error instanceof Error)) return typeof error;
  const type = error.name.replace(/^AI_/, '');
  const statusCode =
    APICallError.isInstance(error) || StreamProviderError.isInstance(error)
      ? error.statusCode
      : undefined;
  return statusCode === undefined ? type : `${type} ${statusCode}`;
}

// 服务端可能在错误响应里回显请求（含对话正文），所以 JSON 响应体只留错误字段
function summarizeResponseBody(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.slice(0, 500);
  }
  if (typeof parsed !== 'object' || parsed === null) return body.slice(0, 500);
  const record = parsed as Record<string, unknown>;
  if (typeof record.error === 'string') return { message: record.error };
  const source = (
    typeof record.error === 'object' && record.error !== null ? record.error : record
  ) as Record<string, unknown>;
  return {
    message: source.message,
    code: source.code,
    type: source.type,
  };
}
