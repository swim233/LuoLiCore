import { createElement as h } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as controls from './index';
import * as icons from '../icons';

/* React 这一层只是拼属性：用服务端渲染（不需要 DOM）看渲染出来的属性对不对。
   样子由纯 CSS 管（QA 在展示页上用真实浏览器验收）；两步确认的点击、超时在浏览器里验。
   这个文件在没有 window 的环境里 import 入口，能 import 进来就说明入口加载时不碰 DOM。 */
const { Badge, Button, Chevron, ConfirmButton, Dot, IconButton, Seg, Spinner, Switch, Tag } =
  controls;
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
