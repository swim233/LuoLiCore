import { normalizeItem } from './list-edit';

/* 列表编辑「画面上的行」的纯逻辑，不碰 DOM。
   数据（string[]）和画面分开：数据在点删除的那一刻就少了一项，画面上那一行还留着一会儿（收起来的动画），收完才真的拿掉。
   所以画面上的行比数据多出「正在离开的」：
   - 每一行有自己的 id（key、删哪一行都认 id，不认下标，所以两行内容一样时动的是被点的那一行）；
   - 阶段 phase：idle 平常的、entering 刚加的（正在长出来）、leaving 正在离开（数据里已经没有它了，字是离开那一刻冻住的）；
   - 活着的行（不是 leaving 的）按顺序和数据一一对应：第 i 个活着的行就是数据里的第 i 项。 */
export type RowPhase = 'idle' | 'entering' | 'leaving';
export interface Row {
  id: string;
  /** 只有 leaving 的行用它（离开那一刻的字）；活着的行的字取自数据 */
  text: string;
  phase: RowPhase;
}

let seq = 0;
/** 新的行 id（整个页面里不重复） */
export const newRowId = () => `r${++seq}`;

/** 初次渲染、或者外面把整个数据换掉时：每项一行，都是平常的（不播动画） */
export function initRows(items: readonly string[], newId: () => string = newRowId): Row[] {
  return items.map(() => ({ id: newId(), text: '', phase: 'idle' }));
}

/** 活着的行有几个 */
export function liveCount(rows: readonly Row[]): number {
  let n = 0;
  for (const r of rows) if (r.phase !== 'leaving') n++;
  return n;
}

/** 这个 id 是活着的行里的第几个；不是活着的（没有、或正在离开）返回 -1 */
export function liveIndexOf(rows: readonly Row[], id: string): number {
  let n = 0;
  for (const r of rows) {
    if (r.phase === 'leaving') continue;
    if (r.id === id) return n;
    n++;
  }
  return -1;
}

/** 在第 liveIndex 个活着的行前面插一行新的（entering）；liveIndex 到头了就插在最后。正在离开的行留在原来的位置，新行插在它们后面 */
export function insertRow(rows: readonly Row[], liveIndex: number, id: string): Row[] {
  const row: Row = { id, text: '', phase: 'entering' };
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.phase === 'leaving') continue;
    if (n === liveIndex) return [...rows.slice(0, i), row, ...rows.slice(i)];
    n++;
  }
  return [...rows, row];
}

/** 这一行开始离开（冻住字）；没有这一行、已经在离开的原样返回 */
export function leaveRow(rows: readonly Row[], id: string, text: string): Row[] {
  const i = rows.findIndex((r) => r.id === id);
  const r = rows[i];
  if (!r || r.phase === 'leaving') return [...rows];
  return rows.map((x, j) => (j === i ? { ...x, text, phase: 'leaving' } : x));
}

/** 长出来了：entering 变成平常的 */
export function settleRow(rows: readonly Row[], id: string): Row[] {
  return rows.map((r) => (r.id === id && r.phase === 'entering' ? { ...r, phase: 'idle' } : r));
}

/** 离开完了：真的拿掉（只拿 leaving 的，活着的行不会被它误删） */
export function dropRow(rows: readonly Row[], id: string): Row[] {
  return rows.filter((r) => !(r.id === id && r.phase === 'leaving'));
}

/** 数据被外面换了（长度和活着的行对不上，比如「重置」）：整个重来，不播动画、也没有正在离开的；对得上就原样 */
export function reconcileRows(
  rows: readonly Row[],
  items: readonly string[],
  newId: () => string = newRowId,
): readonly Row[] {
  return liveCount(rows) === items.length ? rows : initRows(items, newId);
}

/** 第一个空着的活着的行（刚点了「添加」还没填的那一行）的 id；没有返回 null */
export function firstBlankRow(rows: readonly Row[], items: readonly string[]): string | null {
  let n = 0;
  for (const r of rows) {
    if (r.phase === 'leaving') continue;
    if (normalizeItem(items[n++] ?? '') === null) return r.id;
  }
  return null;
}

/** 焦点离开整个列表时：所有空着的活着的行一起离开（冻住字），数据里去掉它们；一个空行也没有返回 null */
export function pruneBlankRows(
  rows: readonly Row[],
  items: readonly string[],
): { rows: Row[]; items: string[] } | null {
  let next: Row[] = [...rows];
  const kept: string[] = [];
  let changed = false;
  let n = 0;
  for (const r of rows) {
    if (r.phase === 'leaving') continue;
    const text = items[n++] ?? '';
    if (normalizeItem(text) === null) {
      next = leaveRow(next, r.id, text);
      changed = true;
    } else {
      kept.push(text);
    }
  }
  return changed ? { rows: next, items: kept } : null;
}
