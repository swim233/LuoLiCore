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
/** 全站唯一的通知通道（docs/09 §6）：写操作的成败均由此输出，页面上不应存在第二种提示样式。 */
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
  if (toasts.length > 5) toasts.splice(0, toasts.length - 5); // 一次批量操作可产生十几条，超出上限时移除最旧的，避免铺满屏幕
  if (item.life > 0) setTimeout(() => dismissToast(item.id), item.life);
}
/**
 * 服务端在 `details` 中逐条给出的原因。`invalid_config` 一直携带该字段（指出具体项与原因），
 * 而此前这里只读取 `message`，导致一次跨字段校验失败在界面上仅显示一句配置校验失败，
 * 既看不出具体项也看不出应如何修改。其他错误码未提供 `details` 时此处不做任何处理。
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
/** 失败提示的停留时间明显更长：上游错误信息通常需要完整阅读，4 秒不足以读完。 */
export function toastError(summary: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // `message` 中已包含前两条原因（服务端的 `invalidConfig`），只有超过两条时才展开完整清单，
  // 否则同一句内容会在一个 toast 中重复出现。
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
