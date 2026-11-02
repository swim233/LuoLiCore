import type { Tool } from 'ai';
import type { FileStore, NewFile } from './files.js';
import { imageSize } from './image-size.js';

/**
 * 工具结果带图片：执行函数返回它（ADR-0006「工具结果里的图片」）。文字一段（可以为空），图片
 * 可以多张，每张给出字节与媒体类型。核心把图片存进文件存储，文字与图片一起交给模型，以后的回复
 * 与摘要里同样。普通的返回值（字符串、能转成 JSON 的值）照旧
 */
export class TextAndImages {
  readonly text: string;
  readonly images: readonly NewFile[];

  constructor({ text = '', images = [] }: { text?: string; images?: readonly NewFile[] }) {
    this.text = text;
    this.images = images;
  }
}

/** 存下来的图片：只有地址与描述，没有图片数据 */
export type StoredImage = {
  type: 'image';
  /** 文件存储里的 `luoli-file:` 地址 */
  url: string;
  mediaType: string;
  /** 宽高（像素）；从文件头读不出时没有 */
  width?: number;
  height?: number;
  /** 字节数 */
  bytes: number;
};

/**
 * 带图片的工具结果存进历史的样子（工具段的 output）：文字与图片按顺序排，图片只存地址。
 * 存不了的图片换成一段文字说明
 */
export type StoredToolContent = {
  type: 'luoli-content';
  parts: Array<{ type: 'text'; text: string } | StoredImage>;
};

export function isStoredToolContent(value: unknown): value is StoredToolContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'luoli-content' &&
    Array.isArray((value as { parts?: unknown }).parts)
  );
}

/**
 * 把执行函数返回的 TextAndImages 换成存下来的样子：每张图存进文件存储（同样的内容只存一份），
 * 读出宽高。存不了的（类型不支持、文件头与类型不符、写入出错）换成「[图片无法保存：类型]」，
 * 调用 onUnsaved，调用本身照常完成
 */
export async function storeToolContent(
  content: TextAndImages,
  files: FileStore,
  onUnsaved: (mediaType: string, error: unknown) => void,
): Promise<StoredToolContent> {
  const images = await Promise.all(
    content.images.map(async (image): Promise<StoredToolContent['parts'][number]> => {
      try {
        const url = await files.save(image);
        const size = imageSize(image.data);
        return {
          type: 'image',
          url,
          mediaType: image.mediaType,
          ...size,
          bytes: image.data.length,
        };
      } catch (error) {
        onUnsaved(image.mediaType, error);
        return { type: 'text', text: `[图片无法保存：${image.mediaType}]` };
      }
    }),
  );
  return {
    type: 'luoli-content',
    parts: [
      ...(content.text === '' ? [] : [{ type: 'text' as const, text: content.text }]),
      ...images,
    ],
  };
}

/** 文字部分（含存不了的图片的说明），各段用换行连接。结果长度只算它 */
export function toolContentText(content: StoredToolContent): string {
  return content.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

export function toolContentImages(content: StoredToolContent): StoredImage[] {
  return content.parts.filter((part) => part.type === 'image');
}

/** 图片的说明，如「[图片 image/png 800×600 52 KB]」；取不到宽高时省掉尺寸 */
export function describeImage({
  mediaType,
  width,
  height,
  bytes,
}: Omit<StoredImage, 'type' | 'url'>) {
  return `[图片 ${[mediaType, dimensions(width, height), formatBytes(bytes)].filter(Boolean).join(' ')}]`;
}

function dimensions(width: number | undefined, height: number | undefined): string | undefined {
  return width === undefined || height === undefined ? undefined : `${width}×${height}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;
}

/**
 * 当次回复里工具结果交给模型的样子（SDK 的 toModelOutput）。带图片的结果是内容部件（见
 * toolContentOutput），图片带上这次回复的标记，拒收时据此找出可疑的图片。其余照 SDK 的默认：
 * 字符串是 text，其他转成 JSON；请求的形状与不设 toModelOutput 时相同
 */
export function toolModelOutput(
  files: FileStore,
): (options: { output: unknown }) => Promise<ToolResultOutput> {
  return async ({ output }) => {
    if (isStoredToolContent(output)) return toolContentOutput(output, files, { fresh: true });
    if (typeof output === 'string') return { type: 'text', value: output };
    // 与 SDK 一样经 JSON 转一遍（undefined 是 null）
    return { type: 'json', value: JSON.parse(JSON.stringify(output) ?? 'null') };
  };
}

/** 本次回复的工具结果里的图片，在请求的文件部件上的标记（providerOptions，provider 不会发出） */
export type FreshImageTag = { luoli: { freshToolImage: string } };

/**
 * 带图片的结果换成内容部件：文字与图片按顺序，图片数据从文件存储读出，读不到的换成
 * 「[图片已丢失]」并调用 onMissing。fresh 时图片带上 FreshImageTag（值是它的地址）。
 * 当次回复与以后的回复、摘要都用它，同一个结果每次换出来的内容相同
 */
export async function toolContentOutput(
  content: StoredToolContent,
  files: FileStore,
  { fresh = false, onMissing }: { fresh?: boolean; onMissing?: (url: string) => void } = {},
): Promise<ToolResultOutput> {
  const value = await Promise.all(
    content.parts.map(async (part): Promise<ContentPart> => {
      if (part.type === 'text') return part;
      const data = await files.read(part.url);
      if (data === undefined) {
        onMissing?.(part.url);
        return { type: 'text', text: '[图片已丢失]' };
      }
      const tag: FreshImageTag = { luoli: { freshToolImage: part.url } };
      return {
        type: 'file',
        mediaType: part.mediaType,
        data: { type: 'data', data },
        ...(fresh ? { providerOptions: tag } : {}),
      };
    }),
  );
  return { type: 'content', value };
}

// 工具结果交给模型的形式（SDK 没有单独导出这个类型）
export type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>;
type ContentPart = Extract<ToolResultOutput, { type: 'content' }>['value'][number];
