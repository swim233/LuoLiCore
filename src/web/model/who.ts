import { hashStr } from '@luoli/ui/util';
import { createStore, useStore } from '@luoli/ui/store';
import { bus } from './bus';

/* 每人一个固定的颜色：按 uid 算（CLI 没有 uid 时按名字），同一个人永远同一个颜色；颜色本身在 :root 的 --ll-who-0…9 */
const PALETTE = Array.from({ length: 10 }, (_, i) => `var(--ll-who-${i})`);
export const colorOf = (key: string) => PALETTE[hashStr(key) % PALETTE.length];

/* 网页会话里自己发的消息显示的名字（LUOLI_WEB_NAME，不设时是系统用户名），由服务告诉面板（hello、status 事件里的 web.author）。
   写进历史的消息各自存着发言人，显示那个（以后改了名字，旧消息照旧）；这个只用于还没写进历史的那条。服务还没告诉面板时是空的 */
export const webAuthor = createStore<{ name: string }>({ name: '' });
export const useWebAuthor = () => useStore(webAuthor, (s) => s.name);
export function setWebAuthor(name: string) {
  if (webAuthor.get().name !== name) webAuthor.set({ name });
}

/* 助手：显示名与「提到她」时要高亮的几样，由服务告诉面板（hello、status 事件里的 assistant）。
   名字只用于显示，和人设、发给模型的内容无关。服务还没告诉面板时用默认名；唤醒词、用户名没有 */
export interface Assistant {
  /** 显示名（LUOLI_NAME，默认「洛璃」） */
  name: string;
  /** 唤醒词（没启动 Telegram 时为空） */
  wakeWords: string[];
  /** bot 的 @用户名，不带 @ */
  username?: string;
}
export const DEFAULT_NAME = '洛璃';
export const assistant = createStore<Assistant>({ name: DEFAULT_NAME, wakeWords: [] });
export const assistantName = () => assistant.get().name;
/** 订阅助手的名字：用了名字的组件（包括 memo 的）调用它，名字变了会重新渲染 */
export const useAssistantName = () => useStore(assistant, (s) => s.name);
export const useAssistant = () => useStore(assistant, (s) => s);

export function setAssistant(next: Assistant) {
  const cur = assistant.get();
  if (
    cur.name === next.name &&
    cur.username === next.username &&
    cur.wakeWords.join('\n') === next.wakeWords.join('\n')
  )
    return;
  assistant.set({ name: next.name, wakeWords: [...next.wakeWords], username: next.username });
  bus.emit('assistant');
}
