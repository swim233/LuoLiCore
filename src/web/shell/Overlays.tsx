import { useLayoutEffect, useRef } from 'react';
import { Button, Dot, Notice } from '@luoli/ui/controls';
import { lastOnlineText, STATE_TEXT, STATE_TONE, status, useStatus } from '../model/status';
import { useAssistantName } from '../model/who';
import { lastReplyText } from '../lib/util';
import { getDef, useDesk, useDefsRev } from '../state/desk';
import { Popover, PopoverContent } from '@luoli/ui/overlay';
import { popHandle, useUi } from '../state/ui';
import { unhideWidget } from '../state/actions';
import { dragStart, wasDragged } from './drag';

/* 各群的状态：悬停顶栏、胶囊或大徽记时弹出 */
export function Pop() {
  const s = useStatus();
  const name = useAssistantName();
  return (
    <Popover handle={popHandle} hoverOnly>
      <PopoverContent
        passive
        side="bottom"
        align="start"
        collisionPadding={16}
        collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'end' }}
        className="pop-body"
      >
        <div className="pop-title">
          {s.state === 'offline'
            ? `${name}离线`
            : s.count
              ? `${s.count} 个会话在回复`
              : '没有进行中的对话'}
        </div>
        {s.state === 'offline' && (
          <div className="pop-row">
            <Dot tone={STATE_TONE.offline} />
            <b>{lastOnlineText()}</b>
          </div>
        )}
        {s.state !== 'offline' && !s.count && (
          <div className="pop-row">
            <Dot tone={STATE_TONE.idle} />
            <b>{status.lastReplyAt ? lastReplyText(status.lastReplyAt) : '今天还没有新的回复'}</b>
          </div>
        )}
        {s.list.map((x) => (
          <div className="pop-row" key={x.id}>
            <Dot tone={STATE_TONE[x.state]} />
            <b>{x.title}</b>
            <span>{x.state === 'tool' ? '调用 ' + (x.tool || '工具') : STATE_TEXT[x.state]}</span>
          </div>
        ))}
        {!s.tgEnabled && (
          <div className="pop-row">
            <Dot tone={STATE_TONE.offline} />
            <b>Telegram 服务未启动</b>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/* 整理提示条：吸在顶栏下面，退出时脱离文档流、固定在原位淡出滑走 */
export function ArrangeBar({ onDone }: { onDone: () => void }) {
  const arranging = useDesk((s) => s.arranging);
  const leaving = useDesk((s) => s.arrLeaving);
  const barPos = useDesk((s) => s.barPos);
  const ref = useRef<HTMLSpanElement>(null);
  const shown = arranging || leaving;
  /* 进入：先渲染成隐藏的样子，下一帧再加 is-on，过渡才会播 */
  const onRef = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      onRef.current = false;
      return;
    }
    if (arranging) {
      if (!onRef.current) {
        void el.offsetWidth;
        onRef.current = true;
      }
      el.classList.add('is-on');
      el.classList.remove('is-leaving');
    } else {
      el.classList.remove('is-on');
      el.classList.add('is-leaving');
      onRef.current = false;
    }
  }, [arranging, shown]);
  if (!shown) return null;
  const style =
    !arranging && leaving && barPos
      ? {
          position: 'fixed' as const,
          top: barPos.top,
          left: barPos.left,
          /* 库的提示条是 border-box，量到的整条宽原样写回，淡出时宽度不变。
             要改回换库之前的样子（content-box，淡出时宽 24px、字右挪 12px）：写 barPos.width + 24 */
          width: barPos.width,
          margin: 0,
        }
      : undefined;
  return (
    <Notice size="lg" className="arrange-bar" id="arrange-bar" ref={ref} style={style}>
      <span>
        <b>整理中</b>：拖动部件换位置，点尺寸调大小，拖进收纳盒隐藏
      </span>
      <Button pressed id="arrange-done" onClick={onDone}>
        完成
      </Button>
    </Notice>
  );
}

/* 收纳盒：固定在窗口底部居中，整理时从下面滑上来 */
export function Tray() {
  useDefsRev();
  const L = useDesk((s) => s.layout);
  const arranging = useDesk((s) => s.arranging);
  const over = useUi((s) => s.trayOver);
  const hidden = L.order.filter((id) => getDef(id) && L.hidden[id]);
  return (
    <div
      className={'tray ll-glass' + (arranging ? ' is-on' : '') + (over ? ' is-over' : '')}
      id="tray"
    >
      <span className="tray-label">收纳盒</span>
      <div className="tray-items" id="tray-items">
        {!hidden.length && (
          <span className="tray-empty">把部件拖到这里收起来；收起来的部件可以拖回桌面</span>
        )}
        {hidden.map((id) => {
          const def = getDef(id)!;
          return (
            <Button
              key={id}
              size="lg"
              className="tray-item"
              data-id={id}
              title="拖回桌面，或单击放回原处"
              onPointerDown={(ev) => dragStart(ev, id, 'tray')}
              onClick={() => {
                if (wasDragged()) return;
                unhideWidget(id);
              }}
            >
              <span className="cap-icon">{def.icon}</span>
              {def.name}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
