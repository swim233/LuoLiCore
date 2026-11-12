import { createStore, useStore } from './store';

/* 聊天气泡的毛玻璃（气泡后面的星空被糊开）有两种做法：
   - live：实时模糊。气泡自己 backdrop-filter: blur(20px) saturate(1.3)，开销在 GPU 上，不垫那一层、没有任何对位的脚本。正式页面里一律用它；
   - baked：预先糊好的星空。启动后空闲时把两张星点贴图各糊一份（lib/winSky.ts），气泡里垫一层（.bubble-sky），滚动时脚本要跟着对位
     （components/bubble-sky.ts），主线程的开销比 live 大（滚动时每秒多花约 80～120 毫秒）。
   两种做法下气泡的大小、文字、配色完全一样，只有「后面的星空怎么糊」不同。
   baked 现在有两处会用到：① 会话窗口里列表和时间线整层淡入淡出的那 0.26 秒（整层带着 opacity，live 拿不到后面的画面，见 components/Bubble.tsx 的
   BakedGlass）；② 开发模式的演示控制面板里的切换（dev/DemoPanel.tsx，用来对比和验收，正式构建里没有）。
   选哪种只存在内存里：不进偏好、不存 localStorage，刷新后回到默认 */
export type Glass = 'baked' | 'live';

/** 默认用哪种（改默认值只改这一处） */
export const GLASS_DEFAULT: Glass = 'live';

const glass = createStore<{ mode: Glass }>({ mode: GLASS_DEFAULT });
/** 现在用哪种 */
export const glassMode = (): Glass => glass.get().mode;
/** 组件里订阅：改了就重新渲染，挂着的气泡当场换 */
export const useGlassMode = (): Glass => useStore(glass, (s) => s.mode);
export function setGlass(mode: Glass) {
  glass.set({ mode });
}
