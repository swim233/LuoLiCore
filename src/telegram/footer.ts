import type { Usage } from '../core/index.js';

/**
 * 回复的尾部：最后一条消息末尾的一行用量，如「输入 5k · 缓存 4.1k · 输出 135 · 推理 102 · 3.2s」。
 * 富文本消息里放在分隔线下面、用下标（见 rich.ts），普通消息里是正文后面斜体的一行（见 plainWithFooter）
 */

/**
 * 尾部的那一行。顺序固定：输入、缓存、输出、推理、用时，用「 · 」隔开。
 * 输入、输出服务端报了就写（0 也写）；缓存、推理大于 0 才写；用时总是有。
 * usage 整个没有（服务端一项都没报）时只有用时。elapsedMs 是从开始生成到回复完成的毫秒数
 */
export function usageFooter(usage: Usage | undefined, elapsedMs: number): string {
  const items: string[] = [];
  if (usage?.input !== undefined) items.push(`输入 ${formatCount(usage.input)}`);
  if (usage?.cacheRead) items.push(`缓存 ${formatCount(usage.cacheRead)}`);
  if (usage?.output !== undefined) items.push(`输出 ${formatCount(usage.output)}`);
  if (usage?.reasoning) items.push(`推理 ${formatCount(usage.reasoning)}`);
  items.push(formatDuration(elapsedMs));
  return items.join(' · ');
}

/**
 * token 数：不到 1000 原样；1000 以上除以 1000、四舍五入到一位小数加 k（小数是 0 不写）；
 * 这样写出来到了 1000k 的及更大的，除以 1000000 同样写，加 M。4096 是 4.1k，999950 是 1M。
 * 全用整数运算（先算出十分位的个数），不经过二进制小数
 */
function formatCount(count: number): string {
  const n = Math.max(0, Math.round(count));
  if (n < 1000) return String(n);
  // 以 0.1k（100）为单位
  const tenthsOfK = roundDiv(n, 100);
  if (tenthsOfK < 10_000) return `${trimmed(tenthsOfK)}k`;
  return `${trimmed(roundDiv(n, 100_000))}M`;
}

/**
 * 用时：四舍五入到 0.1 秒，不到 60 秒写成一位小数加 s（3.2s、3.0s）；60 秒以上（含四舍五入到
 * 0.1 秒后是 60.0 的）四舍五入到整秒，写成 1m05s、12m00s
 */
function formatDuration(elapsedMs: number): string {
  // 不先取整到毫秒：两次四舍五入会把 3049.5 毫秒写成 3.1s
  const ms = Math.max(0, elapsedMs);
  const deciseconds = roundDiv(ms, 100);
  if (deciseconds < 600) return `${Math.floor(deciseconds / 10)}.${deciseconds % 10}s`;
  const seconds = roundDiv(ms, 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** 普通消息里的一个格式标记（MessageEntity）；offset、length 是 UTF-16 码元，和 JS 字符串的下标一致 */
export type MessageEntity = { type: 'italic'; offset: number; length: number };

/**
 * 普通消息带上尾部：正文、一个空行、尾部那一行，用 entities 把那一行标成斜体（不用 parse_mode，
 * 正文里的符号不会被解析）。text 为空时只有尾部那一行
 */
export function plainWithFooter(
  text: string,
  footer: string,
): { text: string; entities: MessageEntity[] } {
  const head = text ? `${text}\n\n` : '';
  return {
    text: `${head}${footer}`,
    entities: [{ type: 'italic', offset: head.length, length: footer.length }],
  };
}

/**
 * 非负数 n 除以 d（偶数）四舍五入，.5 进位：先加上半个 d 再向下取整。n 是整数时（token 数、
 * 整毫秒）恰好落在 .5 上的也不会被二进制小数带偏：n + d/2 是整数，整除得整数时除法是精确的
 */
function roundDiv(n: number, d: number): number {
  return Math.floor((n + d / 2) / d);
}

/** 十分位的个数写成一位小数，小数是 0 不写：41 是 4.1，50 是 5 */
function trimmed(tenths: number): string {
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return fraction === 0 ? String(whole) : `${whole}.${fraction}`;
}
