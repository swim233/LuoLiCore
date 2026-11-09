import { Hono } from 'hono';
import { imageSize, isSupportedImage, type FileStore, type Logger } from '../core/index.js';
import { limitBody } from './body-limit.js';
import type { ErrorResponse, UploadResponse } from './types.js';
import { fileSrc } from './views.js';

/** 一张图片最多多少字节 */
export const maxImageBytes = 20 * 1024 * 1024;

/** 能上传的图片类型（模型能看的）；GIF 只收静态的 */
export const uploadTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Content-Type 的媒体类型部分（小写，不带参数） */
export function mediaTypeOfHeader(contentType: string | undefined): string | undefined {
  return contentType?.split(';')[0]?.trim().toLowerCase() || undefined;
}

/**
 * POST /files（挂在 /api 下）：上传一张图片，见 types.ts 的 UploadResponse。请求体是图片的原始
 * 字节（访问控制里唯一不要求 JSON 的地方）。先看声明的类型，再按内容核对：
 * - 超过 maxImageBytes：413，不读完（Content-Length 超了不读；没有 Content-Length 时读到超了就停）；
 * - 类型不收、是动图：415；空的、内容与声明的类型不符：400。
 * 按内容存进文件存储（同样的只存一份）。日志只记类型与大小
 */
export function uploadRoutes({ fileStore, logger }: { fileStore: FileStore; logger: Logger }) {
  const refuse = (status: 400 | 413 | 415, error: string) =>
    new Response(JSON.stringify({ error } satisfies ErrorResponse), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  return new Hono().post(
    '/files',
    limitBody(maxImageBytes, () => refuse(413, '图片太大：每张不超过 20 MB')),
    async (c) => {
      const mediaType = mediaTypeOfHeader(c.req.header('content-type'));
      if (!mediaType || !uploadTypes.has(mediaType)) {
        return refuse(415, '只收 PNG、JPEG、WebP 和静态的 GIF 图片');
      }
      const data = new Uint8Array(await c.req.arrayBuffer());
      if (data.length === 0) return refuse(400, '图片是空的');
      if (!isSupportedImage({ data, mediaType })) {
        return refuse(400, '图片的内容与声明的类型不符');
      }
      if (mediaType === 'image/gif' && isAnimatedGif(data)) return refuse(415, '不收动图');
      const url = await fileStore.save({ data, mediaType });
      const size = imageSize(data);
      logger.info({ mediaType, bytes: data.length }, 'web.upload');
      return c.json<UploadResponse>({
        url,
        mediaType,
        src: fileSrc(url),
        bytes: data.length,
        ...(size ? { width: size.width, height: size.height } : {}),
      });
    },
  );
}

/**
 * GIF 是不是动图：按 GIF 的块结构走一遍，图像块多于一个就是。结构坏了、走不下去时按已经数到的算
 */
export function isAnimatedGif(data: Uint8Array): boolean {
  if (data.length < 13) return false;
  let at = 13;
  const screen = data[10]!;
  // 全局颜色表
  if (screen & 0x80) at += 3 * 2 ** ((screen & 0x07) + 1);
  let frames = 0;
  while (at < data.length) {
    const block = data[at];
    if (block === 0x3b) break;
    if (block === 0x21) {
      // 扩展块：0x21、标签，然后是若干子块
      at = skipSubBlocks(data, at + 2);
    } else if (block === 0x2c) {
      frames++;
      if (frames > 1) return true;
      const flags = data[at + 9] ?? 0;
      at += 10;
      // 局部颜色表，然后是 LZW 的最小码长一个字节，再是若干子块
      if (flags & 0x80) at += 3 * 2 ** ((flags & 0x07) + 1);
      at = skipSubBlocks(data, at + 1);
    } else {
      break;
    }
  }
  return false;
}

/** 跳过一串子块（每块开头一个字节是长度，长度 0 的块结束） */
function skipSubBlocks(data: Uint8Array, start: number): number {
  let at = start;
  while (at < data.length) {
    const size = data[at]!;
    at += 1 + size;
    if (size === 0) break;
  }
  return at;
}
