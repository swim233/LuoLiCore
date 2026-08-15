import { reactive } from 'vue';

export type ToastSeverity = 'success' | 'info' | 'warn' | 'error';
export interface ToastItem { id: number; severity: ToastSeverity; summary: string; detail: string; life: number }

export const toasts = reactive<ToastItem[]>([]);
let seq = 0;

export function dismissToast(id: number): void {
  const index = toasts.findIndex((item) => item.id === id);
  if (index >= 0) toasts.splice(index, 1);
}
/** 全站唯一的通知通道（docs/09 §6）：写操作的成败都从这里出，页面上不该再有第二种提示样式。 */
export function pushToast(input: { severity?: ToastSeverity; summary: string; detail?: string; life?: number }): void {
  const item: ToastItem = { id: ++seq, severity: input.severity ?? 'info', summary: input.summary, detail: input.detail ?? '', life: input.life ?? 4000 };
  toasts.push(item);
  if (toasts.length > 5) toasts.splice(0, toasts.length - 5); // 一次批量操作能刷出十几条，越界的挤掉最旧的，别把屏幕铺满
  if (item.life > 0) setTimeout(() => dismissToast(item.id), item.life);
}
/** 失败的停留时间要长得多：上游错误往往要照着念给人听，4 秒读不完。 */
export function toastError(summary: string, error: unknown): void {
  pushToast({ severity: 'error', summary, detail: error instanceof Error ? error.message : String(error), life: 9000 });
}
