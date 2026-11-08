import { STATUS_CODES } from 'node:http';

/** 错误的一句话最多这么多个字符 */
export const errorLineChars = 200;

/** 回复出错时给面板看的一句话 */
export type ErrorLine = {
  /** 认出 HTTP 状态码时为「请求失败（429）」；否则为错误说明的第一行（截到 errorLineChars） */
  text: string;
  /** 认出的 HTTP 状态码（400～599） */
  statusCode?: number;
};

// 标准的原因短语 → 状态码（小写），如 too many requests → 429。provider 拿不到 JSON 的错误体时，
// 错误说明就是响应的 statusText
const phrases = new Map(
  Object.entries(STATUS_CODES).flatMap(([code, phrase]) =>
    phrase ? [[phrase.toLowerCase(), Number(code)] as const] : [],
  ),
);

/**
 * 把核心 error 段的错误说明整理成一句话。核心的错误段里只有文字，这里从文字认状态码：
 * - 明写的：「HTTP 401」「status 503」「status code: 502」；
 * - 开头是三位数：整句只有这个数，或者数后面紧跟它的标准原因短语（「429 Too Many Requests」）。
 *   别的说明碰巧以数字开头（「400 tokens is the max…」）不算；
 * - 只有原因短语的：「Too Many Requests」「Service Unavailable」（整句就是标准短语）；
 * - 重试用尽的「Failed after 3 attempts. Last error: …」、遇到不可重试错误的
 *   「Failed after 2 attempts with non-retryable error: '…'」，看里面那个错误（去掉它的类型名）。
 * 只认 400～599。认不出（超时、网络错误、服务端自己写的说明等）时原样取第一行
 */
export function errorLine(errorText: string): ErrorLine {
  const line = firstLine(errorText);
  const statusCode = statusOf(innerError(line));
  if (statusCode !== undefined) return { text: `请求失败（${statusCode}）`, statusCode };
  return { text: brief(line) || '请求失败' };
}

/**
 * 重试包了一层时，取里面那个错误的说明。里面的错误转成文字时带着类型名
 * （「AI_APICallError: Too Many Requests」），去掉它
 */
function innerError(line: string): string {
  const wrapped =
    /^Failed after \d+ attempts\. Last error: (.*)$/s.exec(line) ??
    /^Failed after \d+ attempts with non-retryable error: '(.*)'$/s.exec(line);
  if (!wrapped) return line;
  return wrapped[1]!.trim().replace(/^[A-Za-z_$][\w$]*Error: /, '');
}

function statusOf(text: string): number | undefined {
  const explicit =
    /\bHTTP(?:\/\d(?:\.\d)?)?[ :]+(\d{3})\b/i.exec(text) ??
    /\bstatus(?:[ _-]?code)?\s*[:=]?\s*(\d{3})\b/i.exec(text);
  const code = explicit
    ? Number(explicit[1])
    : (leadingCode(text) ?? phrases.get(text.toLowerCase().replace(/\.$/, '')));
  return code !== undefined && code >= 400 && code <= 599 ? code : undefined;
}

/** 开头的三位数：整句只有它，或者后面紧跟它自己的标准原因短语 */
function leadingCode(text: string): number | undefined {
  const match = /^(\d{3})(?:\s+(.*))?$/s.exec(text);
  if (!match) return undefined;
  const code = Number(match[1]);
  const rest = match[2]?.toLowerCase();
  const phrase = STATUS_CODES[code]?.toLowerCase();
  if (rest === undefined || (phrase && rest.startsWith(phrase))) return code;
  return undefined;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]!.trim();
}

/** 最多 errorLineChars 个字符（按 Unicode 字符计），截了以「…」结尾 */
function brief(text: string): string {
  const chars = [...text];
  return chars.length <= errorLineChars ? text : `${chars.slice(0, errorLineChars - 1).join('')}…`;
}
