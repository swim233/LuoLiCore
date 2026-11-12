import { describe, expect, it } from 'vitest';
import { skyShift } from './skyShift';

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
});

describe('skyShift：气泡里的星空相对气泡左上角的位移', () => {
  it('没有缩放：窗口左上角相对气泡左上角，也就是气泡在窗口里的位置取负；大小是窗口的大小', () => {
    const s = skyShift(box(140, 300, 200, 60), box(100, 80, 640, 480), 640, 480);
    expect(s).toEqual({ x: -40, y: -220, w: 640, h: 480 });
  });

  it('气泡在窗口左上角的外面（滚进标题下面、输入框下面的）位移是正的', () => {
    const s = skyShift(box(110, 60, 200, 60), box(100, 80, 640, 480), 640, 480)!;
    expect(s.x).toBe(-10);
    expect(s.y).toBe(20);
  });

  it('窗口在形变里缩小了一半：量到的矩形都缩了一半，位移换回排版的像素', () => {
    // 排版上气泡在窗口里 (40, 220)，窗口 640×480，缩到一半放在 (300, 200)：气泡在屏幕上 (320, 310)，大小 100×30
    const s = skyShift(box(320, 310, 100, 30), box(300, 200, 320, 240), 640, 480)!;
    expect(s.x).toBeCloseTo(-40, 9);
    expect(s.y).toBeCloseTo(-220, 9);
    expect(s.w).toBe(640);
    expect(s.h).toBe(480);
  });

  it('横竖缩放不一样（形变中的外框）也各自换回来', () => {
    const s = skyShift(box(110, 250, 10, 10), box(100, 100, 320, 480), 640, 480)!;
    expect(s.x).toBeCloseTo(-20, 9);
    expect(s.y).toBeCloseTo(-150, 9);
  });

  it('量不出窗口的大小（还没排版、被收起来了）：返回 null，不写位移', () => {
    expect(skyShift(box(0, 0, 10, 10), box(0, 0, 0, 0), 0, 0)).toBeNull();
    expect(skyShift(box(0, 0, 10, 10), box(0, 0, 100, 100), 0, 100)).toBeNull();
    expect(skyShift(box(0, 0, 10, 10), box(0, 0, 0, 100), 100, 100)).toBeNull();
  });
});
