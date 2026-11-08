import { useEffect, useState } from 'react';
import { Energy, Roll } from '../../components/Roll';
import { bus } from '../../model/bus';
import { db } from '../../model/db';
import { IconToday } from '../../components/icons';
import type { ViewProps, WidgetDef } from '../types';

/* 今日概况：演示「新增部件」，运行时才注册。数字来源是模拟的模型调用表（db.today()） */
function TodayView({ mode }: ViewProps) {
  const full = mode === 'full';
  const [s, setS] = useState(() => ({
    replies: 0,
    failed: 0,
    input: 0,
    cache: 0,
    output: 0,
    per: new Map<string, number>(),
  }));
  /* 打开 80 ms 后取数，数字从 0 滚上来；每次 reply:end/error/abort 刷新 */
  useEffect(() => {
    const t = setTimeout(() => setS(db.today()), 80);
    const update = () => setS(db.today());
    const offs = (['reply:end', 'reply:error', 'reply:abort'] as const).map((x) =>
      bus.on(x, update),
    );
    return () => {
      clearTimeout(t);
      offs.forEach((f) => f());
    };
  }, []);
  const hit = s.input ? s.cache / s.input : 0;
  const failRate = s.replies + s.failed ? s.failed / (s.replies + s.failed) : 0;
  if (!full) {
    return (
      <div className="today">
        <div className="today-hero">
          <Roll value={s.replies} />
          <span>次回复</span>
        </div>
        <div className="stat-row">
          <span>token</span>
          <span>
            输入{' '}
            <b>
              <Roll value={s.input} />
            </b>{' '}
            · 输出{' '}
            <b>
              <Roll value={s.output} />
            </b>
          </span>
        </div>
        <div className="stat">
          <div className="stat-row">
            <span>缓存命中率</span>
            <b>
              <Roll value={hit * 100} fmt={(v) => v.toFixed(1) + '%'} />
            </b>
          </div>
          <Energy value={hit} label="缓存命中率" />
        </div>
        <div className="stat">
          <div className="stat-row">
            <span>失败</span>
            <span>
              <b>
                <Roll value={s.failed} />
              </b>{' '}
              次
            </span>
          </div>
          <Energy value={failRate} bad label="失败率" />
        </div>
      </div>
    );
  }
  const rows = [...s.per]
    .map(([id, n]) => [db.conv(id), n] as const)
    .filter((x) => x[0])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  const max = rows.length ? rows[0][1] : 1;
  return (
    <div className="today" style={{ padding: '20px 24px', gap: 22 }}>
      <div className="today-grid">
        <div className="tile">
          <small>今天的回复</small>
          <Roll value={s.replies} />
        </div>
        <div className="tile">
          <small>输入 token</small>
          <Roll value={s.input} />
        </div>
        <div className="tile">
          <small>输出 token</small>
          <Roll value={s.output} />
        </div>
        <div className="tile">
          <small>缓存命中率</small>
          <Roll value={hit * 100} fmt={(v) => v.toFixed(1) + '%'} />
          <Energy value={hit} label="缓存命中率" />
        </div>
        <div className="tile">
          <small>失败</small>
          <Roll value={s.failed} />
          <Energy value={failRate} bad label="失败率" />
        </div>
      </div>
      <div className="stat">
        <div className="stat-row">
          <b>各会话今天的回复</b>
        </div>
        <div className="per-conv">
          {!rows.length && (
            <div className="empty" style={{ margin: 0 }}>
              今天还没有回复
            </div>
          )}
          {rows.map(([c, n]) => (
            <div className="per-row" key={c!.id}>
              <span>{c!.title}</span>
              <Energy value={n / max} label={c!.title} />
              <span>
                <Roll value={n} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
export const TODAY_DEF: WidgetDef = {
  id: 'today',
  name: '今日概况',
  icon: IconToday,
  defaultSize: '1x1',
  refreshOn: ['reply:end', 'reply:error', 'reply:abort', 'data:reset'],
  thumb: () => (
    <>
      今天 <em>{db.today().replies}</em> 次回复
    </>
  ),
  View: TodayView,
};
