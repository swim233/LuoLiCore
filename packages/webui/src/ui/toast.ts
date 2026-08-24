import { reactive } from "vue";

export type ToastSeverity = "success" | "info" | "warn" | "error";
export interface ToastItem {
  id: number;
  severity: ToastSeverity;
  summary: string;
  detail: string;
  life: number;
}

export const toasts = reactive<ToastItem[]>([]);
let seq = 0;

export function dismissToast(id: number): void {
  const index = toasts.findIndex((item) => item.id === id);
  if (index >= 0) toasts.splice(index, 1);
}
/** 全站唯一的通知通道（docs/09 §6）：写操作的成败都从这里出，页面上不该再有第二种提示样式。 */
export function pushToast(input: {
  severity?: ToastSeverity;
  summary: string;
  detail?: string;
  life?: number;
}): void {
  const item: ToastItem = {
    id: ++seq,
    severity: input.severity ?? "info",
    summary: input.summary,
    detail: input.detail ?? "",
    life: input.life ?? 4000,
  };
  toasts.push(item);
  if (toasts.length > 5) toasts.splice(0, toasts.length - 5); // 一次批量操作能刷出十几条，越界的挤掉最旧的，别把屏幕铺满
  if (item.life > 0) setTimeout(() => dismissToast(item.id), item.life);
}
/**
 * 服务端在 `details` 里逐条给出的原因。`invalid_config` 一直带着它（哪一格、为什么），
 * 而这里此前只念 `message` —— 于是一次跨字段校验失败在界面上就是一句「配置校验失败」，
 * 看不出是哪一格，也看不出该改成什么。别的错误码给不出 `details` 时这里什么都不做。
 */
function detailLines(details: unknown[]): string {
  return details
    .slice(0, 6)
    .map((entry) => {
      const row = entry as { path?: unknown; message?: unknown };
      const path = typeof row.path === "string" ? row.path : "";
      const message =
        typeof row.message === "string" ? row.message : JSON.stringify(entry);
      return path ? `${path}：${message}` : message;
    })
    .join("\n");
}
/** 失败的停留时间要长得多：上游错误往往要照着念给人听，4 秒读不完。 */
export function toastError(summary: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // `message` 里已经拼了前两条原因（服务端的 `invalidConfig`），只有更多条时才把整张清单铺开 ——
  // 否则同一句话会在一个 toast 里出现两遍。
  const details = (error as { details?: unknown } | null)?.details;
  const rest =
    Array.isArray(details) && details.length > 2 ? detailLines(details) : "";
  pushToast({
    severity: "error",
    summary,
    detail: rest ? `${message}\n${rest}` : message,
    life: rest ? 15_000 : 9000,
  });
}
