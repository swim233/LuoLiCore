import { useEffect, useRef, useState } from 'react';
import { useGlide } from '../../components/glide';
import { useLinkPhase } from '../../model/link';
import { useBusRev } from '../../model/rev';
import { activeTasks, tasksReady } from '../../model/tasks';
import type { TaskRow } from '../../model/types';
import { TaskItem, useClockTick } from './TaskItem';

/* 全屏会话的头部：这个会话进行中的任务数（「2 个任务」，没有就不显示），点开是一个小浮层，列出这些任务，样子和任务部件里的行一样，
   也能取消（在行里确认）。浮层的样子跟对话里选会话的菜单（.chat-menu）一致：玻璃底，悬停高亮一块滑动；点外面或按 Esc 关闭。
   Esc 在捕获阶段先接住，只关浮层，不连带退出全屏 */
function TaskPop({ list, now }: { list: TaskRow[]; now: number }) {
  const g = useGlide('.task-row.is-live');
  return (
    <div
      className="chat-menu task-pop"
      role="dialog"
      aria-label="这个会话的任务"
      ref={(el) => {
        g.list.current = el;
      }}
    >
      <i className="glide" ref={(el) => void (g.glide.current = el)} aria-hidden="true" />
      {list.map((t) => (
        <TaskItem key={t.id} task={t} now={now} />
      ))}
    </div>
  );
}

export function TaskChip({ convId }: { convId: string }) {
  useBusRev(['tasks:update', 'data:reset', 'link']);
  const phase = useLinkPhase();
  const now = useClockTick();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  // 取任务失败（版本旧、没取到）时不显示任务数
  const list = phase === 'ready' && tasksReady() ? activeTasks(convId) : [];
  const shown = open && list.length > 0;
  useEffect(() => setOpen(false), [convId]);
  useEffect(() => {
    if (!shown) return;
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [shown]);
  if (!list.length) return null;
  return (
    <span className="task-chip" ref={wrap}>
      <button
        className="pchip task-count"
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={shown}
        title="这个会话进行中的任务"
        onClick={() => setOpen(!shown)}
      >
        {list.length} 个任务
        <span className="chev" aria-hidden="true" />
      </button>
      {shown && <TaskPop list={list} now={now} />}
    </span>
  );
}
