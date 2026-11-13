import { useMemo } from 'react';
import { env } from '@luoli/ui/env';
import { rand } from '@luoli/ui/util';

/* 小星空：「此刻」自己的夜空，文字直接浮在上面。数量普通大小 26 颗、全屏 48 颗（性能低 ×0.6） */
export function MiniSky({ n }: { n: number }) {
  const stars = useMemo(() => {
    const m = Math.round(n * (env.lowPower ? 0.6 : 1));
    return Array.from({ length: m }, () => ({
      left: rand(0, 100).toFixed(1) + '%',
      top: rand(0, 100).toFixed(1) + '%',
      '--s': rand(1, 2.6).toFixed(1) + 'px',
      '--o': rand(0.2, 0.75).toFixed(2),
      '--dx': rand(-14, 14).toFixed(0) + 'px',
      '--dy': rand(-10, 6).toFixed(0) + 'px',
      '--t1': rand(16, 30).toFixed(0) + 's',
      '--t2': rand(3, 7).toFixed(1) + 's',
      '--l1': -rand(0, 20).toFixed(1) + 's',
      '--l2': -rand(0, 6).toFixed(1) + 's',
    }));
  }, [n]);
  return (
    <div className="msky" aria-hidden="true">
      {stars.map((st, i) => (
        <i key={i} style={st} />
      ))}
    </div>
  );
}
