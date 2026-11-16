/* 不能交给模型的内容记成的占位文字。普通消息（content.ts）和富文本消息里的块（rich-received.ts）共用 */

/** 秒数写成 m:ss；没有时长时为 0:00 */
export function duration(seconds = 0): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const videoPlaceholder = (seconds?: number) => `[视频 ${duration(seconds)}]`;

export const voicePlaceholder = (seconds?: number) => `[语音 ${duration(seconds)}]`;

export const gifPlaceholder = '[GIF]';

/** 音频：名字取标题，没有取文件名，都没有就是 [音频] */
export function audioPlaceholder(title?: string, fileName?: string): string {
  const name = title ?? fileName;
  return name ? `[音频 ${name}]` : '[音频]';
}

/** 文件：[文件 文件名]，没有文件名就是 [文件] */
export function filePlaceholder(fileName?: string): string {
  return fileName ? `[文件 ${fileName}]` : '[文件]';
}
