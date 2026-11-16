import { createRedactor } from '../../core/index.js';
import { parseJson, stringifyJson } from './json.js';

// 服务层交出去的文字里抹掉凭据（ADR-0014）：环境变量的值、贴上去的请求头的值、由环境变量算出来的主机名。
// 服务可能把凭据回显在正文里，而且可能用 JSON 的转义写法（PHP 默认把 / 写成 \/，有的把每个字都写成
// \uXXXX）。所以正文是 JSON 时先规整（解析再序列化），再抹；不是 JSON 的，凭据的每个字不论写成原文
// 还是 JSON 的转义写法（\uXXXX、\/、\"、\\、\n 等，混着写也算）都认得出来

/** 短于这么多个字符的不当凭据抹掉（抹掉会把正文里的普通字毁掉）。要抹的值都按这一条 */
export const minSecretChars = 6;

/** JSON 里一个字的简写转义 */
const shortEscapes: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '/': '\\/',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** \uXXXX 里的四位十六进制，字母不分大小写 */
function hexPattern(code: number): string {
  return [...code.toString(16).padStart(4, '0')]
    .map((digit) => (/[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit))
    .join('');
}

/** 一个凭据的各种写法：每个字（UTF-16 的一个单元）是原文，或者 JSON 的任一种转义 */
function escapedPattern(secret: string): string {
  let pattern = '';
  for (let index = 0; index < secret.length; index++) {
    const char = secret[index]!;
    const forms = [escapeRegExp(char), `\\\\u${hexPattern(secret.charCodeAt(index))}`];
    const short = shortEscapes[char];
    if (short) forms.push(escapeRegExp(short));
    pattern += `(?:${forms.join('|')})`;
  }
  return pattern;
}

/**
 * 把文字里的凭据换成 `***`：原文、JSON 转义一层的各种写法（混着写也算），以及核心那一套
 * 逐层 JSON.stringify 的写法（嵌了几层的 JSON）。短于 minSecretChars 个字符的不抹
 */
export function createServiceRedactor(
  secrets: Iterable<string | undefined>,
): (text: string) => string {
  const list = [...new Set(secrets)]
    .filter((secret): secret is string => secret !== undefined && secret.length >= minSecretChars)
    // 长的在前：一个是另一个的一部分时，先整段替换
    .sort((a, b) => b.length - a.length);
  if (list.length === 0) return (text) => text;
  const nested = createRedactor(list);
  const escaped = new RegExp(list.map(escapedPattern).join('|'), 'g');
  return (text) => nested(text).replace(escaped, '***');
}

/**
 * 正文是 JSON 时规整：解析再序列化（indent 是缩进的空格数，0 是一行），序列化只转义 `"`、`\` 和控制字符，
 * 凭据的别的转义写法都还原成了原文，抹的那一步一定认得出。数字照原文的写法写回去，不走样
 * （大整数、1.10，见 json.ts）。不是 JSON 时原样
 */
export function normalizeJson(text: string, indent = 0): { text: string; json: boolean } {
  try {
    return { text: stringifyJson(parseJson(text), indent), json: true };
  } catch {
    return { text, json: false };
  }
}
