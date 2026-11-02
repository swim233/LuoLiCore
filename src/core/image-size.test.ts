import { describe, expect, it } from 'vitest';
import { imageSize } from './index.js';

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u16le = (value: number) => [value & 0xff, value >> 8];
const u16be = (value: number) => [value >> 8, value & 0xff];
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, value >> 16];
const u32be = (value: number) => [
  value >>> 24,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];
const u32le = (value: number) => [...u32be(value)].reverse();
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

function png(width: number, height: number): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    u32be(13),
    ascii('IHDR'),
    u32be(width),
    u32be(height),
    [8, 6, 0, 0, 0],
  );
}

/** JPEG：SOI，若干段（如 EXIF），然后是 SOF0 帧头 */
function jpeg(width: number, height: number, before: number[][] = []): Uint8Array {
  return bytes(
    [0xff, 0xd8],
    ...before,
    [0xff, 0xc0],
    u16be(17),
    [8],
    u16be(height),
    u16be(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xda],
  );
}

// APP1（EXIF）段：段长含这两个长度字节
const exif = [[0xff, 0xe1], u16be(16), ascii('Exif'), [0, 0], [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]];

function gif(width: number, height: number): Uint8Array {
  return bytes(ascii('GIF89a'), u16le(width), u16le(height), [0xf7, 0, 0]);
}

function webp(chunk: string, body: number[][]): Uint8Array {
  return bytes(ascii('RIFF'), u32le(100), ascii('WEBP'), ascii(chunk), u32le(30), ...body);
}

describe('imageSize', () => {
  it.each([
    ['PNG', png(800, 600), { width: 800, height: 600 }],
    ['JPEG', jpeg(1024, 768), { width: 1024, height: 768 }],
    [
      'JPEG（EXIF 段在帧头前面，段间有填充的 0xFF）',
      jpeg(640, 480, [...exif, [0xff]]),
      {
        width: 640,
        height: 480,
      },
    ],
    ['GIF', gif(320, 200), { width: 320, height: 200 }],
    [
      'WebP（VP8，有损）',
      webp('VP8 ', [[0x30, 0x01, 0x00], [0x9d, 0x01, 0x2a], u16le(400), u16le(300)]),
      { width: 400, height: 300 },
    ],
    [
      'WebP（VP8L，无损）',
      webp('VP8L', [[0x2f], u32le((640 - 1) | ((360 - 1) << 14))]),
      { width: 640, height: 360 },
    ],
    [
      'WebP（VP8X，扩展）',
      webp('VP8X', [[0x10, 0, 0, 0], u24le(1920 - 1), u24le(1080 - 1)]),
      { width: 1920, height: 1080 },
    ],
  ])('%s', (_name, data, size) => {
    expect(imageSize(data)).toEqual(size);
  });

  it.each([
    ['PNG 截在 IHDR 中间', png(800, 600).subarray(0, 20)],
    [
      'PNG 第一个块不是 IHDR',
      bytes(
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        u32be(13),
        ascii('IDAT'),
        u32be(1),
        u32be(1),
      ),
    ],
    ['JPEG 截在 EXIF 段里', jpeg(640, 480, exif).subarray(0, 12)],
    ['JPEG 没有帧头就开始图像数据', bytes([0xff, 0xd8, 0xff, 0xda], u16be(8))],
    ['JPEG 段之间不是 0xFF', bytes([0xff, 0xd8, 0x00, 0x00])],
    ['GIF 只有签名', bytes(ascii('GIF89a'))],
    ['WebP 不认识的块', webp('ABCD', [[0, 0, 0, 0]])],
    ['WebP VP8 起始码不对', webp('VP8 ', [[0, 0, 0], [0, 0, 0], u16le(1), u16le(1)])],
    ['WebP 截在块头', webp('VP8X', []).subarray(0, 18)],
    ['宽高为 0', png(0, 600)],
    ['不是图片', bytes(ascii('%PDF-1.7'))],
    ['空的', new Uint8Array()],
  ])('%s：返回 undefined，不抛错', (_name, data) => {
    expect(imageSize(data)).toBeUndefined();
  });
});
