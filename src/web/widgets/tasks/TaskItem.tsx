import { useEffect, useRef, useState } from 'react';
import { Button, Row } from '@luoli/ui/controls';
import { fmtWhen } from '../../lib/zone';
import { getSource } from '../../model/source';
import { END_TEXT, endKind, scheduleLine, serverZone } from '../../model/tasks';
import type { TaskRow } from '../../model/types';

/* 任务的一行：做什么（完整显示，长了换行）、周期、谁让建的，右边是下次到点和「取消」。
   取消在这一行里确认（「取消这个任务？」「确认」「算了」），不用 confirm()；确认后调接口，成功了这一行移到「已结束」，
   失败时在这一行里写原因。有鼠标时「取消」悬停才出现，触屏和窄屏一直显示（样式表）。
   已结束的行变暗，写明已完成、已超时或已取消和结束的时间，不能操作。
   任务部件和全屏会话头部的浮层用的是同一个。 */

/** 每隔一会儿重画一次：「今天、明天」过了零点要跟着变 */
export function useClockTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    const wake = () => document.visibilityState === 'visible' && setNow(Date.now());
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [ms]);
  return now;
}

const ERR_MS = 6000;

export function TaskItem({
  task,
  now,
  where,
}: {
  task: TaskRow;
  now: number;
  /** 已结束的列表里没有会话分组，行里写它在哪个会话 */
  where?: string;
}) {
  const [ask, setAsk] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [err, setErr] = useState('');
  const alive = useRef(true);
  const errTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      alive.current = false;
      clearTimeout(errTimer.current);
    },
    [],
  );
  const tz = serverZone();
  const end = endKind(task);
  const next = task.nextDueAt ? Date.parse(task.nextDueAt) : 0;

  const cancel = async () => {
    setAsk('busy');
    setErr('');
    try {
      await getSource().cancelTask(task.id);
      // 成功：服务的新样子已经放进数据层，这一行换到「已结束」里，这个组件随之卸载
    } catch (e) {
      if (!alive.current) return;
      setAsk('idle');
      setErr(e instanceof Error ? e.message : '取消失败');
      clearTimeout(errTimer.current);
      errTimer.current = setTimeout(() => alive.current && setErr(''), ERR_MS);
    }
  };

  const meta = [scheduleLine(task, tz), `${task.requestedBy.name} 让建的`];
  if (where) meta.push(where);
  return (
    <Row
      wrap
      className={
        'task-row' + (end ? ' is-ended' : ' is-live') + (ask !== 'idle' ? ' is-asking' : '')
      }
      data-id={task.id}
      title={task.action}
      sub={meta.join(' · ')}
      side={
        end ? (
          <>
            <span className="task-state">{END_TEXT[end]}</span>
            {task.endedAt && (
              <span className="task-at">{fmtWhen(Date.parse(task.endedAt), tz, now)}</span>
            )}
          </>
        ) : (
          <>
            <span className="task-next" title="下次到点">
              {next ? fmtWhen(next, tz, now) : ''}
            </span>
            {ask === 'idle' && (
              <Button size="sm" className="task-cancel" onClick={() => setAsk('confirm')}>
                取消
              </Button>
            )}
          </>
        )
      }
    >
      {ask !== 'idle' && (
        <div className="task-ask ll-row-full" role="group" aria-label="取消这个任务？">
          <span>取消这个任务？</span>
          <Button
            size="sm"
            variant="danger"
            data-armed
            disabled={ask === 'busy'}
            onClick={() => void cancel()}
          >
            {ask === 'busy' ? '取消中…' : '确认'}
          </Button>
          <Button size="sm" disabled={ask === 'busy'} onClick={() => setAsk('idle')}>
            算了
          </Button>
        </div>
      )}
      {err && (
        <div className="task-err ll-row-full" role="status">
          没取消成功：{err}
        </div>
      )}
    </Row>
  );
}
