/* 「此刻」终端的上推：这一次提交里，有多少高度的变化该用「整体往下挪回去再推回原位」表现。
   总高变了不一定是新内容来了：挂载后第一次量出真实行高、开头补进来较早的行、窗口宽度变化引起折行变化，都只是位置的修正，不该推。
   所以按行算，只数「该推的行」的变高：
   - 挂上以后才来的行（live）：新来的算全高（带上行间的缝）；它先按估计高度挂上、量出真实高度后又变一次，这次修正也算
     （上推动画从还没推完的偏移出发，能接上前一次）；之后只有它是最后一行时变长才算；
   - 挂上时就有的最后一行（比如挂上时正在逐字出的那一行）：它第一次量出真实高度那次不算，之后变长才算；
   - 开头补进来的行、挂上时就有的其他行：不算。
   「第一次量出真实高度」：一行第一次画出来（born）那次提交里按估计高度，下一次提交里是量到的真实高度。 */
export interface PushInput {
  /** 现在每一行的 id，按顺序 */
  ids: readonly string[];
  /** 这次提交里每一行的高度（量到的，没量到的是估计的）；上次提交的在 prev */
  sizes: ReadonlyMap<string, number>;
  prev: ReadonlyMap<string, number>;
  /** 挂上以后才来的行 */
  live: ReadonlySet<string>;
  /** 每一行第一次画出来是第几次提交 */
  born: ReadonlyMap<string, number>;
  /** 这是第几次提交（从 0 起） */
  no: number;
  /** 行与行之间的缝 */
  gap: number;
}
export function pushAmount(p: PushInput): number {
  let dy = 0;
  p.ids.forEach((id, i) => {
    const size = p.sizes.get(id) ?? 0;
    const before = p.prev.get(id);
    const isLive = p.live.has(id);
    if (before === undefined) {
      /* 新出现的行：挂上以后才来的算全高；开头补进来的、挂上时就有的不算 */
      if (isLive && p.no > 0) dy += size + p.gap;
      return;
    }
    if (size <= before) return;
    const isLast = i === p.ids.length - 1;
    const age = p.no - (p.born.get(id) ?? p.no);
    const counts = isLive ? isLast || age <= 1 : isLast && age > 1;
    if (counts) dy += size - before;
  });
  return dy;
}
