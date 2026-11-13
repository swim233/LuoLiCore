/* 面板自己的时间说法（带中文措辞）。通用的小工具（随机、哈希、时刻的格式……）在 @luoli/ui/util */
import { fmtTime, pad2, startOfDay } from '@luoli/ui/util';

export function fmtDay(ms: number) {
  const today = startOfDay(Date.now());
  if (ms >= today) return fmtTime(ms);
  if (ms >= today - 864e5) return '昨天 ' + fmtTime(ms);
  const d = new Date(ms);
  return d.getMonth() + 1 + '-' + pad2(d.getDate()) + ' ' + fmtTime(ms);
}
export function fmtShort(ms: number) {
  const today = startOfDay(Date.now());
  if (ms >= today) return fmtTime(ms);
  if (ms >= today - 864e5) return '昨天';
  const d = new Date(ms);
  return d.getMonth() + 1 + '-' + pad2(d.getDate());
}
export function relTime(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 50) return '刚刚';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}
/** 上次回复的说法：1 分钟内「刚刚回复过」，其余「上次回复在 X 前」 */
export const recentReply = (ms: number) => Date.now() - ms < 60e3;
export const lastReplyText = (ms: number) =>
  recentReply(ms) ? '刚刚回复过' : '上次回复在 ' + relTime(ms);
