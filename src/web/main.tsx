import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource-variable/noto-sans-sc';
import { createRoot } from 'react-dom/client';
import '@luoli/ui/styles.css';
import './styles/app.css';
import './lib/debug';
import { App } from './app';
import { boot } from './boot';
import { liveSource } from './model/live-source';
import { setSource } from './model/source';
import type { DataSource } from './model/source';

/* 入口：选数据源、启动、渲染。
   开发模式：动态引入 dev/（演示控制面板、模拟服务与模拟数据源），今日概况照 demo 由面板的按钮运行时新增。
   正式构建：import.meta.env.DEV 被换成 false，这一段连同 dev/ 整个目录都不会进产物；用连洛璃服务的数据源，今日概况一开始就在。 */
async function main() {
  let source: DataSource = liveSource;
  let todayAlways = true;
  if (import.meta.env.DEV) {
    const dev = await import('./dev');
    source = dev.installDev();
    todayAlways = false;
  }
  setSource(source);
  boot({ todayAlways });
  createRoot(document.getElementById('root')!).render(<App />);
}
void main();
