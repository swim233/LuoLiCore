import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Hl } from '../../components/Hl';
import { Markdown } from '../../components/Markdown';
import { Pic } from '../../components/Pic';
import { Typed } from '../../components/Typed';
import { Button, Chevron, Spinner } from '@luoli/ui/controls';
import { EASE_OUT_CSS } from '@luoli/ui/easing';
import { Star4 } from '@luoli/ui/icons';
import { motionOn } from '@luoli/ui/motion';
import { cancelWheel, isWheeling } from '@luoli/ui/wheel';
import { fmtTime } from '@luoli/ui/util';
import { colorOf, useAssistantName } from '../../model/who';
import { nowModel } from '../../model/nowModel';
import type { Line, Session } from '../../model/nowModel';
import { pushAmount } from './push';
import { stardustAt } from './stardust';

/* 「此刻」的终端：用户逐项拼出来的样式。一行：23:37 小明 › 正文；洛璃的回复 ✦（内联 SVG 的四角星）、工具调用 ◇、状态行 ·；
   洛璃的行带一层淡淡的底；新行进来时整体平滑上推，最上面的行滚到浮着的头部下面，在那里糊掉。
   终端自己是窗格的滚动区（.ll-pane-sc），上下的内边距里是浮着的头部和底边的留白。
   行用 @tanstack/react-virtual 排（动态高度）；洛璃正在说的那一行是光标打字（Typed.tsx）：按 Markdown 排版，高度随放出的字变。
   滚动：挂上时从底部开始；停在底部时（离底小于 STICK_PX）新内容贴底、照常上推；往上翻着时新内容不把人拉回底部、也不上推，
   视野里的行不跳；下面来了新内容时底部浮出「回到最新」，点了平滑滚到底、恢复贴底 */
const SYM: Record<string, string> = { user: '›', tool: '◇', status: '·', think: '·', stats: '' };
const animated = new Set<string>(); // 已经放过淡入的行：虚拟滚动把它重新挂上时不重放
/* 上推（新行进来、末尾的行变长时整体往下挪回去再推回原位）的参数 */
const PUSH_MS = 300;
/* 窗口宽度变了（形变、调整大小、进出全屏）：折行变了，行高跟着变，之后这么久内的变高不上推 */
const RESIZE_QUIET_MS = 400;
/* 离底小于这么多像素算停在底部。比会话时间线的 80px 小：这里一行才 22px，往上翻一两行就该算离开了 */
const STICK_PX = 40;
/* 用户刚做了滚动的操作（滚轮、触摸、按键、点滚动条）后这么久内的向上滚动，算用户往上翻（哪怕离底还没到 STICK_PX） */
const USER_MS = 250;
/* 视野上下多画多少行（再往外的行往上翻时才画出来）。画得越多展开时越卡：140 行全画出来（overscan 200）展开时最长的一帧比 12 多约 100ms */
const OVERSCAN = 12;
/* 「回到最新」平滑滚到底的时长 */
const JUMP_MS = 350;

function Head({ line, pad }: { line: Line; pad?: boolean }) {
  const luoli = useAssistantName();
  return (
    <span className={'tl-head' + (pad ? ' tl-pad' : '')} aria-hidden={pad || undefined}>
      <span className="tl-time">{fmtTime(line.at)}</span>
      {line.kind === 'user' && <span className="tl-name">{line.name}</span>}
      {(line.kind === 'luoli' || line.kind === 'tool' || pad) && (
        <span className="tl-name">{luoli}</span>
      )}
      {line.kind === 'luoli' || pad ? (
        <span className="tl-sym">
          <Star4 className="st4" />
        </span>
      ) : (
        <span className="tl-sym">{SYM[line.kind]}</span>
      )}
    </span>
  );
}

/* 洛璃正在说的一行。文字是 nowModel 里就地累加的（line.text），到一批来一次 delta：这里自己订阅，只重画这一行；
   同一行可能同时挂在两处（浮起的卡片和全屏里的列），各挂各的、各按全文放。流结束（streaming 变假）由外面的 TermLine 重画带进来 */
function StreamBody({
  line,
  convId,
  onSettled,
}: {
  line: Line;
  convId: string;
  onSettled: () => void;
}) {
  const [text, setText] = useState(line.text || '');
  useEffect(() => {
    setText(line.text || ''); // 挂上到订阅之间来的字
    return nowModel.sub((type, cid, l) => {
      if (type === 'delta' && cid === convId && l && l.id === line.id) setText(l.text || '');
    });
  }, [line.id, convId]);
  return (
    <span className="tl-body">
      <Typed
        convId={convId}
        text={text}
        streaming={!!line.streaming}
        lingerUntil={line.lingerUntil || 0}
        onSettled={onSettled}
        onRevealed={(cursor) => {
          if (line.completed) stardustAt(convId, cursor);
        }}
      />
    </span>
  );
}

function ThinkBody({ line }: { line: Line }) {
  const [open, setOpen] = useState(!!line.open);
  if (!line.done) return <span className="tl-body">思考中…</span>;
  if (line.aborted && !line.text)
    return <span className="tl-body">思考被中止</span>; /* 没有内容：不给展开箭头 */
  const label = line.aborted ? '思考被中止' : line.sec ? `思考了 ${line.sec} 秒` : '思考过程';
  return (
    <span className="tl-body">
      <button
        className="tl-think"
        type="button"
        aria-expanded={open}
        onClick={() => {
          line.open = !open;
          setOpen(!open);
        }}
      >
        {label}
        <Chevron />
      </button>
      <span className="tl-think-text" hidden={!open}>
        {line.text}
      </span>
    </span>
  );
}

const TermLine = memo(function TermLine({
  line,
  ver,
  isNew,
  convId,
}: {
  line: Line;
  ver: number;
  isNew: boolean;
  convId: string;
}) {
  const [settled, setSettled] = useState(false);
  void ver;
  const luoli = line.kind === 'luoli' || line.kind === 'tool';
  const cls = [
    'tl',
    'k-' + line.kind,
    luoli && 'is-luoli',
    line.err && 'is-err',
    line.retry && 'is-retry',
    line.task && 'is-task',
    isNew && motionOn() && 'is-new',
  ]
    .filter(Boolean)
    .join(' ');
  let body: React.ReactNode;
  if (line.kind === 'user') {
    body = (
      <span className="tl-body">
        <Hl text={line.text || ''} hits />
        {line.images && line.images.length > 0 && (
          <>
            {line.text ? ' ' : ''}
            <br />
            {line.images.map((img, i) => (
              <Pic key={i} info={img} box={76} fallback={[76, 54]} />
            ))}
          </>
        )}
      </span>
    );
  } else if (line.kind === 'luoli') {
    body =
      line.streaming || (line.lingerUntil && !settled) ? (
        <StreamBody line={line} convId={convId} onSettled={() => setSettled(true)} />
      ) : (
        <span className="tl-body">
          <Markdown text={line.text || ''} hits={false} />
        </span>
      );
  } else if (line.kind === 'tool') {
    /* 工具按名字通用显示：进行中是工具名加参数的前一截；结束后是成功或出错、耗时，出错时再加错误的一句话，结果里有图就带缩略图 */
    const bad = line.ok === false;
    const name = <b className="tl-tool">{line.toolName || '工具'}</b>;
    body = !line.done ? (
      <span className="tl-body">
        <span>
          正在调用 {name} {line.label}…
        </span>
        <Spinner className="spin" />
      </span>
    ) : (
      <span className="tl-body">
        <span>
          {bad ? '调用出错 ' : '调用了 '}
          {name} {line.label}
        </span>
        <span className={'tl-ok' + (bad ? ' is-bad' : '') + ' is-new'}>
          {bad ? '×' : '✓'}
          {line.ms !== undefined && ` ${(line.ms / 1000).toFixed(1)}s`}
        </span>
        {bad && line.error && <span className="tl-sum is-bad">└ {line.error}</span>}
        {line.images && line.images.length > 0 && (
          <span className="tl-pics">
            {line.images.map((img, i) => (
              <Pic key={i} info={img} box={84} fallback={[84, 58]} />
            ))}
          </span>
        )}
      </span>
    );
  } else if (line.kind === 'think') {
    body = <ThinkBody line={line} />;
  } else {
    body = <span className="tl-body">{line.text}</span>;
  }
  return (
    <div
      className={cls}
      style={line.kind === 'user' ? { '--who': colorOf(line.uid || line.name || '') } : undefined}
    >
      <Head line={line} pad={line.kind === 'stats'} />
      {body}
    </div>
  );
});

export function Terminal({ session }: { session: Session }) {
  const clipRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const vers = useRef(new Map<string, number>());
  const mounted = useRef(false);
  /* 挂上以后才来的行（add 事件）。挂上时就有的行、开头补进来的行（seed）不算 */
  const live = useRef(new Set<string>());
  /* 提交的序号，和每一行第一次画出来是第几次提交（见下面的上推） */
  const commitNo = useRef(0);
  const bornAt = useRef(new Map<string, number>());
  /* 滚动：停在底部（新内容贴底）还是往上翻着；往上翻着时离开底部那一刻行区域的高度（之后长高了就是来了新内容）；
     视野里第一行的位置（行 id 和它离视口顶边多远，保持它不动）；「回到最新」的平滑滚动 */
  const stick = useRef(true);
  const leftAt = useRef<number | null>(null);
  const anchor = useRef<{ id: string; off: number } | null>(null);
  const jump = useRef<{ stop: () => void } | null>(null);
  const lastTop = useRef(0);
  const userAt = useRef(-1e9);
  const pressed = useRef(false);
  const [away, setAway] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const lines = session.lines;
  /* 可以放行的高度（去掉上下的内边距）和上内边距（虚拟器的 scrollMargin：行区域从这里开始） */
  const [view, setView] = useState({ h: 300, top: 0, bottom: 0 });
  const viewH = view.h;
  const geom = useRef(view);
  geom.current = view;
  const virt = useVirtualizer({
    count: lines.length,
    getScrollElement: () => clipRef.current,
    estimateSize: () => 22,
    gap: 2,
    /* 只画视野附近的行，多画 OVERSCAN 行。从胶囊展开、打开全屏时拿到的是挂上那一刻的画面：虚拟器的位置只靠滚动事件更新，
       事件要到下一帧才来，所以第一次渲染时就得把位置定在底部（initialOffset 给一个超过总高的数，它会画最后的那些行），
       不然副本里底部是空的，要等滚动事件来了才补上 */
    overscan: OVERSCAN,
    initialOffset: () => 1e9,
    getItemKey: (i) => lines[i]?.id ?? i,
    initialRect: { width: 400, height: 300 },
    scrollMargin: view.top,
  });
  useEffect(() => {
    const off = nowModel.sub((type, convId, line) => {
      if (convId !== session.convId) return;
      if (type === 'add' && line) live.current.add(line.id);
      if (type === 'add' || type === 'seed' || type === 'reset') {
        bump((n) => n + 1);
      } else if (type === 'update' && line) {
        vers.current.set(line.id, (vers.current.get(line.id) || 0) + 1);
        bump((n) => n + 1);
      }
    });
    return off;
  }, [session.convId]);
  useLayoutEffect(() => {
    const clip = clipRef.current!;
    const measure = () => {
      const cs = getComputedStyle(clip);
      const top = parseFloat(cs.paddingTop) || 0,
        bottom = parseFloat(cs.paddingBottom) || 0;
      const h = Math.max(0, clip.clientHeight - top - bottom);
      setView((v) => (v.h === h && v.top === top && v.bottom === bottom ? v : { h, top, bottom }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(clip);
    measure();
    mounted.current = true;
    /* 虚拟器的位置只靠滚动事件更新：滚动范围是 0（内容放得下）时挂上以后不会有滚动事件，它还停在 initialOffset 那个超过总高的数上，
       只画最后的 OVERSCAN 行。下一帧补发一次，让它读到真实的滚动位置 */
    const sync = requestAnimationFrame(() => clip.dispatchEvent(new Event('scroll')));
    /* 「回到最新」浮在窗格的下浮层里（在内容和底部的渐进模糊上面，@luoli/ui/scroll 的 Pane 的 .ll-pane-bot） */
    setHost(clip.parentElement?.querySelector<HTMLElement>(':scope > .ll-pane-bot') ?? null);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(sync);
    };
  }, []);
  const total = virt.getTotalSize();
  const pad = Math.max(0, viewH - total);
  /* 能滚到的最底下：用行区域自己的高度算，不用 scrollHeight。上推动画正在进行时行区域带着 translateY，scrollHeight 把这段平移也算进去，
     再次渲染时会多滚下去一截，和上推抵消，看上去新行直接就到位了 */
  const bottomTop = () => {
    const clip = clipRef.current;
    if (!clip) return 0;
    const rows = rowsRef.current;
    const content = rows
      ? rows.offsetHeight + geom.current.top + geom.current.bottom
      : clip.scrollHeight;
    return Math.max(0, content - clip.clientHeight);
  };
  const push = useRef<Animation | null>(null);
  /* 滚动：停在底部还是往上翻着，只由用户的操作改（滚轮、触摸、按键、拖滚动条：操作后 USER_MS 内，或者鼠标还按着）：
     往上滚（哪怕离底还没到 STICK_PX，不然慢慢往上拖时每次渲染都被钉回底部）就是离开，向下滚到离底小于 STICK_PX 就是回到底部。
     程序自己滚的（贴底、保持视野里的行不动、内容变矮浏览器夹住滚动位置）不改它，不然往上翻着时补回来的那一点会把人又钉回去 */
  /* 往上翻着：记下视野里第一行（浮着的头部下面露出来的第一行）的位置，之后保持它不动。每次滚动、每次提交都要重记 */
  const captureAnchor = () => {
    const clip = clipRef.current;
    anchor.current = null;
    if (!clip || stick.current) return;
    const edge = clip.scrollTop + geom.current.top;
    for (let i = 0; i < lines.length; i++) {
      const m = virt.measurementsCache[i];
      if (m && m.end > edge) {
        anchor.current = { id: lines[i].id, off: m.start - clip.scrollTop };
        return;
      }
    }
  };
  const onScroll = () => {
    const clip = clipRef.current!;
    const top = clip.scrollTop;
    /* 和上次记下的一样：是程序自己滚的（贴底、补回视野里的行的位置），不是用户 */
    if (Math.abs(top - lastTop.current) < 0.5) return;
    const up = top < lastTop.current;
    lastTop.current = top;
    if (jump.current) return;
    /* 用户的鼠标滚轮缓动在走也算用户在滚：滑行要 0.3 秒以上，最后一个滚轮事件过了 USER_MS 以后的滚动事件不能当成程序自己滚的 */
    const byUser =
      pressed.current || performance.now() - userAt.current < USER_MS || isWheeling(clip);
    if (byUser) {
      const near = bottomTop() - top < STICK_PX;
      const next = up ? false : near ? true : stick.current;
      if (next !== stick.current) {
        stick.current = next;
        if (next) {
          leftAt.current = null;
          setAway(false);
        } else {
          leftAt.current = rowsRef.current?.offsetHeight ?? 0;
          push.current?.cancel(); /* 往上翻了：还没推完的上推停下，行区域回到原位 */
        }
      }
    }
    captureAnchor();
  };
  const touch = () => {
    userAt.current = performance.now();
  };
  useEffect(() => {
    const up = () => {
      pressed.current = false;
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);
  /* 点「回到最新」：平滑滚到底，恢复贴底。滚的途中内容还在长，每一帧重算目标；用户自己操作（滚轮、点按、触摸、按键）就放手 */
  const toLatest = () => {
    const clip = clipRef.current!;
    jump.current?.stop();
    cancelWheel(clip); // 程序要自己滚了：没走完的滚轮距离清掉
    stick.current = true;
    leftAt.current = null;
    setAway(false);
    if (!motionOn()) {
      clip.scrollTop = bottomTop();
      return;
    }
    const from = clip.scrollTop;
    const t0 = performance.now();
    let raf = 0;
    const events = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const e of events) clip.removeEventListener(e, onUser);
      if (jump.current?.stop === stop) jump.current = null;
    };
    const onUser = () => {
      stop();
      onScroll();
    };
    for (const e of events) clip.addEventListener(e, onUser, { passive: true });
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / JUMP_MS);
      const ease = 1 - (1 - k) ** 3;
      clip.scrollTop = from + (bottomTop() - from) * ease;
      if (k < 1) raf = requestAnimationFrame(step);
      else {
        stop();
        clip.scrollTop = bottomTop();
      }
    };
    jump.current = { stop };
    raf = requestAnimationFrame(step);
  };
  useEffect(() => () => jump.current?.stop(), []);
  /* 末尾来了新行、末尾的行变长时，先把整体往下挪回去，再用 .3 秒推到原位（平滑上推）。
     总高变了不一定是它（挂载后第一次量出真实行高、开头补进较早的行、窗口宽度变化引起折行变化），这些不推：
     推多少按行算，规则和原因见 push.ts。窗口宽度变了以后 RESIZE_QUIET_MS 内的变高也不推（折行变化是分几次量出来的）。
     往上翻着时不推（新内容在看不到的地方） */
  const prevSizes = useRef(new Map<string, number>());
  const prevWidth = useRef(-1);
  const quietUntil = useRef(0);
  useLayoutEffect(() => {
    const clip = clipRef.current!;
    const rows = rowsRef.current;
    const stuck = stick.current;
    const before = clip.scrollTop;
    if (stuck) {
      /* 贴底（「回到最新」的平滑滚动途中由它自己滚） */
      if (!jump.current) clip.scrollTop = bottomTop();
    } else if (anchor.current) {
      /* 往上翻着：视野里的行不跳——开头补进来的行、最前面的行被挤掉、上面的行量出真实高度，都会让它的位置变，把滚动位置补回去 */
      const i = lines.findIndex((l) => l.id === anchor.current!.id);
      const m = i >= 0 ? virt.measurementsCache[i] : undefined;
      if (m) {
        const d = m.start - clip.scrollTop - anchor.current.off;
        if (Math.abs(d) > 0.5) clip.scrollTop += d;
      }
    }
    /* 程序自己改了滚动位置：记下，onScroll 里才不会把它当成用户往上滚（用户往上滚还没来得及处理的，不能记下来） */
    if (clip.scrollTop !== before) lastTop.current = clip.scrollTop;
    const no = commitNo.current++;
    const now = performance.now();
    const width = clip.clientWidth;
    if (prevWidth.current >= 0 && Math.abs(width - prevWidth.current) > 0.5)
      quietUntil.current = now + RESIZE_QUIET_MS;
    prevWidth.current = width;
    const sizes = new Map<string, number>();
    lines.forEach((l, i) => sizes.set(l.id, virt.measurementsCache[i]?.size ?? 0));
    const dy = pushAmount({
      ids: lines.map((l) => l.id),
      sizes,
      prev: prevSizes.current,
      live: live.current,
      born: bornAt.current,
      no,
      gap: virt.options.gap,
    });
    prevSizes.current = sizes;
    for (const k of bornAt.current.keys()) if (!sizes.has(k)) bornAt.current.delete(k);
    for (const k of live.current) if (!sizes.has(k)) live.current.delete(k);
    if (
      dy > 0.5 &&
      stuck &&
      now >= quietUntil.current &&
      motionOn() &&
      rows &&
      clip.isConnected &&
      mounted.current
    ) {
      /* 和第 4.1 版一样：从「此刻还没推完的偏移」再加上这次变高的量出发，推回 0。
         不能直接从 dy 开始：新行先按估计的高度挂上、量出真高度后又变一次，后一次的动画会顶掉前一次，整行的上推就只剩下零头 */
      const cur = new DOMMatrixReadOnly(getComputedStyle(rows).transform).m42 || 0;
      push.current?.cancel();
      push.current = rows.animate(
        [{ transform: `translateY(${cur + dy}px)` }, { transform: 'translateY(0px)' }],
        { duration: PUSH_MS, easing: EASE_OUT_CSS },
      );
    }
    captureAnchor();
    /* 下面有新内容：离开底部以后行区域长高了 */
    const grown =
      !stuck && leftAt.current !== null && (rows?.offsetHeight ?? 0) - leftAt.current > 1;
    setAway((v) => (v === grown ? v : grown));
  });
  const items = virt.getVirtualItems();
  return (
    <>
      <div
        className="term ll-pane-sc"
        ref={clipRef}
        role="log"
        aria-live="polite"
        aria-label="实时对话"
        data-conv={session.convId}
        onScroll={onScroll}
        onWheel={touch}
        onTouchMove={touch}
        onPointerDown={() => {
          pressed.current = true;
          touch();
        }}
        onKeyDown={touch}
      >
        <div
          className="term-rows"
          ref={rowsRef}
          style={{
            position: 'relative',
            height: Math.max(total, viewH),
            left: 'auto',
            right: 'auto',
            bottom: 'auto',
            display: 'block',
          }}
        >
          {items.map((v) => {
            const line = lines[v.index];
            if (!line) return null;
            const isNew = !animated.has(line.id) && mounted.current;
            animated.add(line.id);
            if (!bornAt.current.has(line.id)) bornAt.current.set(line.id, commitNo.current);
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virt.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${v.start - view.top + pad}px)`,
                }}
              >
                <TermLine
                  line={line}
                  ver={vers.current.get(line.id) || 0}
                  isNew={isNew}
                  convId={session.convId}
                />
              </div>
            );
          })}
        </div>
      </div>
      {host &&
        away &&
        createPortal(
          <div className="term-jump-wrap">
            <Button variant="glass" className="term-jump" onClick={toLatest}>
              回到最新
              <Chevron dir="down" />
            </Button>
          </div>,
          host,
        )}
    </>
  );
}
