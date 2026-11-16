/// <reference lib="webworker" />
import { particleMessage } from '../src/fx';
import type { ParticleMsg } from '../src/fx';
/* 展示页的星尘 Worker 入口：只有库的粒子处理（particleMessage）。面板里这个入口还要先问徽记的小画布认不认，这里没有徽记 */
self.onmessage = (e: MessageEvent<ParticleMsg>) => {
  particleMessage(e.data);
};
export {};
