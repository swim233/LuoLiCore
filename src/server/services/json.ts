// 不让数字走样的 JSON（ADR-0014）：服务返回的数字照原文的写法保住。普通的 JSON.parse 会把超过
// 安全整数范围的整数变成别的数（9007199254740993 变成 …992），把 1.10 变成 1.1；监听拿数字当编号、
// 交给洛璃看的正文里，这都不行。
// 做法：解析时每个数字换成 JSON.rawJSON(原文)（Node 22 起 JSON.parse 的 reviver 第三个参数带着原文），
// 序列化时 JSON.stringify 照原文写回去

/** 一个数字：原文的写法（如 `1.10`、`9007199254740993`、`1e2`） */
export type JsonNumber = { readonly rawJSON: string };

/** parseJson 的结果：数字都是 JsonNumber，别的同 JSON.parse */
export type JsonValue = string | boolean | null | JsonNumber | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

// TypeScript 的标准库里还没有这两个（JSON.parse source text access，Node 22 起有）
const native = JSON as JSON & {
  rawJSON(text: string): JsonNumber;
  isRawJSON(value: unknown): value is JsonNumber;
};

/** 解析 JSON，数字保住原文的写法。不是 JSON 时抛 SyntaxError */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && context?.source !== undefined
      ? native.rawJSON(context.source)
      : value,
  ) as JsonValue;
}

/** 序列化：数字照原文写回去。indent 是缩进的空格数，0 或不给是一行 */
export function stringifyJson(value: JsonValue, indent = 0): string {
  return JSON.stringify(value, null, indent || undefined);
}

export function isJsonNumber(value: unknown): value is JsonNumber {
  return native.isRawJSON(value);
}

/** 对象（不是数组、不是 null、不是数字） */
export function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsonNumber(value)
  );
}
