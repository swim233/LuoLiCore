/* 气泡里垫的那层星空要和窗口里的星空对齐（app.css 的 .bubble-sky）：这层背景按窗口的大小铺，起点是窗口的左上角，
   所以要把它相对气泡自己的左上角挪「窗口的左上角相对气泡的左上角」那么远，也就是气泡在窗口里的位置取负。
   位置用屏幕上量到的矩形算：窗口在形变里带着缩放（k）时，两个矩形都按 k 缩，差也按 k 缩，除回来就是排版的像素。
   cardW、cardH 是窗口排版的大小（offsetWidth、offsetHeight，不受缩放影响）；量不出来（窗口还没有大小）返回 null */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface SkyShift {
  /** 背景相对气泡左上角的位移（排版像素） */
  x: number;
  y: number;
  /** 背景要铺的大小：窗口的大小 */
  w: number;
  h: number;
}
export function skyShift(bubble: Box, card: Box, cardW: number, cardH: number): SkyShift | null {
  if (cardW < 1 || cardH < 1 || card.width < 1 || card.height < 1) return null;
  const kx = card.width / cardW,
    ky = card.height / cardH;
  return { x: (card.left - bubble.left) / kx, y: (card.top - bubble.top) / ky, w: cardW, h: cardH };
}
