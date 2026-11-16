/* 画布的像素比：最多按 2 倍画（再高的屏也不多画，省 Worker 的力气） */
export const dprOf = () => Math.min(2, window.devicePixelRatio || 1);
