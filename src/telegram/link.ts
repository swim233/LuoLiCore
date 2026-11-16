/* Markdown 链接的网址：哪些能点、点开是什么地址。
   照组件库的 linkHref（packages/ui/src/url.ts）另写的一份，规则和面板一样，测试也用同样的例子：
   Telegram 前端不能引用组件库的代码（lint 拦着）。那边改了规则，这边也要跟着改。
   只认 http、https；没写协议的域名（example.com、docs.foo.dev/a）补成 https；别的协议（javascript:、data:、ftp:、
   mailto:……）、带用户名密码的、带空白的都不认 */

/* 没写协议时认哪些：域名加常见后缀 */
const BARE_RE = /^(?:[a-z0-9-]+\.)+(?:com|org|net|cn|io|dev|me|jp|edu|gov|info)(?:[/?#]|$)/i;

/** 能点的地址（规整过的 http 或 https 网址）；不能点返回 null */
export function linkHref(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  let candidate = s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    // 没写协议：只认「域名加常见后缀」，别的（相对路径、//host、纯文字）不认
    if (!BARE_RE.test(s)) return null;
    candidate = 'https://' + s;
  }
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // 带用户名密码的（https://example.com@evil.com 这类）容易骗人，不当链接
  if (!u.hostname || u.username || u.password) return null;
  return u.href;
}
