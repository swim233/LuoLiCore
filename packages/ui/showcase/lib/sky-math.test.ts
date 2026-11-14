import { describe, expect, it } from 'vitest';
import { SKY_TILES } from '../../src/sky-stars';
import { compareSkyTiles, parseSkyBg } from './sky-math';

const GOOD = `linear-gradient(var(--ll-sky-shade), var(--ll-sky-shade)), var(--ll-sky-stars-a) -40px -30px / 640px 390px, var(--ll-sky-stars-b) -200px -90px / 900px 548px, radial-gradient(520px 320px at 25% 0%, var(--ll-sky-glow-a), transparent 70%), var(--ll-sky-base)`;

describe('星点贴图参数的一致性检查', () => {
  it('从 --ll-sky-bg 里读出两层的起点和大小', () => {
    expect(parseSkyBg(GOOD)).toEqual({
      '--ll-sky-stars-a': [-40, -30, 640, 390],
      '--ll-sky-stars-b': [-200, -90, 900, 548],
    });
  });
  it('空格、0 不带 px 的写法都读得出', () => {
    expect(parseSkyBg('var(--ll-sky-stars-a) 0 0/640px 390px')).toEqual({
      '--ll-sky-stars-a': [0, 0, 640, 390],
    });
  });
  it('样式和 sky-stars.ts 一样时不报', () => {
    expect(compareSkyTiles(GOOD, SKY_TILES)).toEqual([]);
  });
  it('任何一个数写错都报，说明里点名是哪个变量', () => {
    const bad = GOOD.replace('640px 390px', '660px 390px');
    const p = compareSkyTiles(bad, SKY_TILES);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('--ll-sky-stars-a');
    expect(compareSkyTiles(GOOD.replace('-90px', '-80px'), SKY_TILES)).toHaveLength(1);
    expect(compareSkyTiles(GOOD.replace('-30px / 640', '-31px / 640'), SKY_TILES)).toHaveLength(1);
  });
  it('样式里少了一层、多了一层、没有 --ll-sky-bg 都报', () => {
    expect(
      compareSkyTiles(GOOD.replace(/var\(--ll-sky-stars-b\)[^,]*,/, ''), SKY_TILES),
    ).toHaveLength(1);
    expect(
      compareSkyTiles(GOOD + ', var(--ll-sky-stars-c) 0 0 / 10px 10px', SKY_TILES),
    ).toHaveLength(1);
    expect(compareSkyTiles(undefined, SKY_TILES)).toHaveLength(1);
  });
});
