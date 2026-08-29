import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseSfc, compileScript, compileTemplate } from 'vue/compiler-sfc';
import ts from 'typescript';
import { BROWSER_FILES, UTILITIES, applyChanges, basisOf, duplicateIds, elements, extractAll, extractFile, restore as restoreFiles, translateOf, type Change, type ElementInfo } from '../scripts/copy/extract.js';
import { copyEditPlugin, instrument } from '../scripts/copy/plugin.js';
import { rewind, snapshot, steps } from '../scripts/copy/history.js';
import { fillSlots, slotsOf } from '../scripts/copy/slots.js';
import { code, source } from './support/source.js';

/**
 * 文案改写工具链的两条防线。
 *
 * 其一是生产环境零插桩：dev 文案面板会给每一句文案包一层 `__LUOLI_C__`，该行为只允许发生在
 * `COPY_EDIT=1 `的 dev server 上。共两道闩：插件在缺少该环境变量时返回 `false`（Vite 忽略
 * 假值插件），返回的插件又带 `apply: 'serve'`。缺少任意一道，一次误带环境变量的 `pnpm build`
 * 就会把插桩打入线上产物。
 *
 * 其二是插桩不得破坏源码。此处出现过两次问题：`` `${x ?? '请求失败'}……` `` 中内外两条条目范围重叠，
 * 替换内层后外层 offset 错位，切出一段语法不成立的代码；以及 `placeholder='…&#10;…'` 中的
 * HTML 实体会被模板解析器先解码为真实换行，从而截断 JS 字符串。两次都属于测试全部通过而界面白屏的形态，
 * 因此本断言对每个文件实际解析一遍。
 */
describe('dev 文案面板不进生产', () => {
  it('没有 COPY_EDIT=1 时插件不存在', () => {
    const before = process.env.COPY_EDIT;
    delete process.env.COPY_EDIT;
    expect(copyEditPlugin()).toBe(false);
    if (before !== undefined) process.env.COPY_EDIT = before;
  });
  it('有 COPY_EDIT=1 时也只在 dev server 上生效', () => {
    const before = process.env.COPY_EDIT;
    process.env.COPY_EDIT = '1';
    const plugin = copyEditPlugin();
    expect(plugin).not.toBe(false);
    // `apply: 'serve'` 是第二道闩：`vite build` 阶段该插件不参与。
    expect(plugin && typeof plugin === 'object' ? plugin.apply : null).toBe('serve');
    if (before === undefined) delete process.env.COPY_EDIT; else process.env.COPY_EDIT = before;
  });
  it('运行时那两个文件在 webui 源码树之外，产物里够不着', () => {
    // 生产构建只从 `packages/webui/src` 开始；面板与 `__LUOLI_C__` 都位于 `scripts/` 下，
    // 唯一的引用是插件在 dev 时注入的那一行 import。
    for (const file of BROWSER_FILES) {
      expect(readFileSync(file, 'utf8')).not.toContain('scripts/copy/runtime');
    }
  });
});

describe('插桩后的源码仍然解析得动', () => {
  for (const file of BROWSER_FILES) {
    it(`${file.replace('packages/webui/src/', '')} 插桩后无解析错误`, () => {
      const source = readFileSync(file, 'utf8');
      const instrumented = instrument(source, extractFile(file));
      expect(instrumented).not.toBe('');
      if (file.endsWith('.vue')) {
        const { descriptor, errors } = parseSfc(instrumented, { filename: file });
        expect(errors.map(String)).toEqual([]);
        if (descriptor.template) {
          const script = compileScript(descriptor, { id: file });
          const compiled = compileTemplate({ id: file, filename: file, source: descriptor.template.content,
            compilerOptions: script.bindings ? { bindingMetadata: script.bindings } : {} });
          expect(compiled.errors.map((error) => String(error))).toEqual([]);
          // 这一条是主要防线：`_ctx.__LUOLI_C__` 表示模板编译未将其视为组件作用域内的标识符，
          // 渲染时会立即抛出 TypeError、整页空白，而解析与编译阶段都不报错。
          expect(compiled.code).not.toContain('_ctx.__LUOLI_C__');
        }
        return;
      }
      const parsed = ts.createSourceFile(file, instrumented, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      expect((parsed as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
    });
  }
});

describe('点界面回跳：data-copy-id 挂在元素上', () => {
  const file = 'packages/webui/src/views/ConsoleView.vue';
  const source = readFileSync(file, 'utf8');
  const owners = new Map([...elements(file).values()].map((info) => [info.key, info.attrInsert]));
  const instrumented = instrument(source, extractFile(file), owners);
  it('挂在原有元素上，而不是新包一层', () => {
    // 包一层 span 会影响 12 处 `+ .`、8 处 `:nth-child` 与 4 处 `:last-child`，而使用属性不会。
    expect(instrumented).toContain('data-copy-id="');
    const before = (source.match(/<span/g) ?? []).length;
    const after = (instrumented.match(/<span/g) ?? []).length;
    expect(after).toBe(before);
  });
  it('每个 data-copy-id 里的 id 都是抽取出来的真条目', () => {
    const known = new Set(extractFile(file).map((entry) => entry.id));
    for (const match of instrumented.matchAll(/data-copy-id="([^"]+)"/g)) {
      for (const id of (match[1] ?? '').split(' ')) expect(known, id).toContain(id);
    }
  });
});

/**
 * 下面这几组用真实源码文件作为夹具（写入、断言、再写回）：不引入 mock 层是本仓库的既定做法，
 * 且插桩与落回的判据都基于源码的当前内容，夹具一旦伪造就无法验证任何东西。
 *
 * 有一处代价需要处理：快照必须在每条用例开始时实时读取，不能在模块加载时读取一次。用户可能正打开
 * `COPY_EDIT=1` 的面板修改这两个文件（实测确实如此：运行测试期间 ConsoleView 上新增了两句文案），
 * 而模块加载时的快照会在 `afterEach` 中静默覆盖用户刚保存的内容。
 * 反方向无需处理：保存发生在用例执行中途时，`applyChanges` 会因原文与记录不匹配而拒绝，不会写坏文件。
 */
describe('自由拖拽定位：偏移写成元素自己的 translate', () => {
  const file = 'packages/webui/src/views/LoginView.vue';
  let restore = '';
  beforeEach(() => { restore = readFileSync(file, 'utf8'); });
  afterEach(() => writeFileSync(file, restore));

  const pick = (): ElementInfo => {
    const hit = [...elements(file).values()].find((info) => info.attrInsert > 0 && !info.styleAttr);
    expect(hit, '找不到可拖的元素').toBeDefined();
    return hit!;
  };
  const nowAt = (): ElementInfo | undefined => [...elements(file).values()].find((info) => info.styleAttr?.value.includes('translate'));
  const drag = (key: string, dx: number, dy: number): ReturnType<typeof applyChanges> =>
    applyChanges([{ kind: 'style', file, key, dx, dy }]);

  it('拖过再归位 = 一个字节都没变', () => {
    expect(drag(pick().key, 12, -4).applied).toBe(1);
    expect(readFileSync(file, 'utf8')).toContain('style="translate: 12px -4px"');
    // 归位时需连同整个 style 属性一并移除，不能留下 `style=""`。
    expect(drag(nowAt()!.key, 0, 0).applied).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(restore);
  });

  it('再拖一次是替换而不是追加', () => {
    expect(drag(pick().key, 12, -4).applied).toBe(1);
    expect(drag(nowAt()!.key, -30, 8).applied).toBe(1);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('translate: -30px 8px');
    expect(text).not.toContain('12px -4px');
    expect((text.match(/translate:/g) ?? []).length).toBe(1);
  });

  it('读回来的偏移与写进去的一致', () => {
    expect(drag(pick().key, -7, 23).applied).toBe(1);
    expect(translateOf(nowAt()!)).toEqual({ dx: -7, dy: 23 });
  });

  it('小数四舍五入到整像素', () => {
    expect(drag(pick().key, 3.7, -0.2).applied).toBe(1);
    expect(readFileSync(file, 'utf8')).toContain('translate: 4px 0px');
  });

  it('偏移写的是 translate 而不是 transform', () => {
    // `transform` 已被按压反馈（scale(.97)）、rise-in 入场与页面过渡使用，内联 transform 会覆盖它们。
    expect(drag(pick().key, 5, 5).applied).toBe(1);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('style="translate:');
    expect(text).not.toContain('style="transform:');
  });

  it('拖过之后模板仍然编译得动', () => {
    expect(drag(pick().key, 9, 9).applied).toBe(1);
    const { descriptor, errors } = parseSfc(readFileSync(file, 'utf8'), { filename: file });
    expect(errors.map(String)).toEqual([]);
    const compiled = compileTemplate({ id: file, filename: file, source: descriptor.template?.content ?? '' });
    expect(compiled.errors.map(String)).toEqual([]);
  });

  it('styles.css 里没有人用独立的 translate 属性 —— 拖拽偏移不会被别处覆盖', () => {
    expect(/^\s*translate:/m.test(readFileSync('packages/webui/src/styles.css', 'utf8'))).toBe(false);
  });
});

describe('贴边 / 对齐 / 间距：工具类 token', () => {
  const file = 'packages/webui/src/views/LoginView.vue';
  let restore = '';
  beforeEach(() => { restore = readFileSync(file, 'utf8'); });
  afterEach(() => writeFileSync(file, restore));

  const withClass = (): ElementInfo => {
    const hit = [...elements(file).values()].find((info) => info.classAttr && !info.classAttr.value.includes('u-'));
    expect(hit, '找不到带 class 的元素').toBeDefined();
    return hit!;
  };
  const withoutClass = (): ElementInfo => {
    const hit = [...elements(file).values()].find((info) => !info.classAttr && info.attrInsert > 0);
    expect(hit, '找不到不带 class 的元素').toBeDefined();
    return hit!;
  };

  const set = (key: string, group: 'push' | 'text' | 'gapx' | 'gapy', value: string): ReturnType<typeof applyChanges> =>
    applyChanges([{ kind: 'class', file, key, group, value }]);

  it('本来有 class：设了再清 = 一个字节都没变', () => {
    const target = withClass();
    expect(set(target.key, 'push', 'end').applied).toBe(1);
    expect(readFileSync(file, 'utf8')).toContain('u-push-end');
    const again = [...elements(file).values()].find((info) => info.classAttr?.value.includes('u-push-end'));
    expect(set(again!.key, 'push', '').applied).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(restore);
  });

  it('本来没有 class：设了会新插一个属性，清掉时连属性一起摘走', () => {
    const target = withoutClass();
    expect(set(target.key, 'gapy', '2').applied).toBe(1);
    const mid = readFileSync(file, 'utf8');
    expect(mid).toContain('class="u-gap-y-2"');
    const again = [...elements(file).values()].find((info) => info.classAttr?.value === 'u-gap-y-2');
    expect(set(again!.key, 'gapy', '').applied).toBe(1);
    // 留下一个 `class=""` 等于向源码写入无用内容；要么完全还原，要么不做改动。
    expect(readFileSync(file, 'utf8')).toBe(restore);
  });

  it('同组互斥：换一档不会两个 token 并存', () => {
    const target = withClass();
    expect(set(target.key, 'push', 'end').applied).toBe(1);
    const again = [...elements(file).values()].find((info) => info.classAttr?.value.includes('u-push-end'));
    expect(set(again!.key, 'push', 'center').applied).toBe(1);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('u-push-center');
    expect(text).not.toContain('u-push-end');
  });

  it('不同组可以并存', () => {
    const target = withClass();
    expect(set(target.key, 'push', 'end').applied).toBe(1);
    const again = [...elements(file).values()].find((info) => info.classAttr?.value.includes('u-push-end'));
    expect(set(again!.key, 'text', 'center').applied).toBe(1);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('u-push-end');
    expect(text).toContain('u-text-center');
  });

  it('不认识的档位被拒绝，源码不动', () => {
    const target = withClass();
    const result = applyChanges([{ kind: 'class', file, key: target.key, group: 'gapx', value: '99' }]);
    expect(result.applied).toBe(0);
    expect(result.refused.join()).toContain('没有 99 这一档');
    expect(readFileSync(file, 'utf8')).toBe(restore);
  });

  /**
   * 字号档位曾出过一次问题：最初写的是 `font-size: 1.12em`，而 `em` 用于 `font-size` 时取父级字号，
   * 实测一个 64px 的 `<h1>`（父级 16px）选择放大后缩至 17.9px，与按钮标注的效果相反。
   * 现在改为基准乘以倍数，基准由面板测量元素自身字号后写入 `--u-base`。这三条用例固定该行为。
   */
  it('字号档是基准乘倍数，不是父级相对', () => {
    const css = readFileSync('packages/webui/src/styles.css', 'utf8');
    for (const value of UTILITIES.size.values) {
      expect(css).toMatch(new RegExp(`\\.u-size-${value} \\{ font-size: calc\\(var\\(--u-base`));
    }
    expect(css).not.toMatch(/\.u-size-\w+ \{ font-size: [\d.]+em/);
  });

  it('设字号会连基准一起写进内联样式，取消时一起摘走', () => {
    const target = withoutClass();
    const wrote = applyChanges([
      { kind: 'class', file, key: target.key, group: 'size', value: 'lg' },
      { kind: 'basis', file, key: target.key, px: 13.34 },
    ]);
    expect(wrote.refused).toEqual([]);
    // 附属项不计数：调整一次字号属于一次操作，而非两次。
    expect(wrote.applied).toBe(1);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('class="u-size-lg"');
    expect(text).toContain('--u-base: 13.3px');
    const after = [...elements(file).values()].find((info) => info.classAttr?.value.includes('u-size-lg'));
    expect(basisOf(after!)).toBe(13.3);
    expect(applyChanges([
      { kind: 'class', file, key: after!.key, group: 'size', value: '' },
      { kind: 'basis', file, key: after!.key, px: null },
    ]).refused).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(restore);
  });

  it('同一个元素上的两组档位一次保存都落到位', () => {
    // 逐条写入的旧写法在此会插入两个 class 属性，或把后一条判为重叠而丢弃。
    const target = withoutClass();
    const result = applyChanges([
      { kind: 'class', file, key: target.key, group: 'size', value: 'lg' },
      { kind: 'class', file, key: target.key, group: 'weight', value: '700' },
      { kind: 'style', file, key: target.key, dx: 3, dy: 0 },
      { kind: 'basis', file, key: target.key, px: 20 },
    ]);
    expect(result.refused).toEqual([]);
    expect(result.applied).toBe(3);
    const text = readFileSync(file, 'utf8');
    expect((text.match(/class="/g) ?? []).length).toBe((restore.match(/class="/g) ?? []).length + 1);
    expect(text).toContain('class="u-size-lg u-weight-700"');
    expect(text).toContain('style="translate: 3px 0px; --u-base: 20px"');
  });

  it('每个 token 在 styles.css 里都真的有规则，且带 !important', () => {
    // 没有对应规则的 token 表现为面板点击无响应；缺少 !important 则会被既有的高特异性规则覆盖，同样无响应。
    const css = readFileSync('packages/webui/src/styles.css', 'utf8');
    for (const [group, spec] of Object.entries(UTILITIES)) {
      for (const value of spec.values) {
        const rule = new RegExp(`\\.${spec.prefix}-${value} \\{[^}]*!important`);
        expect(rule.test(css), `${group}/${value} 少了规则或少了 !important`).toBe(true);
      }
    }
  });
});

describe('抽取出来的条目形状', () => {
  const entries = extractAll();
  /**
   * 这条断言确实拦截过一次问题：6 位十六进制为 24 bit，而当前有 2700 条文案，按生日问题估算碰撞概率约 20%，
   * 而 `applyChanges` 的 `new Map([id, entry])` 在碰撞时静默保留后写入的那条，导致在面板中修改前一句
   * 会覆盖后一句的源码区间（实测 `aa826d` 上重合的是 `sandbox.bypassRoles` 与
   * `approval.skipForOwner` 两条配置说明）。位数与碰撞兜底各断言一次：只保留前者属于概率估计，
   * 只保留后者则是等待再次碰撞。
   */
  it('id 唯一', () => {
    const dupes = [...duplicateIds(entries)];
    expect(dupes, dupes.map((id) => `${id}: ${entries.filter((entry) => entry.id === id).map((entry) => entry.core.slice(0, 20)).join(' / ')}`).join('\n')).toEqual([]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });
  it('id 位宽够用 —— 收窄回去等于把撞号概率抬回两成', () => {
    // 2700 条在 24 bit 下碰撞概率约 20%；48 bit 下同等规模约为 1.3e-8。
    for (const entry of entries.slice(0, 5)) expect(entry.id).toMatch(/^[0-9a-f]{12}$/);
  });
  it('每条的 raw 都能在源码的记录位置上原样找到', () => {
    const cache = new Map<string, string>();
    for (const entry of entries) {
      const text = cache.get(entry.file) ?? cache.set(entry.file, readFileSync(entry.file, 'utf8')).get(entry.file) ?? '';
      expect(text.slice(entry.offset, entry.end), `${entry.file}:${entry.line}`).toBe(entry.raw);
    }
  });
  it('同一个文件里没有互相包住的条目', () => {
    // 重叠意味着落回时按已失效的 offset 切分源码，`dropNested` 拦截的正是这一情形。
    const byFile = new Map<string, typeof entries>();
    for (const entry of entries) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
    for (const [file, rows] of byFile) {
      for (const entry of rows) {
        const wrapper = rows.find((other) => other !== entry && other.offset <= entry.offset && entry.end <= other.end);
        expect(wrapper, `${file}:${entry.line} 被 ${wrapper?.id} 包住`).toBeUndefined();
      }
    }
  });
});

describe('手动保存与撤销', () => {
  const file = 'packages/webui/src/views/LoginView.vue';
  let original = '';
  beforeEach(() => { original = readFileSync(file, 'utf8'); });
  afterEach(() => writeFileSync(file, original));

  /** 三种改动落在同一文件的不同位置：文案、工具类与拖拽偏移。 */
  const batch = (): Change[] => {
    const entry = extractFile(file).find((row) => row.zone === 'template' && row.place === 'text' && !row.slots.length);
    const box = [...elements(file).values()].find((info) => info.classAttr && !info.styleAttr && info.attrInsert > 0);
    expect(entry, '没找到可改的文案').toBeDefined();
    expect(box, '没找到可挂属性的元素').toBeDefined();
    return [
      { kind: 'text', file, id: entry!.id, value: '换过的一句话' },
      { kind: 'class', file, key: box!.key, group: 'push', value: 'end' },
      { kind: 'style', file, key: box!.key, dx: 11, dy: -6 },
    ];
  };

  it('一次保存里三种改动都落到位，互不错位', () => {
    // 关键不变量：所有 offset 都相对同一份原文测量，逐条写盘会让后续 offset 全部失效。
    const result = applyChanges(batch());
    expect(result.refused).toEqual([]);
    expect(result.applied).toBe(3);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('换过的一句话');
    expect(text).toContain('u-push-end');
    expect(text).toContain('translate: 11px -6px');
  });

  it('同一个元素上同时新建 class 与 style 时合成一次插入', () => {
    const box = [...elements(file).values()].find((info) => !info.classAttr && !info.styleAttr && info.attrInsert > 0);
    expect(box).toBeDefined();
    const result = applyChanges([
      { kind: 'class', file, key: box!.key, group: 'text', value: 'center' },
      { kind: 'style', file, key: box!.key, dx: 4, dy: 4 },
    ]);
    expect(result.refused).toEqual([]);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('class="u-text-center" style="translate: 4px 4px"');
  });

  it('保存前源码一个字节都没动 —— 面板上的一切都只是预览', () => {
    // `applyChanges` 是全仓唯一的写入入口；不调用它时，无论抽取多少次都不应修改文件。
    extractFile(file);
    elements(file);
    extractAll();
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('撤销上次保存 = 回到保存前那一刻', () => {
    const { before } = applyChanges(batch());
    expect(Object.keys(before)).toEqual([file]);
    expect(readFileSync(file, 'utf8')).not.toBe(original);
    expect(restoreFiles(before)).toEqual([file]);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});

/**
 * 实际删除是这套工具中唯一在源码层面不可逆的操作：文案改错仍然可见，元素被移除后只能依赖历史栈恢复。
 * 因此它的三条否决判据需要断言覆盖，它们分别对应一种保存之后才会出错的形态。
 */
describe('删除元素', () => {
  const file = 'packages/webui/src/views/LoginView.vue';
  let original = '';
  beforeEach(() => { original = readFileSync(file, 'utf8'); });
  afterEach(() => writeFileSync(file, original));

  const deletable = (): ElementInfo => {
    const hit = [...elements(file).values()].find((info) => !info.guards.length && info.parent);
    expect(hit, '找不到可删的元素').toBeDefined();
    return hit!;
  };
  const blank = (text: string): number => (text.match(/\n[ \t]+\n/g) ?? []).length;

  it('整行摘走，不留一行空缩进', () => {
    const target = deletable();
    const slice = original.slice(target.range.start, target.range.end);
    const result = applyChanges([{ kind: 'remove', file, key: target.key }]);
    expect(result.refused).toEqual([]);
    expect(result.applied).toBe(1);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(slice);
    expect(text.length).toBeLessThan(original.length);
    expect(blank(text)).toBe(blank(original));
  });

  it('删完模板仍然解析、编译得动', () => {
    expect(applyChanges([{ kind: 'remove', file, key: deletable().key }]).applied).toBe(1);
    const source = readFileSync(file, 'utf8');
    const { descriptor, errors } = parseSfc(source, { filename: file });
    expect(errors.map(String)).toEqual([]);
    const compiled = compileTemplate({ id: file, filename: file, source: descriptor.template?.content ?? '' });
    expect(compiled.errors.map(String)).toEqual([]);
  });

  it('三条否决判据都真的会命中（不是写了没接线）', () => {
    const guards = new Set<string>();
    for (const name of BROWSER_FILES.filter((each) => each.endsWith('.vue'))) {
      for (const info of elements(name).values()) for (const each of info.guards) guards.add(each.replace(/<.*/, ''));
    }
    expect([...guards].some((each) => each.includes('v-else'))).toBe(true);
    expect([...guards].some((each) => each.includes('ref'))).toBe(true);
    expect([...guards].some((each) => each.includes('根节点'))).toBe(true);
  });

  it('带否决理由的一律拒绝，源码一个字节不动', () => {
    for (const name of BROWSER_FILES.filter((each) => each.endsWith('.vue'))) {
      const guarded = [...elements(name).values()].find((info) => info.guards.length);
      if (!guarded) continue;
      const was = readFileSync(name, 'utf8');
      const result = applyChanges([{ kind: 'remove', file: name, key: guarded.key }]);
      expect(result.applied).toBe(0);
      expect(result.refused.join()).toContain('删不了');
      expect(readFileSync(name, 'utf8')).toBe(was);
      return;
    }
    throw new Error('全仓一个带否决理由的元素都没有，这条断言失去意义');
  });

  it('落在删除范围里的改动被吃掉，且计数不重复', () => {
    // 删除一个容器并修改其中一句文案算作一处改动，而非两处。计数不扣减时，
    // 写回 2 处中会有一处实际从未发生。
    const rows = extractFile(file);
    const container = [...elements(file).values()].find((info) => !info.guards.length && info.parent
      && rows.some((row) => row.offset > info.range.start && row.end < info.range.end
        && row.place === 'text' && !row.slots.length));
    expect(container, '找不到里面装着文案的可删容器').toBeDefined();
    const inside = rows.find((row) => row.offset > container!.range.start && row.end < container!.range.end
      && row.place === 'text' && !row.slots.length)!;
    const result = applyChanges([
      { kind: 'text', file, id: inside.id, value: '这句话应该跟着容器一起消失' },
      { kind: 'remove', file, key: container!.key },
    ]);
    expect(result.refused).toEqual([]);
    expect(result.applied).toBe(1);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('这句话应该跟着容器一起消失');
    expect(text).not.toContain(inside.raw.trim());
  });
});

/** 保存历史：逐次快照并支持回退任意步数。 */
describe('保存历史', () => {
  const file = 'packages/webui/src/views/LoginView.vue';
  let original = '';
  const seat = 'data/copy-history.test';
  beforeEach(() => {
    original = readFileSync(file, 'utf8');
    process.env.LUOLI_COPY_HISTORY = seat;
    rmSync(seat, { recursive: true, force: true });
  });
  afterEach(() => {
    writeFileSync(file, original);
    rmSync(seat, { recursive: true, force: true });
    delete process.env.LUOLI_COPY_HISTORY;
  });

  /** 修改一句文案并保存一层，返回该层的 id。 */
  const commit = (value: string): string => {
    const entry = extractFile(file).find((row) => row.zone === 'template' && row.place === 'text' && !row.slots.length)!;
    const result = applyChanges([{ kind: 'text', file, id: entry.id, value }]);
    expect(result.applied).toBe(1);
    return snapshot(result.before, result.applied)!.id;
  };

  it('每次保存一层，按时间序编号', () => {
    expect(steps()).toEqual([]);
    const first = commit('第一次');
    const second = commit('第二次');
    expect(first).toBe('0001');
    expect(second).toBe('0002');
    expect(steps().map((step) => step.id)).toEqual(['0001', '0002']);
    expect(steps()[0]?.files).toEqual([file]);
  });

  it('退到某一步之前 = 那一步之前的字节', () => {
    commit('第一次');
    const afterFirst = readFileSync(file, 'utf8');
    const second = commit('第二次');
    expect(readFileSync(file, 'utf8')).not.toBe(afterFirst);
    const result = rewind(second);
    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(afterFirst);
  });

  it('往回退两步一次到位，且退掉的层不再留着', () => {
    // 同一文件在两层中都被修改过，应写回最早的那一份。取最新的那一份等同于未回退。
    const first = commit('第一次');
    commit('第二次');
    expect(rewind(first).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(steps()).toEqual([]);
  });

  it('不给 id 就是退最近一步', () => {
    commit('第一次');
    const afterFirst = readFileSync(file, 'utf8');
    commit('第二次');
    expect(rewind().ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(afterFirst);
    expect(steps().map((step) => step.id)).toEqual(['0001']);
  });

  it('没有历史时如实说，不假装退了', () => {
    const result = rewind();
    expect(result.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('一处都没落地就不留空层', () => {
    expect(snapshot({}, 0)).toBeNull();
    expect(steps()).toEqual([]);
  });

  it('只留最近 20 层', () => {
    for (let index = 0; index < 23; index += 1) snapshot({ [file]: `第 ${index} 层` }, 1);
    const kept = steps();
    expect(kept.length).toBe(20);
    expect(kept[0]?.id).toBe('0004');
    expect(kept.at(-1)?.id).toBe('0023');
  });
});

/**
 * 带占位符的那 282 条。它们最容易被改坏且出错后不报错：缺少一个占位符时，界面上会
 * 少一个数字或名称，而模板仍能编译、测试仍会通过。
 */
describe('带占位符的文案', () => {
  const file = 'packages/webui/src/views/ConsoleView.vue';
  let original = '';
  beforeEach(() => { original = readFileSync(file, 'utf8'); });
  afterEach(() => writeFileSync(file, original));
  const entryOf = (predicate: (row: ReturnType<typeof extractFile>[number]) => boolean) => {
    const hit = extractFile(file).find(predicate);
    expect(hit, '找不到符合条件的条目').toBeDefined();
    return hit!;
  };
  const single = () => entryOf((row) => row.place === 'text' && row.slots.length === 1);

  it('嵌套的 ${} 按括号数，不切在第一个右括号上', () => {
    // 原先是 `\$\{[^}]*\}`，切分结果是不完整的片段。用不完整片段做存在性检查看不出问题，
    // 用它生成代码（把占位符的当前值传给运行时）会直接切坏源码，实测破坏了 4 个文件。
    expect(slotsOf('恒发「${list[i]}」${i === raw ? \'\' : `（下标 ${raw} 越界）`}'))
      .toEqual(['${list[i]}', '${i === raw ? \'\' : `（下标 ${raw} 越界）`}']);
    expect(slotsOf('共 {{ n }} 条 · {{ m }} 次')).toEqual(['{{ n }}', '{{ m }}']);
  });

  it('全仓每条 slots 都能在它自己那句话里原样找到', () => {
    for (const entry of extractAll()) {
      for (const slot of entry.slots) expect(entry.core, `${entry.file}:${entry.line}`).toContain(slot);
    }
  });

  it('少一个占位就拒绝落盘，源码一个字节不动', () => {
    const entry = single();
    const result = applyChanges([{ kind: 'text', file, id: entry.id, value: '把占位删掉的一句话' }]);
    expect(result.applied).toBe(0);
    expect(result.refused.join()).toContain('少了插值');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('同一个占位出现两次时，只留一个照样拒绝', () => {
    // `删除 ${name} 的配置覆盖？…回到 agents/${name}.md` 中若只保留一个占位符，第二处会变成
    // 字面量 `agents/.md`。判据必须基于个数，`includes` 无法检出。
    // 源码中此刻没有这样一句（最后一条随主体页角色列的红字一起删除，`effectiveRole` 已下线），
    // 因此先自己造一句：多写一个占位符是允许的，把它减回一个必须被拒。
    const seed = single();
    expect(applyChanges([{ kind: 'text', file, id: seed.id, value: `${seed.core}${seed.slots[0]!}` }]).applied).toBe(1);
    const entry = entryOf((row) => new Set(row.slots).size !== row.slots.length);
    // 需要选取重复出现的那一个：本条中还有几个只出现一次的占位符，用它们验证没有意义。
    const slot = entry.slots.find((each, index) => entry.slots.indexOf(each) !== index)!;
    const once = entry.core.split(slot).join('X').replace('X', slot);
    expect(once.split(slot).length - 1).toBeLessThan(entry.core.split(slot).length - 1);
    const after = readFileSync(file, 'utf8');
    expect(applyChanges([{ kind: 'text', file, id: entry.id, value: once }]).refused.join()).toContain('少了插值');
    // 被拒的那次一个字节都不许写下去（原文是上一步造出来的那份，`afterEach` 再还原回源码）。
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('大括号内侧的空白顺手收成记录里那个样子', () => {
    const entry = single();
    const slot = entry.slots[0]!;
    const squeezed = entry.core.replace(slot, `{{${slot.slice(2, -2).trim()}}}`);
    expect(squeezed).not.toBe(entry.core);
    const result = applyChanges([{ kind: 'text', file, id: entry.id, value: squeezed }]);
    expect(result.refused).toEqual([]);
    // 落盘的是规整后的版本，否则源码中会出现同一占位符的四种写法。
    expect(readFileSync(file, 'utf8')).toContain(slot);
  });

  it('占位挪到句首也算留着', () => {
    const entry = single();
    const slot = entry.slots[0]!;
    const moved = `${slot} —— ${entry.core.split(slot).join('').trim()}`;
    const result = applyChanges([{ kind: 'text', file, id: entry.id, value: moved }]);
    expect(result.refused).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain(moved);
  });

  it('插桩把占位的当前值一起传给运行时', () => {
    // 缺少这一段时，修改一句带占位符的文案后页面上显示的是字面的 `{{ n }}` 而非实际数值。
    const entry = single();
    const expression = entry.slots[0]!.slice(2, -2).trim();
    const instrumented = instrument(readFileSync(file, 'utf8'), [entry]);
    expect(instrumented).toContain(`, [${expression}])`);
  });

  it('填回真实值：按文本替换，所以挪位置与重复都还对', () => {
    expect(fillSlots('一共 {{ n }} 回', ['{{ n }}'], [42])).toBe('一共 42 回');
    expect(fillSlots('{{ n }} —— 共这么多', ['{{ n }}'], [7])).toBe('7 —— 共这么多');
    expect(fillSlots('删 ${name} → agents/${name}.md', ['${name}', '${name}'], ['ops', 'ops']))
      .toBe('删 ops → agents/ops.md');
    // 大括号内侧空白不一致的同样要能填充，否则预览会显示字面占位符。
    expect(fillSlots('一共 {{n}} 回', ['{{ n }}'], [3])).toBe('一共 3 回');
    // 提供的值不足时剩余占位符原样保留：宁可显示占位符，也不显示 "undefined"。
    expect(fillSlots('{{ a }} / {{ b }}', ['{{ a }}', '{{ b }}'], [1])).toBe('1 / {{ b }}');
  });

  it('被拒的那几条会指名道姓交回来 —— 面板据此留住人刚打的字', () => {
    // 只有供人阅读的说明（`refused`）时，面板无法判断应保留哪几条暂存，因此此前是无条件清空：
    // 拒绝 3 处意味着那三处既未落盘、已输入的内容也丢失。`stuck` 记录的是未生效的目标。
    const good = single();
    const bad = entryOf((row) => row.place === 'text' && row.slots.length === 1 && row.id !== good.id);
    const result = applyChanges([
      { kind: 'text', file, id: good.id, value: `${good.core} ·` },
      { kind: 'text', file, id: bad.id, value: '把占位删掉的一句话' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.stuck).toEqual([bad.id]);
  });

  it('面板与落盘用的是同一份判据', () => {
    // 各写一份的结果是面板提示可以保存而落盘拒绝，或反过来拦截本可保存的内容。
    const panel = source('scripts/copy/runtime/CopyPanel.vue');
    expect(panel).toContain(code("from '../slots.js'"));
    // 面板此前自行执行 `row.slots.filter(slot => !override.includes(slot))`，只做存在性检查，
    // 与落盘侧的个数判据不一致，表现为按钮可用但保存被拒。
    expect(panel).not.toMatch(/row\.slots\.filter/);
    expect(source('scripts/copy/runtime/boot.ts')).toContain(code("from '../slots.js'"));
  });
});

/**
 * 面板自身同样可能白屏。它不在 `BROWSER_FILES` 中（不属于产品代码），因此上面那条插桩后仍可解析
 * 的循环覆盖不到它；而它一旦损坏，整个改写工具即不可用，且 `tsc --noEmit` 不检查 `.vue`。
 */
describe('面板自己', () => {
  const file = 'scripts/copy/runtime/CopyPanel.vue';
  // 编译需要原文（`parseSfc` 依据真实 offset），读码断言需要归一化后的版本，两者各自取用。
  const raw = readFileSync(file, 'utf8');
  const text = source(file);

  it('解析、编译都没有错误', () => {
    const { descriptor, errors } = parseSfc(raw, { filename: file });
    expect(errors.map(String)).toEqual([]);
    expect(compileScript(descriptor, { id: file }).content.length).toBeGreaterThan(0);
    const compiled = compileTemplate({ id: file, filename: file, source: descriptor.template?.content ?? '' });
    expect(compiled.errors.map(String)).toEqual([]);
  });

  /**
   * 面板中的那三条只能通过读取源码固定：它们属于浏览器侧行为，而本测试不启动浏览器。
   * 三条都属于静默丢失内容的形态，值得用一条读码断言拦截。
   */
  it('保存之后只清落地的那些，被拒的留在面板上', () => {
    expect(text).toContain(code('const stuck = new Set(result.stuck ?? [])'));
    expect(text).toContain(code("if (stuck.has(entry.id ?? entry.key ?? '')) kept[slot] = entry"));
    // 无条件清空是此前的错误做法，不应再出现。空白压平后换行也变为空格，因此这里不再写 `\n`。
    expect(text).not.toMatch(/staged\.value = \{\}; undoStack\.value = \[\]; committed/);
  });

  it('退历史之前先丢掉未保存的', () => {
    // 回退后源码已变更，保留的暂存状态中记录的 offset 与元素 key 全部失效。
    expect(text).toMatch(/async function rewind[\s\S]{0,200}?if \(dirty\.value\) discardAll\(\)/);
  });

  it('元素级的暂存按元素记，不按行记', () => {
    // 185 个元素被 2 条以上文案共用（共 472 条）。若按行记录，A 行已选择隐藏而 B 行仍显示未选中，
    // 两行都操作过之后保存时的合并顺序决定最终结果，属于不确定行为。
    for (const kind of ['class', 'style', 'remove', 'basis']) {
      expect(text, `${kind} 的 slot 键还挂在行 id 上`).not.toContain(code(`\`${kind}:\${row.id}`));
    }
    expect(text).toContain(code('`class:${row.owner}:${group}`'));
    expect(text).toContain(code('`remove:${row.owner}`'));
  });

  it('面板的档位表与 UTILITIES 的 prefix 一一对应', () => {
    // 两侧不一致的表现是：面板点击有响应（DOM 上添加了 class），保存后无响应（源码中该 token
    // 没有对应的 CSS 规则）。预览与结果不一致是这套工具最严重的一种缺陷。
    for (const spec of Object.values(UTILITIES)) {
      expect(text, `面板里没有 ${spec.prefix}`).toContain(code(`prefix: '${spec.prefix}'`));
    }
    // 归一化之后引号恒为 `"`，因此这里使用双引号，更换 prettier 配置也不会复发。
    for (const found of text.matchAll(/prefix: "(u-[a-z-]+)"/g)) {
      expect(Object.values(UTILITIES).map((spec) => spec.prefix)).toContain(found[1]);
    }
  });
});
