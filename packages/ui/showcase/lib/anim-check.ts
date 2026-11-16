import {
  DUR_BLUR_IN,
  DUR_CARD,
  DUR_GLIDE,
  DUR_GLIDE_IN,
  DUR_GLIDE_OUT,
  DUR_HOVER,
  EASE_OUT,
} from '../../src/easing';
import { createStore, useStore } from '../../src/store';
import { compareAnim } from './anim-math';
import type { Expected } from './anim-math';
import { readStaticTokens } from './tokens-src';

/* 一致性检查：动画的 7 个变量有两处来源——tokens.css 里静态写的一份（在 ll.tokens 这一层里），
   和 easing.ts 加载时写进 <head> 的一份（不在层里，有 JS 时盖过前一份）。两处必须一样，这里按数值比：
   时长换算成毫秒（200ms、.2s、0.2s 是一样的），曲线比四个数（空格、前导 0 随便）。对不上就 console.error，
   「变量」一节的「动画」组上面显示一条红色提示。
   浮层的几个进出场时长（CSS_ONLY）不在这个检查里：它们只在 tokens.css 里定义一次，没有 easing.ts 的另一份 */

/** easing.ts 的常量：变量名 → 值（时长是毫秒，曲线是四个数） */
export const EASING_TS: Record<string, Expected> = {
  '--ll-ease-out': EASE_OUT,
  '--ll-dur-hover': DUR_HOVER,
  '--ll-dur-card': DUR_CARD,
  '--ll-dur-glide': DUR_GLIDE,
  '--ll-dur-glide-in': DUR_GLIDE_IN,
  '--ll-dur-glide-out': DUR_GLIDE_OUT,
  '--ll-dur-blur-in': DUR_BLUR_IN,
};

/** 只在 tokens.css 里定义一次的动画变量（浮层的进出场时长）：Base UI 用 CSS 过渡，TS 里用不到，没有 easing.ts 的另一份，检查时不要求登记 */
export const CSS_ONLY = [
  '--ll-dur-pop-in',
  '--ll-dur-pop-out',
  '--ll-dur-tip',
  '--ll-dur-dim',
  '--ll-dur-dialog-in',
  '--ll-dur-dialog-out',
  '--ll-dur-toast',
  '--ll-dur-grow-in',
  '--ll-dur-grow-content-in',
  '--ll-dur-grow-out',
  '--ll-dur-grow-content-out',
  '--ll-dur-grow-tint',
];

export interface AnimCheck {
  ok: boolean;
  problems: string[];
}
const result = createStore<AnimCheck>({ ok: true, problems: [] });
export const useAnimCheck = () => useStore(result, (s) => s);

/** 跑一遍检查（页面加载后、样式热更新后各一次）；对不上就 console.error */
export function runAnimCheck() {
  const vals = readStaticTokens(document.styleSheets);
  const problems = vals
    ? compareAnim(vals, EASING_TS, Object.keys(vals), CSS_ONLY)
    : ['样式表里找不到 @layer ll.tokens（库的 styles.css 没有加载？）'];
  if (problems.length)
    console.error(
      '[展示页] 动画变量的两处来源对不上：\n' + problems.map((p) => '  ' + p).join('\n'),
    );
  result.set({ ok: problems.length === 0, problems });
}
