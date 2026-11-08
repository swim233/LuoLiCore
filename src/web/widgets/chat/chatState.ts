import { createStore } from '../../lib/store';
import { db } from '../../model/db';
import { bus } from '../../model/bus';
import { getSource } from '../../model/source';
import type { ImagePart } from '../../model/types';
import { toast } from '../../state/ui';

/* 网页自己的状态（不在 ADR 里）：当前对话、正在生成的对话 id、每个对话的草稿（文字和待发图片，只存内存） */
export interface Att {
  url: string;
  name: string;
  type: string;
}
export interface Draft {
  text: string;
  atts: Att[];
}
export const chatState = createStore<{ cur: string | null; gen: string | null }>({
  cur: null,
  gen: null,
});
export const drafts = new Map<string, Draft>();
export const draftOf = (id: string): Draft => {
  if (!drafts.has(id)) drafts.set(id, { text: '', atts: [] });
  return drafts.get(id)!;
};
export const webConvs = () => db.sorted().filter((c) => c.platform === 'web');
export function chatCur() {
  const s = chatState.get();
  if (s.cur && db.conv(s.cur)) return s.cur;
  const l = webConvs();
  const cur = l.length ? l[0].id : null;
  chatState.get().cur = cur;
  return cur;
}
/** 新开一个网页对话；现在不能开（网页对话还不能用、bot 离线）时提示并返回 null */
export function newWebConv(): string | null {
  const blocked = getSource().chatBlocked();
  const store = getSource().webChat;
  if (blocked || !store) {
    toast(blocked ?? '网页对话还不能用');
    return null;
  }
  const id = store.newConv();
  chatState.set({ cur: id });
  bus.emit('chat:switch', {});
  return id;
}
export function switchTo(id: string) {
  chatState.set({ cur: id });
  bus.emit('chat:switch', {});
}
export function resetChatState() {
  chatState.set({ cur: null, gen: null });
  drafts.clear();
}
export type { ImagePart };
