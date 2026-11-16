import { hoverHandlers as hover } from '@luoli/ui/fx';
import { desk } from '../state/desk';
import { edgeSkip } from '../lib/fx-dom';

/* 悬停的动效与发光（流光、边光、倾斜加边光）是库的（@luoli/ui/fx）：用哪一种由根元素的 data-ll-hover 说（app.tsx、boot.ts 按偏好写），
   这里只交给库两个外壳的判断：全屏窗口、整理模式里不倾斜；全屏打开期间不放流光 */
export function hoverHandlers(isFull: boolean) {
  return hover({ canTilt: () => !isFull && !desk.get().arranging, skipEdge: edgeSkip });
}
