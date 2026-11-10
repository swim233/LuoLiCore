import { describe, expect, it } from 'vitest';
import { pushAmount } from './push';
import type { PushInput } from './push';

/* 「此刻」终端的上推：哪些高度变化该推、哪些不该 */
const EST = 22;
const GAP = 2;
function run(o: {
  rows: [id: string, size: number][];
  prev: Record<string, number>;
  live?: string[];
  born?: Record<string, number>;
  no: number;
}) {
  const input: PushInput = {
    ids: o.rows.map(([id]) => id),
    sizes: new Map(o.rows),
    prev: new Map(Object.entries(o.prev)),
    live: new Set(o.live ?? []),
    born: new Map(Object.entries(o.born ?? {})),
    no: o.no,
    gap: GAP,
  };
  return pushAmount(input);
}

describe('pushAmount', () => {
  it('挂载后第一次量出真实行高：不推（挂上时按估计的 22 算，下一次提交里量到真实的）', () => {
    const rows: [string, number][] = [
      ['a', 22],
      ['b', 66],
      ['c', 44],
    ];
    expect(
      run({
        rows,
        prev: { a: EST, b: EST, c: EST },
        born: { a: 0, b: 0, c: 0 },
        no: 1,
      }),
    ).toBe(0);
  });

  it('挂上时就有的最后一行：第一次量出真实高度不算，之后变长（逐字）才算', () => {
    const born = { a: 0, b: 0 };
    // 第一次量出：b 22 → 66
    expect(
      run({
        rows: [
          ['a', 22],
          ['b', 66],
        ],
        prev: { a: 22, b: 22 },
        born,
        no: 1,
      }),
    ).toBe(0);
    // 之后：b 66 → 88
    expect(
      run({
        rows: [
          ['a', 22],
          ['b', 88],
        ],
        prev: { a: 22, b: 66 },
        born,
        no: 2,
      }),
    ).toBe(22);
  });

  it('开头补进来较早的行（seed）：不推，也不影响别的行', () => {
    expect(
      run({
        rows: [
          ['s1', 44],
          ['s2', 66],
          ['a', 22],
        ],
        prev: { a: 22 },
        born: { a: 0, s1: 3, s2: 3 },
        no: 3,
      }),
    ).toBe(0);
  });

  it('末尾来了新行：算全高（含缝）；它量出真实高度的那次修正也算', () => {
    const live = ['n'];
    expect(
      run({
        rows: [
          ['a', 22],
          ['n', EST],
        ],
        prev: { a: 22 },
        live,
        born: { a: 0, n: 5 },
        no: 5,
      }),
    ).toBe(EST + GAP);
    // 下一次提交：n 22 → 66
    expect(
      run({
        rows: [
          ['a', 22],
          ['n', 66],
        ],
        prev: { a: 22, n: EST },
        live,
        born: { a: 0, n: 5 },
        no: 6,
      }),
    ).toBe(44);
  });

  it('挂上以后才来的行，过了修正那一次，不是最后一行时变高：不推（比如用户展开了中间的思考）', () => {
    expect(
      run({
        rows: [
          ['t', 66],
          ['x', 22],
        ],
        prev: { t: 22, x: 22 },
        live: ['t', 'x'],
        born: { t: 1, x: 3 },
        no: 8,
      }),
    ).toBe(0);
  });

  it('挂上以后才来的最后一行逐字变长：推', () => {
    expect(
      run({
        rows: [
          ['a', 22],
          ['n', 44],
        ],
        prev: { a: 22, n: 22 },
        live: ['n'],
        born: { a: 0, n: 2 },
        no: 9,
      }),
    ).toBe(22);
  });

  it('变矮不算；挂载那一次提交里（没有上一次）来的行不算', () => {
    expect(
      run({
        rows: [
          ['a', 22],
          ['n', 22],
        ],
        prev: { a: 44, n: 44 },
        live: ['n'],
        born: { a: 0, n: 0 },
        no: 4,
      }),
    ).toBe(0);
    expect(
      run({
        rows: [['a', EST]],
        prev: {},
        live: ['a'],
        born: { a: 0 },
        no: 0,
      }),
    ).toBe(0);
  });

  it('一次提交里几件事：只数该推的行', () => {
    // 开头补进两行（不算）+ 末尾新来一行（算）+ 挂上时就有的中间行变高（不算）
    expect(
      run({
        rows: [
          ['s1', 44],
          ['s2', 44],
          ['m', 88],
          ['n', EST],
        ],
        prev: { m: 22 },
        live: ['n'],
        born: { m: 0, s1: 6, s2: 6, n: 6 },
        no: 6,
      }),
    ).toBe(EST + GAP);
  });
});
