/// <reference lib="webworker" />
import { particleMessage } from '@luoli/ui/fx';
import type { ParticleMsg } from '@luoli/ui/fx';
import { badgeMessage } from './badge-canvas';
import type { BadgeMsg } from './badge-msg';
/* 星尘 Worker 的入口：整屏的星尘（库的 particleMessage）和徽记的小画布（bd- 开头的消息，见 badge-canvas.ts）共用这一个 Worker，各画各的。
   先问徽记认不认，不认再交给库 */
self.onmessage = (e: MessageEvent<ParticleMsg | BadgeMsg>) => {
  const m = e.data;
  if (badgeMessage(m)) return;
  particleMessage(m);
};
export {};
