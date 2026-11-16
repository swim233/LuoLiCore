/* 可以固定种子的随机数：星空和星尘的 Worker 里所有的随机都走这里。
   不给种子时就是 Math.random，行为和以前完全一样；给了种子，每次启动画出来的星点、粒子都一样，可以逐像素比（测试、截图对比用）。
   算法是 mulberry32（32 位整数种子，一次出一个 [0, 1) 的数），写成纯函数，别的地方要用同一个序列对照时照这个公式写就行。 */
export function seededRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 没给种子就是 Math.random（每次调用时现取，和直接写 Math.random() 一样），给了就是固定种子的序列 */
export function makeRandom(seed?: number): () => number {
  return seed === undefined ? () => Math.random() : seededRandom(seed);
}
