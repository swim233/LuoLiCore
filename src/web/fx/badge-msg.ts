/* 徽记的粒子：每个徽记有自己的小画布，交给星尘 Worker（和新增部件的星尘同一个）画。
   主线程只发这里的消息：加、去掉画布，尺寸和 DPR 变了；放一批粒子；开始、结束持续的特效；时间倍率（开发模式慢放用）。
   形状、颜色都用名字，具体的点和颜色由 Worker 取，消息很小。坐标单位是徽记的 100×100（原点在中心，和 SVG 的 viewBox 一样）；时间单位毫秒，从 Worker 收到时算起。 */

/** 粒子的颜色：一组颜色里随机取 */
export type ColKey =
  | 'goldS' /* 聚成星星：金、金、淡金、白、蓝 */
  | 'spark' /* 金粉、火花：淡金、金、白 */
  | 'sparkGP' /* 伴星掉的金粉：淡金、金 */
  | 'dust' /* 弯月的蓝色星尘 */
  | 'dustGold' /* 蓝色星尘加金 */
  | 'dustWhite' /* 蓝色星尘加白 */
  | 'amber' /* 重试的琥珀色 */
  | 'shatter'; /* 出错的红色碎片 */
/** 单个光点、光环的颜色 */
export type Col =
  'gold' | 'pale' | 'white' | 'tool' | 'toolp' | 'amber' | 'amberp' | 'red' | 'redp' | 'flare';

/** 一批点的形状：从哪里出发、到哪里去 */
export type Shape =
  | { t: 'moon' } /* 弯月的轮廓和内部 */
  | { t: 'star'; k?: number } /* 四角星的轮廓和内部，k 是缩放（默认 1） */
  | { t: 'ring'; r: [number, number] } /* 随机角度，半径在 r 之间 */
  | { t: 'at'; x: number; y: number; j?: number }; /* 一个位置，每个点在 ±j 里抖动 */

/** 持续的特效。on 为真时开始（淡入），之后由 bd-stop（淡出 0.32 秒）或 bd-reset 结束 */
export type FxName =
  | 'motes' /* 思考：三颗拖尾光点绕着转 */
  | 'scan' /* 工具：雷达扫描弧，每 1.4 秒放一个光环 */
  | 'redglow' /* 出错：留一点红光 */
  | 'tipsWait' /* 关掉动画时「等待合并」的静态图：一圈亮点 */
  | 'tipsReply' /* 关掉动画时「回复中」的静态图：两个尖上的亮点 */
  | 'charge' /* 等待合并：星尘从四周往弯月里聚（every 毫秒一颗） */
  | 'rain'; /* 回复中：金粉不断往下落（每 every 毫秒以 p 的概率落 n 颗，n 带小数时按概率取整） */

export type Op =
  | {
      op: 'move';
      from: Shape;
      to: Shape;
      n: number;
      dur: [number, number];
      r: [number, number];
      cols: ColKey;
      /** 两头的点按角度排序再一一对应（弯月和星星互相变） */
      sort?: boolean;
      swirl?: number;
      shift?: number;
      fo?: number;
      delay?: number;
      stagger?: number;
    }
  | {
      op: 'drift';
      x: number;
      y: number;
      n: number;
      sp: [number, number];
      life: [number, number];
      r: [number, number];
      cols: ColKey;
      /** 出发方向（弧度）；不给就是四面八方 */
      ang?: number;
      spread?: number;
      /** 重力：有就是往下落的粒子 */
      g?: number;
      up?: number;
      jit?: number;
      delay?: number;
    }
  | { op: 'flash'; x: number; y: number; r: number; col: Col; life?: number }
  /** 亮一下再暗下去的光点（尖上的柔光、伴星的闪光） */
  | { op: 'pulse'; x: number; y: number; r: number; col: Col; dur: number }
  | { op: 'ring'; r0: number; r1: number; w: number; a: number; col: Col; dur: number }
  /** 出错：星星碎成红色星尘落下 */
  | { op: 'shatter'; n: number }
  | {
      op: 'fx';
      fx: FxName;
      /** 淡入的毫秒数；不给用默认值 */
      fin?: number;
      /** 画固定的一帧（关掉动画时的静态图）：给的是时间值 */
      fixed?: number;
      every?: number;
      p?: number;
      n?: number;
    };

export type BadgeMsg =
  | { type: 'bd-add'; id: number; canvas: OffscreenCanvas; s: number; dpr: number }
  | { type: 'bd-size'; id: number; dpr: number }
  | { type: 'bd-del'; id: number }
  /** 清空这个徽记的粒子和特效，不淡出（看不见了、关掉动画、重建） */
  | { type: 'bd-reset'; id: number }
  /** 现有的特效淡出（0.32 秒）；粒子照常飘完 */
  | { type: 'bd-stop'; id: number }
  | { type: 'bd-do'; id: number; ops: Op[] }
  /** 时间倍率：开发模式的慢放。正式构建里永远是 1 */
  | { type: 'bd-rate'; rate: number }
  | { type: 'bd-stats' };

/** Worker 回给主线程的：每个徽记画了多少帧、此刻有多少粒子和特效（检查「看不见时不画」用） */
export interface BadgeStats {
  id: number;
  frames: number;
  parts: number;
  fx: number;
}
export type BadgeReply = { type: 'bd-stats'; stats: BadgeStats[]; rafs: number };
