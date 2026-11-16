import type { Plugin } from '../src/plugin-api.js';
import { fetchPlugin } from './fetch/index.js';

// 插件清单（ADR-0014）：洛璃服务启动时装配，插件的工具按这个顺序（插件里再按插件自己的顺序）发给模型。
// 加插件：在 plugins/ 下新建一个目录，入口 index.ts 用 definePlugin 导出插件，再在这里 import 并加进数组
export const plugins: readonly Plugin[] = [fetchPlugin];
