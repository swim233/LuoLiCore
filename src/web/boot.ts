import { fpsMeter } from './lib/fps';
import { startWinSky, warmBubbleSky } from './lib/winSky';
import { motionOn } from '@luoli/ui/motion';
import { prefs } from './lib/prefs';
import { getSource } from './model/source';
import { status } from './model/status';
import { NOW_DEF } from './widgets/now/Now';
import { SESSIONS_DEF } from './widgets/sessions/Sessions';
import { CHAT_DEF } from './widgets/chat/Chat';
import { SETTINGS_DEF } from './widgets/settings/Settings';
import { TASKS_DEF } from './widgets/tasks/Tasks';
import { TODAY_DEF } from './widgets/today/Today';
import { desk, registerWidget } from './state/desk';
import { closeFull, installPressTracking, setArranging } from './state/actions';
import { pop } from './state/ui';
import { installWheel } from './shell/wheel';
import { chatEscAbort } from './widgets/chat/chatEsc';
import { escHooks } from './lib/dev-slot';

/* 启动：数据源、部件注册、全局的键盘与窗口事件。
   todayAlways：今日概况是不是一开始就在注册表里。正式构建里是；开发模式照 demo，由演示面板的按钮运行时新增 */
export function boot({ todayAlways }: { todayAlways: boolean }) {
  {
    const r = document.documentElement;
    r.classList.toggle('motion', motionOn());
    r.classList.toggle('still', !motionOn());
    r.classList.add('hover-' + prefs.get().hover);
  }
  fpsMeter.set(prefs.get().fps);
  startWinSky();
  // 气泡的毛玻璃用实时模糊，但会话窗口里整层淡入淡出时要暂时用「预先糊好」的星空：启动后等页面空闲时先糊好（约 15～20 毫秒），不留到第一次开会话那一下
  warmBubbleSky();
  getSource().start();
  registerWidget(NOW_DEF);
  registerWidget(SESSIONS_DEF);
  registerWidget(CHAT_DEF);
  registerWidget(SETTINGS_DEF);
  if (todayAlways || desk.get().layout.extra.includes('today')) registerWidget(TODAY_DEF);
  registerWidget(TASKS_DEF);
  installPressTracking();
  installWheel();
  /* Esc：① 对话正在生成且对话是当前操作的部件 → 中止；② 额外的处理（开发模式：演示面板开着且焦点在里面 → 收起）；③ 全屏 → 退出；④ 整理模式 → 退出；⑤ 收起弹出框 */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (chatEscAbort()) {
      e.preventDefault();
      return;
    }
    if (escHooks.some((h) => h(e))) return;
    if (desk.get().full) {
      closeFull();
      return;
    }
    if (desk.get().arranging) {
      setArranging(false);
      return;
    }
    pop.hide();
  });
  status.emit();
  setTimeout(warmFs, 700);
}
/* 第一次进全屏时，显卡要现编模糊用的着色器，第一帧会卡一下。页面空闲时先在角落里用一个几乎看不见的小块
   把背景模糊和内容模糊各走一遍，之后第一次进全屏就和以后一样顺 */
function warmFs() {
  if (!motionOn()) return;
  const g = document.createElement('div');
  g.setAttribute('aria-hidden', 'true');
  g.style.cssText =
    'position:fixed;left:0;bottom:0;width:48px;height:48px;opacity:.01;pointer-events:none;z-index:1;-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:100%;height:100%;font-size:12px;color:var(--ll-fg)';
  inner.textContent = '洛璃';
  g.append(inner);
  document.body.append(g);
  const a = inner.animate(
    [
      { filter: 'blur(24px)', transform: 'scale(1.6)' },
      { filter: 'blur(0px)', transform: 'none' },
    ],
    { duration: 360 },
  );
  a.finished.catch(() => {}).then(() => g.remove());
}
