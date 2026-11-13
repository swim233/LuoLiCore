import type { Bezier } from '../../src/easing';

/* 动画变量一致性检查里的纯逻辑（不碰页面，可以在 node 里测）：时长换算成毫秒、曲线取四个数，按数值比。
   读样式表、读 easing.ts 常量、报错和提示都在 anim-check.ts */
export type Expected = number | Bezier;

/** '200ms'、'.2s'、'0.2s' → 毫秒；别的写法 null */
export function parseTimeMs(v: string): number | null {
  const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round((m[2] === 's' ? n * 1000 : n) * 1e6) / 1e6;
}

/** 'cubic-bezier(0.2, 0.8, 0.2, 1)'、'cubic-bezier(.2,.8,.2,1)' → 四个数；别的写法 null */
export function parseBezier(v: string): Bezier | null {
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(v.trim());
  if (!m) return null;
  const nums = m[1].split(',').map((s) => (/^\s*-?\d*\.?\d+\s*$/.test(s) ? Number(s) : NaN));
  return nums.length === 4 && nums.every((n) => Number.isFinite(n)) ? (nums as Bezier) : null;
}

const show = (e: Expected) => (typeof e === 'number' ? `${e}ms` : `cubic-bezier(${e.join(', ')})`);

/** 静态的一份和 easing.ts 的常量按数值比，返回对不上的说明（空数组是对得上）。
 *  staticVals 是静态那份读到的字面值（没有这个变量的不在里面）；names 是 tokens.css 里全部变量的名字，
 *  用来发现「tokens.css 里有动画变量、easing.ts 没登记」 */
export function compareAnim(
  staticVals: Record<string, string>,
  expected: Record<string, Expected>,
  names: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const [name, exp] of Object.entries(expected)) {
    const got = staticVals[name];
    if (got == null) {
      problems.push(`${name}：tokens.css 里没有静态的这一份（easing.ts 是 ${show(exp)}）`);
      continue;
    }
    const same =
      typeof exp === 'number'
        ? parseTimeMs(got) === exp
        : (() => {
            const b = parseBezier(got);
            return b != null && b.every((n, i) => n === exp[i]);
          })();
    if (!same) problems.push(`${name}：tokens.css 里是 ${got}，easing.ts 是 ${show(exp)}`);
  }
  for (const name of names) {
    if (/^--ll-(dur|ease)-/.test(name) && !(name in expected))
      problems.push(`${name}：tokens.css 里有，easing.ts 没有登记`);
  }
  return problems;
}
