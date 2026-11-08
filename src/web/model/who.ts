import { hashStr } from '../lib/util';

/* 每人一个固定的颜色：按 uid 算（CLI 没有 uid 时按名字），同一个人永远同一个颜色；颜色本身在 :root 的 --who-0…9 */
const PALETTE = Array.from({ length: 10 }, (_, i) => `var(--who-${i})`);
export const colorOf = (key: string) => PALETTE[hashStr(key) % PALETTE.length];
export const LUOLI = '洛璃';
