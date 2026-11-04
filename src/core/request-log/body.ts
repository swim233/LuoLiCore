import { createHash } from 'node:crypto';
import { fileUrlOf, mediaTypeOf, type FileStore } from '../files.js';

// 请求体怎么拆开存、怎么拼回（ADR-0008）。
//
// 请求体是紧凑的 JSON 对象（与 JSON.stringify 的结果一字不差，provider 发出的就是这样）时拆开：
// `messages` 数组的每一项、整个 `tools` 数组各存一份内容（键为内容的 SHA-256），请求体里
// `messages` 换成哈希的数组，`tools` 换成只含一个哈希的数组；其余字段原样留着。拼回时把哈希换回
// 内容，JSON.stringify 的结果与原来的请求体相同：对象字段的顺序随 JSON.parse 保留，换掉的只是
// 两个已有字段的值。
//
// 拆开的请求体里，`messages`、`tools` 是数组当且仅当它们被换成了哈希：原来是数组的一定会换，
// 原来不是数组的照原样留着、仍不是数组。所以只看拆开的请求体就知道哪些要换回。
//
// 不是 JSON、不是对象、或不是紧凑格式（多了空格、数字写法不同……）的请求体原样存整个字符串：
// 拆开再拼回会变样。

/** 拆开后的请求体（format 为 'raw' 时就是原来的请求体）与它引用的内容（哈希 → 内容） */
export type SplitBody = {
  format: 'raw' | 'split';
  body: string;
  contents: Map<string, string>;
};

const fileScheme = 'luoli-file:';

/**
 * 拆开请求体。消息里 `image_url.url` 位置的 base64 图片，文件存储里有同一张图时换成它的
 * `luoli-file:` 地址，再算内容的哈希
 */
export async function splitBody(body: string, files: FileStore): Promise<SplitBody> {
  const parsed = parseCompactObject(body);
  if (!parsed) return { format: 'raw', body, contents: new Map() };

  const contents = new Map<string, string>();
  const store = (value: unknown): string => {
    const content = JSON.stringify(value);
    const hash = sha256(content);
    contents.set(hash, content);
    return hash;
  };

  const skeleton: Record<string, unknown> = { ...parsed };
  if (Array.isArray(parsed.messages)) {
    const hashes: string[] = [];
    for (const message of parsed.messages) {
      await replaceImages(message, files);
      hashes.push(store(message));
    }
    skeleton.messages = hashes;
  }
  if (Array.isArray(parsed.tools)) skeleton.tools = [store(parsed.tools)];
  return { format: 'split', body: JSON.stringify(skeleton), contents };
}

/** 拼回 splitBody 拆开的请求体（对象）。content 按哈希取内容 */
export function joinBody(
  skeleton: string,
  content: (hash: string) => string,
): Record<string, unknown> {
  const body = JSON.parse(skeleton) as Record<string, unknown>;
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((hash: string) => JSON.parse(content(hash)));
  }
  if (Array.isArray(body.tools)) body.tools = JSON.parse(content(body.tools[0] as string));
  return body;
}

/**
 * 把拼回的请求体里 `image_url.url` 位置的 `luoli-file:` 地址换回 data URL（就地修改）。
 * read 读文件；读不到的照旧是地址，返回这些地址（去重，按出现的顺序）
 */
export async function embedImages(
  body: Record<string, unknown>,
  read: (url: string) => Promise<string | undefined>,
): Promise<string[]> {
  const missing = new Set<string>();
  if (!Array.isArray(body.messages)) return [];
  for (const message of body.messages) {
    for (const holder of imageHolders(message)) {
      if (!holder.url.startsWith(fileScheme)) continue;
      const dataUrl = await read(holder.url);
      if (dataUrl === undefined) missing.add(holder.url);
      else holder.url = dataUrl;
    }
  }
  return [...missing];
}

/** 文件存储里的一张图换成 data URL；读不到、不是文件存储的地址时返回 undefined */
export async function fileToDataUrl(url: string, files: FileStore): Promise<string | undefined> {
  const mediaType = mediaTypeOf(url);
  if (mediaType === undefined) return undefined;
  const data = await files.read(url);
  return data && `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
}

/** 内容的哈希：UTF-8 的 SHA-256，十六进制 */
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 紧凑 JSON 对象解析成对象；不是 JSON、不是对象、或不是紧凑格式时返回 undefined */
function parseCompactObject(body: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return JSON.stringify(parsed) === body ? (parsed as Record<string, unknown>) : undefined;
}

/** 消息的内容数组里，`image_url` 是带字符串 `url` 的对象的那些 `image_url` */
function imageHolders(message: unknown): Array<{ url: string }> {
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  const holders: Array<{ url: string }> = [];
  for (const part of message.content) {
    if (!isObject(part)) continue;
    const imageUrl = part.image_url;
    if (isObject(imageUrl) && typeof imageUrl.url === 'string') {
      holders.push(imageUrl as { url: string });
    }
  }
  return holders;
}

/** 消息里的 base64 图片换成文件存储的地址（就地修改）；见 storedImageUrl */
async function replaceImages(message: unknown, files: FileStore): Promise<void> {
  for (const holder of imageHolders(message)) {
    const url = await storedImageUrl(holder.url, files);
    if (url !== undefined) holder.url = url;
  }
}

/**
 * `data:<媒体类型>;base64,<数据>` 指向的图片在文件存储里时，返回它的地址。媒体类型不支持、
 * 解码失败、文件存储里没有，或 base64 不是标准写法（换回时拼不出一样的字符串）时返回 undefined
 */
async function storedImageUrl(value: string, files: FileStore): Promise<string | undefined> {
  const marker = ';base64,';
  if (!value.startsWith('data:')) return undefined;
  const at = value.indexOf(marker);
  if (at < 0) return undefined;
  const mediaType = value.slice('data:'.length, at);
  const base64 = value.slice(at + marker.length);
  const data = Buffer.from(base64, 'base64');
  // Buffer.from 会跳过不认识的字符、容忍缺少的补齐；换回时按标准写法编码，必须一字不差
  if (data.toString('base64') !== base64) return undefined;
  const url = fileUrlOf({ data, mediaType });
  // 地址按扩展名换回媒体类型：一种扩展名只对应一种媒体类型，换回的 data URL 与原来相同
  if (url === undefined || mediaTypeOf(url) !== mediaType) return undefined;
  return (await files.has(url)) ? url : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
