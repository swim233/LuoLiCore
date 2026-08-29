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
 * 按码点截断，先按 UTF-16 下标做一次粗截：单个码点最多占 2 个 UTF-16 单元，故前 `maxChars`
 * 个码点必然落在前 `maxChars*2` 个单元内。粗截可能切开代理对，但随后按码点取满 `maxChars`
 * 时落单的半字符必被丢弃 —— 粗截仅在原串更长时发生。
 */
function truncateCodePoints(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return [...text.slice(0, maxChars * 2)].slice(0, maxChars).join("");
}

/**
 * 文档解析的墙钟上限。`pdf-parse` / `mammoth` 对用户上传的文件没有任何预算约束，而该步骤曾运行在
 * 按 chat 串行的入口锁内：一个畸形 PDF（解析器活锁、压缩炸弹）使 `attachMedia` 永不返回，
 * 该会话此后的每条消息既不归档也不触发，日志中没有任何 `turn.start`（docs/27 · R-01）。
 *
 * 本闸只约束等待，不约束计算：解析器在 await 之间挂起时有效；纯 CPU 紧循环会独占事件循环，
 * `Promise.race` 的定时器一侧不会得到调度。计算侧由字节闸门约束（见 `process`）。
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

/**
 * 上下文占位符中的文件种类。`file.kind` 是 Telegram 的原始英文，直接拼接会使模型看到
 * `[voice  9s]`，而同一文件中 PDF 输出「文档」、超限输出「超出下载限制」，中英混用仅出现在
 * 这几个兜底分支（docs/29 · M-TG-06）。语音的 `file.name` 恒为空，连续两个空格即由该空槽产生，
 * 因此拼接统一走 `placeholder()` 而非模板串。
 */
const KIND_LABEL: Record<string, string> = {
  photo: "图片",
  document: "文档",
  voice: "语音",
  audio: "音频",
  sticker: "贴纸",
};
const placeholder = (
  file: TelegramFile,
  ...tail: Array<string | false>
): string =>
  `[${[KIND_LABEL[file.kind] ?? file.kind, file.name, file.duration ? `${file.duration}s` : "", ...tail].filter(Boolean).join(" ")}]`;

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
   * @param log 可选。`media.download` / `media.extract` 是 `docs/10 §2` 已规定而实现长期缺失的
   *   两条日志：20MB 图片被 `maxImageBytes` 拦截、PDF 解析超时，此前只记录在 `attachments`
   *   的两列错误字段中（docs/28 · L-LOG-01）。无 traceId —— 该段运行在开轮之前。
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

  /** 贴纸是否按图片处理。默认否：贴纸多为表情噪音，每张按 1500 token 计会耗尽群聊上下文预算。 */
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
    // `downloadVoice=false`：语音一律不下载（首版不实现 STT，见 docs/14 A13，下载后仅占用磁盘）。
    // 仍写入一行 attachments，使归档与界面能显示此处存在语音消息。
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
      return [{ type: "text", text: placeholder(file) }];
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
      return [{ type: "text", text: placeholder(file, "超出下载限制") }];
    }
    try {
      const remote = await this.api.getFile(file.fileId);
      const extension =
        extname(file.name ?? remote.file_path ?? "") ||
        (file.kind === "photo" ? ".jpg" : ".bin");
      const directory = join(this.config.dir, archived.chatId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // photo 的 extension 恒为 .jpg（file.name 为 undefined，remote.file_path 固定为 photos/file_N.jpg），
      // 归一化输出同为 .jpg —— 两者同名时 sharp 抛出 "Cannot use same file for input and output"，
      // 被 catch 记为处理失败，多模态输入完全不可用（docs/20 · W-MEDIA-01）。
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
      // 上一道闸判定的是 Telegram 声明的 `file_size`，该字段可缺省（`?? 0` 会全部放行）。
      // 落盘前按真实字节数再判定一次：解析器的 CPU 开销与字节数成正比，而 `EXTRACT_TIMEOUT_MS`
      // 无法约束纯 CPU 紧循环（docs/27 · R-01）。
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
        // 归一化实现只保留一份（`@luoli/core` 的 `normalizeImage`）：若此处与 `web_fetch` / MCP
        // 各自实现一遍 sharp 链，必然出现「Telegram 图片已归一化、网页图片未归一化」的分叉。
        await normalizeImage(path, localPath, this.config.maxImageEdge);
        rmSync(path, { force: true });
      }
      // 提取失败不计为下载失败：文件已落盘，记为 failed 会使 local_path 变为 NULL，
      // 盘上的文件成为 gcFiles 视角下的孤儿。`attachments` 没有 extract_error 列（迁移提交后
      // 不可修改），故原因带前缀写入唯一的错误列 —— `download_state='done'` 已表明失败发生在哪一步。
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
      // `image` part 在 AI SDK v7 已废弃（SDK 内部转为 file 后再发送，并对每张图输出一条
      // DeprecationWarning）。读出侧由 `contextMessages` 兼容历史 part，写入侧自此处直接产出新形状。
      if (this.#asImage(file))
        return [
          { type: "file", ref: `attachment://${id}`, mediaType: "image/jpeg" },
        ];
      if (extractState === "failed")
        return [
          {
            type: "text",
            text: `[文档 ${file.name ?? file.uniqueId}：正文提取失败（${extractError}）]`,
          },
        ];
      if (extracted)
        return [
          {
            type: "text",
            text: `[文档 ${file.name ?? file.uniqueId}]\n${untrusted(`file:${file.name ?? file.uniqueId}`, [...extracted].slice(0, this.config.extract.inlineChars).join(""))}`,
          },
        ];
      return [{ type: "text", text: placeholder(file) }];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.insert(id, archived, file, null, "failed", message, null, "failed");
      this.#download(id, archived, file, "failed", startedAt, {
        error: message.slice(0, 300),
      });
      return [{ type: "text", text: placeholder(file, "处理失败") }];
    }
  }

  /**
   * 文本文件不整份读入内存再展开：`media.maxDocBytes` 默认 20 MB，而 `maxChars` 默认 40 000 ——
   * 此前 `[...readFileSync(path,'utf8')]` 为取 4 万个码点先构造两千万元素的数组（docs/22 · I-07）。
   * 单个码点最多 4 字节，故前 `maxChars` 个码点必然落在前 `maxChars*4` 字节内。
   * 末尾被字节边界切开的字符由 `StringDecoder` 处理：它会暂存不输出，不会产生 U+FFFD。
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
    // 内置集合是可确定为纯文本的最小集；`media.extract.codeExtensions` 为追加而非替换 ——
    // 若配置写错一个扩展名即关闭 .md 的提取，此类失败运维需要很久才能发现。
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
