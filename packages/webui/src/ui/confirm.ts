import { ref } from "vue";

/**
 * 全站共用的确认框（沿用 `toast.ts` 与 `ToastHost.vue` 的做法：状态在模块内，宿主在 `App.vue` 挂载一次）。
 *
 * `window.confirm` 不适用于这个控制台：它同步阻塞、样式不受控、在 happy-dom 中没有实现，
 * 而此处需要确认的多为不可撤销的操作。`ExtensionsPage.vue` 先在页内实现了一份，
 * 这里将其提升为单例。该页的本地副本本轮不改动，`ConsoleView` 中其余的
 * `window.confirm` 同样保留，属于另一次改动的范围。
 */
export interface ConfirmBox {
  open: boolean;
  title: string;
  detail: string;
  run: (() => Promise<void>) | null;
}

const CLOSED: ConfirmBox = { open: false, title: "", detail: "", run: null };

export const confirmBox = ref<ConfirmBox>({ ...CLOSED });
export const confirmBusy = ref(false);

export function askConfirm(
  title: string,
  detail: string,
  run: () => Promise<void>,
): void {
  confirmBox.value = { open: true, title, detail, run };
}
export function dismissConfirm(): void {
  confirmBox.value = { ...CLOSED };
}
/** 动作抛出时不关闭对话框：关闭会掩盖操作未成功这一事实，报错由动作自身的 `toastError` 输出。 */
export async function runConfirmed(): Promise<void> {
  const action = confirmBox.value.run;
  if (!action) return;
  confirmBusy.value = true;
  try {
    await action();
    dismissConfirm();
  } finally {
    confirmBusy.value = false;
  }
}
