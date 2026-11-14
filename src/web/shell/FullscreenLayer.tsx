import { Badge } from '../components/Badge';
import { MorphHost } from './morph';
import { getDef, useDefsRev, useDesk, visibleIds } from '../state/desk';
import { fsPointer, openFull } from '../state/actions';
import { WidgetWindow } from './WidgetWindow';

/* 全屏：接近全屏的窗口，后面的桌面变暗、变模糊；顶部一排部件图标可以切换。
   层次：暗层（固定半径的背景模糊，只动透明度）< 形变层（窗口外框 + 旧内容）< 窗口（切换栏 + 新内容）。
   不要给 .fs 或它的祖先加 opacity / filter / will-change：那样暗层的 backdrop-filter 就看不到后面的桌面了 */
export function FullscreenLayer() {
  useDefsRev();
  const wins = useDesk((s) => s.fsWins);
  const cur = useDesk((s) => s.full?.id ?? null);
  useDesk((s) => s.layout);
  if (!wins.length) return null;
  const ids = visibleIds();
  const curId = cur ?? wins[wins.length - 1].id;
  return (
    <div
      className="fs"
      id="fs"
      onPointerDown={(e) => fsPointer.down(e.nativeEvent)}
      onPointerUp={(e) => fsPointer.up(e.nativeEvent)}
      onPointerCancel={() => fsPointer.cancel()}
    >
      {/* 触屏：让暗层也算「可以点的地方」，免得点在边距上被浏览器的触点校正挪到旁边的窗口内容上 */}
      <div className="fs-dim" id="fs-dim" onClick={() => {}} />
      <div className="fs-morph" id="fs-morph" aria-hidden="true">
        <MorphHost host="fs" />
      </div>
      <div
        className="fs-win"
        id="fs-win"
        role="dialog"
        aria-modal="true"
        aria-label="全屏部件"
        tabIndex={-1}
      >
        <nav className="fs-switch" id="fs-switch" aria-label="切换部件">
          {ids.map((id) => {
            const def = getDef(id)!;
            return (
              /* 当前项变了就重建按钮（和第 4.1 版一样）：原地改 aria-current 会触发颜色、边线、阴影的 CSS 过渡，那是主线程逐帧重绘，切换时的头 200 ms 会掉帧 */
              <button
                key={id + (id === curId ? '*' : '')}
                className="fs-tab ll-tab"
                data-size="md"
                type="button"
                aria-current={id === curId}
                title={def.name}
                onClick={() => openFull(id)}
              >
                <span className="w-icon">{id === 'now' ? <Badge size={18} /> : def.icon}</span>
                <span className="fs-tab-name">{def.name}</span>
              </button>
            );
          })}
        </nav>
        <div className="fs-stage" id="fs-stage">
          {wins.map((w) => (
            <WidgetWindow
              key={w.key}
              id={w.id}
              variant="full"
              cols={1}
              winKey={w.key}
              params={w.params}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
