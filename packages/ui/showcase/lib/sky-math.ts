import type { SkyTile } from '../../src/sky-stars';

/* 星点贴图参数一致性检查里的纯逻辑（不碰页面，可以在 node 里测）：
   tokens.css 的 --ll-sky-bg 里写了两层星点贴图的起点和大小（「var(--ll-sky-stars-a) -40px -30px / 640px 390px」这样），
   sky-stars.ts 的 SKY_TILES 里又写了一份，按数值比。读样式表、报错和提示在 sky-check.ts */

/** 从 --ll-sky-bg 的字面值里找出每个星点变量那一层写的 [起点 x, 起点 y, 宽, 高]；找不到的不在结果里 */
export function parseSkyBg(skyBg: string): Record<string, [number, number, number, number]> {
  const out: Record<string, [number, number, number, number]> = {};
  const re =
    /var\((--ll-sky-stars-[a-z0-9-]+)\)\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s*\/\s*([\d.]+)px\s+([\d.]+)px/g;
  for (const m of skyBg.matchAll(re))
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  return out;
}

/** 样式里写的和 JS 里的按数值比，返回对不上的说明（空数组是对得上） */
export function compareSkyTiles(skyBg: string | undefined, tiles: readonly SkyTile[]): string[] {
  if (skyBg == null) return ['tokens.css 里没有 --ll-sky-bg'];
  const css = parseSkyBg(skyBg);
  const problems: string[] = [];
  for (const [name, w, h, x, y] of tiles) {
    const c = css[name];
    if (!c) {
      problems.push(`--ll-sky-bg 里找不到 ${name} 那一层的起点和大小`);
      continue;
    }
    const want = [x, y, w, h];
    if (c.some((n, i) => n !== want[i]))
      problems.push(
        `${name}：tokens.css 写的是 ${c[0]}px ${c[1]}px / ${c[2]}px ${c[3]}px，sky-stars.ts 里是 ${x}px ${y}px / ${w}px ${h}px`,
      );
  }
  for (const name of Object.keys(css))
    if (!tiles.some((t) => t[0] === name))
      problems.push(`--ll-sky-bg 里有 ${name} 这一层，sky-stars.ts 里没有`);
  return problems;
}
