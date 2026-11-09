import { bus } from '../../model/bus';
import { status } from '../../model/status';
import type { EndKind, Snap } from '../../model/status';
import { createStore } from '../../lib/store';
import { onTimeRate, real, timeRate, vnow } from './timescale';

/* 徽记的「样子」：接在状态汇总（model/status.ts）后面的一层。
   状态汇总照旧实时（顶栏文字、弹出框、工具名、「此刻」部件、aria-label 都用它）；徽记画出来的样子由这里算，五处徽记订阅同一份，所以同一帧一起变。

   样子由三样合成：主状态、伴星数、离线。在状态后面加的东西：
   - 每个样子至少停 0.8 秒：停留期间来的变化只取最后一个，到时间再换；
   - 回复完（最后一个会话正常完成，整体从工作状态变回空闲）：闪一下，星星浮着留 3 秒再散回弯月（主状态 linger）；中止、等待被放弃、出错后都不闪，直接散回去；
   - 留 3 秒期间又被叫（等待合并）：星星保持浮着，取消「3 秒后散回弯月」；之后开始思考照常衔接，等待被放弃就散回弯月；
   - 离线优先：连不上 Telegram 时主状态是 idle 加离线（云遮月），伴星散掉。 */

/** 画出来的主状态：八种状态里的七种（离线是单独的一项），加上回复完的停留 */
export type Main =
  'idle' | 'waiting' | 'thinking' | 'replying' | 'tool' | 'retry' | 'error' | 'linger';
export interface Look {
  main: Main;
  /** 伴星数 0~3：只在工作状态里有 */
  comps: number;
  offline: boolean;
}
/** 状态汇总算出的「想要的样子」，带着最后一个会话是怎么结束的 */
export interface Desired extends Look {
  end: EndKind | null;
}

export const HOLD = 800;
export const LINGER = 3000;
export const MAX_COMPS = 3;
const WORK = new Set<Main>(['thinking', 'replying', 'tool', 'retry']);
/** 思考、回复、工具、重试：工作状态（星星在，伴星才出现） */
export const isWork = (m: Main) => WORK.has(m);
export const sameLook = (a: Look, b: Look) =>
  a.main === b.main && a.comps === b.comps && a.offline === b.offline;

/** 从状态汇总算出想要的样子 */
export function desiredOf(snap: Snap): Desired {
  const st = snap.state;
  if (st === 'offline') return { main: 'idle', comps: 0, offline: true, end: null };
  const main: Main = st;
  const comps = isWork(main) ? Math.min(MAX_COMPS, Math.max(0, snap.count - 1)) : 0;
  return { main, comps, offline: false, end: snap.ended };
}

/* 开发模式的实验台可以接管：手动给想要的样子，退出后回到实时 */
let manual: Desired | null = null;
const desired = (): Desired => manual ?? desiredOf(status.snapshot());

let displayed: Look = (() => {
  const d = desired();
  return { main: d.main, comps: d.comps, offline: d.offline };
})();
let shownAt = -Infinity;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let lingerTimer: ReturnType<typeof setTimeout> | undefined;
let lingerUntil = 0;
/** 留 3 秒期间来了「等待合并」：不再等 3 秒到了散回弯月 */
let held = false;

/** 实验台和调试看的：此刻画出来的样子，和等着换的样子 */
export const lookView = createStore<{ look: Look; pending: Look | null }>({
  look: displayed,
  pending: null,
});
const subs = new Set<(l: Look) => void>();
/** 订阅「画出来的样子」变了。徽记的控制器用 */
export function onLook(fn: (l: Look) => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
export const getLook = () => displayed;

/** 想要的样子，经过「回复完」「留 3 秒期间」的规则，成为此刻该画的样子 */
function resolve(d: Desired, cur: Look): Look {
  const dl: Look = { main: d.main, comps: d.comps, offline: d.offline };
  if (cur.main === 'linger') {
    if (!d.offline && d.main === 'waiting') {
      held = true;
      clearTimeout(lingerTimer);
      return cur;
    }
    if (!d.offline && d.main === 'idle') {
      if (held || vnow() >= lingerUntil) return dl;
      return cur;
    }
    return dl;
  }
  if (!d.offline && d.main === 'idle' && d.end === 'end' && isWork(cur.main))
    return { main: 'linger', comps: 0, offline: false };
  return dl;
}

function show(next: Look) {
  const wasLinger = displayed.main === 'linger';
  displayed = next;
  shownAt = vnow();
  held = false;
  clearTimeout(lingerTimer);
  if (next.main === 'linger') {
    lingerUntil = shownAt + LINGER;
    lingerTimer = setTimeout(reconcile, real(LINGER) + 5);
  } else if (wasLinger) lingerUntil = 0;
  lookView.set({ look: next, pending: null });
  for (const f of [...subs]) {
    try {
      f(next);
    } catch (e) {
      console.error('[badge]', e);
    }
  }
}

/** 状态、停留、倍率变了：重新算此刻该画什么 */
function reconcile() {
  clearTimeout(holdTimer);
  holdTimer = undefined;
  const t = resolve(desired(), displayed);
  if (sameLook(t, displayed)) {
    if (lookView.get().pending) lookView.set({ pending: null });
    return;
  }
  const wait = shownAt + HOLD - vnow();
  if (wait > 0) {
    lookView.set({ pending: t });
    holdTimer = setTimeout(reconcile, real(wait) + 5);
    return;
  }
  show(t);
}

bus.on('status', reconcile);
onTimeRate(() => {
  /* 倍率变了，等待中的计时器按新倍率重排 */
  if (holdTimer) reconcile();
  if (displayed.main === 'linger' && !held) {
    clearTimeout(lingerTimer);
    lingerTimer = setTimeout(reconcile, real(Math.max(0, lingerUntil - vnow())) + 5);
  }
});

/** 开发模式的实验台：接管（给想要的样子）或退出接管（null） */
export function setManualLook(d: Desired | null) {
  manual = d;
  reconcile();
}
export const manualLook = () => manual;
/** 此刻的时间倍率（实验台显示用） */
export const lookRate = timeRate;
