/** 图片的宽高（像素） */
export type ImageSize = { width: number; height: number };

/**
 * 从文件头读出 PNG、JPEG、GIF、WebP 的宽高。不认识的格式、截断或损坏的文件头返回 undefined，
 * 不抛错。只看字节，不看声明的媒体类型
 */
export function imageSize(data: Uint8Array): ImageSize | undefined {
  const bytes = new Bytes(data);
  try {
    if (bytes.startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return png(bytes);
    if (bytes.startsWith([0xff, 0xd8])) return jpeg(bytes);
    if (bytes.ascii(0, 4) === 'GIF8') return gif(bytes);
    if (bytes.ascii(0, 4) === 'RIFF' && bytes.ascii(8, 4) === 'WEBP') return webp(bytes);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  return undefined;
}

// 第一个块是 IHDR：宽、高各 4 字节，大端
function png(bytes: Bytes): ImageSize | undefined {
  if (bytes.ascii(12, 4) !== 'IHDR') return undefined;
  return valid(bytes.u32be(16), bytes.u32be(20));
}

// 逐段找帧头（SOF）：EXIF 等 APP 段可能在前面，按段长跳过
function jpeg(bytes: Bytes): ImageSize | undefined {
  let at = 2;
  for (;;) {
    if (bytes.u8(at) !== 0xff) return undefined;
    // 段之间可以有填充的 0xFF
    let marker = bytes.u8(at + 1);
    while (marker === 0xff) marker = bytes.u8(++at + 1);
    at += 2;
    // 没有长度的独立标记：RST0–7、TEM
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    // 图像数据开始或结束了还没见到帧头
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = bytes.u16be(at);
    // SOF0–SOF15，除去 DHT（C4）、JPG（C8）、DAC（CC）
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return valid(bytes.u16be(at + 5), bytes.u16be(at + 3));
    }
    at += length;
  }
}

// 逻辑屏幕的宽、高各 2 字节，小端
function gif(bytes: Bytes): ImageSize | undefined {
  return valid(bytes.u16le(6), bytes.u16le(8));
}

function webp(bytes: Bytes): ImageSize | undefined {
  switch (bytes.ascii(12, 4)) {
    // 有损：帧头的起始码之后是 14 位的宽、高
    case 'VP8 ':
      if (!bytes.startsWith([0x9d, 0x01, 0x2a], 23)) return undefined;
      return valid(bytes.u16le(26) & 0x3fff, bytes.u16le(28) & 0x3fff);
    // 无损：签名 0x2F 之后的 28 位里是宽 - 1、高 - 1，各 14 位
    case 'VP8L': {
      if (bytes.u8(20) !== 0x2f) return undefined;
      const bits = bytes.u32le(21);
      return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    // 扩展：画布的宽 - 1、高 - 1，各 3 字节，小端
    case 'VP8X':
      return valid(bytes.u24le(24) + 1, bytes.u24le(27) + 1);
    default:
      return undefined;
  }
}

function valid(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** 按位置读数；越界时抛 RangeError，由 imageSize 换成 undefined */
class Bytes {
  constructor(private readonly data: Uint8Array) {}

  u8(at: number): number {
    const value = this.data[at];
    if (value === undefined) throw new RangeError('文件头不完整');
    return value;
  }

  u16be(at: number): number {
    return (this.u8(at) << 8) | this.u8(at + 1);
  }

  u16le(at: number): number {
    return this.u8(at) | (this.u8(at + 1) << 8);
  }

  u24le(at: number): number {
    return this.u8(at) | (this.u8(at + 1) << 8) | (this.u8(at + 2) << 16);
  }

  u32be(at: number): number {
    return (
      ((this.u8(at) << 24) | (this.u8(at + 1) << 16) | (this.u8(at + 2) << 8) | this.u8(at + 3)) >>>
      0
    );
  }

  u32le(at: number): number {
    return (this.u16le(at) | (this.u16le(at + 2) << 16)) >>> 0;
  }

  ascii(at: number, length: number): string | undefined {
    if (at + length > this.data.length) return undefined;
    return String.fromCharCode(...this.data.subarray(at, at + length));
  }

  startsWith(prefix: number[], at = 0): boolean {
    return prefix.every((byte, index) => this.data[at + index] === byte);
  }
}
