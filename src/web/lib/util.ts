/* 基础工具：随机、时间格式、哈希。原页面第 0 节 */
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
export function fmtDay(ms: number) {
  const today = startOfDay(Date.now());
  if (ms >= today) return fmtTime(ms);
  if (ms >= today - 864e5) return '昨天 ' + fmtTime(ms);
  const d = new Date(ms);
  return d.getMonth() + 1 + '-' + pad2(d.getDate()) + ' ' + fmtTime(ms);
}
export function fmtShort(ms: number) {
  const today = startOfDay(Date.now());
  if (ms >= today) return fmtTime(ms);
  if (ms >= today - 864e5) return '昨天';
  const d = new Date(ms);
  return d.getMonth() + 1 + '-' + pad2(d.getDate());
}
export function relTime(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 50) return '刚刚';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}
/** 上次回复的说法：1 分钟内「刚刚回复过」，其余「上次回复在 X 前」 */
export const recentReply = (ms: number) => Date.now() - ms < 60e3;
export const lastReplyText = (ms: number) =>
  recentReply(ms) ? '刚刚回复过' : '上次回复在 ' + relTime(ms);
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
