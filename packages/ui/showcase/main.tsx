import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource-variable/noto-sans-sc';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/easing';
import './legacy/step5.css';
import './legacy/step5b.css';
import './showcase.css';
import './showcase-b2.css';
import { motionOn, subscribeMotion } from '../src/motion';
import { startSkyStars } from '../src/sky-stars';
import { App } from './App';
import { runAnimCheck } from './lib/anim-check';
import { bumpCss } from './lib/css-read';
import { installForcedStates } from './lib/force-states';
import { runSkyCheck } from './lib/sky-check';
import './lib/prefs';

/* 展示页的入口：只引库（../src/…）和展示页自己的文件，不引 src/ 下面板、core、服务的任何东西。
   - 库的样式（变量，在 @layer 里）和 easing（往 head 写动画的那几个变量）先引，再引对比块里「现在」那边的旧样式（legacy/，b 段结束时删），展示页自己的样式（不在层里，里面有几条要盖过旧样式的）最后引；
   - 动画开关变了，根元素上的 motion / still 类跟着换（照面板的做法）；
   - 夜空窗口的星点贴图启动时画好（startSkyStars，所有「夜空窗口」的底从这里起带星点）；
   - 动画变量、星点贴图参数的一致性检查，「强制悬停 / 焦点」的样式复制，在页面加载后和样式热更新后各跑一次 */
const applyMotion = () => {
  const r = document.documentElement;
  r.classList.toggle('motion', motionOn());
  r.classList.toggle('still', !motionOn());
};
applyMotion();
subscribeMotion(applyMotion);
startSkyStars();

const refresh = () => {
  runAnimCheck();
  runSkyCheck();
  installForcedStates();
  bumpCss();
};
refresh();
if (import.meta.hot) import.meta.hot.on('vite:afterUpdate', refresh);

createRoot(document.getElementById('root')!).render(<App />);
