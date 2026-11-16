import { pipeline, type Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

// 能解的压缩方式；请求头里协商的也是这几种
const decoders = new Map<string, () => NodeJS.ReadWriteStream>([
  ['gzip', createGunzip],
  ['x-gzip', createGunzip],
  ['br', createBrotliDecompress],
  ['deflate', createInflate],
]);

/**
 * 按 Content-Encoding 解压。多种压缩按写的顺序叠加，倒着解；有不认识的就原样返回，
 * 由调用方看到的是原始字节。下游被销毁（读到上限）时连同 body 一起销毁，连接随之关闭
 */
export function decompressed(body: Readable, contentEncoding: string | null): Readable {
  const codings = (contentEncoding ?? '')
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '' && coding !== 'identity');
  if (codings.length === 0 || !codings.every((coding) => decoders.has(coding))) return body;
  const stages = codings.reverse().map((coding) => decoders.get(coding)!());
  // 出错时 pipeline 销毁各段，错误从最后一段的读取抛出；回调只是为了不留未处理的错误
  return pipeline([body, ...stages], () => {}) as unknown as Readable;
}

/** 读到 maxBytes 为止；后面还有数据时停下，truncated 为真 */
export async function readCapped(
  stream: Readable,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (size + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      // 跳出循环会销毁流，不再读后面的数据
      break;
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks, size)), truncated };
}

// 开头的字节序标记，优先于声明的字符集（与浏览器相同）
const byteOrderMarks: Array<[number[], string]> = [
  [[0xef, 0xbb, 0xbf], 'utf-8'],
  [[0xfe, 0xff], 'utf-16be'],
  [[0xff, 0xfe], 'utf-16le'],
];

// 在 HTML 开头这么多字节里找 <meta charset>
const sniffBytes = 2048;

// <meta charset="gbk"> 与 <meta http-equiv="Content-Type" content="text/html; charset=gbk">
const metaCharset = /<meta[^>]*?charset\s*=\s*["']?\s*([^\s"'/>;]+)/i;

/**
 * 把正文解成文字。字符集依次看：字节序标记、Content-Type 的 charset、（HTML 或没写类型时）
 * 开头约 2 KB 里的 <meta>，都没有用 UTF-8；不认识的编码名也用 UTF-8。字节序标记不留在文字里。
 * truncated 时末尾可能是半个字符，丢掉而不是解成乱码
 */
export function decodeText(
  bytes: Uint8Array,
  contentType: string | null,
  truncated: boolean,
): { text: string; charset: string } {
  const decoder = textDecoder(charsetOf(bytes, contentType));
  return { text: decoder.decode(bytes, { stream: truncated }), charset: decoder.encoding };
}

function charsetOf(bytes: Uint8Array, contentType: string | null): string | undefined {
  const bom = byteOrderMarks.find(([mark]) => mark.every((byte, i) => bytes[i] === byte));
  if (bom) return bom[1];
  const declared = contentType?.match(/;\s*charset\s*=\s*"?([^";\s]+)/i)?.[1];
  if (declared) return declared;
  const type = mimeTypeOf(contentType);
  if (type !== undefined && type !== 'text/html' && type !== 'application/xhtml+xml') {
    return undefined;
  }
  // 编码名只含 ASCII，按 latin1 看开头的字节即可，不受实际编码影响
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, sniffBytes));
  return head.toString('latin1').match(metaCharset)?.[1];
}

function textDecoder(label: string | undefined): TextDecoder {
  if (label !== undefined) {
    try {
      return new TextDecoder(label);
    } catch {
      // 不认识的编码名：RangeError，退回 UTF-8
    }
  }
  return new TextDecoder('utf-8');
}

/** Content-Type 的类型部分，小写，如 `text/html`；没写时为 undefined */
export function mimeTypeOf(contentType: string | null): string | undefined {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return type || undefined;
}
