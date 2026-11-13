/* tokens.css 里定义的变量，从页面的样式表里读：@layer ll.tokens 这一层 :root 里的全部自定义属性，按文件里的顺序
   （easing.ts 写进 head 的那份不在层里，不读）。读的是页面上实际生效的样式，不是源文件的文字；
   改了 tokens.css（样式热更新）以后重新读一遍就是新的。
   「变量」一节拿它和分组的数据对一遍（lib/token-diff.ts），动画变量的一致性检查（lib/anim-check.ts）也用它 */

/** 样式表里 ll.tokens 这一层 :root 的自定义属性：名字 → 写的字面值。样式表里找不到这一层（库的 styles.css 没有加载）返回 null */
export function readStaticTokens(sheets: StyleSheetList): Record<string, string> | null {
  const out: Record<string, string> = {};
  let found = false;
  const visit = (rules: CSSRuleList, inTokens: boolean) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSLayerBlockRule) {
        const here = inTokens || rule.name === 'll.tokens';
        if (here) found = true;
        visit(rule.cssRules, here);
      } else if (rule instanceof CSSStyleRule) {
        if (inTokens && rule.selectorText === ':root')
          for (const p of Array.from(rule.style))
            if (p.startsWith('--')) out[p] = rule.style.getPropertyValue(p).trim();
      } else if ('cssRules' in rule) {
        visit((rule as CSSGroupingRule).cssRules, inTokens);
      }
    }
  };
  for (const sheet of Array.from(sheets)) {
    try {
      visit(sheet.cssRules, false);
    } catch {
      /* 跨域的样式表读不了：展示页自己的都是同源的 */
    }
  }
  return found ? out : null;
}

/** tokens.css 里的全部变量名（读不到这一层是 null） */
export function tokenNames(): string[] | null {
  const vals = readStaticTokens(document.styleSheets);
  return vals ? Object.keys(vals) : null;
}
