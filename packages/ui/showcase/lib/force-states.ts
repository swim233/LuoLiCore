/* 「强制显示悬停 / 焦点」：控件的悬停、键盘焦点要不靠鼠标和键盘就能摆出来看。
   做法：把样式表里选择器含 :hover、:focus-visible 的库的规则（选择器里有 .ll-…），和对比块里「现在」那边的旧规则（选择器里有 .sc-legacy，legacy/ 里抄来的）各复制一条，
   紧挨着原来那条，选择器里的 :hover 换成 .sc-hover、:focus-visible 换成 .sc-focus；给元素加上这两个类就是那个状态。
   复制出来的规则和原来的一样在 @layer 和 @media 里面，次序也一样，所以和真的悬停、真的焦点画出来的相同。
   样式热更新以后样式表换了，要再跑一次（main.tsx 里的 refresh）。 */
const FORCE = /:hover|:focus-visible/;
const MINE = /\.ll-|\.sc-legacy/;
const DONE = /\.sc-hover|\.sc-focus/;

function walk(parent: CSSStyleSheet | CSSGroupingRule) {
  const rules = parent.cssRules;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r instanceof CSSStyleRule) {
      const sel = r.selectorText;
      if (!FORCE.test(sel) || !MINE.test(sel) || DONE.test(sel)) continue;
      const forced = sel
        .replaceAll(':hover', '.sc-hover')
        .replaceAll(':focus-visible', '.sc-focus');
      parent.insertRule(`${forced} { ${r.style.cssText} }`, i + 1);
      i++;
    } else if (r instanceof CSSGroupingRule) {
      walk(r);
    }
  }
}

export function installForcedStates() {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet);
    } catch {
      /* 别的来源的样式表读不了，不用管 */
    }
  }
}
