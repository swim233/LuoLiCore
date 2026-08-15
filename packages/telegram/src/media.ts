import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ulid } from 'ulid';
import sharp from 'sharp';
import type { Api } from 'grammy';
import type { Config } from '@luoli/core';
import type { ArchivedMessage, Sqlite } from '@luoli/db';
import { untrusted } from '@luoli/shared';

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

  async process(message: Record<string, unknown>, archived: ArchivedMessage): Promise<unknown[]> {
    const file = fileFrom(message);
    if (!file) return [];
    const limit = file.kind === 'photo' ? this.config.maxImageBytes : this.config.maxDocBytes;
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
      const path = join(directory, `${file.uniqueId}${extension}`);
      const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${remote.file_path}`);
      if (!response.ok) throw new Error(`download_http_${response.status}`);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
      let localPath = path;
      if (file.kind === 'photo') {
        localPath = join(directory, `${file.uniqueId}.jpg`);
        await sharp(path).rotate().resize({ width: this.config.maxImageEdge, height: this.config.maxImageEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(localPath);
      }
      const extracted = await this.extract(localPath, file);
      this.insert(id, archived, file, localPath, 'done', null, extracted, extracted === null ? 'skipped' : 'done');
      if (file.kind === 'photo') return [{ type: 'image', image: readFileSync(localPath).toString('base64'), mediaType: 'image/jpeg' }];
      if (extracted) return [{ type: 'text', text: `[文档 ${file.name ?? file.uniqueId}]\n${untrusted(`file:${file.name ?? file.uniqueId}`, [...extracted].slice(0, this.config.extract.inlineChars).join(''))}` }];
      return [{ type: 'text', text: `[${file.kind} ${file.name ?? ''}${file.duration ? ` ${file.duration}s` : ''}]` }];
    } catch (error) {
      this.insert(id, archived, file, null, 'failed', error instanceof Error ? error.message : String(error), null, 'failed');
      return [{ type: 'text', text: `[${file.kind} 处理失败]` }];
    }
  }

  private async extract(path: string, file: TelegramFile): Promise<string | null> {
    if (!this.config.extract.enabled) return null;
    if (file.mime?.startsWith('text/') || ['.json', '.csv', '.md', '.ts', '.js', '.py', '.yaml', '.yml'].includes(extname(path).toLocaleLowerCase())) return [...readFileSync(path, 'utf8')].slice(0, this.config.extract.maxChars).join('');
    if (file.mime === 'application/pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: readFileSync(path) });
      try { return [...(await parser.getText()).text].slice(0, this.config.extract.maxChars).join(''); } finally { await parser.destroy(); }
    }
    if (file.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = await import('mammoth');
      return [...(await mammoth.extractRawText({ path })).value].slice(0, this.config.extract.maxChars).join('');
    }
    return null;
  }

  private insert(id: string, message: ArchivedMessage, file: TelegramFile, localPath: string | null, state: string, error: string | null, extracted: string | null, extractState: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO attachments(id,message_id,chat_id,kind,tg_file_id,tg_file_unique_id,file_name,mime,size_bytes,width,height,duration_sec,local_path,download_state,download_error,extracted_text,extract_state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, message.id, message.chatId, file.kind, file.fileId, file.uniqueId, file.name ?? null, file.mime ?? null, file.size ?? null, file.width ?? null, file.height ?? null, file.duration ?? null, localPath, state, error, extracted, extractState, Date.now());
  }
}
