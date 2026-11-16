import { describe, expect, it } from 'vitest';
import { DEFAULT_LABELS, resolveLabels } from './labels';

/* 入口加载时不碰 DOM：这里是 node 环境，没有 window、document。import 能成功、拿得到东西，就说明没碰 */
describe('@luoli/ui/chat 在没有 DOM 的环境里', () => {
  it('能加载', async () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    const m = await import('./index');
    expect(typeof m.ChatBubble).toBe('object'); // memo 组件
    expect(typeof m.ChatTyping).toBe('function');
    expect(typeof m.Markdown).toBe('object');
    expect(typeof m.Typed).toBe('function');
    expect(typeof m.Cursor).toBe('function');
    expect(typeof m.Hl).toBe('object');
    expect(typeof m.Pic).toBe('function');
    expect(typeof m.installBubbleFrame).toBe('function');
    expect(typeof m.colorOf).toBe('function');
    expect(typeof m.plainPreview).toBe('function');
    expect(typeof m.ChatMentions).toBe('object');
  });
  it('@luoli/ui/md（纯逻辑，不带组件）也能加载', async () => {
    const m = await import('./md');
    expect(typeof m.plainPreview).toBe('function');
    expect(typeof m.lexMarkdown).toBe('function');
    expect(typeof m.IncrementalLexer).toBe('function');
  });
  it('没有大动画在走时 installBubbleFrame 装上、拆掉都不碰 DOM', async () => {
    const { installBubbleFrame } = await import('./index');
    const off = installBubbleFrame({ busy: () => true });
    expect(() => off()).not.toThrow();
    expect(() => installBubbleFrame()()).not.toThrow();
  });
});

describe('每个人的名字颜色', () => {
  it('同一个 key 永远同一个颜色，颜色取自 --ll-who-0…9', async () => {
    const { colorOf } = await import('./colors');
    expect(colorOf('u1')).toBe(colorOf('u1'));
    expect(colorOf('u1')).toMatch(/^var\(--ll-who-[0-9]\)$/);
    const seen = new Set(Array.from({ length: 200 }, (_, i) => colorOf('user' + i)));
    expect(seen.size).toBe(10);
  });
});

describe('写死的话能换', () => {
  it('不给就是默认的（同一个对象）', () => {
    expect(resolveLabels()).toBe(DEFAULT_LABELS);
    expect(resolveLabels({})).toBe(DEFAULT_LABELS);
    expect(resolveLabels({ copy: undefined })).toBe(DEFAULT_LABELS);
  });
  it('只写要换的那几条，别的还是默认的', () => {
    const L = resolveLabels({ copy: 'Copy', thought: (n) => `thought ${n}s` });
    expect(L.copy).toBe('Copy');
    expect(L.thought(3)).toBe('thought 3s');
    expect(L.copied).toBe(DEFAULT_LABELS.copied);
    expect(L.queued).toBe('排队中');
  });
  it('默认的几句和以前写死的一样', () => {
    expect(DEFAULT_LABELS.thought(3)).toBe('思考了 3 秒');
    expect(DEFAULT_LABELS.result(12345, true)).toBe('结果 · 共 12,345 字符，这里只有开头');
    expect(DEFAULT_LABELS.result(8, false)).toBe('结果 · 共 8 字符');
  });
});
