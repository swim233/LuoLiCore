import { useSyncExternalStore } from 'react';

const mq = (q: string) => window.matchMedia(q);
export const MQ = {
  narrow: mq('(max-width: 719px)'),
  hover: mq('(hover: hover) and (pointer: fine)'),
  reduced: mq('(prefers-reduced-motion: reduce)'),
};
export const env = {
  get narrow() {
    return MQ.narrow.matches;
  },
  get hover() {
    return MQ.hover.matches;
  },
  lowPower: (navigator.hardwareConcurrency || 8) <= 4,
};
/* 粒子数量：窄屏、性能低时减少 */
export const particleScale = () => (env.narrow ? 0.5 : 1) * (env.lowPower ? 0.5 : 1);

const sub = (m: MediaQueryList) => (fn: () => void) => {
  m.addEventListener('change', fn);
  return () => m.removeEventListener('change', fn);
};
export const useNarrow = () => useSyncExternalStore(sub(MQ.narrow), () => MQ.narrow.matches);
