import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource-variable/noto-sans-sc';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/easing';
import './showcase.css';
import { motionOn, subscribeMotion } from '../src/motion';
import { App } from './App';
import { runAnimCheck } from './lib/anim-check';
import { bumpCss } from './lib/css-read';
import { installForcedStates } from './lib/force-states';
import './lib/prefs';

/* 展示页的入口：只引库（../src/…）和展示页自己的文件，不引 src/ 下面板、core、服务的任何东西。
   - 库的样式（变量，在 @layer 里）和 easing（往 head 写动画的那几个变量）先引，展示页自己的样式（不在层里）后引；
   - 动画开关变了，根元素上的 motion / still 类跟着换（照面板的做法）；
   - 动画变量的一致性检查、「强制悬停 / 焦点」的样式复制，在页面加载后和样式热更新后各跑一次 */
const applyMotion = () => {
  const r = document.documentElement;
  r.classList.toggle('motion', motionOn());
  r.classList.toggle('still', !motionOn());
};
applyMotion();
subscribeMotion(applyMotion);

const refresh = () => {
  runAnimCheck();
  installForcedStates();
  bumpCss();
};
refresh();
if (import.meta.hot) import.meta.hot.on('vite:afterUpdate', refresh);

createRoot(document.getElementById('root')!).render(<App />);
