/* 列表编辑「焦点离开整个列表时，空着的行要不要消失、什么时候消失」的判断，纯函数，不碰 DOM。
   空行一收起，下面的东西（保存钮、人设框……）就跟着往上挪。要是焦点是被鼠标按下带走的，按下那一刻就收，抬起时指针已经不在原来要点的东西上，这一下点击就丢了；
   所以鼠标按下引起的，等这一下鼠标抬起、click 走完再收；键盘 Tab 出去的、代码把焦点挪走的，马上收；窗口失焦（切到别的窗口）不收（回来时光标还在原来的行）。 */
export type BlurAction = 'keep' | 'now' | 'after-release';

export interface BlurInfo {
  /** 焦点去了列表里别的地方（别的行、删除钮、「添加」钮） */
  toInside: boolean;
  /** 焦点没有去任何元素（relatedTarget 是空的：点了页面空白处，或者窗口失焦） */
  toNothing: boolean;
  /** 页面（文档）现在还有没有焦点：窗口失焦时是 false */
  windowHasFocus: boolean;
  /** 鼠标（或笔）正按着：按下发生在这次失焦之前、还没抬起 */
  pointerDown: boolean;
}

export function blurAction(i: BlurInfo): BlurAction {
  if (i.toInside) return 'keep';
  if (i.toNothing && !i.windowHasFocus) return 'keep';
  return i.pointerDown ? 'after-release' : 'now';
}

/** 鼠标抬起、click 走完以后真的要收吗：焦点又回到列表里了（比如点的就是列表里的东西）就不收 */
export function shouldPruneAfterRelease(focusInsideList: boolean): boolean {
  return !focusInsideList;
}

/** 鼠标按下后一直没等到抬起（抬在窗口外面丢了、右键菜单吃掉了……）时，最多等这么久就收，免得空行一直留着 */
export const RELEASE_WAIT_MAX_MS = 5000;
