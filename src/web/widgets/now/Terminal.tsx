import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Hl, Spin } from '../../components/Hl';
import { Pic } from '../../components/Pic';
import { STAR_SVG, StreamText } from '../../components/stream';
import { EASE_OUT_CSS } from '../../lib/easing';
import { motionOn } from '../../lib/prefs';
import { fmtTime } from '../../lib/util';
import { colorOf, useAssistantName } from '../../model/who';
import { nowModel } from '../../model/nowModel';
import type { Line, Session } from '../../model/nowModel';

/* 「此刻」的终端：用户逐项拼出来的样式。一行：23:37 小明 › 正文；洛璃的回复 ✦（内联 SVG 的四角星）、工具调用 ◇、状态行 ·；
   洛璃的行带一层淡淡的底；新行进来时整体平滑上推，最上面的行滚到浮着的头部下面，在那里糊掉。
   终端自己是窗格的滚动区（.pane-sc，不能往回滚，overflow: hidden，一直贴底），上下的内边距里是浮着的头部和底边的留白。
   行用 @tanstack/react-virtual 排（动态高度、贴底，终端不能往回滚）；逐字落下的那一行是命令式的小岛（stream.ts） */
const SYM: Record<string, string> = { user: '›', tool: '◇', status: '·', think: '·', stats: '' };
const islands = new Map<string, Set<StreamText>>();
const animated = new Set<string>(); // 已经放过淡入的行：虚拟滚动把它重新挂上时不重放

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
        <span className="tl-sym" dangerouslySetInnerHTML={{ __html: STAR_SVG }} />
      ) : (
        <span className="tl-sym">{SYM[line.kind]}</span>
      )}
    </span>
  );
}

function StreamBody({
  line,
  convId,
  onSettled,
}: {
  line: Line;
  convId: string;
  onSettled: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  /* 这个实例自己的小岛。同一行可能同时挂在两处（浮起的卡片和全屏里的列），按行 id 登记一组，各管各的 */
  const mine = useRef<StreamText | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const st = new StreamText(el, line.text || '', convId);
    mine.current = st;
    let group = islands.get(line.id);
    if (!group) islands.set(line.id, (group = new Set()));
    group.add(st);
    let cancel = () => {};
    if (!line.streaming) {
      /* 已经出完了（挂上来时就结束）：光标停到 lingerUntil，再淡出，换成静态文字 */
      const wait = Math.max(0, (line.lingerUntil || Date.now()) - Date.now());
      cancel = st.finish(wait, 500, onSettled);
    }
    return () => {
      cancel();
      group.delete(st);
      if (!group.size) islands.delete(line.id);
      mine.current = null;
      el.textContent = '';
    };
  }, []);
  /* 流结束（streaming 从真变假）：同样处理 */
  const was = useRef(line.streaming);
  useEffect(() => {
    if (was.current && !line.streaming) {
      const st = mine.current;
      if (st) {
        const wait = Math.max(0, (line.lingerUntil || Date.now()) - Date.now());
        const c = st.finish(wait, 500, onSettled);
        was.current = false;
        return c;
      }
    }
    was.current = line.streaming;
  });
  return <span className="tl-body" ref={ref} />;
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
        <span className="chev" aria-hidden="true" />
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
          <Hl text={line.text || ''} hits={false} />
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
        <Spin />
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
  const lines = session.lines;
  /* 可以放行的高度（去掉上下的内边距）和上内边距（虚拟器的 scrollMargin：行区域从这里开始） */
  const [view, setView] = useState({ h: 300, top: 0, bottom: 0 });
  const viewH = view.h;
  const virt = useVirtualizer({
    count: lines.length,
    getScrollElement: () => clipRef.current,
    estimateSize: () => 22,
    gap: 2,
    overscan: 12,
    getItemKey: (i) => lines[i]?.id ?? i,
    initialRect: { width: 400, height: 300 },
    scrollMargin: view.top,
  });
  useEffect(() => {
    const off = nowModel.sub((type, convId, line, extra) => {
      if (convId !== session.convId) return;
      if (type === 'add' || type === 'seed' || type === 'reset') {
        bump((n) => n + 1);
      } else if (type === 'delta') {
        if (line) islands.get(line.id)?.forEach((st) => st.delta(extra ?? '', line.text || ''));
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
    return () => ro.disconnect();
  }, []);
  const total = virt.getTotalSize();
  const pad = Math.max(0, viewH - total);
  /* 贴底；内容变高时先把整体往下挪回去，再用 .3 秒推到原位（平滑上推） */
  const prevTotal = useRef(total);
  const push = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const clip = clipRef.current!;
    /* 贴底：用行区域自己的高度算，不用 scrollHeight。上推动画正在进行时行区域带着 translateY，scrollHeight 把这段平移也算进去，
       再次渲染时会多滚下去一截，和上推抵消，看上去新行直接就到位了 */
    clip.scrollTop = Math.max(
      0,
      (rowsRef.current
        ? rowsRef.current.offsetHeight + view.top + view.bottom
        : clip.scrollHeight) - clip.clientHeight,
    );
    const dy = total - prevTotal.current;
    prevTotal.current = total;
    if (dy > 0.5 && motionOn() && rowsRef.current && clip.isConnected && mounted.current) {
      /* 和第 4.1 版一样：从「此刻还没推完的偏移」再加上这次变高的量出发，推回 0。
         不能直接从 dy 开始：新行先按估计的高度挂上、量出真高度后又变一次，后一次的动画会顶掉前一次，整行的上推就只剩下零头 */
      const el = rowsRef.current;
      const cur = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 || 0;
      push.current?.cancel();
      push.current = el.animate(
        [{ transform: `translateY(${cur + dy}px)` }, { transform: 'translateY(0px)' }],
        { duration: 300, easing: EASE_OUT_CSS },
      );
    }
  });
  const items = virt.getVirtualItems();
  return (
    <div
      className="term pane-sc"
      ref={clipRef}
      role="log"
      aria-live="polite"
      aria-label="实时对话"
      data-conv={session.convId}
      style={{ overflow: 'hidden' }}
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
  );
}
