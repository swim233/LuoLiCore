import {
  isSupportedImage,
  isSupportedMediaType,
  type AppendInput,
  type NewFile,
} from '../core/index.js';
import { displayName, type TelegramRaw } from './message.js';
import { readRichMessage, type ReceivedRich } from './rich-received.js';
import {
  audioPlaceholder,
  duration,
  filePlaceholder,
  gifPlaceholder,
  videoPlaceholder,
  voicePlaceholder,
} from './placeholder.js';

export { duration } from './placeholder.js';

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

/**
 * 一条 Telegram 消息的内容：图片、占位文字（不能交给模型的内容）、正文（文字或说明文字）。
 * 富文本消息是 rich：要下载的照片，和按各张照片的占位拼出文字的办法（照片在文字里有自己的位置）；
 * 转换出了错时只有占位「[不支持的消息]」，错误在 richError 里（只给日志）
 */
export type Item = {
  image?: ImageRef;
  placeholder?: string;
  body?: string;
  rich?: RichItem;
  richError?: { error: unknown };
};

/**
 * 富文本消息里的照片和文字：images 按照片在文字里出现的顺序，要下载的是前 maxRichPhotos 张有尺寸的，
 * 别的为 undefined；text(i => 占位) 拼出文字
 */
export type RichItem = { images: Array<ImageRef | undefined>; text: ReceivedRich['text'] };

// 照片、贴纸下载到的内容不是图片时的占位
const unreadable = '[图片无法读取]';
const unsupported = '[不支持的消息]';
const downloadFailed = '[图片下载失败]';
// 富文本消息里照片的占位（交给模型的、没下载的、编辑后的都是它）
const photoMark = '[图片]';

/** 一条富文本消息里最多交给模型看几张照片，多出来的只记占位 */
export const maxRichPhotos = 10;

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
  const rich = readRich(raw);
  if (rich) return describeRich(rich);
  const body = raw.text ?? raw.caption;
  const content = describeContent(raw);
  if (content === undefined) {
    if (body !== undefined) return { body };
    return serviceKeys.some((key) => key in raw) ? undefined : { placeholder: unsupported };
  }
  return { ...content, body };
}

/**
 * 富文本消息（rich_message）读出来的内容：转成的文字、照片、被提到的人；转换出了错时是 error。
 * 不是富文本消息时为 undefined
 */
export function readRich(
  raw: TelegramRaw,
): { content: ReceivedRich } | { error: unknown } | undefined {
  if (raw.rich_message === undefined) return undefined;
  try {
    return { content: readRichMessage(raw.rich_message) };
  } catch (error) {
    return { error };
  }
}

/**
 * 富文本消息：前 maxRichPhotos 张照片（取长边不超过 maxPhotoSide 的那一档）要下载。
 * 没有字、也没有照片的，转换出错的，记成「[不支持的消息]」
 */
function describeRich(rich: { content: ReceivedRich } | { error: unknown }): Item {
  if ('error' in rich) return { placeholder: unsupported, richError: { error: rich.error } };
  const { content } = rich;
  if (content.photos.length === 0 && !content.text(() => '').trim()) {
    return { placeholder: unsupported };
  }
  let downloads = 0;
  const images = content.photos.map((sizes): ImageRef | undefined => {
    if (sizes.length === 0 || downloads >= maxRichPhotos) return undefined;
    downloads += 1;
    const photo = selectPhoto(sizes);
    return {
      kind: 'photo',
      fileId: photo.file_id,
      mediaType: 'image/jpeg',
      size: photo.file_size,
      fallback: unreadable,
    };
  });
  return { rich: { images, text: content.text } };
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
  if (raw.animation) return { placeholder: gifPlaceholder };
  if (raw.document) {
    const { document } = raw;
    const mediaType = document.mime_type;
    const fitsSize = (document.file_size ?? 0) <= maxImageDocumentBytes;
    const placeholder = filePlaceholder(document.file_name);
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
  if (raw.video) return { placeholder: videoPlaceholder(raw.video.duration) };
  if (raw.video_note) return { placeholder: `[视频消息 ${duration(raw.video_note.duration)}]` };
  if (raw.voice) return { placeholder: voicePlaceholder(raw.voice.duration) };
  if (raw.audio) return { placeholder: audioPlaceholder(raw.audio.title, raw.audio.file_name) };
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

/**
 * 一条消息（或一组相册）记成核心的输入：占位文字与正文各占一行（占位在前），图片下载后作为附件。
 * 相册按原顺序合成一条，正文取有说明文字的那一条，发言人、时间与消息 id 取第一条。
 * 下载失败的图片记成「[图片下载失败]」；下载到的内容与声明的类型不符（伪造或损坏）时不作为图片，
 * 记成它的 fallback 占位。富文本消息是转出来的文字，照片在文字里自己的位置上，失败的照片那里换成
 * 对应的占位；转换出错的报告给 onRichUnreadable。全是服务消息或没有发送者时返回 undefined
 */
export async function toAppendInput(
  raws: TelegramRaw[],
  loader: Loader & {
    /** 富文本消息转换出错（这条记成「[不支持的消息]」） */
    onRichUnreadable?: (error: unknown) => void;
  },
): Promise<(Omit<AppendInput, 'files'> & { files: NewFile[] }) | undefined> {
  const [first] = raws;
  if (!first?.from) return undefined;
  const items = raws.map(describe);
  if (items.every((item) => item === undefined)) return undefined;

  const lines: string[] = [];
  const files: NewFile[] = [];
  for (const item of items) {
    if (item?.richError) loader.onRichUnreadable?.(item.richError.error);
    if (item?.placeholder) lines.push(item.placeholder);
    if (item?.image) {
      const loaded = await load(item.image, loader);
      if (typeof loaded === 'string') lines.push(loaded);
      else files.push(loaded);
    }
    if (item?.rich) {
      // 照片按出现的顺序下载，附件的顺序和文字里占位的顺序一致
      const marks: string[] = [];
      for (const image of item.rich.images) {
        const loaded = image ? await load(image, loader) : photoMark;
        if (typeof loaded === 'string') {
          marks.push(loaded);
        } else {
          files.push(loaded);
          marks.push(photoMark);
        }
      }
      lines.push(item.rich.text((index) => marks[index] ?? photoMark));
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

/** 下载图片要用的：下载，下载失败、内容不是图片时报告 */
type Loader = {
  download: (fileId: string) => Promise<Uint8Array>;
  onDownloadFailed: (image: ImageRef) => void;
  /** 下载到的内容不是声明的图片；bytes 为实际字节数 */
  onImageRejected: (image: ImageRef, bytes: number) => void;
};

/** 下载一张图片、按内容核对格式：成了是附件；下载失败是「[图片下载失败]」，不是这种图片是它的 fallback */
async function load(image: ImageRef, loader: Loader): Promise<NewFile | string> {
  let file: NewFile;
  try {
    file = { data: await loader.download(image.fileId), mediaType: image.mediaType };
  } catch {
    loader.onDownloadFailed(image);
    return downloadFailed;
  }
  if (isSupportedImage(file)) return file;
  loader.onImageRejected(image, file.data.length);
  return image.fallback;
}

/**
 * 编辑后的正文：占位与新的文字或说明文字；图片不变，不重新下载。富文本消息是新转出来的文字，照片的
 * 位置一律写「[图片]」；转换出错的报告给 onRichUnreadable
 */
export function editedText(
  raw: TelegramRaw,
  { onRichUnreadable }: { onRichUnreadable?: (error: unknown) => void } = {},
): string {
  const item = describe(raw);
  if (item?.richError) onRichUnreadable?.(item.richError.error);
  if (item?.rich) return item.rich.text(() => photoMark);
  return [item?.placeholder, item?.body].filter(Boolean).join('\n');
}
