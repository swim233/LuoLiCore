import { describe, expect, it } from 'vitest';
import { autosize, charCount, countLabel, rowsToHeight } from './autosize';
import { DEFAULT_FORM_CONFIG, resolveFormConfig } from './config';
import { blurAction, shouldPruneAfterRelease } from './list-blur';
import { numberFormat, sliderValueText } from './value-text';
import {
  cleanList,
  defaultItemLabel,
  hasItem,
  insertBlankAt,
  isDuplicateAt,
  normalizeItem,
  removeAt,
  updateAt,
} from './list-edit';
import {
  dropRow,
  firstBlankRow,
  initRows,
  insertRow,
  leaveRow,
  liveCount,
  liveIndexOf,
  pruneBlankRows,
  reconcileRows,
  settleRow,
} from './list-rows';
import type { Row } from './list-rows';

describe('多行输入长高的计算', () => {
  const base = { lineHeight: 18, padding: 12, minRows: 3, maxRows: 8 };
  it('内容不到最少行数时按最少行数', () => {
    expect(autosize({ ...base, scrollHeight: 30 })).toEqual({ height: 66, overflow: false });
  });
  it('内容在上下限之间时就是内容的高度', () => {
    expect(autosize({ ...base, scrollHeight: 100 })).toEqual({ height: 100, overflow: false });
  });
  it('内容超过最多行数时停在上限，并且要出滚动条', () => {
    expect(autosize({ ...base, scrollHeight: 400 })).toEqual({ height: 156, overflow: true });
  });
  it('内容正好等于上限时不出滚动条（贴着上限不闪滚动条）', () => {
    expect(autosize({ ...base, scrollHeight: 156 })).toEqual({ height: 156, overflow: false });
    expect(autosize({ ...base, scrollHeight: 156.4 })).toEqual({ height: 156, overflow: false });
  });
  it('不给最多行数就不封顶', () => {
    expect(autosize({ ...base, maxRows: undefined, scrollHeight: 5000 })).toEqual({
      height: 5000,
      overflow: false,
    });
  });
  it('最多行数比最少行数还小时以最少行数为准', () => {
    expect(autosize({ ...base, minRows: 4, maxRows: 2, scrollHeight: 500 })).toEqual({
      height: 84,
      overflow: true,
    });
  });
  it('几行对应的高度', () => {
    expect(rowsToHeight(3, 18, 12)).toBe(66);
    expect(rowsToHeight(0, 18, 12)).toBe(12);
    expect(rowsToHeight(-1, 18, 12)).toBe(12);
  });
});

describe('字数', () => {
  it('给了上限写「12 / 200」，没给只写数字', () => {
    expect(countLabel(12, 200)).toBe('12 / 200');
    expect(countLabel(12)).toBe('12');
  });
  it('按「字」数，不是 UTF-16 码元数：表情、生僻字算一个', () => {
    expect(charCount('abc')).toBe(3);
    expect(charCount('洛璃')).toBe(2);
    expect(charCount('😀😀')).toBe(2);
    expect(charCount('𠮷')).toBe(1);
    expect(charCount('')).toBe(0);
  });
});

describe('列表编辑（数据）', () => {
  it('去两头空白，空的是 null', () => {
    expect(normalizeItem('  nori ')).toBe('nori');
    expect(normalizeItem('   ')).toBeNull();
    expect(normalizeItem('')).toBeNull();
  });
  it('删掉第 i 项、改第 i 项，不改原数组', () => {
    const src = ['a', 'b', 'c'];
    expect(removeAt(src, 1)).toEqual(['a', 'c']);
    expect(updateAt(src, 1, 'x')).toEqual(['a', 'x', 'c']);
    expect(removeAt(src, 9)).toEqual(['a', 'b', 'c']);
    expect(src).toEqual(['a', 'b', 'c']);
  });
  it('插一个空行：插在末尾、插在中间，满了不插', () => {
    expect(insertBlankAt(['a'], 1)).toEqual(['a', '']);
    expect(insertBlankAt(['a', 'b'], 1)).toEqual(['a', '', 'b']);
    expect(insertBlankAt(['a', 'b'], 2, { max: 2 })).toEqual(['a', 'b']);
  });
  it('存下来之前过一遍：去空白、去空行、去重复（留第一个），默认不分大小写', () => {
    expect(cleanList([' a ', '', 'b', 'A', '  ', 'b'])).toEqual(['a', 'b']);
    expect(cleanList(['a', 'A'], { caseSensitive: true })).toEqual(['a', 'A']);
    expect(cleanList(['a', 'a'], { unique: false })).toEqual(['a', 'a']);
  });
  it('第 i 项是不是和前面的重复（改某一行时用来标红）', () => {
    expect(isDuplicateAt(['a', 'b', 'a'], 2)).toBe(true);
    expect(isDuplicateAt(['a', 'b', 'a'], 0)).toBe(false);
    expect(isDuplicateAt(['a', '', ''], 2)).toBe(false);
    expect(isDuplicateAt(['a', 'a'], 1, { unique: false })).toBe(false);
  });
  it('hasItem 可以跳过自己那一行', () => {
    expect(hasItem(['a', 'b'], 'a')).toBe(true);
    expect(hasItem(['a', 'b'], 'a', {}, 0)).toBe(false);
  });
});

describe('列表编辑（画面上的行）', () => {
  /* 测试里用固定的 id，好对着看 */
  const ids = (...x: string[]) => {
    let i = 0;
    return () => x[i++] ?? `z${i}`;
  };
  const mk = (phases: string, texts = ''): Row[] =>
    [...phases].map((c, i) => ({
      id: `r${i}`,
      text: texts[i] ?? '',
      phase: c === 'l' ? 'leaving' : c === 'e' ? 'entering' : 'idle',
    }));
  const phases = (rows: readonly Row[]) => rows.map((r) => `${r.id}:${r.phase[0]}`).join(' ');

  it('初次渲染：每项一行，都是平常的（不播动画）', () => {
    const rows = initRows(['a', 'b'], ids('r0', 'r1'));
    expect(phases(rows)).toBe('r0:i r1:i');
  });
  it('活着的行的个数、某个 id 是第几个活着的（正在离开的不算）', () => {
    const rows = mk('ilii');
    expect(liveCount(rows)).toBe(3);
    expect(liveIndexOf(rows, 'r0')).toBe(0);
    expect(liveIndexOf(rows, 'r1')).toBe(-1);
    expect(liveIndexOf(rows, 'r2')).toBe(1);
    expect(liveIndexOf(rows, 'r3')).toBe(2);
    expect(liveIndexOf(rows, 'nope')).toBe(-1);
  });
  it('添加：插在第 n 个活着的行前面，新行是 entering；到头了插在最后', () => {
    expect(phases(insertRow(mk('ii'), 1, 'n'))).toBe('r0:i n:e r1:i');
    expect(phases(insertRow(mk('ii'), 2, 'n'))).toBe('r0:i r1:i n:e');
    expect(phases(insertRow(mk(''), 0, 'n'))).toBe('n:e');
  });
  it('添加时正在离开的行留在原地，新行插在它们后面（用第 n 个活着的行定位置）', () => {
    expect(phases(insertRow(mk('ili'), 1, 'n'))).toBe('r0:i r1:l n:e r2:i');
    expect(phases(insertRow(mk('il'), 1, 'n'))).toBe('r0:i r1:l n:e');
  });
  it('删除：这一行变成 leaving，冻住离开那一刻的字；数据里已经没有它了', () => {
    const rows = leaveRow(mk('iii'), 'r1', '二');
    expect(phases(rows)).toBe('r0:i r1:l r2:i');
    expect(rows[1]?.text).toBe('二');
    expect(liveCount(rows)).toBe(2);
  });
  it('重复点同一行的删除：不再改它（字还是第一次冻住的）', () => {
    const once = leaveRow(mk('ii'), 'r0', '甲');
    const twice = leaveRow(once, 'r0', '乙');
    expect(twice[0]?.text).toBe('甲');
  });
  it('删除没有的 id：什么也不变', () => {
    expect(phases(leaveRow(mk('ii'), 'nope', ''))).toBe('r0:i r1:i');
  });
  it('离开完了：拿掉；只拿 leaving 的，活着的行不会被误删', () => {
    expect(phases(dropRow(mk('ili'), 'r1'))).toBe('r0:i r2:i');
    expect(phases(dropRow(mk('ili'), 'r0'))).toBe('r0:i r1:l r2:i');
  });
  it('长出来了：entering 变平常的；别的阶段不变', () => {
    expect(phases(settleRow(mk('ie'), 'r1'))).toBe('r0:i r1:i');
    expect(phases(settleRow(mk('il'), 'r1'))).toBe('r0:i r1:l');
  });
  it('有重复值的列表删其中一行：动的是被点的那一行（按 id，不按内容）', () => {
    const items = ['a', 'a'];
    const rows = mk('ii');
    const i = liveIndexOf(rows, 'r1');
    const next = leaveRow(rows, 'r1', items[i] ?? '');
    expect(phases(next)).toBe('r0:i r1:l');
    expect(removeAt(items, i)).toEqual(['a']);
  });
  it('连加三行、连删三行、加了马上删、删到一半再加：数据和画面始终对得上', () => {
    let items: string[] = ['a'];
    let rows: readonly Row[] = initRows(items, ids('r0'));
    const n = ids('n1', 'n2', 'n3', 'n4', 'n5');
    const add = () => {
      const at = items.length;
      rows = insertRow(rows, at, n());
      items = insertBlankAt(items, at);
    };
    const del = (id: string) => {
      const i = liveIndexOf(rows, id);
      rows = leaveRow(rows, id, items[i] ?? '');
      items = removeAt(items, i);
    };
    add();
    add();
    add();
    expect(items).toHaveLength(4);
    expect(liveCount(rows)).toBe(4);
    del('n2');
    expect(liveCount(rows)).toBe(items.length);
    add(); // 删到一半（n2 还在离开）再加
    expect(items).toHaveLength(4);
    expect(liveCount(rows)).toBe(4);
    expect(rows.some((r) => r.id === 'n2' && r.phase === 'leaving')).toBe(true);
    del('n1');
    del('n3');
    del('n3'); // 重复点
    expect(items).toHaveLength(2);
    expect(liveCount(rows)).toBe(2);
    for (const id of ['n1', 'n2', 'n3']) rows = dropRow(rows, id);
    expect(rows.every((r) => r.phase !== 'leaving')).toBe(true);
    expect(rows).toHaveLength(2);
    add();
    del('n4'); // 加了马上删
    expect(liveCount(rows)).toBe(items.length);
    rows = dropRow(rows, 'n4');
    expect(rows.map((r) => r.id)).toEqual(['r0', 'n5']);
  });
  it('找第一个空着的行：正在离开的不算，写着空格的也算空', () => {
    expect(firstBlankRow(mk('iii'), ['a', '', 'c'])).toBe('r1');
    expect(firstBlankRow(mk('iii'), ['a', 'b', 'c'])).toBeNull();
    expect(firstBlankRow(mk('ili'), ['a', '  '])).toBe('r2');
    expect(firstBlankRow(mk(''), [])).toBeNull();
  });
  it('焦点离开整个列表：所有空行一起离开、数据里去掉它们；没有空行就什么也不变', () => {
    const out = pruneBlankRows(mk('iiii'), ['a', '', 'c', ' ']);
    expect(out).not.toBeNull();
    expect(phases(out?.rows ?? [])).toBe('r0:i r1:l r2:i r3:l');
    expect(out?.items).toEqual(['a', 'c']);
    expect(pruneBlankRows(mk('ii'), ['a', 'b'])).toBeNull();
    expect(pruneBlankRows(mk('il'), ['a'])).toBeNull();
  });
  it('数据被外面换了（长度对不上）：整个重来，没有正在离开的、不播动画；对得上就原样', () => {
    const rows = mk('ile');
    const same = reconcileRows(rows, ['x', 'y'], ids('q'));
    expect(same).toBe(rows);
    const reset = reconcileRows(rows, ['x'], ids('q0'));
    expect(phases(reset)).toBe('q0:i');
  });
});

describe('列表编辑：焦点离开时空行什么时候消失', () => {
  const base = { toInside: false, toNothing: false, windowHasFocus: true, pointerDown: false };
  it('焦点还在列表里（别的行、删除钮、添加钮）：不收，鼠标按着也不收', () => {
    expect(blurAction({ ...base, toInside: true })).toBe('keep');
    expect(blurAction({ ...base, toInside: true, pointerDown: true })).toBe('keep');
  });
  it('键盘 Tab 出去、代码把焦点挪走：马上收', () => {
    expect(blurAction(base)).toBe('now');
    expect(blurAction({ ...base, toNothing: true })).toBe('now');
  });
  it('鼠标按下带走焦点（点了别的钮、别的输入框、页面空白处）：等抬起以后再收', () => {
    expect(blurAction({ ...base, pointerDown: true })).toBe('after-release');
    expect(blurAction({ ...base, toNothing: true, pointerDown: true })).toBe('after-release');
  });
  it('窗口失焦（焦点没去任何元素、页面也没焦点了）：不收，鼠标按没按着都一样', () => {
    expect(blurAction({ ...base, toNothing: true, windowHasFocus: false })).toBe('keep');
    expect(blurAction({ ...base, toNothing: true, windowHasFocus: false, pointerDown: true })).toBe(
      'keep',
    );
  });
  it('页面没焦点、但焦点去了一个具体的元素（比如 iframe 里的）：照常算离开', () => {
    expect(blurAction({ ...base, windowHasFocus: false })).toBe('now');
  });
  it('抬起以后：焦点回到列表里就不收，不然收', () => {
    expect(shouldPruneAfterRelease(true)).toBe(false);
    expect(shouldPruneAfterRelease(false)).toBe(true);
  });
  it('每一行输入框的读屏名字默认是「第 N 项」', () => {
    expect(defaultItemLabel(0)).toBe('第 1 项');
    expect(defaultItemLabel(4)).toBe('第 5 项');
  });
});

describe('数字输入、滑块的数字怎么写', () => {
  it('默认不加千分位，自己给的选项照用，要千分位自己写', () => {
    expect(numberFormat()).toEqual({ useGrouping: false });
    expect(numberFormat({ minimumFractionDigits: 1 })).toEqual({
      useGrouping: false,
      minimumFractionDigits: 1,
    });
    expect(numberFormat({ useGrouping: true }).useGrouping).toBe(true);
    expect(new Intl.NumberFormat('en-US', numberFormat()).format(7310)).toBe('7310');
    expect(new Intl.NumberFormat('en-US', numberFormat({ useGrouping: true })).format(7310)).toBe(
      '7,310',
    );
  });
  it('滑块给读屏的文字：自己写的字或数字照读，写的是别的就读格式化好的数字加单位', () => {
    expect(sliderValueText({ rendered: '永久', formatted: '0' })).toBe('永久');
    expect(sliderValueText({ rendered: '30 天', formatted: '30' })).toBe('30 天');
    expect(sliderValueText({ rendered: 30, formatted: '30' })).toBe('30');
    expect(sliderValueText({ rendered: { type: 'span' }, formatted: '30', unit: '天' })).toBe(
      '30 天',
    );
    expect(sliderValueText({ formatted: '50', unit: '%' })).toBe('50 %');
    expect(sliderValueText({ formatted: '50' })).toBe('50');
  });
});

describe('表单配置', () => {
  it('什么都不给就是默认的：表单里默认用 lg（高 32、字 13）', () => {
    expect(resolveFormConfig()).toEqual(DEFAULT_FORM_CONFIG);
    expect(DEFAULT_FORM_CONFIG.size).toBe('lg');
    expect(DEFAULT_FORM_CONFIG.layout).toBeUndefined();
  });
  it('后面的盖过前面的，undefined 不盖', () => {
    const c = resolveFormConfig({ size: 'sm' }, { size: undefined, layout: 'row' });
    expect(c.size).toBe('sm');
    expect(c.layout).toBe('row');
  });
});

describe('@luoli/ui/forms 在没有 DOM 的环境里', () => {
  it('能加载，导出的都不是 undefined', async () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    const m = await import('./index');
    const entries = Object.entries(m);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, v] of entries) {
      expect(['function', 'object'], `${name} 是 ${typeof v}`).toContain(typeof v);
      expect(v, name).not.toBeNull();
    }
  });
});
