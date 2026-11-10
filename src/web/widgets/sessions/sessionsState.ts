import { createStore } from '../../lib/store';
import { db } from '../../model/db';

/* 会话部件的状态：窗口和全屏共用。普通视图在进全屏、缩成胶囊时会卸载，所以放在模块里，不放组件的 useState。
   - cur：选中的（最后选中的）会话。窗口里点了一行、全屏里点了一行、「此刻」里「在会话中打开」都会写它；
   - detail：窗口里停在时间线这一层（true）还是列表这一层（false）。点了一行为 true，点「返回」为 false；
     全屏里只是自己自动选了第一个会话（没人点过）不改它，所以从列表放大再退回来，窗口还停在列表。
   窄屏的全屏是两层（列表、详情），那一层自己在 FullView 里记；窄屏的窗口永远只显示列表（点一行进全屏） */
export const sessState = createStore<{ cur: string | null; detail: boolean }>({
  cur: null,
  detail: false,
});

/** 打开一个会话：选中它，窗口里进时间线这一层 */
export const pickConv = (id: string) => sessState.set({ cur: id, detail: true });
/** 回到列表这一层（选中的会话还记着，放大时全屏仍然选它） */
export const backToList = () => sessState.set({ detail: false });
export const resetSessState = () => sessState.set({ cur: null, detail: false });
/** 选中的会话不在了（被删、数据整批换了以后找不到）：什么都不选，窗口回到列表 */
export function dropGone() {
  const s = sessState.get();
  if (s.cur && !db.conv(s.cur)) resetSessState();
}
/** 选中的会话，还在才算；没选过或已经不在是 null */
export const sessCur = (): string | null => {
  const c = sessState.get().cur;
  return c && db.conv(c) ? c : null;
};
