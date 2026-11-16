/* 星空 Worker 和主线程之间的消息（sky.ts 发，sky.worker.ts 收） */
export type SkyMsg =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      w: number;
      h: number;
      dpr: number;
      colors: Record<string, string>;
      narrow: boolean;
      lowPower: boolean;
      motion: boolean;
      fps: number;
      /** 固定种子：不给就用 Math.random，行为和不加这一项时一样 */
      seed?: number;
    }
  | { type: 'size'; w: number; h: number; dpr: number; narrow: boolean }
  | { type: 'motion'; on: boolean }
  | { type: 'hold'; on: boolean }
  | { type: 'con'; id: number; dotAlpha?: number[]; lineAlpha?: number[] };
