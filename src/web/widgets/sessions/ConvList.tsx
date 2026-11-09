import { memo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { DUR_VANISH, EASE_OUT } from '../../lib/easing';
import { usePrefs } from '../../lib/prefs';
import { morphStore } from '../../shell/morph';
import { fmtShort } from '../../lib/util';
import { db } from '../../model/db';
import { status } from '../../model/status';
import { useAssistantName } from '../../model/who';
import { useGlide } from '../../components/glide';
import type { Conversation, ConvKind } from '../../model/types';

/* 会话行：左边 34px 的圆角方块图标，中间标题和最近一条消息预览，右边时间和未读数 */
export const KIND_TEXT: Record<ConvKind, string> = {
  group: '群',
  private: '私',
  cli: '>_',
  web: '网',
  other: '·',
};
export const KIND_LABEL: Record<ConvKind, string> = {
  group: 'Telegram 群',
  private: 'Telegram 私聊',
  cli: 'CLI',
  web: '网页',
  other: '其他',
};

const ConvRow = memo(function ConvRow({
  conv,
  selected,
  rev,
  onPick,
}: {
  conv: Conversation;
  selected?: boolean;
  rev: number;
  onPick: (id: string) => void;
}) {
  void rev;
  useAssistantName(); // 助手的名字变了，预览里的名字跟着变
  const n = conv.unread;
  const last = db.previewOf(conv) || '还没有消息';
  const st = status.conv.get(conv.id);
  const time = st ? (st.state === 'error' ? '出错' : '回复中…') : fmtShort(Date.parse(conv.lastAt));
  return (
    <button
      className={'conv-item' + (n > 0 ? ' has-new' : '')}
      type="button"
      aria-current={selected === undefined ? undefined : selected}
      aria-label={`${conv.title}，${n ? n + ' 条新消息，' : ''}${last}`}
      onClick={() => onPick(conv.id)}
    >
      <span className="conv-ico" data-p={conv.kind} aria-hidden="true">
        {KIND_TEXT[conv.kind] || '群'}
      </span>
      <span className="conv-main">
        <span className="conv-title">{conv.title}</span>
        <span className={'conv-last' + (conv.last?.event ? ' is-event' : '')}>{last}</span>
      </span>
      <span className="conv-side">
        <span
          className="conv-time"
          style={st ? { color: st.state === 'error' ? 'var(--err)' : 'var(--gold)' } : undefined}
        >
          {time}
        </span>
        <span className="conv-unread">{n ? (n > 99 ? '99+' : String(n)) : ''}</span>
      </span>
    </button>
  );
});

/* 全屏窗口在放大的过程中，列表行的 layout 投影会让整个窗口每帧重新栅格（第一次进全屏的头 400 ms 掉到 12–20 ms 一帧）。
   所以挂载在全屏形变里的列表先不开 layout，形变结束后再开；平时（桌面、形变之外挂载）照常开 */
function useLayoutAfterMorph(motionOn: boolean) {
  const [lateOn, setLateOn] = useState(() => !document.body.classList.contains('fs-open'));
  useEffect(() => {
    if (lateOn) return;
    let seen = false;
    const check = () => {
      const busy = morphStore.get().list.some((m) => !m.dead && m.host === 'fs');
      if (busy) seen = true;
      else if (seen) {
        off();
        setLateOn(true);
      }
    };
    const off = morphStore.subscribe(check);
    const t = setTimeout(() => {
      off();
      setLateOn(true);
    }, 1500);
    return () => {
      off();
      clearTimeout(t);
    };
  }, [lateOn]);
  return motionOn && lateOn;
}

/* 列表：新条目进入（高度 0 → 实际高度、淡入、从左 −16px 滑入，420 ms）；删掉的条目收起（高度 → 0、淡出、向右 16px，320 ms ease-in）；
   顺序变了位移 FLIP 420 ms；首次渲染和动画关掉时无动画。
   列表自己是窗格的滚动区（.pane-sc）；悬停时一块高亮跟着鼠标从一行滑到另一行（components/glide.ts） */
export function ConvList({
  convs,
  selectedId,
  onPick,
  rev,
  label,
  empty,
}: {
  convs: Conversation[];
  selectedId?: string | null;
  onPick: (id: string) => void;
  rev: number;
  label: string;
  empty?: React.ReactNode;
}) {
  const motionOn = usePrefs((p) => p.motion);
  const layoutOn = useLayoutAfterMorph(motionOn);
  const g = useGlide('.conv-item');
  return (
    <div
      className="list pane-sc"
      role="list"
      aria-label={label}
      ref={(el) => {
        g.list.current = el;
      }}
    >
      <i className="glide" ref={(el) => void (g.glide.current = el)} aria-hidden="true" />
      <AnimatePresence initial={false}>
        {convs.map((c) => (
          <motion.div
            key={c.id}
            layout={layoutOn ? 'position' : false}
            className="li-wrap"
            role="listitem"
            data-id={c.id}
            initial={motionOn && !db.bulk.has(c.id) ? { height: 0, opacity: 0, x: -16 } : false}
            animate={{ height: 'auto', opacity: 1, x: 0 }}
            exit={
              motionOn
                ? {
                    height: 0,
                    opacity: 0,
                    x: 16,
                    transition: { duration: DUR_VANISH / 1000, ease: 'easeIn' },
                  }
                : { opacity: 0, transition: { duration: 0 } }
            }
            transition={{
              duration: 0.42,
              ease: EASE_OUT,
              layout: { duration: 0.42, ease: EASE_OUT },
            }}
          >
            <ConvRow
              conv={c}
              selected={selectedId === undefined ? undefined : c.id === selectedId}
              rev={rev}
              onPick={onPick}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      {!convs.length && empty}
    </div>
  );
}
/* 有新用户消息进来的行，整行亮一下（1.4 秒，金色底和外圈淡出） */
export function lightUp(convId: string) {
  if (!usePrefsMotion()) return;
  for (const b of document.querySelectorAll(`.li-wrap[data-id="${convId}"] > .conv-item`)) {
    b.classList.remove('is-lit');
    void (b as HTMLElement).offsetWidth;
    b.classList.add('is-lit');
  }
}
import { motionOn as usePrefsMotion } from '../../lib/prefs';
