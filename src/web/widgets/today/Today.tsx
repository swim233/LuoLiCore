import { useEffect, useState } from 'react';
import { Empty, Meter, Roll, Stat } from '@luoli/ui/controls';
import { bus } from '../../model/bus';
import { db } from '../../model/db';
import { link, useLinkPhase } from '../../model/link';
import { IconToday } from '../../components/icons';
import { Pane } from '../../components/Pane';
import type { TodaySummary } from '../../model/types';
import type { ViewProps, WidgetDef } from '../types';

/* 今日概况：数字来自服务算好的汇总（今天按服务器的时区，从当天 0 点算起；回复数只算回复，token 是回复加摘要）。
   打开时取一次（启动时已经在 db 里），之后服务推「今日概况变了」就换新的；服务器的日期变了（过了 0 点）由数据源重新取。 */
const zero = (): TodaySummary => ({
  date: '',
  timeZone: '',
  since: '',
  replies: 0,
  failedReplies: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  conversations: [],
});

function Notice({ phase }: { phase: 'loading' | 'down' }) {
  return (
    <Pane>
      <div className="today pane-sc">
        {phase === 'down' ? (
          <Empty title="连不上洛璃服务">连上后会自动恢复</Empty>
        ) : (
          <Empty title="加载中…" />
        )}
      </div>
    </Pane>
  );
}

function TodayView({ mode, handle }: ViewProps) {
  const full = mode === 'full';
  const phase = useLinkPhase();
  const [t, setT] = useState<TodaySummary>(zero);
  /* 打开 80 ms 后放进数字，数字从 0 滚上来；之后每次服务推来新的汇总就换。
     这个部件自己正在形变（从胶囊展开、打开全屏）时，形变期间看到的是挂上那一刻的画面，数字要等形变结束再放，用户才看得到从 0 滚完的整段；
     等的时候服务推来新的汇总不用记：放进去的那一刻读的就是最新的（db.today） */
  useEffect(() => {
    let landed = false;
    let offMorph: (() => void) | undefined;
    const take = () => {
      if (db.today) setT(db.today);
    };
    const timer = setTimeout(() => {
      offMorph = handle.afterMorph(() => {
        landed = true;
        take();
      });
    }, 80);
    const off = bus.on('today:update', () => landed && take());
    return () => {
      clearTimeout(timer);
      offMorph?.();
      off();
    };
  }, []);
  if (phase === 'down') return <Notice phase="down" />;
  if (!db.today && phase === 'loading') return <Notice phase="loading" />;
  const s = {
    replies: t.replies,
    failed: t.failedReplies,
    input: t.inputTokens,
    cache: t.cacheReadTokens,
    output: t.outputTokens,
  };
  const hit = s.input ? s.cache / s.input : 0;
  const failRate = s.replies + s.failed ? s.failed / (s.replies + s.failed) : 0;
  if (!full) {
    return (
      <Pane>
        <div className="today pane-sc">
          <Stat variant="hero" value={<Roll value={s.replies} />} unit="次回复" />
          <Stat
            variant="row"
            label="token"
            value={
              <>
                输入{' '}
                <b>
                  <Roll value={s.input} />
                </b>{' '}
                · 输出{' '}
                <b>
                  <Roll value={s.output} />
                </b>
              </>
            }
          />
          <Stat
            variant="row"
            label="缓存命中率"
            value={
              <b>
                <Roll value={hit * 100} fmt={(v) => v.toFixed(1) + '%'} />
              </b>
            }
          >
            <Meter value={hit} label="缓存命中率" />
          </Stat>
          <Stat
            variant="row"
            label="失败"
            value={
              <>
                <b>
                  <Roll value={s.failed} />
                </b>{' '}
                次
              </>
            }
          >
            <Meter value={failRate} tone="danger" label="失败率" />
          </Stat>
        </div>
      </Pane>
    );
  }
  const rows = [...t.conversations].sort((a, b) => b.replies - a.replies).slice(0, 12);
  const max = rows.length ? rows[0].replies : 1;
  return (
    <Pane>
      <div className="today is-full pane-sc">
        <div className="today-grid">
          <Stat label="今天的回复" value={<Roll value={s.replies} />} />
          <Stat label="输入 token" value={<Roll value={s.input} />} />
          <Stat label="输出 token" value={<Roll value={s.output} />} />
          <Stat
            label="缓存命中率"
            value={<Roll value={hit * 100} fmt={(v) => v.toFixed(1) + '%'} />}
          >
            <Meter value={hit} label="缓存命中率" />
          </Stat>
          <Stat label="失败" value={<Roll value={s.failed} />}>
            <Meter value={failRate} tone="danger" label="失败率" />
          </Stat>
        </div>
        <div className="stat">
          <div className="ll-stat-line">
            <b>各会话今天的回复</b>
          </div>
          <div className="per-conv">
            {!rows.length && <Empty flat>今天还没有回复</Empty>}
            {rows.map((c) => {
              const title = c.title || db.conv(c.id)?.title || '会话';
              return (
                <div className="per-row" key={c.id}>
                  <span>{title}</span>
                  <Meter value={c.replies / max} label={title} />
                  <span>
                    <Roll value={c.replies} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Pane>
  );
}
export const TODAY_DEF: WidgetDef = {
  id: 'today',
  name: '今日概况',
  icon: IconToday,
  defaultSize: '1x1',
  refreshOn: ['today:update', 'data:reset', 'link'],
  thumb: () =>
    link.get().phase === 'down' ? (
      '连不上洛璃服务'
    ) : (
      <>
        今天 <em>{db.today?.replies ?? 0}</em> 次回复
      </>
    ),
  View: TodayView,
};
