import { ref } from 'vue';

/**
 * 全站共用的确认框（照 `toast.ts` + `ToastHost.vue` 的先例：状态在模块里，宿主在 `App.vue` 挂一次）。
 *
 * `window.confirm` 在这个控制台上是个坏选择：它同步阻塞、样式不受控、在 happy-dom 里没有实现，
 * 而这里要问的多半是「这一步不可撤销」那一类。`ExtensionsPage.vue` 先在页内做了一份，
 * 这里把它抬成单例 —— **那一页的本地副本这一轮不动**，也没动 `ConsoleView` 另外那些
 * `window.confirm`，那是另一次改动。
 */
export interface ConfirmBox { open: boolean; title: string; detail: string; run: (() => Promise<void>) | null }

const CLOSED: ConfirmBox = { open: false, title: '', detail: '', run: null };

export const confirmBox = ref<ConfirmBox>({ ...CLOSED });
export const confirmBusy = ref(false);

export function askConfirm(title: string, detail: string, run: () => Promise<void>): void {
  confirmBox.value = { open: true, title, detail, run };
}
export function dismissConfirm(): void { confirmBox.value = { ...CLOSED }; }
/** 动作抛出时**不关框**：关掉等于把「没成功」这件事一起藏起来，报错由动作自己的 `toastError` 出。 */
export async function runConfirmed(): Promise<void> {
  const action = confirmBox.value.run;
  if (!action) return;
  confirmBusy.value = true;
  try { await action(); dismissConfirm(); }
  finally { confirmBusy.value = false; }
}
