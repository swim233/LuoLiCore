import { desk } from '../../state/desk';
import { chatState } from './chatState';
import { abortChat } from './chatCore';

/* 生成中按 Esc 中止（焦点在对话里，或对话是当前操作的部件） */
export function chatEscAbort() {
  const gen = chatState.get().gen;
  if (!gen) return false;
  const d = desk.get();
  if (d.full && d.full.id !== 'chat') return false; /* 全屏里显示的不是对话：Esc 先关全屏 */
  const a = document.activeElement as HTMLElement | null;
  const inChat = a && a.closest && a.closest('[data-id="chat"]');
  if (inChat || d.activeId === 'chat' || (d.full && d.full.id === 'chat')) {
    abortChat(gen);
    return true;
  }
  return false;
}
