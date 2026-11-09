import {
  isSupportedImage,
  isSupportedMediaType,
  type AppendInput,
  type NewFile,
} from '../core/index.js';
import { displayName, type TelegramRaw } from './message.js';

type PhotoSize = NonNullable<TelegramRaw['photo']>[number];

/** 要下载后作为图片交给模型的文件 */
export type ImageRef = {
  kind: 'photo' | 'sticker' | 'document';
  fileId: string;
  mediaType: string;
  /** 字节数，Telegram 给出时才有 */
  size?: number;
  /** 下载到的内容不是这种图片（伪造或损坏）时记的占位 */
  fallback: string;
};

/** 一条 Telegram 消息的内容：图片、占位文字（不能交给模型的内容）、正文（文字或说明文字） */
export type Item = { image?: ImageRef; placeholder?: string; body?: string };

// 照片、贴纸下载到的内容不是图片时的占位
const unreadable = '[图片无法读取]';

/** 照片取长边不超过它的最大一档 */
export const maxPhotoSide = 1280;
/** 图片文件（document）超过它就只记占位 */
export const maxImageDocumentBytes = 10 * 1024 * 1024;

// 入群、退群、置顶等服务消息：不记录（改群名由前端另行处理）
const serviceKeys = [
  'new_chat_members',
  'left_chat_member',
  'new_chat_title',
  'new_chat_photo',
  'delete_chat_photo',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created',
  'message_auto_delete_timer_changed',
  'migrate_to_chat_id',
  'migrate_from_chat_id',
  'pinned_message',
  'forum_topic_created',
  'forum_topic_edited',
  'forum_topic_closed',
  'forum_topic_reopened',
  'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
  'video_chat_scheduled',
  'video_chat_started',
  'video_chat_ended',
  'video_chat_participants_invited',
  'boost_added',
  'chat_background_set',
  'write_access_allowed',
  'users_shared',
  'chat_shared',
];

/** 一条消息的内容；服务消息返回 undefined */
export function describe(raw: TelegramRaw): Item | undefined {
  const body = raw.text ?? raw.caption;
  const content = describeContent(raw);
  if (content === undefined) {
    if (body !== undefined) return { body };
    return serviceKeys.some((key) => key in raw) ? undefined : { placeholder: '[不支持的消息]' };
  }
  return { ...content, body };
}

/** 文字以外的部分：图片或占位；没有文字以外的内容时返回 undefined */
function describeContent(raw: TelegramRaw): Omit<Item, 'body'> | undefined {
  if (raw.photo?.length) {
    const photo = selectPhoto(raw.photo);
    return {
      image: {
        kind: 'photo',
        fileId: photo.file_id,
        mediaType: 'image/jpeg',
        size: photo.file_size,
        fallback: unreadable,
      },
    };
  }
  if (raw.sticker) {
    const { sticker } = raw;
    if (!sticker.is_animated && !sticker.is_video) {
      return {
        image: {
          kind: 'sticker',
          fileId: sticker.file_id,
          mediaType: 'image/webp',
          size: sticker.file_size,
          fallback: unreadable,
        },
      };
    }
    return { placeholder: sticker.emoji ? `[贴纸 ${sticker.emoji}]` : '[贴纸]' };
  }
  // 动图同时带着 document，先看它
  if (raw.animation) return { placeholder: '[GIF]' };
  if (raw.document) {
    const { document } = raw;
    const mediaType = document.mime_type;
    const fitsSize = (document.file_size ?? 0) <= maxImageDocumentBytes;
    const placeholder = document.file_name ? `[文件 ${document.file_name}]` : '[文件]';
    if (mediaType && isSupportedMediaType(mediaType) && fitsSize) {
      return {
        image: {
          kind: 'document',
          fileId: document.file_id,
          mediaType,
          size: document.file_size,
          fallback: placeholder,
        },
      };
    }
    return { placeholder };
  }
  if (raw.video) return { placeholder: `[视频 ${duration(raw.video.duration)}]` };
  if (raw.video_note) return { placeholder: `[视频消息 ${duration(raw.video_note.duration)}]` };
  if (raw.voice) return { placeholder: `[语音 ${duration(raw.voice.duration)}]` };
  if (raw.audio) {
    const name = raw.audio.title ?? raw.audio.file_name;
    return { placeholder: name ? `[音频 ${name}]` : '[音频]' };
  }
  if (raw.location || raw.venue) return { placeholder: '[位置]' };
  if (raw.contact) {
    return { placeholder: `[联系人 ${displayName(raw.contact)}]` };
  }
  if (raw.poll) return { placeholder: `[投票 ${raw.poll.question}]` };
  return undefined;
}

/** 长边不超过 maxPhotoSide 的最大一档；都超过时取最小的一档 */
export function selectPhoto(sizes: PhotoSize[]): PhotoSize {
  const side = (size: PhotoSize) => Math.max(size.width, size.height);
  const bySide = [...sizes].sort((a, b) => side(a) - side(b));
  return bySide.filter((size) => side(size) <= maxPhotoSide).at(-1) ?? bySide[0]!;
}

/** 秒数写成 m:ss；没有时长时为 0:00 */
export function duration(seconds = 0): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * 一条消息（或一组相册）记成核心的输入：占位文字与正文各占一行（占位在前），图片下载后作为附件。
 * 相册按原顺序合成一条，正文取有说明文字的那一条，发言人、时间与消息 id 取第一条。
 * 下载失败的图片记成「[图片下载失败]」；下载到的内容与声明的类型不符（伪造或损坏）时不作为图片，
 * 记成它的 fallback 占位。全是服务消息或没有发送者时返回 undefined
 */
export async function toAppendInput(
  raws: TelegramRaw[],
  {
    download,
    onDownloadFailed,
    onImageRejected,
  }: {
    download: (fileId: string) => Promise<Uint8Array>;
    onDownloadFailed: (image: ImageRef) => void;
    /** 下载到的内容不是声明的图片；bytes 为实际字节数 */
    onImageRejected: (image: ImageRef, bytes: number) => void;
  },
): Promise<(Omit<AppendInput, 'files'> & { files: NewFile[] }) | undefined> {
  const [first] = raws;
  if (!first?.from) return undefined;
  const items = raws.map(describe);
  if (items.every((item) => item === undefined)) return undefined;

  const lines: string[] = [];
  const files: NewFile[] = [];
  for (const item of items) {
    if (item?.placeholder) lines.push(item.placeholder);
    if (!item?.image) continue;
    let file: NewFile;
    try {
      file = { data: await download(item.image.fileId), mediaType: item.image.mediaType };
    } catch {
      onDownloadFailed(item.image);
      lines.push('[图片下载失败]');
      continue;
    }
    if (isSupportedImage(file)) {
      files.push(file);
    } else {
      onImageRejected(item.image, file.data.length);
      lines.push(item.image.fallback);
    }
  }
  const body = items.find((item) => item?.body)?.body;
  if (body) lines.push(body);

  return {
    author: { id: String(first.from.id), name: displayName(first.from) },
    text: lines.join('\n'),
    files,
    createdAt: new Date(first.date * 1000).toISOString(),
    platformMessageId: String(first.message_id),
  };
}

/** 编辑后的正文：占位与新的文字或说明文字；图片不变，不重新下载 */
export function editedText(raw: TelegramRaw): string {
  const item = describe(raw);
  return [item?.placeholder, item?.body].filter(Boolean).join('\n');
}
