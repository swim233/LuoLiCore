/* 「变量」一节的分组数据和 tokens.css 对一遍（纯逻辑，页面上和测试里都用它）：
   - ungrouped：tokens.css 里有、分组里没有（要在 data/tokens-groups.ts 里登记）；
   - absent：分组里有、tokens.css 里没有（名字写错了，或者变量已经删了）；
   - duplicated：分组里登记了不止一次。 */
export interface TokenDiff {
  ungrouped: string[];
  absent: string[];
  duplicated: string[];
}

export function diffTokens(sheetNames: readonly string[], listed: readonly string[]): TokenDiff {
  const inSheet = new Set(sheetNames);
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const n of listed) {
    if (seen.has(n) && !duplicated.includes(n)) duplicated.push(n);
    seen.add(n);
  }
  return {
    ungrouped: sheetNames.filter((n) => !seen.has(n)),
    absent: [...seen].filter((n) => !inSheet.has(n)),
    duplicated,
  };
}

/** 有问题时返回一段说明（给 console.error 用），没问题返回空串 */
export function describeDiff(d: TokenDiff): string {
  const parts: string[] = [];
  if (d.ungrouped.length) parts.push(`tokens.css 里有、分组里没有：${d.ungrouped.join('、')}`);
  if (d.absent.length) parts.push(`分组里有、tokens.css 里没有：${d.absent.join('、')}`);
  if (d.duplicated.length) parts.push(`分组里登记了不止一次：${d.duplicated.join('、')}`);
  return parts.length ? `[展示页] 「变量」一节和 tokens.css 对不上：${parts.join('；')}` : '';
}
