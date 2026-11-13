/* 消息里的网址：哪些能点、点开是什么地址。
   只认 http、https；没写协议的域名（example.com、docs.foo.dev/a）补成 https；别的协议（javascript:、data:、ftp:、mailto:……）都不认，当普通文字。
   正文里自动认出的网址（components/Hl.tsx）和 Markdown 里写的链接（components/Markdown.tsx）都经过这里。纯函数，不碰 DOM */

/* 没写协议时认哪些：域名加常见后缀，和 Hl 里高亮认的那些一致 */
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

/** 句子里的网址后面常常紧跟标点（「看这里 https://a.com/x。」「https://a.com/x, 然后…」）：把末尾的标点从网址里分出来。
    括号、中文标点不用管：Hl 认网址时本来就在它们前面停下 */
export function splitUrlTail(s: string): [url: string, tail: string] {
  const m = /[.,;:!?'"*_~\]}]+$/.exec(s);
  return m ? [s.slice(0, m.index), m[0]] : [s, ''];
}
