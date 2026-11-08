import './demo.css';
import { devSlot, escHooks } from '../lib/dev-slot';
import { DemoPanel } from './DemoPanel';
import { devUi, toggleDemo } from './demo-state';
import { mockSource } from './mock-source';

/* 开发模式的入口（main.tsx 只在开发模式里动态引入它，正式构建里没有）：
   装上演示控制面板和它的 Esc 处理，返回模拟数据源 */
export function installDev() {
  devSlot.Panel = DemoPanel;
  escHooks.push(() => {
    const demo = document.getElementById('demo');
    if (devUi.get().open && demo && demo.contains(document.activeElement)) {
      toggleDemo(false);
      document.getElementById('demo-toggle')?.focus();
      return true;
    }
    return false;
  });
  return mockSource;
}
