/* 折叠的开合和浏览器自己的开合对上：浏览器会在页面内查找（Ctrl+F）命中收着的 <details> 里的字时自己把它打开，
   这时 DOM 的 open 是开的、React 记着（或用的地方传进来）的还是关的。点头时库自己挡掉浏览器的开合，所以只有这种「外面改了 DOM」的情况才会走到这里
   （details 的 toggle 事件里对一下）。纯函数，不碰 DOM，行为测试直接测它。 */
export interface FoldSyncPlan {
  /** 不受控：把记着的状态改成这个（DOM 里的样子） */
  adopt?: boolean;
  /** 调 onOpenChange，参数是这个（DOM 里的样子） */
  notify?: boolean;
  /** 受控：用的地方没跟着改的话，要把 DOM 改回 open 属性传进来的样子（由用的地方有没有跟着改决定，下一帧再看） */
  revertIfUnchanged?: boolean;
}

/** dom：toggle 事件里 DOM 的 open；now：现在记着的（受控是传进来的 open，不受控是自己记的）；controlled：是不是受控 */
export function syncOpen({
  dom,
  now,
  controlled,
}: {
  dom: boolean;
  now: boolean;
  controlled: boolean;
}): FoldSyncPlan {
  if (dom === now) return {};
  return controlled ? { notify: dom, revertIfUnchanged: true } : { adopt: dom, notify: dom };
}
