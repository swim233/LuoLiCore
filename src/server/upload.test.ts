import { describe, expect, it } from 'vitest';
import { createMemoryFileStore } from '../core/index.js';
import { gifBytes, jpegBytes, pngBytes, testService, webpBytes } from './test-kit.js';
import type { ErrorResponse, UploadResponse } from './types.js';
import { isAnimatedGif, maxImageBytes } from './upload.js';

async function setup() {
  const fileStore = createMemoryFileStore();
  const service = await testService({ fileStore });
  const upload = (body: RequestInit['body'], headers: Record<string, string>) =>
    service.request('/api/files', {
      method: 'POST',
      headers,
      body,
      // 流做请求体时 fetch 要求写明
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);
  return { ...service, upload };
}

const errorOf = async (response: Response) => [
  response.status,
  ((await response.json()) as ErrorResponse).error,
];

describe('上传图片：POST /api/files', () => {
  it('PNG、JPEG、WebP、静态 GIF：按内容存进文件存储，返回地址、取图的路径、大小与宽高', async () => {
    const { upload, fileStore } = await setup();
    const cases: Array<[Uint8Array, string, string]> = [
      [pngBytes(80, 60, 'a'), 'image/png', 'png'],
      [jpegBytes('b'), 'image/jpeg', 'jpg'],
      [webpBytes('c'), 'image/webp', 'webp'],
      [gifBytes(1, 4, 3), 'image/gif', 'gif'],
    ];
    for (const [data, mediaType, extension] of cases) {
      const response = await upload(data, { 'content-type': mediaType });
      expect(response.status).toBe(200);
      const body = (await response.json()) as UploadResponse;
      expect(body.url).toMatch(new RegExp(`^luoli-file:[0-9a-f]{64}\\.${extension}$`));
      expect(body).toMatchObject({ mediaType, bytes: data.length });
      expect(body.src).toBe(`/api/files/${body.url.slice('luoli-file:'.length)}`);
      expect(await fileStore.read(body.url)).toEqual(data);
    }
    const [png] = cases[0]!;
    const again = (await (
      await upload(png, { 'content-type': 'image/png' })
    ).json()) as UploadResponse;
    expect(again).toMatchObject({ width: 80, height: 60 });
    const gif = (await (
      await upload(gifBytes(1, 4, 3), { 'content-type': 'image/gif' })
    ).json()) as UploadResponse;
    expect(gif).toMatchObject({ width: 4, height: 3 });
  });

  it('同样的内容只存一份：地址相同；Content-Type 带参数、大小写不同也认', async () => {
    const { upload } = await setup();
    const data = pngBytes(2, 2, 'same');
    const first = (await (
      await upload(data, { 'content-type': 'image/png' })
    ).json()) as UploadResponse;
    const second = (await (
      await upload(data, { 'content-type': 'Image/PNG; charset=binary' })
    ).json()) as UploadResponse;
    expect(second.url).toBe(first.url);
  });

  it('超过 20 MB：413，不读完（Content-Length 超了直接拒；没有 Content-Length 时读到超了就停）', async () => {
    const { upload } = await setup();
    const big = new Uint8Array(maxImageBytes + 1);
    big.set(pngBytes(1, 1));
    expect(await errorOf(await upload(big, { 'content-type': 'image/png' }))).toEqual([
      413,
      '图片太大：每张不超过 20 MB',
    ]);

    // 不带长度的流：一块块给，记下读到了多少
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(pngBytes(1, 1));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        if (pulled > 40 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await upload(body, { 'content-type': 'image/png' });
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(40 * 1024 * 1024);
  });

  it('分块传输（没有 Content-Length）：没超的照收，内容一字不差；超了 413', async () => {
    const { upload, fileStore } = await setup();
    const data = pngBytes(5, 4, 'chunked');
    const chunked = (bytes: Uint8Array, size: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += size) {
            controller.enqueue(bytes.slice(at, at + size));
          }
          controller.close();
        },
      });
    const response = await upload(chunked(data, 7), { 'content-type': 'image/png' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as UploadResponse;
    expect(body).toMatchObject({ width: 5, height: 4, bytes: data.length });
    expect(await fileStore.read(body.url)).toEqual(data);

    const exact = new Uint8Array(maxImageBytes);
    exact.set(pngBytes(3, 3));
    expect(
      (await upload(chunked(exact, 1024 * 1024), { 'content-type': 'image/png' })).status,
    ).toBe(200);
  });

  it('20 MB 整的照收', async () => {
    const { upload } = await setup();
    const exact = new Uint8Array(maxImageBytes);
    exact.set(pngBytes(3, 3));
    expect((await upload(exact, { 'content-type': 'image/png' })).status).toBe(200);
  });

  it('声明的类型与内容不符、空的：400；类型不收、动图：415', async () => {
    const { upload } = await setup();
    expect(await errorOf(await upload(pngBytes(2, 2), { 'content-type': 'image/jpeg' }))).toEqual([
      400,
      '图片的内容与声明的类型不符',
    ]);
    expect(
      await errorOf(
        await upload(new TextEncoder().encode('不是图片'), { 'content-type': 'image/png' }),
      ),
    ).toEqual([400, '图片的内容与声明的类型不符']);
    expect(await errorOf(await upload(new Uint8Array(), { 'content-type': 'image/png' }))).toEqual([
      400,
      '图片是空的',
    ]);
    expect(await errorOf(await upload(gifBytes(2), { 'content-type': 'image/gif' }))).toEqual([
      415,
      '不收动图',
    ]);
    // 访问控制里只放行图片类型；JSON 能进来，但不是图片
    expect(
      await errorOf(await upload(pngBytes(2, 2), { 'content-type': 'application/json' })),
    ).toEqual([415, '只收 PNG、JPEG、WebP 和静态的 GIF 图片']);
    for (const type of ['image/bmp', 'image/svg+xml', 'text/plain', 'application/octet-stream']) {
      expect((await upload(pngBytes(2, 2), { 'content-type': type })).status).toBe(415);
    }
  });

  it('跨站的请求被挡：别的网页的 Origin、别的 Host 都是 403；只有这个路径放行图片类型', async () => {
    const { upload, request } = await setup();
    const png = pngBytes(2, 2, 'x');
    expect(
      (await upload(png, { 'content-type': 'image/png', origin: 'http://evil.example' })).status,
    ).toBe(403);
    expect(
      (
        await request('/api/files', {
          method: 'POST',
          headers: { host: 'evil.example:7310', 'content-type': 'image/png' },
          body: png,
        })
      ).status,
    ).toBe(403);
    expect(
      (await upload(png, { 'content-type': 'image/png', origin: 'http://127.0.0.1:7310' })).status,
    ).toBe(200);
    // 别的接口发图片类型的请求体：照旧 415
    const other = await request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    expect(await errorOf(other)).toEqual([415, '请求体必须是 JSON']);
  });
});

describe('动图', () => {
  it('按块结构数图像块：一帧是静态的，两帧以上是动图；截断的按数到的算', () => {
    expect(isAnimatedGif(gifBytes(1))).toBe(false);
    expect(isAnimatedGif(gifBytes(2))).toBe(true);
    expect(isAnimatedGif(gifBytes(5))).toBe(true);
    const two = gifBytes(2);
    // 第二帧的图像块被截掉（只剩它前面的扩展块）：只数到一帧
    expect(isAnimatedGif(two.slice(0, two.length - 16))).toBe(false);
    expect(isAnimatedGif(new Uint8Array(5))).toBe(false);
  });
});
