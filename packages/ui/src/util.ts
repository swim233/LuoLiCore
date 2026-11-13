/* 通用的小工具：随机、哈希、数字与时间的格式、字符串。只有 cssRGB 要用 DOM（调用时才碰，加载时不碰） */
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const randi = (a: number, b: number) => Math.floor(rand(a, b + 1));
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
/* FNV-1a 32 位：同一个人（用户 id，没有就用名字）永远同一个颜色 */
export function hashStr(s: string) {
  let x = 2166136261;
  for (const c of String(s)) {
    x ^= c.codePointAt(0)!;
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}
export const nf = (n: number) => Math.round(n).toLocaleString('zh-CN');
export const pad2 = (n: number) => String(n).padStart(2, '0');
export const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};
export function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
let idSeq = 0;
export const uid = (p: string) => p + '_' + Date.now().toString(36) + (idSeq++).toString(36);
export const chars = (s: string) => Array.from(s);
export const esc = (s: string) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );

/* 画布要 r,g,b：从 :root 的变量读，浏览器把任何颜色写法规范成 #rrggbb 或 rgba() */
let cvx: CanvasRenderingContext2D | null = null;
export function cssRGB(name: string) {
  cvx ||= document.createElement('canvas').getContext('2d')!;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cvx.fillStyle = '#000';
  cvx.fillStyle = v || '#fff';
  const c = String(cvx.fillStyle);
  if (c[0] === '#') return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(',');
  const m = c.match(/[\d.]+/g);
  return m ? m.slice(0, 3).join(',') : '255,255,255';
}
