import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Star4 } from '../icons';
import { motionOn } from '../motion';
import type { ChatLabels } from './labels';
import { Markdown } from './Markdown';
import { IncrementalLexer } from './markdown';
import { hiddenTail, linkTailSpans, settleMarkdown } from './stream-md';
import { advanceCp, cpLen, cpSpans, DROP_MS, Pacer, Spans, trimBatches } from './typing';
import type { Batch } from './typing';

/* 正在逐字输出的回复：光标打字。气泡里正在出的回复、终端里正在说的那一行用的是同一个。
   - 到达的文字排成一条队（lib/typing.ts 的 Pacer），一个字一个字轮到：每个字的开始时刻 = max(到达的时刻, 上一个字的开始时刻 + 间隔)，
     间隔平时 28 ms，来得快时缩短，显示最多落后到达约 0.3 秒。轮到的字才出现；没轮到的字不进 DOM、不占位置；
   - 已经出现的部分按 Markdown 排版（Markdown.tsx）：换行（breaks）逐字时就显示；排版只往前走，已经显示出来的字和块不因为
     后面的字到了而变回别的样子（lib/stream-md.ts 把放出来的文字改一遍再分析：行首还看不出是什么的符号先不显示，
     没写完的加粗、行内代码、删除线、链接一出现就是最终的样子，符号和网址不露出来；到这一行结束都没闭合的变回原样）。
     被压住的字照样算放出（光标停在上一个显示出来的字后面）；链接的网址不占时间（Pacer 的 free）；
     回复结束、全部放完以后用原文，不再改（结束那一下没闭合的写法变回原样，允许变一次）；
   - 光标是 tail：紧跟在最后一个出现的字后面，不管它在段落、列表项、表格还是代码块里。光标不占宽度，有没有它折行都一样；
   - 每个字各自轻轻落下（Fresh.tsx）：近 0.3 秒内出现的字各包一个行内 span，每个字的落下从它自己的开始时刻起，落完就是普通文字。
     新到的字接在队尾，不从头数，所以同一时刻只有末尾这一段在落、只有一个波前；
   - 回复结束后先把队列里剩下的字照这个节奏落完（最后一个字出现时调 onRevealed：星尘从光标散开），光标再停一阵
     （正常结束 2 秒，中止、出错 0.3 秒；lingerUntil 是结束的时刻加这么久），淡出，
     换成不带光标的 Markdown：同一份 DOM 只是去掉光标，排版不变，高度不变；
   - 关掉动画（motionOn 为假）：不排队、不落下，到了就显示，光标照旧在末尾；
   - 文字不是接着往后写的（这一步重新生成了、换成历史里存的文字）：直接放到头，不播。
   同一行同时挂在两处时各挂各的，各自按全文放，互不干扰。 */
const FADE_MS = 500;
/** 开始时刻和这一批的第一个字相差不到这么多的相邻字，包在同一个 span 里。不到一帧（144 Hz 下 6.9 ms）：这几个字本来就在同一帧出现，
 *  落下的起点最多差 8 ms（top 差不到半个像素），看不出来；好处是追赶（间隔缩到 1 ms）、切回标签页时一帧里的 span 少几倍 */
const MERGE_MS = 8;

/** 取这一处现在的光标：最后一个字出现时，用的项目（面板的星尘）按它在页面上的位置放特效 */
export type CursorRef = () => HTMLElement | null;

/* 光标：<span class="ll-cursor" data-stream=这一处的标识><svg class="ll-cursor-star"/></span>。
   用的项目要按「这一处看得见的光标」找它时，靠这三样（类名 ll-cursor、属性 data-stream、里面那颗星 ll-cursor-star）；gone（淡出中）时带 data-gone */
export function Cursor({
  streamId,
  gone,
  elRef,
}: {
  streamId: string;
  gone: boolean;
  elRef?: Ref<HTMLSpanElement>;
}) {
  return (
    <span
      className="ll-cursor"
      data-gone={gone ? '' : undefined}
      data-stream={streamId}
      aria-hidden="true"
      ref={elRef}
    >
      <Star4 className="ll-cursor-star" />
    </span>
  );
}

type Phase = 'live' | 'fade' | 'done';
interface Run {
  pacer: Pacer;
  /** 最新的全文，已经放出的部分是它的前 end 个 UTF-16 单位（pacer 数的是字，这里数的是单位，advanceCp 换算） */
  text: string;
  end: number;
  batches: Batch[];
  seq: number;
  raf: number;
  /** 回复已经结束，光标还要停多久（毫秒，从最后一个字出现算起） */
  ended: boolean;
  lingerMs: number;
  /** 最后一个字出现时已经通知过 onRevealed（挂上来时回复早就结束的不通知） */
  reported: boolean;
  timer: ReturnType<typeof setTimeout> | 0;
  lexer: IncrementalLexer;
  /** 已经到达的全文里不占放字时间的字（链接的网址） */
  free: Spans;
}

export function Typed({
  streamId,
  text,
  streaming,
  lingerUntil,
  onSettled,
  onRevealed,
  labels,
}: {
  /** 这一处逐字输出的标识（光标上的 data-stream） */
  streamId: string;
  text: string;
  streaming: boolean;
  lingerUntil: number;
  /** 光标淡出、换成静态的以后（挂上来时早就过了停留的时间也算） */
  onSettled?: () => void;
  /** 回复结束、最后一个字出现的那一刻（刚渲染完，光标已经在最后一个字后面）：回复正常完成时用它放星尘。每次回复只调一次；
   *  参数是取这一处光标的函数（星尘等画面画出来以后再量它的位置） */
  onRevealed?: (cursor: CursorRef) => void;
  /** 要换的话（复制、已复制……），传给里面的 Markdown，见 labels.ts */
  labels?: Partial<ChatLabels>;
}) {
  const run = useRef<Run | null>(null);
  if (!run.current) {
    run.current = {
      pacer: new Pacer(cpLen(text)),
      text,
      end: text.length,
      batches: [],
      seq: 0,
      raf: 0,
      ended: false,
      lingerMs: 0,
      reported: !streaming,
      timer: 0,
      lexer: new IncrementalLexer(),
      free: new Spans(),
    };
  }
  const r = run.current;
  const [view, setView] = useState<{ end: number; fresh: Batch[] }>({
    end: text.length,
    fresh: [],
  });
  /* 挂上来时回复早就结束、光标也停够了（虚拟列表把行重新挂上）：直接是静态的 */
  const [phase, setPhase] = useState<Phase>(
    !streaming && lingerUntil <= Date.now() ? 'done' : 'live',
  );
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const revealed = useRef(onRevealed);
  revealed.current = onRevealed;
  const cursorEl = useRef<HTMLSpanElement | null>(null);
  const getCursor = useRef<CursorRef>(() => cursorEl.current).current;
  const commit = () => setView({ end: r.end, fresh: r.batches });
  const stopTimer = () => {
    if (r.timer) clearTimeout(r.timer);
    r.timer = 0;
  };
  /* 队列放完、回复也结束了：光标再停 lingerMs，淡出，交给静态的 */
  const settle = () => {
    if (!r.ended || r.timer || r.pacer.pending > 0) return;
    r.timer = setTimeout(() => {
      setPhase('fade');
      r.timer = setTimeout(() => {
        r.timer = 0;
        setPhase('done');
        settled.current?.();
      }, FADE_MS);
    }, r.lingerMs);
  };
  /* 回复结束了、队列也放空了（最后一个字刚出现）：通知一次，光标开始计停留的时间 */
  const drained = () => {
    if (!r.ended || r.pacer.pending > 0) return;
    if (!r.reported) {
      r.reported = true;
      revealed.current?.(getCursor);
    }
    settle();
  };
  const tick = (now: number) => {
    r.raf = 0;
    const before = r.pacer.shown;
    const starts = r.pacer.advance(now, r.free);
    const released = r.pacer.shown - before; // 比 starts 多出来的是不占时间的字
    // 落完的字：和新出现的一起更新（没有新字时等全落完再清，不白白每帧重画）
    const cutoff = now - DROP_MS;
    const alive = r.batches.filter((b) => b.at > cutoff);
    if (released > 0) {
      r.end = advanceCp(r.text, r.end, released);
      for (const t of starts) {
        // 开始时刻早于 DROP_MS 以前的，落下的时间已经过完（切回标签页，一次轮到一大堆）：直接是普通文字，不建 span
        if (t <= cutoff) continue;
        const last = alive.at(-1);
        if (last && t - last.at < MERGE_MS) alive[alive.length - 1] = { ...last, n: last.n + 1 };
        else alive.push({ id: ++r.seq, n: 1, at: t });
      }
      r.batches = alive;
      commit();
    } else if (r.batches.length && !alive.length) {
      r.batches = [];
      commit();
    }
    if (r.pacer.pending > 0 || r.batches.length) r.raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (r.raf) return;
    r.raf = requestAnimationFrame(tick);
  };

  /* 新到的文字：进队列（关了动画、不是接着往后写的直接放到头） */
  useLayoutEffect(() => {
    const prev = r.text;
    if (text === prev) return;
    r.text = text;
    r.free = cpSpans(text, linkTailSpans(text));
    if (!text.startsWith(prev) || !motionOn()) {
      r.pacer.snap(cpLen(text));
      r.end = text.length;
      r.batches = [];
      commit();
      return;
    }
    r.pacer.arrive(cpLen(text), performance.now());
    kick();
  }, [text]);

  /* 每次渲染完：回复结束了、队列也放空了，就是最后一个字刚出现（光标已经在它后面） */
  useLayoutEffect(() => {
    drained();
  }, [view]);

  /* 回复结束（挂上来时就结束了也一样）：放完队列以后光标再停一阵；又开始了（重新生成）就取消 */
  useEffect(() => {
    if (streaming) {
      stopTimer();
      r.ended = false;
      r.reported = false;
      setPhase((p) => (p === 'live' ? p : 'live'));
      return;
    }
    if (!r.ended) {
      r.ended = true;
      r.lingerMs = Math.max(0, lingerUntil - Date.now());
    }
    if (phase === 'done') settled.current?.();
    else drained(); // 队列早就放空了就是现在；还有字没轮到的，等它们放完（上面的每次渲染完）
  }, [streaming]);

  useEffect(
    () => () => {
      if (r.raf) cancelAnimationFrame(r.raf);
      stopTimer();
    },
    [],
  );

  const shown = text.slice(0, Math.min(view.end, text.length));
  const cursor = useMemo(
    () => <Cursor streamId={streamId} gone={phase === 'fade'} elRef={cursorEl} />,
    [streamId, phase],
  );
  if (phase === 'done') return <Markdown text={text} labels={labels} />;
  // 回复结束、全部放完：用原文（和结束后的静态显示完全一样）；还在放的时候改一遍，排版只往前走
  const whole = !streaming && r.pacer.pending === 0;
  const lexed = r.lexer.lex(whole ? shown : settleMarkdown(shown));
  // 落下的动画对「显示出来的最后几个字」：末尾没显示的字（结尾的符号、压住的符号、换行）的时刻要去掉；
  // 链接的网址本来就不在时刻里（不占放字的时间）
  const hidden = hiddenTail(shown, lexed);
  const end = cpLen(shown);
  const fresh = trimBatches(view.fresh, hidden - r.free.count(end - hidden, end));
  return <Markdown text={shown} tokens={lexed} tail={cursor} fresh={fresh} labels={labels} />;
}
