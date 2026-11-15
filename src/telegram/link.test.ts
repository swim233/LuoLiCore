import { describe, expect, it } from 'vitest';
import { linkHref } from './link.js';

/* 和组件库 packages/ui/src/url.test.ts 里 linkHref 的例子一样：两份规则要一致 */
describe('Markdown 链接的网址', () => {
  it('http、https 网址原样认（规整成标准写法）', () => {
    expect(linkHref('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(linkHref('http://example.com')).toBe('http://example.com/');
    expect(linkHref('  https://example.com/x  ')).toBe('https://example.com/x');
  });

  it('没写协议的域名补成 https', () => {
    expect(linkHref('example.com')).toBe('https://example.com/');
    expect(linkHref('docs.foo.dev/a/b?c=1')).toBe('https://docs.foo.dev/a/b?c=1');
    expect(linkHref('Book.Example.COM/algernon')).toBe('https://book.example.com/algernon');
  });

  it('别的协议不认', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<b>x</b>',
      'ftp://example.com/a',
      'mailto:a@example.com',
      'file:///etc/passwd',
      'vbscript:x',
      'blob:https://example.com/x',
    ])
      expect(linkHref(bad), bad).toBeNull();
  });

  it('不像网址的不认', () => {
    for (const bad of [
      '',
      '   ',
      '文字',
      'foo',
      '/relative/path',
      '//evil.com/x',
      'a b.com',
      'example',
    ]) {
      expect(linkHref(bad), bad).toBeNull();
    }
    // 没有认得的后缀的裸域名不补协议
    expect(linkHref('foo.bar')).toBeNull();
    expect(linkHref('v1.2.3')).toBeNull();
  });

  it('带用户名密码的不认（https://example.com@evil.com 这类容易骗人）', () => {
    expect(linkHref('https://example.com@evil.com/')).toBeNull();
    expect(linkHref('https://user:pw@example.com/')).toBeNull();
  });
});
