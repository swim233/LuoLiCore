import { Badge } from '../components/Badge';
import { Button, Switch } from '@luoli/ui/controls';
import { useNarrow } from '@luoli/ui/env';
import { IconArrange } from '@luoli/ui/icons';
import { useMotionOn } from '@luoli/ui/motion';
import { chooseMotion } from '../lib/prefs';
import { STATE_TEXT, useStatus } from '../model/status';
import { useAssistantName } from '../model/who';
import { hasDef, useDefsRev, useDesk } from '../state/desk';
import { nowCtl, setArranging } from '../state/actions';
import { pop } from '../state/ui';
import { Cap } from './Cap';

/* 顶栏：洛璃的状态按钮（点一下展开「此刻」）、窄屏时「此刻」的胶囊在正中（灵动岛）、整理、动画开关 */
export function TopBar() {
  useDefsRev();
  const snap = useStatus();
  const name = useAssistantName();
  const narrow = useNarrow();
  const arranging = useDesk((s) => s.arranging);
  const motion = useMotionOn();
  const L = useDesk((s) => s.layout);
  const islandOn = narrow && hasDef('now') && !L.hidden.now;
  const stateName =
    snap.state === 'tool' ? '调用 ' + (snap.tool || '工具') : STATE_TEXT[snap.state];
  const where = snap.count >= 2 ? snap.count + ' 个会话' : snap.list[0] ? snap.list[0].title : '';
  return (
    <header className="top" id="top">
      <div className="top-in">
        <button
          className={'top-status' + (islandOn ? ' is-island-mode' : '')}
          id="top-status"
          type="button"
          aria-label={`${name}的状态，点一下展开「此刻」`}
          onClick={() => {
            pop.hide();
            nowCtl.manualExpand();
          }}
          onPointerEnter={(e) => {
            if (e.pointerType === 'mouse') pop.show(e.currentTarget);
          }}
          onPointerLeave={() => pop.hide()}
        >
          <span className="top-badge" id="top-badge">
            <Badge size={22} />
          </span>
          <span className="top-name">{name}</span>
          <span className="top-state" id="top-state">
            {snap.state === 'offline' ? (
              '离线'
            ) : snap.state === 'idle' ? (
              '空闲'
            ) : (
              <>
                <b>{stateName}</b>
                {where ? ' · ' + where : ''}
              </>
            )}
          </span>
        </button>
        <div className="island-slot" id="island-slot">
          {islandOn && <Cap id="now" island />}
        </div>
        <div className="top-right">
          <Button
            size="lg"
            id="btn-arrange"
            pressed={arranging}
            title="整理桌面（Esc 退出）"
            onClick={() => setArranging(!arranging)}
          >
            <IconArrange />
            <span className="tlabel">整理</span>
          </Button>
          <Switch
            boxed
            size="lg"
            id="btn-motion"
            checked={motion}
            title="装饰性的动画"
            onChange={chooseMotion}
            label="动画"
          />
        </div>
      </div>
    </header>
  );
}
