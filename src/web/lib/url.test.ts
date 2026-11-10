import { describe, expect, it } from 'vitest';
import { linkHref, splitUrlTail } from './url';

/* 消息里的网址：哪些能点、点开是什么地址 */
describe('linkHref', () => {
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
    // 没有认得的后缀的裸域名不补协议（和 Hl 高亮认的一致）
    expect(linkHref('foo.bar')).toBeNull();
    expect(linkHref('v1.2.3')).toBeNull();
  });

  it('带用户名密码的不认（https://example.com@evil.com 这类容易骗人）', () => {
    expect(linkHref('https://example.com@evil.com/')).toBeNull();
    expect(linkHref('https://user:pw@example.com/')).toBeNull();
  });
});

describe('splitUrlTail', () => {
  it('把网址末尾的标点分出来', () => {
    expect(splitUrlTail('https://a.com/x.')).toEqual(['https://a.com/x', '.']);
    expect(splitUrlTail('https://a.com/x?q=1,')).toEqual(['https://a.com/x?q=1', ',']);
    expect(splitUrlTail('example.com!?')).toEqual(['example.com', '!?']);
    expect(splitUrlTail('https://a.com/x**')).toEqual(['https://a.com/x', '**']);
  });

  it('网址里面的标点不动，没有标点原样返回', () => {
    expect(splitUrlTail('https://a.com/x.html')).toEqual(['https://a.com/x.html', '']);
    expect(splitUrlTail('https://a.com/a_b')).toEqual(['https://a.com/a_b', '']);
  });
});
