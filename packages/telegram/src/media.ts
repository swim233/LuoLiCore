import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ulid } from 'ulid';
import sharp from 'sharp';
import type { Api } from 'grammy';
import type { Config } from '@luoli/core';
import type { ArchivedMessage, Sqlite } from '@luoli/db';
import { untrusted } from '@luoli/shared';

/**
 * 按**码点**截断，但先按 UTF-16 下标粗截一刀：一个码点最多占 2 个 UTF-16 单元，所以前
 * `maxChars` 个码点必然落在前 `maxChars*2` 个单元里。粗截可能切开一对代理对，而随后按码点
 * 取满 `maxChars` 时那个落单的半字符必然被丢掉 —— 粗截只在原串更长时才发生。
 */
function truncateCodePoints(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return [...text.slice(0, maxChars * 2)].slice(0, maxChars).join('');
}

interface TelegramFile {
  fileId: string;
  uniqueId: string;
  name: string | undefined;
  mime: string | undefined;
  size: number | undefined;
  width: number | undefined;
  height: number | undefined;
  duration: number | undefined;
  kind: string;
}

function fileFrom(message: Record<string, unknown>): TelegramFile | null {
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo.at(-1) as Record<string, unknown>;
    return { fileId: String(photo.file_id), uniqueId: String(photo.file_unique_id), name: undefined, mime: 'image/jpeg', size: Number(photo.file_size ?? 0), width: Number(photo.width ?? 0), height: Number(photo.height ?? 0), duration: undefined, kind: 'photo' };
  }
  for (const kind of ['document', 'voice', 'audio', 'sticker'] as const) {
    const value = message[kind];
    if (value && typeof value === 'object') {
      const file = value as Record<string, unknown>;
      return { fileId: String(file.file_id), uniqueId: String(file.file_unique_id), name: typeof file.file_name === 'string' ? file.file_name : undefined,
        mime: typeof file.mime_type === 'string' ? file.mime_type : undefined, size: Number(file.file_size ?? 0), width: Number(file.width ?? 0), height: Number(file.height ?? 0), duration: Number(file.duration ?? 0), kind };
    }
  }
  return null;
}

export class TelegramMedia {
  constructor(private readonly api: Api, private readonly token: string, private readonly db: Sqlite, private readonly config: Readonly<Config['media']>) {}

  /** 贴纸是不是当图片看。默认否 —— 贴纸多半是表情噪音，每张按 1500 token 记会把群聊上下文吃穿。 */
  #asImage(file: TelegramFile): boolean {
    return file.kind === 'photo' || (file.kind === 'sticker' && this.config.stickerAsImage);
  }

  async process(message: Record<string, unknown>, archived: ArchivedMessage): Promise<unknown[]> {
    const file = fileFrom(message);
    if (!file) return [];
    // `downloadVoice=false`：语音一律不下载（第一版不做 STT，见 docs/14 A13，下下来也只是占磁盘）。
    // 仍然落一条 attachments 行，好让「这里有条语音」在归档与界面上看得见。
    if (file.kind === 'voice' && !this.config.downloadVoice) {
      this.insert(ulid(), archived, file, null, 'skipped', 'download_voice_disabled', null, 'skipped');
      return [{ type: 'text', text: `[语音${file.duration ? ` ${file.duration}s` : ''}]` }];
    }
    const limit = this.#asImage(file) ? this.config.maxImageBytes : this.config.maxDocBytes;
    const id = ulid();
    if ((file.size ?? 0) > limit) {
      this.insert(id, archived, file, null, 'skipped', 'size_limit', null, 'skipped');
      return [{ type: 'text', text: `[${file.kind} ${file.name ?? ''} 超出下载限制]` }];
    }
    try {
      const remote = await this.api.getFile(file.fileId);
      const extension = extname(file.name ?? remote.file_path ?? '') || (file.kind === 'photo' ? '.jpg' : '.bin');
      const directory = join(this.config.dir, archived.chatId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // photo 的 extension 恒为 .jpg（file.name 是 undefined，remote.file_path 固定是 photos/file_N.jpg），
      // 归一化输出也是 .jpg —— 两者同名时 sharp 直接抛 "Cannot use same file for input and output"，
      // catch 把它记成「处理失败」，多模态输入 100% 不可用（docs/20 · W-MEDIA-01）。
      const path = join(directory, this.#asImage(file) ? `${file.uniqueId}.orig${extension}` : `${file.uniqueId}${extension}`);
      const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${remote.file_path}`);
      if (!response.ok) throw new Error(`download_http_${response.status}`);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
      let localPath = path;
      if (this.#asImage(file)) {
        localPath = join(directory, `${file.uniqueId}.jpg`);
        await sharp(path).rotate().resize({ width: this.config.maxImageEdge, height: this.config.maxImageEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(localPath);
        rmSync(path, { force: true });
      }
      const extracted = await this.extract(localPath, file);
      this.insert(id, archived, file, localPath, 'done', null, extracted, extracted === null ? 'skipped' : 'done');
      // `image` part 在 AI SDK v7 已废弃（SDK 内部就是转成 file 再发，顺带每张图打一条
      // DeprecationWarning）。读出侧 `contextMessages` 兜历史 part，写入侧从这里就产出新形状。
      if (this.#asImage(file)) return [{ type: 'file', ref: `attachment://${id}`, mediaType: 'image/jpeg' }];
      if (extracted) return [{ type: 'text', text: `[文档 ${file.name ?? file.uniqueId}]\n${untrusted(`file:${file.name ?? file.uniqueId}`, [...extracted].slice(0, this.config.extract.inlineChars).join(''))}` }];
      return [{ type: 'text', text: `[${file.kind} ${file.name ?? ''}${file.duration ? ` ${file.duration}s` : ''}]` }];
    } catch (error) {
      this.insert(id, archived, file, null, 'failed', error instanceof Error ? error.message : String(error), null, 'failed');
      return [{ type: 'text', text: `[${file.kind} 处理失败]` }];
    }
  }

  /**
   * 文本文件不整份读进内存再展开：`media.maxDocBytes` 默认 20 MB，而 `maxChars` 默认 40 000 ——
   * 此前 `[...readFileSync(path,'utf8')]` 为了取 4 万个码点先造两千万元素的数组（docs/22 · I-07）。
   * 每个码点最多 4 字节，所以前 `maxChars` 个码点必然落在前 `maxChars*4` 字节里。
   * `StringDecoder` 负责末尾那个被字节边界切开的字符：它会攒着不吐，不会留下 U+FFFD。
   */
  private readHead(path: string, maxChars: number): string {
    const handle = openSync(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(maxChars * 4);
      const read = readSync(handle, buffer, 0, buffer.length, 0);
      return truncateCodePoints(new StringDecoder('utf8').write(buffer.subarray(0, read)), maxChars);
    } finally { closeSync(handle); }
  }

  private async extract(path: string, file: TelegramFile): Promise<string | null> {
    if (!this.config.extract.enabled) return null;
    const maxChars = this.config.extract.maxChars;
    // 内置这批是「肯定是纯文本」的最小集；`media.extract.codeExtensions` 往上加，不替换 ——
    // 配错一个扩展名就把 .md 的提取关掉，那种失败运维要过很久才会发现。
    const textExtensions = new Set(['.json', '.csv', '.md', '.ts', '.js', '.py', '.yaml', '.yml',
      ...this.config.extract.codeExtensions.map((value) => (value.startsWith('.') ? value : `.${value}`).toLocaleLowerCase())]);
    if (file.mime?.startsWith('text/') || textExtensions.has(extname(path).toLocaleLowerCase())) return this.readHead(path, maxChars);
    if (file.mime === 'application/pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: readFileSync(path) });
      try { return truncateCodePoints((await parser.getText()).text, maxChars); } finally { await parser.destroy(); }
    }
    if (file.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = await import('mammoth');
      return truncateCodePoints((await mammoth.extractRawText({ path })).value, maxChars);
    }
    return null;
  }

  private insert(id: string, message: ArchivedMessage, file: TelegramFile, localPath: string | null, state: string, error: string | null, extracted: string | null, extractState: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO attachments(id,message_id,chat_id,kind,tg_file_id,tg_file_unique_id,file_name,mime,size_bytes,width,height,duration_sec,local_path,download_state,download_error,extracted_text,extract_state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, message.id, message.chatId, file.kind, file.fileId, file.uniqueId, file.name ?? null, file.mime ?? null, file.size ?? null, file.width ?? null, file.height ?? null, file.duration ?? null, localPath, state, error, extracted, extractState, Date.now());
  }
}
