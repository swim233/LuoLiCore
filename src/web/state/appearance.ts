import { fpsMeter } from '../lib/fps';
import { setPrefs } from '../lib/prefs';
import type { Prefs } from '../lib/prefs';
import { nowCtl, resetLayout } from './actions';
import { toast } from './ui';

/* 「外观」里几项偏好的修改动作：设置部件里的「外观」组和开发模式的演示面板共用同一份，
   状态都在 lib/prefs.ts 的 prefs 里（存 localStorage），改一处另一处跟着变 */

export function setHover(hover: Prefs['hover']) {
  setPrefs({ hover });
}

/* 帧率显示：存偏好，同时开关帧率元素 */
export function setFps(on: boolean) {
  setPrefs({ fps: on });
  fpsMeter.set(on);
}

/* 「此刻」自动缩回的秒数：已经在计时的，按新的秒数重新计 */
export function setCollapse(collapse: Prefs['collapse']) {
  setPrefs({ collapse });
  if (nowCtl.timer) {
    nowCtl.cancel();
    nowCtl.schedule();
  }
}

/* 有回复时「此刻」自动展开：关掉时手动展开才展开；正在浮着的不收，等它自己缩回 */
export function setAutoNow(on: boolean) {
  setPrefs({ autoNow: on });
}

export function resetLayoutToDefault() {
  resetLayout();
  toast('布局恢复成默认的了');
}
