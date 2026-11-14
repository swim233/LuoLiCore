import { createElement as h } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as controls from './index';
import * as icons from '../icons';

/* React 这一层只是拼属性：用服务端渲染（不需要 DOM）看渲染出来的属性对不对。
   样子由纯 CSS 管（QA 在展示页上用真实浏览器验收）；两步确认的点击、超时在浏览器里验。
   这个文件在没有 window 的环境里 import 入口，能 import 进来就说明入口加载时不碰 DOM。 */
const {
  Badge,
  Button,
  Chevron,
  ConfirmButton,
  Dot,
  Empty,
  Field,
  Fold,
  IconButton,
  Link,
  Meter,
  Notice,
  Roll,
  Row,
  RowButton,
  Seg,
  Skeleton,
  Spinner,
  Stat,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tag,
} = controls;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('Button', () => {
  it('默认是 type=button、类名 ll-btn，不写样子和尺寸就没有 data-variant、data-size', () => {
    const out = html(h(Button, null, '按钮'));
    expect(out).toBe('<button type="button" class="ll-btn">按钮</button>');
  });
  it('样子和尺寸写成 data- 属性，pressed 写成 aria-pressed，className 拼在库的类名后面，其余属性原样传下去', () => {
    const out = html(
      h(
        Button,
        {
          variant: 'primary',
          size: 'lg',
          pressed: true,
          className: 'mine',
          disabled: true,
          title: '提示',
        },
        '发送',
      ),
    );
    expect(out).toContain('class="ll-btn mine"');
    expect(out).toContain('data-variant="primary"');
    expect(out).toContain('data-size="lg"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('disabled=""');
    expect(out).toContain('title="提示"');
  });
  it('pressed 为 false 时写 aria-pressed="false"，不写 pressed 时没有这个属性', () => {
    expect(html(h(Button, { pressed: false }))).toContain('aria-pressed="false"');
    expect(html(h(Button))).not.toContain('aria-pressed');
  });
});

describe('IconButton', () => {
  it('类名 ll-icon-btn，aria-label 原样传下去', () => {
    const out = html(h(IconButton, { 'aria-label': '还原' }, h(icons.IconRestore)));
    expect(out).toContain('class="ll-icon-btn"');
    expect(out).toContain('aria-label="还原"');
    expect(out).toContain('<svg');
  });
});

describe('Switch', () => {
  it('role=switch、aria-checked 跟着 checked，里面有轨道，有 label 才有文字', () => {
    const bare = html(h(Switch, { checked: true, onChange: () => {}, 'aria-label': '动画' }));
    expect(bare).toContain('role="switch"');
    expect(bare).toContain('aria-checked="true"');
    expect(bare).toContain('ll-switch-track');
    expect(bare).not.toContain('ll-switch-label');
    const labeled = html(h(Switch, { checked: false, onChange: () => {}, label: '动画' }));
    expect(labeled).toContain('aria-checked="false"');
    expect(labeled).toContain('<span class="ll-switch-label">动画</span>');
  });
  it('boxed 才写 data-boxed 和 data-size', () => {
    const boxed = html(h(Switch, { checked: false, onChange: () => {}, boxed: true, size: 'lg' }));
    expect(boxed).toContain('data-boxed=""');
    expect(boxed).toContain('data-size="lg"');
    const plain = html(h(Switch, { checked: false, onChange: () => {}, size: 'lg' }));
    expect(plain).not.toContain('data-boxed');
    expect(plain).not.toContain('data-size');
  });
});

describe('Seg', () => {
  it('一组 role=group，当前项 aria-pressed=true，每项带 data-v 和悬停说明', () => {
    const out = html(
      h(Seg, {
        value: 'on',
        onPick: () => {},
        label: '动画',
        items: [
          ['system', '跟随系统'],
          ['on', '开', '一直开着'],
        ],
      }),
    );
    expect(out).toContain('class="ll-seg"');
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="动画"');
    expect(out).toContain('data-v="system" aria-pressed="false"');
    expect(out).toContain('title="一直开着"');
    expect(out).toMatch(
      /data-v="on"[^>]*aria-pressed="true"|title="一直开着"[^>]*aria-pressed="true"/,
    );
  });
});

describe('标签、徽标、状态点、小箭头', () => {
  it('Tag 的样子、色调、尺寸写成 data- 属性', () => {
    expect(html(h(Tag, null, '群'))).toBe('<span class="ll-tag">群</span>');
    const out = html(h(Tag, { variant: 'soft', tone: 'star', size: 'md' }, '提示'));
    expect(out).toContain('data-variant="soft"');
    expect(out).toContain('data-tone="star"');
    expect(out).toContain('data-size="md"');
  });
  it('Badge 没有内容时是空的 span（样式里 :empty 把它藏起来）', () => {
    expect(html(h(Badge))).toBe('<span class="ll-badge"></span>');
    expect(html(h(Badge, { tone: 'accent' }, '3'))).toBe(
      '<span class="ll-badge" data-tone="accent">3</span>',
    );
  });
  it('Dot 只是装饰：aria-hidden，色调写成 data-tone', () => {
    expect(html(h(Dot, { tone: 'danger' }))).toBe(
      '<span class="ll-dot" data-tone="danger" aria-hidden="true"></span>',
    );
  });
  it('Chevron 不写方向时没有 data-dir（由父元素的 aria-expanded 决定）', () => {
    expect(html(h(Chevron))).toBe('<span class="ll-chev" aria-hidden="true"></span>');
    expect(html(h(Chevron, { dir: 'down' }))).toContain('data-dir="down"');
  });
});

describe('Spinner', () => {
  it('服务端也能渲染：当作动画开着，渲染出空的 span（字符由浏览器里的定时器填），色调写成 data-tone', () => {
    expect(html(h(Spinner))).toBe('<span class="ll-spin" aria-hidden="true"></span>');
    expect(html(h(Spinner, { tone: 'tool' }))).toBe(
      '<span class="ll-spin" data-tone="tool" aria-hidden="true"></span>',
    );
  });
});

describe('ConfirmButton', () => {
  it('一开始是平常的按钮，没有 data-armed，显示 children', () => {
    const out = html(h(ConfirmButton, { onConfirm: () => {}, armedLabel: '再点一次' }, '恢复'));
    expect(out).toContain('class="ll-btn"');
    expect(out).toContain('>恢复<');
    expect(out).not.toContain('data-armed');
    expect(out).not.toContain('data-variant="danger"');
  });
});

describe('提示条、空状态、骨架条', () => {
  it('Notice：类名 ll-notice，色调和尺寸写成 data- 属性，role 由用的地方传，里面可以放按钮', () => {
    expect(html(h(Notice, null, '加载中…'))).toBe('<span class="ll-notice">加载中…</span>');
    const out = html(
      h(
        Notice,
        { tone: 'danger', size: 'lg', role: 'status', className: 'mine' },
        '没取到',
        h(Button, { size: 'xs' }, '重试'),
      ),
    );
    expect(out).toContain('class="ll-notice mine"');
    expect(out).toContain('data-tone="danger"');
    expect(out).toContain('data-size="lg"');
    expect(out).toContain('role="status"');
    expect(out).toContain('>重试</button>');
  });
  it('Empty：标题、说明、按钮按这个顺序直接放在里面；没有标题就没有标题那一行；flat 写 data-flat', () => {
    const out = html(
      h(
        Empty,
        { title: '连不上洛璃服务', action: h(Button, { size: 'sm' }, '重试') },
        '连上后会自动恢复',
      ),
    );
    expect(out).toBe(
      '<div class="ll-empty"><b class="ll-empty-title">连不上洛璃服务</b>连上后会自动恢复<button type="button" class="ll-btn" data-size="sm">重试</button></div>',
    );
    expect(html(h(Empty, null, '加载中…'))).toBe('<div class="ll-empty">加载中…</div>');
    expect(html(h(Empty, { flat: true }, '今天还没有回复'))).toContain('data-flat=""');
    expect(html(h(Empty, { flat: false }, 'x'))).not.toContain('data-flat');
  });
  it('Skeleton：是装饰（aria-hidden），不写形状是一条线，block 写 data-shape', () => {
    expect(html(h(Skeleton))).toBe('<span class="ll-skel" aria-hidden="true"></span>');
    const out = html(h(Skeleton, { shape: 'block', style: { height: 120 } }));
    expect(out).toContain('data-shape="block"');
    expect(out).toContain('style="height:120px"');
  });
});

describe('表单项、链接', () => {
  it('Field：没给 htmlFor，标签是 span；给了是 label for；说明同时写进根上的 title', () => {
    const a = html(h(Field, { label: '动画', hint: '跟随系统或手动开关' }, h('i')));
    expect(a).toContain('<span class="ll-field-label">动画</span>');
    expect(a).toContain('title="跟随系统或手动开关"');
    expect(a).toContain('<p class="ll-field-hint">跟随系统或手动开关</p>');
    expect(a.indexOf('<i>')).toBeGreaterThan(a.indexOf('ll-field-label'));
    expect(a.indexOf('<i>')).toBeLessThan(a.indexOf('ll-field-hint'));
    const b = html(
      h(Field, { label: '名字', htmlFor: 'n', layout: 'row' }, h('input', { id: 'n' })),
    );
    expect(b).toContain('<label class="ll-field-label" for="n">名字</label>');
    expect(b).toContain('data-layout="row"');
    expect(b).not.toContain('ll-field-hint');
    expect(b).not.toContain('title=');
  });
  it('Link：新标签页打开、rel 带 noopener noreferrer、title 是地址；auto 写 data-variant', () => {
    const out = html(h(Link, { href: 'https://example.com/a' }, '链接'));
    expect(out).toContain('class="ll-link"');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('title="https://example.com/a"');
    expect(html(h(Link, { href: 'https://a.b', variant: 'auto' }, 'x'))).toContain(
      'data-variant="auto"',
    );
  });
  it('Link：点、按下、双击都不往外冒（外面的点击不会被触发）', () => {
    /* Link 是普通的函数组件：直接调它，拿到渲染出来的 <a> 的属性 */
    const a = Link({ href: 'https://a.b', children: 'x' }) as unknown as {
      props: Record<string, (e: unknown) => void>;
    };
    for (const name of ['onClick', 'onPointerDown', 'onDoubleClick']) {
      let stopped = 0;
      a.props[name]({ stopPropagation: () => stopped++ });
      expect(stopped, name).toBe(1);
    }
  });
  it('Link：用的地方自己传的 onClick、onPointerDown、onDoubleClick 照常调（先调它，再停止冒泡），不会被顶掉', () => {
    const order: string[] = [];
    const a = Link({
      href: 'https://a.b',
      children: 'x',
      onClick: () => order.push('click'),
      onPointerDown: () => order.push('down'),
      onDoubleClick: () => order.push('dbl'),
    }) as unknown as { props: Record<string, (e: unknown) => void> };
    for (const [name, mine] of [
      ['onClick', 'click'],
      ['onPointerDown', 'down'],
      ['onDoubleClick', 'dbl'],
    ] as const) {
      order.length = 0;
      a.props[name]({ stopPropagation: () => order.push('stop') });
      expect(order, name).toEqual([mine, 'stop']);
    }
  });
});

describe('统计格、数字滚动、能量槽', () => {
  it('Stat 方格：小标题在上、数字在下，下面放能量槽', () => {
    const out = html(h(Stat, { label: '输入 token', value: '1,234' }, h(Meter, { value: 0.5 })));
    expect(out).toContain('class="ll-stat"');
    expect(out).not.toContain('data-variant');
    expect(out.indexOf('ll-stat-label')).toBeLessThan(out.indexOf('ll-stat-value'));
    expect(out.indexOf('ll-stat-value')).toBeLessThan(out.indexOf('ll-meter'));
  });
  it('Stat 头条：大数字后面跟单位，不显示标签', () => {
    const out = html(h(Stat, { variant: 'hero', label: '回复', value: '42', unit: '次回复' }));
    expect(out).toContain('data-variant="hero"');
    expect(out).toContain('<span class="ll-stat-unit">次回复</span>');
    expect(out).not.toContain('ll-stat-label');
  });
  it('Stat 一行：标签和数字放在一行里，单位不显示', () => {
    const out = html(h(Stat, { variant: 'row', label: '失败', value: '3', unit: '次' }));
    expect(out).toContain('data-variant="row"');
    expect(out).toContain(
      '<div class="ll-stat-line"><span class="ll-stat-label">失败</span><span class="ll-stat-value">3</span></div>',
    );
    expect(out).not.toContain('ll-stat-unit');
  });
  it('Roll：服务端渲染出 fmt(0)（之后的数字由浏览器里的动画写），可以换 fmt 和类名', () => {
    expect(html(h(Roll, { value: 5 }))).toBe('<span class="ll-roll">0</span>');
    expect(
      html(h(Roll, { value: 5, fmt: (n: number) => n.toFixed(1) + '%', className: 'x' })),
    ).toBe('<span class="ll-roll x">0.0%</span>');
  });
  it('Meter：role=meter，aria-valuenow 是百分数，宽度是百分数，超出 0–1 的截断，不是数的当 0', () => {
    const out = html(h(Meter, { value: 0.256, label: '缓存命中率' }));
    expect(out).toContain('role="meter"');
    expect(out).toContain('aria-valuemin="0"');
    expect(out).toContain('aria-valuemax="100"');
    expect(out).toContain('aria-valuenow="26"');
    expect(out).toContain('aria-label="缓存命中率"');
    expect(out).toContain('style="width:25.60%"');
    expect(html(h(Meter, { value: 3 }))).toContain('aria-valuenow="100"');
    expect(html(h(Meter, { value: -1 }))).toContain('aria-valuenow="0"');
    expect(html(h(Meter, { value: NaN }))).toContain('style="width:0.00%"');
    expect(html(h(Meter, { value: 0.5, tone: 'danger' }))).toContain('data-tone="danger"');
  });
});

describe('图标', () => {
  it('每个图标都是 aria-hidden 的 svg，大小默认 1em，颜色跟着文字', () => {
    for (const [name, Icon] of Object.entries(icons)) {
      if (typeof Icon !== 'function') continue;
      const out = html(h(Icon as ComponentType));
      expect(out, name).toContain('<svg');
      expect(out, name).toContain('aria-hidden="true"');
      expect(out, name).toContain('width="1em"');
      expect(out, name).toMatch(/currentColor/);
    }
  });
  it('抄来的 Lucide 图标统一成 24 格、线宽 2、圆头圆角', () => {
    const out = html(h(icons.IconCheck));
    expect(out).toContain('viewBox="0 0 24 24"');
    expect(out).toContain('stroke-width="2"');
    expect(out).toContain('stroke-linecap="round"');
    expect(out).toContain('stroke-linejoin="round"');
  });
  it('图标的属性可以覆盖默认值（大小、类名）', () => {
    const out = html(h(icons.IconX, { width: 24, className: 'x' }));
    expect(out).toContain('width="24"');
    expect(out).toContain('class="x"');
  });
});

describe('折叠、标签页、列表行', () => {
  it('Fold：渲染成 details.ll-fold，头是 summary.ll-fold-head，内容跟在后面；默认收着', () => {
    const out = html(h(Fold, { head: '已结束（3）' }, h('p', null, '内容')));
    expect(out).toBe(
      '<details class="ll-fold"><summary class="ll-fold-head">已结束（3）</summary><p>内容</p></details>',
    );
  });
  it('Fold：defaultOpen、open 都是展开着；open={false} 是收着（受控）；多余的属性传给 details', () => {
    expect(html(h(Fold, { head: 'x', defaultOpen: true }))).toContain(
      '<details class="ll-fold" open="">',
    );
    expect(html(h(Fold, { head: 'x', open: true }))).toContain(' open=""');
    expect(html(h(Fold, { head: 'x', open: false, defaultOpen: true }))).not.toContain('open');
    const out = html(
      h(Fold, {
        head: 'x',
        headClassName: 'my-head',
        className: 'mine',
        id: 'f1',
        'data-k': 'v',
      } as never),
    );
    expect(out).toContain('<summary class="ll-fold-head my-head">');
    expect(out).toContain('class="ll-fold mine"');
    expect(out).toContain('id="f1"');
    expect(out).toContain('data-k="v"');
  });
  it('Tabs：tablist、tab、tabpanel 的角色和属性对：选中的 aria-selected，只渲染选中的面板（Tab 键顺序、aria-controls 要挂上以后才有，在浏览器里验）', () => {
    const out = html(
      h(
        Tabs,
        { defaultValue: 'a' },
        h(
          TabList,
          { 'aria-label': '会话' },
          h(Tab, { value: 'a' }, '甲'),
          h(Tab, { value: 'b', size: 'md' }, '乙'),
        ),
        h(TabPanel, { value: 'a' }, '甲的内容'),
        h(TabPanel, { value: 'b' }, '乙的内容'),
      ),
    );
    expect(out).toContain('class="ll-tabs');
    expect(out).toContain('role="tablist"');
    expect(out).toContain('class="ll-tabs-list');
    expect(out).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>甲<\/button>/);
    expect(out).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="false"[^>]*>乙<\/button>/);
    expect(out).toContain('data-size="md"');
    expect(out).toContain('role="tabpanel"');
    expect(out).toContain('甲的内容');
    expect(out).not.toContain('乙的内容');
  });
  it('Tabs：侧栏写 data-variant="side"，orientation="vertical" 时 aria-orientation 是 vertical', () => {
    const out = html(
      h(
        Tabs,
        { defaultValue: 'a', orientation: 'vertical' },
        h(TabList, { variant: 'side' }, h(Tab, { value: 'a' }, '外观')),
      ),
    );
    expect(out).toContain('data-variant="side"');
    expect(out).toContain('aria-orientation="vertical"');
  });
  it('Row：头、标题、次要文字、右列按顺序；没给头就没有头那一格；wrap 写 data-wrap；selected 写 aria-current', () => {
    const out = html(
      h(Row, { lead: '群', title: '标题', sub: '预览', side: '11:20', wrap: true, selected: true }),
    );
    expect(out.startsWith('<div class="ll-row"')).toBe(true);
    expect(out).toContain('data-wrap=""');
    expect(out).toContain('aria-current="true"');
    const order = ['ll-row-lead', 'll-row-main', 'll-row-title', 'll-row-sub', 'll-row-side'].map(
      (c) => out.indexOf(c),
    );
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const bare = html(h(Row, { title: '只有标题' }));
    expect(bare).not.toContain('ll-row-lead');
    expect(bare).not.toContain('ll-row-sub');
    expect(bare).not.toContain('ll-row-side');
    expect(bare).not.toContain('aria-current');
    expect(bare).not.toContain('data-wrap');
  });
  it('RowButton：根是 button，默认 type=button，其余属性传下去，后面接的东西放在最后', () => {
    const out = html(
      h(
        RowButton,
        { title: '会话', 'aria-label': '会话，没有新消息', className: 'conv-item' } as never,
        h('i', { className: 'll-row-full' }),
      ),
    );
    expect(out.startsWith('<button type="button" class="ll-row conv-item"')).toBe(true);
    expect(out).toContain('aria-label="会话，没有新消息"');
    expect(out.endsWith('<i class="ll-row-full"></i></button>')).toBe(true);
  });
});
