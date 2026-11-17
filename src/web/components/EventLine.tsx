import { memo, useId, useState } from 'react';
import { Chevron } from '@luoli/ui/controls';
import { motionOn } from '@luoli/ui/motion';
import { fmtDay } from '../lib/util';
import { eventLine, eventOf, hasFoldedBody } from '../model/events';
import { textOf } from '../model/parts';
import type { MsgRow } from '../model/types';

/* 事件（任务触发、任务超时、监听触发、监听失败）在时间线里不是气泡：居中的一行灰字，没有头像、名字，时间放在末尾、小一号。
   这一行不参与发言人的分组，也不带「排队中」。会话部件的时间线和对话部件共用。
   - 任务触发、任务超时：悬停显示事件的完整正文，不能点；
   - 监听触发、监听失败：正文可能有几千个字（查到的条目、查不到的原因），这一行是个按钮（带 aria-expanded，键盘能操作），
     点一下在下面展开正文（原样文字、保留换行，最高 240 像素，超出在里面滚），再点收起；不放悬停的说明。
     展开、收起时高度平滑地变（样式表里 .evt-body，关动画时直接到位）；时间线的长列表会观察每一条的高度，
     贴着底部时继续贴着，往上翻着时点的这一行不动。展开的状态按消息 id 记在页面里：这一条滚出长列表、被卸下再挂上，仍是展开的 */
const openBodies = new Set<string>();

export const EventLine = memo(function EventLine({ row, isNew }: { row: MsgRow; isNew: boolean }) {
  const type = eventOf(row);
  const bodyId = useId();
  const [open, setOpen] = useState(() => openBodies.has(row.id));
  if (!type) return null;
  const body = textOf(row);
  const text = eventLine(type, row.task, body);
  const time = fmtDay(Date.parse(row.createdAt));
  const cls = 'evt' + (isNew && motionOn() ? ' is-new' : '');
  if (!hasFoldedBody(type))
    return (
      <div className={cls} title={body}>
        <span className="evt-text">{text}</span>
        <span className="evt-time">{time}</span>
      </div>
    );
  const toggle = () => {
    const next = !open;
    if (next) openBodies.add(row.id);
    else openBodies.delete(row.id);
    setOpen(next);
  };
  return (
    <div className={cls + ' is-fold'}>
      <button
        type="button"
        className="evt-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="evt-text">{text}</span>
        <span className="evt-time">
          {time}
          {/* 箭头不是按钮的直接子元素（和时间放在一起，免得单独掉到下一行），库的 Chevron 不会自己跟着 aria-expanded 转向，方向用 dir 说 */}
          <Chevron dir={open ? 'down' : 'right'} />
        </span>
      </button>
      <div id={bodyId} className="evt-body" data-open={open ? '' : undefined} inert={!open}>
        <div className="evt-body-in ll-inset ll-scrollbar" data-size="sm" tabIndex={0}>
          {body}
        </div>
      </div>
    </div>
  );
});
