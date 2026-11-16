import { hashStr } from '../util';

/** 名字的颜色：每人一个固定的颜色，按 key 算（用户 id，没有就用名字），同一个人永远同一个颜色；颜色本身在 :root 的 --ll-who-0…9 */
const PALETTE = Array.from({ length: 10 }, (_, i) => `var(--ll-who-${i})`);
export const colorOf = (key: string): string => PALETTE[hashStr(key) % PALETTE.length];
