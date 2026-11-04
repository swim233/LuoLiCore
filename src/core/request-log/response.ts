import type { RequestResponse } from './log.js';

// 边收边整理一次响应（ADR-0008）：只看 SDK 读过的字节，不另外读、不缓存整条流。
//
// - 2xx 的流式响应（SSE，Chat Completions 格式）：逐个事件累积文字、思考内容、工具调用、结束原因、
//   用量；流里出现错误事件（`{"error": …}`）或解析不了的数据时记下第一个，已收到的照样整理。
//   与 SDK 一样不看 content-type：流式请求的响应都按 SSE 解析。正常读完却没有结束原因时算错误
//   （SDK 此时报「Response stream ended without a finish reason」并重新生成）；一个事件都没有的
//   （服务端回了非流式的 JSON 等），注明是非流式响应，能整理的字段照常整理。
//   中途结束（中止、超时、断开）时，最后没有换行的半行丢掉，不当成解析不了的数据。
// - 非流式请求的 2xx 响应：读完后照同样的字段整理 JSON。
// - 非 2xx：响应体原文。
//
// 错误内容最多存 errorLimit 个字符。先多留一点（errorSlack）、抹掉秘密后再截，免得秘密正好被
// 截断处切开、留下前半截。

/** 错误内容最多保留的字符数；超出的截掉并注明 */
export const errorLimit = 64 * 1024;
const errorSlack = 4096;

/** 错误内容：最多 errorLimit + errorSlack 个字符的原文，与原来的长度 */
export type ErrorText = { text: string; length: number };

export type CollectedResponse = {
  /** 整理出的字段（不含 status、error，由调用方按结果填） */
  fields: Omit<RequestResponse, 'status' | 'error'>;
  /** 流里的错误事件、2xx JSON 里的错误，或非 2xx 的响应体原文；没有时为 undefined */
  error?: ErrorText;
};

export type ResponseCollector = {
  /** SDK 读到的一段字节 */
  chunk(bytes: Uint8Array): void;
  /** 整理已收到的部分。complete：响应体正常读完；中止、超时、断开等中途结束时为 false */
  end(complete: boolean): CollectedResponse;
};

/**
 * 按响应选整理的方式。streaming：这次请求是不是流式请求，只在 content-type 不是
 * text/event-stream 的 2xx 响应时才调用（要解析请求体）
 */
export function collectResponse(
  status: number,
  contentType: string | null,
  streaming: () => boolean,
): ResponseCollector {
  if (status < 200 || status >= 300) return collectError();
  if (contentType?.toLowerCase().includes('text/event-stream') || streaming()) {
    return collectEvents(contentType);
  }
  return collectJson();
}

/** 请求体里 `stream` 为 true（Chat Completions 的流式请求） */
export function isStreamingRequest(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return isObject(parsed) && parsed.stream === true;
  } catch {
    return false;
  }
}

/** 非 2xx：响应体原文（中途结束时是已读到的部分），超过上限的截掉 */
function collectError(): ResponseCollector {
  const text = textCollector(errorLimit + errorSlack);
  return {
    chunk: text.chunk,
    end: () => ({ fields: {}, error: text.end() }),
  };
}

/** 非流式请求的 2xx：读完后解析 JSON；解析不了时记成错误。中途结束时不解析 */
function collectJson(): ResponseCollector {
  const text = textCollector(Number.POSITIVE_INFINITY);
  return {
    chunk: text.chunk,
    end(complete) {
      if (!complete) return { fields: {} };
      const raw = text.end();
      const parsed = parseObject(raw.text);
      if (!parsed) return { fields: {}, error: errorText(`响应不是 JSON 对象：${raw.text}`) };
      return jsonResponse(parsed, raw);
    },
  };
}

/** 非流式的 JSON 响应：带 error 的整份作为错误，否则取 choices[0].message 等字段 */
function jsonResponse(parsed: Record<string, unknown>, raw: ErrorText): CollectedResponse {
  if (parsed.error !== undefined && parsed.error !== null) return { fields: {}, error: raw };
  const fields = accumulator();
  const choice = firstChoice(parsed);
  if (choice) {
    fields.add(isObject(choice.message) ? choice.message : {});
    fields.finish(choice.finish_reason);
  }
  fields.usage(parsed.usage);
  return { fields: fields.result() };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 流式请求的 2xx：按 SSE 逐行切开，空行分隔事件，`data:` 行是事件的数据 */
function collectEvents(contentType: string | null): ResponseCollector {
  const decoder = new TextDecoder();
  const fields = accumulator();
  let error: ErrorText | undefined;
  // 还没遇到换行的半行
  let pending = '';
  let data: string[] = [];
  // 收到的事件数（含 [DONE]）；还没有事件时留着开头的原文，用来整理非流式的响应
  let events = 0;
  const head = textCollector(errorLimit + errorSlack);

  /** 分发攒着的 data 行。lenient：中途结束时收尾，解析不了的不算错误 */
  const dispatch = (lenient = false) => {
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    events++;
    if (payload.trim() === '[DONE]') return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      if (!lenient) error ??= errorText(`无法解析的数据：${payload}`);
      return;
    }
    if (!isObject(event)) return;
    if (event.error !== undefined && event.error !== null) {
      error ??= errorText(payload);
      return;
    }
    const choice = firstChoice(event);
    if (choice) {
      if (isObject(choice.delta)) fields.add(choice.delta);
      fields.finish(choice.finish_reason);
    }
    fields.usage(event.usage);
  };

  const line = (text: string) => {
    if (text === '') return dispatch();
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const name = colon < 0 ? text : text.slice(0, colon);
    if (name !== 'data') return;
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  };

  const feed = (text: string) => {
    if (events === 0) head.add(text);
    pending += text;
    // 一段字节可能在 \r\n 中间断开：结尾的 \r 留到下一段再判断
    const lines = pending.split(/\r\n|\r(?!$)|\n/);
    pending = lines.pop() ?? '';
    for (const text of lines) line(text);
  };

  /** 正常读完却没有结束原因：一个事件都没有时按非流式响应整理 */
  const unfinished = (): CollectedResponse => {
    const raw = head.end();
    const kind = `服务端返回了非流式响应（content-type: ${contentType ?? '无'}）`;
    if (events > 0 || raw.text.trim() === '') {
      return { fields: fields.result(), error: errorText('响应流结束时没有结束原因') };
    }
    const parsed = raw.length === raw.text.length ? parseObject(raw.text) : undefined;
    if (!parsed) return { fields: {}, error: errorText(`${kind}：${raw.text}`) };
    const collected = jsonResponse(parsed, raw);
    return { fields: collected.fields, error: collected.error ?? errorText(kind) };
  };

  return {
    chunk: (bytes) => feed(decoder.decode(bytes, { stream: true })),
    end(complete) {
      feed(decoder.decode());
      if (complete) {
        // 最后一行没有换行、最后一个事件没有空行结尾时照样算
        if (pending !== '') line(pending.replace(/\r$/, ''));
        dispatch();
      } else {
        // 中途结束：没有换行的半行丢掉；已收全的 data 行照常整理
        dispatch(true);
      }
      pending = '';
      const result = fields.result();
      if (complete && error === undefined && result.finishReason === undefined) {
        return unfinished();
      }
      return { fields: result, error };
    },
  };
}

/** 文字、思考内容、工具调用、结束原因、用量的累积 */
function accumulator() {
  let text = '';
  let reasoning = '';
  let finishReason: string | undefined;
  let usage: RequestResponse['usage'];
  const toolCalls: Array<{ id?: string; name: string; arguments: string }> = [];
  // 工具调用增量的 index → toolCalls 里的位置
  const byIndex = new Map<number, number>();

  const addToolCall = (delta: Record<string, unknown>) => {
    const fn = isObject(delta.function) ? delta.function : {};
    const id = typeof delta.id === 'string' && delta.id !== '' ? delta.id : undefined;
    let position: number | undefined;
    if (typeof delta.index === 'number') {
      position = byIndex.get(delta.index);
      if (position === undefined) {
        position = toolCalls.push({ name: '', arguments: '' }) - 1;
        byIndex.set(delta.index, position);
      }
    } else {
      // 没有 index 的服务端：带了新 id 的是新的调用，否则接在上一个后面
      const last = toolCalls.at(-1);
      position =
        last && (id === undefined || last.id === undefined || last.id === id)
          ? toolCalls.length - 1
          : toolCalls.push({ name: '', arguments: '' }) - 1;
    }
    const call = toolCalls[position]!;
    if (id !== undefined) call.id ??= id;
    if (typeof fn.name === 'string' && fn.name !== '' && call.name === '') call.name = fn.name;
    if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
  };

  return {
    /** 流里的 delta，或非流式的 message */
    add(part: Record<string, unknown>) {
      if (typeof part.content === 'string') text += part.content;
      if (typeof part.reasoning_content === 'string') reasoning += part.reasoning_content;
      else if (typeof part.reasoning === 'string') reasoning += part.reasoning;
      if (Array.isArray(part.tool_calls)) {
        for (const delta of part.tool_calls) if (isObject(delta)) addToolCall(delta);
      }
    },
    finish(reason: unknown) {
      if (typeof reason === 'string' && reason !== '') finishReason = reason;
    },
    usage(value: unknown) {
      if (!isObject(value)) return;
      const prompt = isObject(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
      const completion = isObject(value.completion_tokens_details)
        ? value.completion_tokens_details
        : {};
      const reported = {
        ...numberField('input', value.prompt_tokens),
        ...numberField('cacheRead', prompt.cached_tokens),
        ...numberField('output', value.completion_tokens),
        ...numberField('reasoning', completion.reasoning_tokens),
      };
      // 后来的用量覆盖之前的（有的服务端每一块都带累计用量）
      if (Object.keys(reported).length > 0) usage = reported;
    },
    result(): CollectedResponse['fields'] {
      return {
        ...(text === '' ? {} : { text }),
        ...(reasoning === '' ? {} : { reasoning }),
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
        ...(finishReason === undefined ? {} : { finishReason }),
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}

/** 收文字，最多 max 个字符，记下原来的长度。字节用 chunk，已解码的文字用 add */
function textCollector(max: number) {
  const decoder = new TextDecoder();
  let text = '';
  let length = 0;
  const add = (part: string) => {
    length += part.length;
    if (text.length < max) text += part.slice(0, max - text.length);
  };
  return {
    add,
    chunk: (bytes: Uint8Array) => add(decoder.decode(bytes, { stream: true })),
    end(): ErrorText {
      add(decoder.decode());
      return { text, length };
    },
  };
}

/** 一段错误内容，只留 errorLimit + errorSlack 个字符 */
export function errorText(text: string): ErrorText {
  return { text: text.slice(0, errorLimit + errorSlack), length: text.length };
}

/** 存进记录的错误内容：先抹掉秘密，再截到 errorLimit，截了的注明原来的长度 */
export function formatError(error: ErrorText, redact: (text: string) => string): string {
  const text = redact(error.text);
  return text.length > errorLimit || error.length > error.text.length
    ? `${text.slice(0, errorLimit)}…（已截断，共 ${error.length} 字符）`
    : text;
}

function firstChoice(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
  return isObject(choice) ? choice : undefined;
}

function numberField<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  return typeof value === 'number' ? ({ [key]: value } as Record<K, number>) : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
