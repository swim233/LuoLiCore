import { useEffect, useLayoutEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { motionOn } from '../lib/prefs';

/* 虚拟滚动的时间线：@tanstack/react-virtual，动态高度，贴底。
   切换会话（resetKey 变）直接到底；新条目进来时如果本来就在底部附近（距底 < 80px）就平滑跟到底（动画开着时）；
   内容变高（逐字、折叠展开）时，原本贴底的继续贴底。 */
export interface LogItem {
  key: string;
  node: React.ReactNode;
  est?: number;
}
export function VirtualLog({
  items,
  resetKey,
  label,
  live,
  children,
}: {
  items: LogItem[];
  resetKey: string | null;
  label: string;
  live?: boolean;
  children?: React.ReactNode;
}) {
  const scRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scRef.current,
    estimateSize: (i) => items[i]?.est ?? 70,
    gap: 10,
    overscan: 6,
    getItemKey: (i) => items[i]?.key ?? i,
    initialRect: { width: 600, height: 500 },
  });
  const nearBottom = () => {
    const c = scRef.current;
    return !c || c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  };
  const stick = useRef(true);
  const lastKey = useRef<string | null | undefined>(undefined);
  const prevCount = useRef(0);
  useLayoutEffect(() => {
    const c = scRef.current;
    if (!c) return;
    const switched = lastKey.current !== resetKey;
    lastKey.current = resetKey;
    if (switched) {
      stick.current = true;
      if (items.length) virt.scrollToIndex(items.length - 1, { align: 'end' });
      requestAnimationFrame(() => {
        if (items.length) virt.scrollToIndex(items.length - 1, { align: 'end' });
        c.scrollTop = c.scrollHeight;
      });
    } else if (items.length !== prevCount.current && stick.current && items.length) {
      virt.scrollToIndex(items.length - 1, {
        align: 'end',
        behavior: motionOn() ? 'smooth' : 'auto',
      });
    }
    prevCount.current = items.length;
  });
  const total = virt.getTotalSize();
  useEffect(() => {
    const c = scRef.current;
    if (c && stick.current) c.scrollTop = c.scrollHeight;
  }, [total]);
  return (
    <div
      className="tline"
      ref={scRef}
      role="log"
      aria-label={label}
      aria-live={live ? 'polite' : undefined}
      onScroll={() => {
        stick.current = nearBottom();
      }}
      style={{ display: 'block' }}
    >
      <div style={{ position: 'relative', height: total, width: '100%' }}>
        {virt.getVirtualItems().map((v) => {
          const it = items[v.index];
          if (!it) return null;
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
                transform: `translateY(${v.start}px)`,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {it.node}
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}
