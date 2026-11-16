import { motionOn } from '@luoli/ui/motion';
import { fx } from '@luoli/ui/fx';
import { desk } from '../../state/desk';
import { faces } from '../../shell/faces';
import type { CursorRef } from '@luoli/ui/chat';

/* 回复正常完成：每个看得见的地方，在自己的最后一个字出现时，从自己的光标那里散开一团星尘。
   - 时机：逐字输出（库的 Typed）每一处把队列放空、最后一个字出现时调 stardustAt(convId, 取光标的函数)，不是服务说回复结束（reply:end）的时候：
     那时队列里可能还有字没出现，光标还不在末尾；对话部件和「此刻」的逐字各按各的进度放，所以各自在自己放完的那一刻散；
   - 位置等排定了再量：放完的那一刻刚渲染完、还没画出来，页面上这一刻的排版还可能要变（对话里回复一结束，输入框上方多出「正在回复」
     一行、时间线滚到最底下都要隔一两帧才排定，光标跟着挪几十像素），所以从下一帧起每帧量，连着两帧一样才散。
     光标不占宽度，位置取光标里那颗星（库的 .ll-cursor-star）；
   - 哪些地方：只有看得见的光标才散：藏着的、形变中的、浮起前的副本（[data-hide]、[data-lifted]、.fs-morph、.ghosts）不散，
     全屏时只有全屏里的散；一次回复最多两处（MAX_BURSTS）；
   - 没有看得见的光标（「此刻」缩成胶囊、对话部件不在）：reply:end 时从顶栏或胶囊里的徽记散开（stardustAtEnd）；
   - 中止、出错没有星尘（Typed 的 onRevealed 只有回复正常完成才通知；reply:end 也只在正常完成时有）；关掉动画不放。 */
/** 一次回复最多散几处 */
const MAX_BURSTS = 2;
/** 等光标位置稳下来，最多量几帧 */
const SETTLE_FRAMES = 4;
/** reply:end 以后一处也没散（光标在但逐字一直没放完的通知，如那一处的 Typed 没了）：这么久之后照样放 */
const SAFETY_MS = 1200;
/** 上一次散开这么久以后又来的，算新的一次回复（没收到 reply:start 时的兜底） */
const STALE_MS = 5000;

/** 一个会话里正在进行的这次回复的星尘记录 */
interface Reply {
  bursts: number;
  /** 已经收尾了（从徽记散过、或者兜底放过）：这次回复不再放 */
  closed: boolean;
  /** 最近一次散开或收尾的时刻 */
  last: number;
  safety: ReturnType<typeof setTimeout> | 0;
}
const replies = new Map<string, Reply>();
const newReply = (): Reply => ({ bursts: 0, closed: false, last: -Infinity, safety: 0 });

function replyOf(convId: string): Reply {
  let rep = replies.get(convId);
  const stale = rep && (rep.bursts > 0 || rep.closed) && performance.now() - rep.last > STALE_MS;
  if (!rep || stale) {
    if (rep?.safety) clearTimeout(rep.safety);
    rep = newReply();
    replies.set(convId, rep);
  }
  return rep;
}

/** 这个光标现在看得见时，里面那颗星的范围；看不见（藏着的副本、不在窗口里、没有大小）是 null */
function visibleStar(c: Element): DOMRect | null {
  if (c.closest('[data-hide], [data-lifted], .fs-morph, .ghosts')) return null;
  if (desk.get().full && !c.closest('#fs')) return null;
  const r = (c.querySelector('.ll-cursor-star') ?? c).getBoundingClientRect();
  const inView =
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.top < window.innerHeight &&
    r.right > 0 &&
    r.left < window.innerWidth;
  return inView ? r : null;
}

/** 这个会话现在看得见的光标里那颗星的范围，最多两处 */
function visibleStars(convId: string): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>('.ll-cursor')]
    .filter((c) => c.dataset.stream === convId)
    .map(visibleStar)
    .filter((r): r is DOMRect => !!r)
    .slice(0, MAX_BURSTS);
}

const burst = (r: DOMRect) => fx.burst(r.left + r.width / 2, r.top + r.height / 2, { n: 30 });

/** 从顶栏的徽记或「此刻」胶囊里的徽记散开一团（这次回复收尾） */
function burstAtBadge(rep: Reply) {
  rep.closed = true;
  rep.last = performance.now();
  const cand = [document.getElementById('top-badge'), faces('now').capBtn?.querySelector('.bd')]
    .filter(Boolean)
    .map((x) => (x as Element).getBoundingClientRect())
    .filter((r) => r.width > 0);
  if (cand[0]) burst(cand[0]);
}

/**
 * 一处的逐字放完了（最后一个字刚出现）：等光标的位置稳下来，从这一处的光标散开一团。
 * 这一处看不见（藏着的副本、不在窗口里）、这次回复已经散够了或者收尾了，就不散。
 * 从下一帧起每帧量一次，连着两帧一样就是稳了（对话里回复一结束，输入框上方的「正在回复」那一行、滚到最底下这些要隔一两帧才排定，
 * 光标会被挪几十像素）；最多量 SETTLE_FRAMES 帧，一直在动（滚动、上推）的就按最后量到的位置散。
 */
export function stardustAt(convId: string, cursor: CursorRef) {
  if (!motionOn()) return;
  const rep = replyOf(convId);
  if (rep.closed || rep.bursts >= MAX_BURSTS) return;
  const look = (frame: number, prev: DOMRect | null) =>
    requestAnimationFrame(() => {
      if (!motionOn() || rep.closed || rep.bursts >= MAX_BURSTS) return;
      const el = cursor();
      const r = el && visibleStar(el);
      if (!r) return;
      const still = prev && Math.abs(r.left - prev.left) < 0.5 && Math.abs(r.top - prev.top) < 0.5;
      if (!still && frame < SETTLE_FRAMES) {
        look(frame + 1, r);
        return;
      }
      rep.bursts++;
      rep.last = performance.now();
      if (rep.safety) clearTimeout(rep.safety);
      rep.safety = 0;
      burst(r);
    });
  look(1, null);
}

/** 一次回复开始了：这次回复的星尘重新记 */
export function stardustStart(convId: string) {
  const old = replies.get(convId);
  if (old?.safety) clearTimeout(old.safety);
  replies.set(convId, newReply());
}

/**
 * 服务说回复正常完成了（reply:end）。
 * - 看得见的光标一处也没有：现在就从徽记那里放；
 * - 有：等各处的逐字放完（Typed 会调 stardustAt）；已经有处散过了就不管；SAFETY_MS 后还一处也没散就放（光标处，没有就徽记）。
 */
export function stardustAtEnd(convId: string) {
  if (!motionOn()) return;
  const rep = replyOf(convId);
  if (rep.closed || rep.bursts > 0) return;
  if (!visibleStars(convId).length) {
    burstAtBadge(rep);
    return;
  }
  if (rep.safety) clearTimeout(rep.safety);
  rep.safety = setTimeout(() => {
    rep.safety = 0;
    if (rep.closed || rep.bursts > 0) return;
    const pts = visibleStars(convId);
    if (!pts.length) {
      burstAtBadge(rep);
      return;
    }
    rep.closed = true;
    rep.last = performance.now();
    pts.forEach(burst);
  }, SAFETY_MS);
}
