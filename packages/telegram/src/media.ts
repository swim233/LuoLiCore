import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ulid } from "ulid";
import type { Api } from "grammy";
import { normalizeImage } from "@luoli/core";
import type { Config, LogSink } from "@luoli/core";
import type { ArchivedMessage, Sqlite } from "@luoli/db";
import { untrusted } from "@luoli/shared";

/**
 * 按**码点**截断，但先按 UTF-16 下标粗截一刀：一个码点最多占 2 个 UTF-16 单元，所以前
 * `maxChars` 个码点必然落在前 `maxChars*2` 个单元里。粗截可能切开一对代理对，而随后按码点
 * 取满 `maxChars` 时那个落单的半字符必然被丢掉 —— 粗截只在原串更长时才发生。
 */
function truncateCodePoints(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return [...text.slice(0, maxChars * 2)].slice(0, maxChars).join("");
}

/**
 * 文档解析的墙钟上限。`pdf-parse` / `mammoth` 对用户上传的文件都没有任何预算，而这一步曾经跑在
 * 按 chat 串行的入口锁里：一个畸形 PDF（解析器活锁、压缩炸弹）让 `attachMedia` 永不返回，那个
 * 会话之后的每条消息就既不归档也不触发，日志里连一条 `turn.start` 都没有（docs/27 · R-01）。
 *
 * **这道闸只挡「等」，不挡「算」**：解析器在 await 之间挂住时它有效；一个纯 CPU 的紧循环会把
 * 事件循环整个占住，`Promise.race` 那一侧根本轮不到。算的那一半由字节闸门挡（见 `process`）。
 */
const EXTRACT_TIMEOUT_MS = 20_000;
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    return {
      fileId: String(photo.file_id),
      uniqueId: String(photo.file_unique_id),
      name: undefined,
      mime: "image/jpeg",
      size: Number(photo.file_size ?? 0),
      width: Number(photo.width ?? 0),
      height: Number(photo.height ?? 0),
      duration: undefined,
      kind: "photo",
    };
  }
  for (const kind of ["document", "voice", "audio", "sticker"] as const) {
    const value = message[kind];
    if (value && typeof value === "object") {
      const file = value as Record<string, unknown>;
      return {
        fileId: String(file.file_id),
        uniqueId: String(file.file_unique_id),
        name: typeof file.file_name === "string" ? file.file_name : undefined,
        mime: typeof file.mime_type === "string" ? file.mime_type : undefined,
        size: Number(file.file_size ?? 0),
        width: Number(file.width ?? 0),
        height: Number(file.height ?? 0),
        duration: Number(file.duration ?? 0),
        kind,
      };
    }
  }
  return null;
}

export class TelegramMedia {
  /**
   * @param log 可选。`media.download` / `media.extract` 是 `docs/10 §2` 里写了而实现里一直没有的
   *   两条：一张 20MB 的图被 `maxImageBytes` 挡掉、一个 PDF 解析超时，此前只落在 `attachments`
   *   那两列错误里（docs/28 · L-LOG-01）。**没有 traceId** —— 这一段跑在开轮之前。
   */
  constructor(
    private readonly api: Api,
    private readonly token: string,
    private readonly db: Sqlite,
    private readonly config: Readonly<Config["media"]>,
    private readonly log?: LogSink,
  ) {}

  /** 一次附件下载的结局。`state` 与 `attachments.download_state` 同一套取值。 */
  #download(
    id: string,
    archived: ArchivedMessage,
    file: TelegramFile,
    state: string,
    startedAt: number,
    extra: Record<string, unknown> = {},
  ): void {
    this.log?.event({
      level: state === "done" ? "info" : "warn",
      kind: "media.download",
      summary: `${file.kind} ${file.name ?? file.uniqueId} ${state}`,
      chatId: archived.chatId,
      durationMs: Math.round(performance.now() - startedAt),
      data: {
        attachmentId: id,
        kind: file.kind,
        bytes: file.size ?? null,
        state,
        ...extra,
      },
    });
  }

  /** 贴纸是不是当图片看。默认否 —— 贴纸多半是表情噪音，每张按 1500 token 记会把群聊上下文吃穿。 */
  #asImage(file: TelegramFile): boolean {
    return (
      file.kind === "photo" ||
      (file.kind === "sticker" && this.config.stickerAsImage)
    );
  }

  async process(
    message: Record<string, unknown>,
    archived: ArchivedMessage,
  ): Promise<unknown[]> {
    const file = fileFrom(message);
    if (!file) return [];
    const startedAt = performance.now();
    // `downloadVoice=false`：语音一律不下载（第一版不做 STT，见 docs/14 A13，下下来也只是占磁盘）。
    // 仍然落一条 attachments 行，好让「这里有条语音」在归档与界面上看得见。
    if (file.kind === "voice" && !this.config.downloadVoice) {
      const voiceId = ulid();
      this.insert(
        voiceId,
        archived,
        file,
        null,
        "skipped",
        "download_voice_disabled",
        null,
        "skipped",
      );
      this.#download(voiceId, archived, file, "skipped", startedAt, {
        reason: "download_voice_disabled",
      });
      return [
        {
          type: "text",
          text: `[语音${file.duration ? ` ${file.duration}s` : ""}]`,
        },
      ];
    }
    const limit = this.#asImage(file)
      ? this.config.maxImageBytes
      : this.config.maxDocBytes;
    const id = ulid();
    if ((file.size ?? 0) > limit) {
      this.insert(
        id,
        archived,
        file,
        null,
        "skipped",
        "size_limit",
        null,
        "skipped",
      );
      this.#download(id, archived, file, "skipped", startedAt, {
        reason: "size_limit",
        limit,
      });
      return [
        {
          type: "text",
          text: `[${file.kind} ${file.name ?? ""} 超出下载限制]`,
        },
      ];
    }
    try {
      const remote = await this.api.getFile(file.fileId);
      const extension =
        extname(file.name ?? remote.file_path ?? "") ||
        (file.kind === "photo" ? ".jpg" : ".bin");
      const directory = join(this.config.dir, archived.chatId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // photo 的 extension 恒为 .jpg（file.name 是 undefined，remote.file_path 固定是 photos/file_N.jpg），
      // 归一化输出也是 .jpg —— 两者同名时 sharp 直接抛 "Cannot use same file for input and output"，
      // catch 把它记成「处理失败」，多模态输入 100% 不可用（docs/20 · W-MEDIA-01）。
      const path = join(
        directory,
        this.#asImage(file)
          ? `${file.uniqueId}.orig${extension}`
          : `${file.uniqueId}${extension}`,
      );
      const response = await fetch(
        `https://api.telegram.org/file/bot${this.token}/${remote.file_path}`,
      );
      if (!response.ok) throw new Error(`download_http_${response.status}`);
      const payload = Buffer.from(await response.arrayBuffer());
      // 上面那道闸判的是 Telegram **声明**的 `file_size`，而它可以缺省（`?? 0` 一路放行）。
      // 落盘前按真实字节数再判一次：解析器的 CPU 开销跟着字节走，而 `EXTRACT_TIMEOUT_MS`
      // 挡不住纯 CPU 的紧循环（docs/27 · R-01）。
      if (payload.length > limit) {
        this.insert(
          id,
          archived,
          file,
          null,
          "skipped",
          "size_limit",
          null,
          "skipped",
        );
        this.#download(id, archived, file, "skipped", startedAt, {
          reason: "size_limit",
          limit,
          realBytes: payload.length,
        });
        return [
          {
            type: "text",
            text: `[${file.kind} ${file.name ?? ""} 超出下载限制]`,
          },
        ];
      }
      writeFileSync(path, payload, { mode: 0o600 });
      let localPath = path;
      if (this.#asImage(file)) {
        localPath = join(directory, `${file.uniqueId}.jpg`);
        // 归一化只有一份（`@luoli/core` 的 `normalizeImage`）：这里与 `web_fetch` / MCP 抓回来的图
        // 各写一遍 sharp 链的话，「Telegram 的图归一化了、网页的图没有」是必然会出现的第二种形状。
        await normalizeImage(path, localPath, this.config.maxImageEdge);
        rmSync(path, { force: true });
      }
      // 提取失败**不算**下载失败：文件已经在盘上了，记成 failed 会让 local_path 变成 NULL、
      // 盘上那份变成 gcFiles 眼里的孤儿。`attachments` 没有 extract_error 列（迁移提交后不可
      // 修改），所以原因带前缀写进唯一那个错误列 —— `download_state='done'` 已经说清了是哪一步。
      this.#download(id, archived, file, "done", startedAt, {
        realBytes: payload.length,
      });
      let extracted: string | null = null;
      let extractState = "skipped";
      let extractError: string | null = null;
      const extractStartedAt = performance.now();
      try {
        extracted = await withDeadline(
          this.extract(localPath, file),
          EXTRACT_TIMEOUT_MS,
          "extract",
        );
        extractState = extracted === null ? "skipped" : "done";
      } catch (error) {
        extractState = "failed";
        extractError = `extract: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.log?.event({
        level: extractState === "failed" ? "warn" : "info",
        kind: "media.extract",
        summary: `${file.name ?? file.uniqueId} ${extractState}`,
        chatId: archived.chatId,
        durationMs: Math.round(performance.now() - extractStartedAt),
        data: {
          attachmentId: id,
          kind: file.kind,
          chars: extracted?.length ?? 0,
          state: extractState,
          error: extractError,
        },
      });
      this.insert(
        id,
        archived,
        file,
        localPath,
        "done",
        extractError,
        extracted,
        extractState,
      );
      // `image` part 在 AI SDK v7 已废弃（SDK 内部就是转成 file 再发，顺带每张图打一条
      // DeprecationWarning）。读出侧 `contextMessages` 兜历史 part，写入侧从这里就产出新形状。
      if (this.#asImage(file))
        return [
          { type: "file", ref: `attachment://${id}`, mediaType: "image/jpeg" },
        ];
      if (extractState === "failed")
        return [
          {
            type: "text",
            text: `[文档 ${file.name ?? file.uniqueId}：正文读不出来（${extractError}）]`,
          },
        ];
      if (extracted)
        return [
          {
            type: "text",
            text: `[文档 ${file.name ?? file.uniqueId}]\n${untrusted(`file:${file.name ?? file.uniqueId}`, [...extracted].slice(0, this.config.extract.inlineChars).join(""))}`,
          },
        ];
      return [
        {
          type: "text",
          text: `[${file.kind} ${file.name ?? ""}${file.duration ? ` ${file.duration}s` : ""}]`,
        },
      ];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.insert(id, archived, file, null, "failed", message, null, "failed");
      this.#download(id, archived, file, "failed", startedAt, {
        error: message.slice(0, 300),
      });
      return [{ type: "text", text: `[${file.kind} 处理失败]` }];
    }
  }

  /**
   * 文本文件不整份读进内存再展开：`media.maxDocBytes` 默认 20 MB，而 `maxChars` 默认 40 000 ——
   * 此前 `[...readFileSync(path,'utf8')]` 为了取 4 万个码点先造两千万元素的数组（docs/22 · I-07）。
   * 每个码点最多 4 字节，所以前 `maxChars` 个码点必然落在前 `maxChars*4` 字节里。
   * `StringDecoder` 负责末尾那个被字节边界切开的字符：它会攒着不吐，不会留下 U+FFFD。
   */
  private readHead(path: string, maxChars: number): string {
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(maxChars * 4);
      const read = readSync(handle, buffer, 0, buffer.length, 0);
      return truncateCodePoints(
        new StringDecoder("utf8").write(buffer.subarray(0, read)),
        maxChars,
      );
    } finally {
      closeSync(handle);
    }
  }

  private async extract(
    path: string,
    file: TelegramFile,
  ): Promise<string | null> {
    if (!this.config.extract.enabled) return null;
    const maxChars = this.config.extract.maxChars;
    // 内置这批是「肯定是纯文本」的最小集；`media.extract.codeExtensions` 往上加，不替换 ——
    // 配错一个扩展名就把 .md 的提取关掉，那种失败运维要过很久才会发现。
    const textExtensions = new Set([
      ".json",
      ".csv",
      ".md",
      ".ts",
      ".js",
      ".py",
      ".yaml",
      ".yml",
      ...this.config.extract.codeExtensions.map((value) =>
        (value.startsWith(".") ? value : `.${value}`).toLocaleLowerCase(),
      ),
    ]);
    if (
      file.mime?.startsWith("text/") ||
      textExtensions.has(extname(path).toLocaleLowerCase())
    )
      return this.readHead(path, maxChars);
    if (file.mime === "application/pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: readFileSync(path) });
      try {
        return truncateCodePoints((await parser.getText()).text, maxChars);
      } finally {
        await parser.destroy();
      }
    }
    if (
      file.mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const mammoth = await import("mammoth");
      return truncateCodePoints(
        (await mammoth.extractRawText({ path })).value,
        maxChars,
      );
    }
    return null;
  }

  private insert(
    id: string,
    message: ArchivedMessage,
    file: TelegramFile,
    localPath: string | null,
    state: string,
    error: string | null,
    extracted: string | null,
    extractState: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO attachments(id,message_id,chat_id,kind,tg_file_id,tg_file_unique_id,file_name,mime,size_bytes,width,height,duration_sec,local_path,download_state,download_error,extracted_text,extract_state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        message.id,
        message.chatId,
        file.kind,
        file.fileId,
        file.uniqueId,
        file.name ?? null,
        file.mime ?? null,
        file.size ?? null,
        file.width ?? null,
        file.height ?? null,
        file.duration ?? null,
        localPath,
        state,
        error,
        extracted,
        extractState,
        Date.now(),
      );
  }
}
