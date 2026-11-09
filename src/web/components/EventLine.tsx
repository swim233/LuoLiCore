import { memo } from 'react';
import { motionOn } from '../lib/prefs';
import { fmtDay } from '../lib/util';
import { eventLine, eventOf } from '../model/events';
import { textOf } from '../model/parts';
import type { MsgRow } from '../model/types';

/* 事件（任务到点、任务超时）在时间线里不是气泡：居中的一行灰字，没有头像、名字，时间放在末尾、小一号；悬停显示事件的完整正文。
   这一行不参与发言人的分组，也不带「排队中」。会话部件的时间线和对话部件共用 */
export const EventLine = memo(function EventLine({ row, isNew }: { row: MsgRow; isNew: boolean }) {
  const type = eventOf(row);
  if (!type) return null;
  const body = textOf(row);
  return (
    <div className={'evt' + (isNew && motionOn() ? ' is-new' : '')} title={body}>
      <span className="evt-text">{eventLine(type, row.task, body)}</span>
      <span className="evt-time">{fmtDay(Date.parse(row.createdAt))}</span>
    </div>
  );
});
