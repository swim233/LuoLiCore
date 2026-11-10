import { describe, expect, it } from 'vitest';
import { chooseOrder, flowWrap, packDense } from './dragLayout';
import type { Pt, Size, Span } from './dragLayout';

/* 整理拖动换位的纯计算：只测函数，不碰 DOM */

/* 默认布局（4 列）：会话 2×2、对话 1×2、设置 1×1、任务 1×2 */
const SPANS: Record<string, Span> = {
  sessions: [2, 2],
  chat: [1, 2],
  settings: [1, 1],
  tasks: [1, 2],
};
const grid = (cols: number, spans: Record<string, Span>) => (order: readonly string[]) =>
  packDense(
    cols,
    order.map((id) => spans[id]),
  );
/* 格子（列、行，从 0 起）的中间 */
const cell = (col: number, row: number): Pt => ({ x: col + 0.5, y: row + 0.5 });
const ORDER = ['sessions', 'chat', 'settings', 'tasks'];

function move(dragged: string, p: Pt, order = ORDER, near?: Pt[]) {
  return chooseOrder({ order, dragged, layout: grid(4, SPANS), point: p, near });
}

describe('packDense：和 CSS 网格 row dense 一样的排布', () => {
  it('默认布局', () => {
    expect(grid(4, SPANS)(ORDER)).toEqual([
      { x: 0, y: 0, w: 2, h: 2 },
      { x: 2, y: 0, w: 1, h: 2 },
      { x: 3, y: 0, w: 1, h: 1 },
      { x: 3, y: 1, w: 1, h: 2 },
    ]);
  });
  it('后面的小卡填进前面留下的空位', () => {
    expect(
      packDense(3, [
        [2, 2],
        [2, 2],
        [1, 1],
      ]),
    ).toEqual([
      { x: 0, y: 0, w: 2, h: 2 },
      { x: 0, y: 2, w: 2, h: 2 },
      { x: 2, y: 0, w: 1, h: 1 },
    ]);
  });
  it('通栏（列数写得很大）收到列数以内，占满一行', () => {
    expect(
      packDense(3, [
        [1, 1],
        [99, 1],
        [1, 1],
      ]),
    ).toEqual([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0, y: 1, w: 3, h: 1 },
      { x: 1, y: 0, w: 1, h: 1 },
    ]);
  });
});

describe('chooseOrder：网格', () => {
  it('小卡拖到大卡：只有排好以后能盖住指针的那一格会换位，其余三格不动', () => {
    expect(move('settings', cell(0, 0))).toEqual(['settings', 'sessions', 'chat', 'tasks']);
    expect(move('settings', cell(1, 0))).toBeNull();
    expect(move('settings', cell(0, 1))).toBeNull();
    expect(move('settings', cell(1, 1))).toBeNull();
  });

  it('大卡拖到小卡：换到能盖住指针的位置', () => {
    expect(move('sessions', cell(3, 0))).toEqual(['chat', 'settings', 'sessions', 'tasks']);
  });

  it('现在的排布已经盖住指针，不动', () => {
    expect(move('settings', cell(3, 0))).toBeNull();
    expect(move('sessions', cell(1, 1))).toBeNull();
    expect(move('tasks', cell(3, 2))).toBeNull();
  });

  it('指针附近的点被盖住也不动（停在两格交界处）；没有这些点就换位', () => {
    expect(move('settings', cell(2, 0), ORDER, [cell(3, 0)])).toBeNull();
    expect(move('settings', cell(2, 0))).toEqual(['sessions', 'settings', 'chat', 'tasks']);
  });

  it('有几个位置都能盖住时，取离现在的位置最近的', () => {
    /* 2 列：x、A 是 1×1，W 占满一行。x 排在 A 后面、W 后面，都落在第一行的右格（1,0）：从最前面拖过去，取近的（A 后面） */
    const spans: Record<string, Span> = { x: [1, 1], A: [1, 1], W: [2, 1] };
    const layout = grid(2, spans);
    expect(layout(['A', 'x', 'W'])[1]).toEqual({ x: 1, y: 0, w: 1, h: 1 });
    expect(layout(['A', 'W', 'x'])[2]).toEqual({ x: 1, y: 0, w: 1, h: 1 });
    const r = chooseOrder({ order: ['x', 'A', 'W'], dragged: 'x', layout, point: cell(1, 0) });
    expect(r).toEqual(['A', 'x', 'W']);
  });

  it('指针在最后一张卡后面的空白处：放到最后', () => {
    /* 第三行是空的（前三格），对话（1×2）怎么插都盖不住（1,2）这一格 */
    expect(move('chat', cell(1, 2))).toEqual(['sessions', 'settings', 'tasks', 'chat']);
    /* 小卡可以直接排到那一格，结果同样是放到最后 */
    expect(move('settings', cell(0, 2))).toEqual(['sessions', 'chat', 'tasks', 'settings']);
  });

  it('指针在整个网格下面（y 无穷大）：放到最后；已经在最后就不动', () => {
    const below: Pt = { x: 0, y: Infinity };
    expect(move('sessions', below)).toEqual(['chat', 'settings', 'tasks', 'sessions']);
    expect(move('tasks', below)).toBeNull();
  });

  it('end 为 false：「放到最后」不做（拖动时要停够时间才做），能盖住指针的换位照常', () => {
    const noEnd = (dragged: string, p: Pt) =>
      chooseOrder({ order: ORDER, dragged, layout: grid(4, SPANS), point: p, end: false });
    expect(noEnd('chat', cell(1, 2))).toBeNull();
    expect(noEnd('sessions', { x: 0, y: Infinity })).toBeNull();
    expect(noEnd('settings', cell(0, 2))).toEqual(['sessions', 'chat', 'tasks', 'settings']);
    expect(noEnd('settings', cell(0, 0))).toEqual(['settings', 'sessions', 'chat', 'tasks']);
  });

  it('指针在空白格上、但后面还有别的卡（不是最后面）：盖不住就不动', () => {
    /* 3 列：a 占左边两行，b 占满第三行，c 填进 a 右边的空位。(2,1) 是空的，下面还有 b */
    const spans: Record<string, Span> = { a: [1, 2], b: [3, 1], c: [1, 1] };
    const order = ['a', 'b', 'c'];
    const layout = grid(3, spans);
    expect(layout(order)).toEqual([
      { x: 0, y: 0, w: 1, h: 2 },
      { x: 0, y: 2, w: 3, h: 1 },
      { x: 1, y: 0, w: 1, h: 1 },
    ]);
    expect(chooseOrder({ order, dragged: 'c', layout, point: cell(2, 1) })).toBeNull();
    /* b 所在的第三行以下才是最后面：a 拖到那里，放到最后 */
    expect(chooseOrder({ order, dragged: 'a', layout, point: cell(2, 3) })).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('被拖的不在顺序里：不动', () => {
    expect(move('nope', cell(0, 0))).toBeNull();
  });

  it('只剩被拖的一个：不动', () => {
    const r = chooseOrder({
      order: ['a'],
      dragged: 'a',
      layout: grid(4, { a: [1, 1] }),
      point: cell(2, 3),
    });
    expect(r).toBeNull();
  });

  /* 核心性质：换位以后，同一个指针位置再算一次一定不动，所以指针停住不会来回换。
     穷举：几种大小的组合、所有顺序、每个被拖的部件、每个格子（含网格下面），列数 2、3、4 */
  it('换位的结果再算一次不动（所有顺序、所有格子）', () => {
    const sets: Record<string, Span>[] = [
      { a: [2, 2], b: [1, 2], c: [1, 1], d: [1, 2], e: [1, 1] },
      { a: [2, 1], b: [2, 2], c: [1, 1], d: [1, 1], e: [99, 1] },
      { a: [1, 1], b: [1, 1], c: [2, 2], d: [1, 2], e: [2, 1] },
    ];
    const perms = (xs: string[]): string[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]),
          );
    let moved = 0;
    for (const cols of [2, 3, 4]) {
      for (const spans of sets) {
        const layout = grid(cols, spans);
        for (const order of perms(['a', 'b', 'c', 'd', 'e'])) {
          for (const dragged of order) {
            for (let row = 0; row <= 7; row++) {
              for (let col = 0; col < cols; col++) {
                const point = row === 7 ? { x: col + 0.5, y: Infinity } : cell(col, row);
                const next = chooseOrder({ order, dragged, layout, point });
                if (!next) continue;
                moved++;
                expect([...next].sort()).toEqual([...order].sort());
                expect(chooseOrder({ order: next, dragged, layout, point })).toBeNull();
                /* 换完以后被拖的盖住指针，或者放到了最后 */
                const box = layout(next)[next.indexOf(dragged)];
                const last = next[next.length - 1] === dragged;
                const covered =
                  point.x >= box.x &&
                  point.x < box.x + box.w &&
                  point.y >= box.y &&
                  point.y < box.y + box.h;
                expect(covered || last).toBe(true);
              }
            }
          }
        }
      }
    }
    expect(moved).toBeGreaterThan(1000);
  }, 30_000);
});

/* 胶囊那一排：宽度各不相同，放不下就换行 */
const H = 44;
const SIZES: Record<string, Size> = {
  now: { w: 260, h: H },
  sessions: { w: 199, h: H },
  chat: { w: 147, h: H },
  settings: { w: 254, h: H },
  tasks: { w: 240, h: H },
};
const flow = (width: number) => (order: readonly string[]) =>
  flowWrap(
    width,
    10,
    10,
    order.map((id) => SIZES[id]),
  );
const CAPS = ['now', 'sessions', 'chat', 'settings', 'tasks'];

describe('flowWrap', () => {
  it('放不下就换行，一行的高度取这一行里最高的', () => {
    const b = flowWrap(500, 10, 8, [
      { w: 200, h: 40 },
      { w: 200, h: 50 },
      { w: 200, h: 30 },
    ]);
    expect(b).toEqual([
      { x: 0, y: 0, w: 200, h: 40 },
      { x: 210, y: 0, w: 200, h: 50 },
      { x: 0, y: 58, w: 200, h: 30 },
    ]);
  });
  it('刚好放满一行不换行；比一行还宽的单独一行', () => {
    const b = flowWrap(410, 10, 10, [
      { w: 200, h: 20 },
      { w: 200, h: 20 },
      { w: 500, h: 20 },
    ]);
    expect(b.map((x) => [x.x, x.y])).toEqual([
      [0, 0],
      [210, 0],
      [0, 30],
    ]);
  });
});

describe('chooseOrder：胶囊那一排', () => {
  const run = (dragged: string, p: Pt, order = CAPS, near?: Pt[]) =>
    chooseOrder({ order, dragged, layout: flow(520), point: p, near });

  it('拖到另一个胶囊的位置上：换到它的前面', () => {
    /* 第一行是「此刻」「会话」，指针在「此刻」左边 */
    expect(run('chat', { x: 30, y: 20 })).toEqual(['chat', 'now', 'sessions', 'settings', 'tasks']);
  });

  it('窄的拖到宽的右半边：排好以后盖不住，不动（以前会来回换）', () => {
    expect(run('chat', { x: 208, y: 22 })).toBeNull();
  });

  it('现在就盖住指针：不动', () => {
    expect(run('now', { x: 100, y: 20 })).toBeNull();
  });

  it('最后一行右边的空白：放到最后', () => {
    /* 最后一行只有「任务」（240 宽），指针在它右边 */
    expect(run('now', { x: 400, y: 2 * (H + 10) + 20 })).toEqual([
      'sessions',
      'chat',
      'settings',
      'tasks',
      'now',
    ]);
  });

  it('两个胶囊之间的缝、行与行之间的缝：不动', () => {
    expect(run('tasks', { x: 265, y: 20 })).toBeNull();
    expect(run('tasks', { x: 100, y: H + 4 })).toBeNull();
  });

  it('换位的结果再算一次不动（所有顺序、所有位置、几种宽度）', () => {
    const perms = (xs: string[]): string[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]),
          );
    let moved = 0;
    for (const width of [330, 520, 800]) {
      const layout = flow(width);
      for (const order of perms(CAPS)) {
        for (const dragged of order) {
          for (const y of [10, 30, 50, 64, 84, 120, 150, 200]) {
            for (let x = 5; x < width; x += 41) {
              const point = { x, y };
              const next = chooseOrder({ order, dragged, layout, point });
              if (!next) continue;
              moved++;
              expect(chooseOrder({ order: next, dragged, layout, point })).toBeNull();
            }
          }
        }
      }
    }
    expect(moved).toBeGreaterThan(1000);
  }, 30_000);
});
