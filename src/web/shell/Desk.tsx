import { createPortal } from 'react-dom';
import { LayoutGroup } from 'motion/react';
import { Empty } from '@luoli/ui/controls';
import { useNarrow } from '@luoli/ui/env';
import { useCols } from '../lib/useCols';
import { hasDef, useDesk, useDefsRev } from '../state/desk';
import { Cap } from './Cap';
import { WidgetWindow } from './WidgetWindow';

/* 缩略的部件排在网格上方的一行（可换行）；普通大小的卡片在网格里；「此刻」浮起（自动展开）盖在网格上方，窄屏像灵动岛 */
export function DeskWrap() {
  useDefsRev();
  const cols = useCols();
  const narrow = useNarrow();
  const L = useDesk((s) => s.layout);
  const nowFloat = useDesk((s) => s.nowFloat);
  const ids = L.order.filter((id) => hasDef(id) && !L.hidden[id]);
  const isIsland = (id: string) => narrow && id === 'now';
  const shelf = ids.filter((id) => L.mini[id] && !isIsland(id));
  const deskIds = ids.filter((id) => !L.mini[id] && !isIsland(id));
  const showFloat = !narrow && ids.includes('now') && L.mini.now && nowFloat;
  const showIsland = narrow && ids.includes('now') && (!L.mini.now || nowFloat);
  return (
    <div className="desk-wrap" id="desk-wrap">
      <LayoutGroup>
        <div className="shelf" id="shelf" aria-label="缩略的部件">
          {shelf.map((id) => (
            <Cap key={id} id={id} />
          ))}
        </div>
        <div className="desk" id="desk" aria-label="桌面">
          {deskIds.map((id) => (
            <WidgetWindow key={id} id={id} variant="desk" cols={cols} />
          ))}
          {!deskIds.length && (
            <Empty flat className="desk-empty">
              {ids.length
                ? '部件都缩成了上面的胶囊，单击胶囊展开'
                : '桌面上没有部件。点「整理」，从收纳盒把部件拖回来'}
            </Empty>
          )}
        </div>
      </LayoutGroup>
      {showFloat && <WidgetWindow key="now-float" id="now" variant="float" cols={cols} />}
      {showIsland &&
        createPortal(
          <WidgetWindow key="now-island" id="now" variant="island" cols={cols} />,
          document.body,
        )}
    </div>
  );
}
