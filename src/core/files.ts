import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from './message.js';

/** 消息附带的文件（图片），按内容存一份；消息里只存 `luoli-file:<哈希>.<扩展名>` 地址（ADR-0005） */
export type FileStore = {
  /**
   * 保存文件，返回地址。同样的内容只存一份。不支持的媒体类型、文件头与媒体类型不符
   * （伪造或损坏的图片）时抛错
   */
  save(file: NewFile): Promise<string>;
  /** 读取地址指向的文件；文件不存在（或地址不是本存储的格式）时返回 undefined */
  read(url: string): Promise<Uint8Array | undefined>;
};

export type NewFile = { data: Uint8Array; mediaType: string };

const scheme = 'luoli-file:';

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

// 支持的媒体类型：扩展名与文件头（null 为任意字节）。用 Map 查表：普通对象会把
// constructor、__proto__ 等原型上的键也当成支持的类型
const imageTypes = new Map<string, { extension: string; headers: Array<Array<number | null>> }>([
  ['image/jpeg', { extension: 'jpg', headers: [[0xff, 0xd8, 0xff]] }],
  ['image/png', { extension: 'png', headers: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] }],
  [
    'image/webp',
    { extension: 'webp', headers: [[...ascii('RIFF'), null, null, null, null, ...ascii('WEBP')]] },
  ],
  ['image/gif', { extension: 'gif', headers: [ascii('GIF87a'), ascii('GIF89a')] }],
]);

/** 文件存储支持的媒体类型（图片）；其他类型 save 时会报错 */
export function isSupportedMediaType(mediaType: string): boolean {
  return imageTypes.has(mediaType);
}

/**
 * 能否存成图片：媒体类型受支持，且文件头与它相符。发送方声明的类型可能是假的（如改了扩展名的
 * 文件），内容也可能损坏；这样的「图片」存进历史，之后每次请求都会被模型服务拒绝
 */
export function isSupportedImage({ data, mediaType }: NewFile): boolean {
  const type = imageTypes.get(mediaType);
  // 文件比文件头短时，缺的字节是 undefined，不会相符
  return (
    type?.headers.some((header) => header.every((byte, i) => byte === null || data[i] === byte)) ??
    false
  );
}

// 地址里的文件名：64 位十六进制哈希加扩展名。读取时先核对，地址拼不出目录外的路径
const fileName = /^[0-9a-f]{64}\.(jpg|png|webp|gif)$/;

/** 文件名：内容的 SHA-256 加上按媒体类型定的扩展名 */
function nameOf(file: NewFile): string {
  const type = imageTypes.get(file.mediaType);
  if (!type) throw new Error(`不支持的文件类型：${file.mediaType}`);
  if (!isSupportedImage(file)) throw new Error(`文件内容与媒体类型不符：${file.mediaType}`);
  return `${createHash('sha256').update(file.data).digest('hex')}.${type.extension}`;
}

function nameIn(url: string): string | undefined {
  if (!url.startsWith(scheme)) return undefined;
  const name = url.slice(scheme.length);
  return fileName.test(name) ? name : undefined;
}

/** 把文件存在一个目录里。目录在第一次保存时才创建 */
export function openFileStore(dir: string): FileStore {
  return {
    async save(file) {
      const name = nameOf(file);
      const path = join(dir, name);
      if (await exists(path)) return scheme + name;
      await mkdir(dir, { recursive: true });
      // 先写临时文件再改名：进程中途退出也不会留下半截的图片
      const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, file.data);
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return scheme + name;
    },
    async read(url) {
      const name = nameIn(url);
      if (!name) return undefined;
      try {
        return new Uint8Array(await readFile(join(dir, name)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 内存里的文件存储，地址与语义同 openFileStore，供测试使用 */
export function createMemoryFileStore(): FileStore & { names(): string[] } {
  const files = new Map<string, Uint8Array>();
  return {
    async save(file) {
      const name = nameOf(file);
      if (!files.has(name)) files.set(name, new Uint8Array(file.data));
      return scheme + name;
    },
    async read(url) {
      const name = nameIn(url);
      const data = name === undefined ? undefined : files.get(name);
      return data && new Uint8Array(data);
    },
    /** 已保存的文件名，供测试核对 */
    names: () => [...files.keys()],
  };
}

/**
 * 发给模型前，把 `luoli-file:` 地址换成 data URL；读不到的文件换成文字「[图片已丢失]」，
 * 并调用 onMissing；metadata 里标记为无法读取的换成「[图片无法读取]」，不读文件。
 * 只改送给模型的副本
 */
export async function inlineFiles(
  message: Message,
  store: FileStore,
  onMissing: (url: string) => void,
): Promise<Message> {
  if (!message.parts.some((part) => part.type === 'file' && part.url.startsWith(scheme))) {
    return message;
  }
  const parts = await Promise.all(
    message.parts.map(async (part): Promise<Message['parts'][number]> => {
      if (part.type !== 'file' || !part.url.startsWith(scheme)) return part;
      if (message.metadata?.unreadableFiles?.includes(part.url)) {
        return { type: 'text', text: '[图片无法读取]' };
      }
      const data = await store.read(part.url);
      if (!data) {
        onMissing(part.url);
        return { type: 'text', text: '[图片已丢失]' };
      }
      return {
        ...part,
        url: `data:${part.mediaType};base64,${Buffer.from(data).toString('base64')}`,
      };
    }),
  );
  return { ...message, parts };
}
