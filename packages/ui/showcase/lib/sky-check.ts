import { SKY_TILES } from '../../src/sky-stars';
import { createStore, useStore } from '../../src/store';
import { compareSkyTiles } from './sky-math';
import { readStaticTokens } from './tokens-src';

/* 星点贴图参数的一致性检查：贴图的起点和大小有两处来源——tokens.css 里 --ll-sky-bg 静态写的一份，和 sky-stars.ts 的 SKY_TILES。
   两处必须一样，页面加载后（和样式热更新后）按数值比一次：对不上就 console.error，「面」一节上面显示一条红字提示 */
export interface SkyCheck {
  ok: boolean;
  problems: string[];
}
const result = createStore<SkyCheck>({ ok: true, problems: [] });
export const useSkyCheck = () => useStore(result, (s) => s);

export function runSkyCheck() {
  const vals = readStaticTokens(document.styleSheets);
  const problems = vals
    ? compareSkyTiles(vals['--ll-sky-bg'], SKY_TILES)
    : ['样式表里找不到 @layer ll.tokens（库的 styles.css 没有加载？）'];
  if (problems.length)
    console.error(
      '[展示页] 星点贴图的参数两处对不上：\n' + problems.map((p) => '  ' + p).join('\n'),
    );
  result.set({ ok: problems.length === 0, problems });
}
