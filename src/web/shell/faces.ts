/* 部件在页面上的元素：卡片（.w）、卡片里的外观层（.w-card）、胶囊（.cap-wrap、.cap）。
   组件用 ref 登记，形变、遮挡判断、闪光这些命令式的东西靠它找到真实的 DOM */
export interface Faces {
  wrap?: HTMLElement | null;
  card?: HTMLElement | null;
  cap?: HTMLElement | null;
  capBtn?: HTMLElement | null;
}
const map = new Map<string, Faces>();
export const faces = (id: string): Faces => {
  let f = map.get(id);
  if (!f) map.set(id, (f = {}));
  return f;
};
export const setFace = (id: string, key: keyof Faces) => (el: HTMLElement | null) => {
  faces(id)[key] = el;
};
export const allFaces = () => map;
/* 全屏窗口里的那一份 */
export const fsFace: Faces = {};
