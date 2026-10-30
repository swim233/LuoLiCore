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
