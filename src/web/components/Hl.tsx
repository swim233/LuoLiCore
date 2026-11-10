import { Fragment, memo } from 'react';
import type { CSSProperties } from 'react';
import { motionOn } from '../lib/prefs';
import { linkHref, splitUrlTail } from '../lib/url';
import type { ImagePart } from '../model/types';
import { assistant, useAssistant } from '../model/who';
import { Link } from './Link';

/* 正文高亮：网址、@提及、引号里的话、提到助手（名字、唤醒词，由服务告诉面板）、数字。
   @提及里认名字、唤醒词和 bot 的 @用户名：提到她的 @ 加亮 */
const URL_RE = String.raw`https?:\/\/[^\s，。！？、；：（）()《》“”"'‘’「」<>]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|cn|io|dev|me|jp|edu|gov|info)(?:\/[^\s，。！？、；：（）()《》“”"'‘’「」<>]*)?`;
const QUOTE_RE = String.raw`“[^”]*”|「[^」]*」|"[^"\n]*"|‘[^’]*’`;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* 纯英文数字的词要按词的边界认（nori 不认 norita），中文名字直接认 */
const word = (w: string) => (/^[\w-]+$/.test(w) ? `\\b${escRe(w)}\\b` : escRe(w));
interface Matcher {
  re: RegExp;
  at: RegExp | null;
}
let cache: { key: string; m: Matcher } | null = null;
function matcher(): Matcher {
  const a = assistant.get();
  const key = JSON.stringify([a.name, a.wakeWords, a.username]);
  if (cache?.key === key) return cache.m;
  const uniq = (xs: string[]) =>
    [...new Set(xs.map((x) => x.trim()).filter(Boolean))].sort((p, q) => q.length - p.length);
  const names = uniq([a.name, ...a.wakeWords]);
  const handles = uniq([a.name, ...a.wakeWords, ...(a.username ? [a.username] : [])]);
  const mention = names.length ? `(${names.map(word).join('|')})` : '(\\b\\B)';
  const re = new RegExp(
    `(${URL_RE})|(@[\\w一-龥]+)|(${QUOTE_RE})|${mention}|(\\d+(?:[.:]\\d+)*%?)`,
    'gi',
  );
  const at = handles.length ? new RegExp(`^@(${handles.map(escRe).join('|')})`, 'i') : null;
  cache = { key, m: { re, at } };
  return cache.m;
}
export interface Tok {
  t: string;
  c: string;
}
export function hlTokens(text: string, hits: boolean): Tok[] {
  const out: Tok[] = [];
  let last = 0,
    m: RegExpExecArray | null;
  const { re: base, at } = matcher();
  const re = new RegExp(base.source, base.flags);
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), c: '' });
    let c = '';
    if (m[1]) c = 'hl-url';
    else if (m[2]) c = 'hl-at' + (hits && at?.test(m[2]) ? ' hl-hit' : '');
    else if (m[3]) c = 'hl-q';
    else if (m[4]) c = hits ? 'hl-hit' : '';
    else if (m[5]) c = 'hl-num';
    out.push({ t: m[0], c });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), c: '' });
  return out;
}
/* links：认出的网址是不是做成能点的链接（默认是；已经在链接里面的文字不能再嵌一层链接，传 false）。
   网址末尾紧跟的标点不算网址；不是 http、https 的（认不出来的）当普通文字 */
export const Hl = memo(function Hl({
  text,
  hits,
  links = true,
}: {
  text: string;
  hits: boolean;
  links?: boolean;
}) {
  useAssistant(); // 名字、唤醒词变了要重新高亮
  return (
    <>
      {hlTokens(text, hits).map((x, i) => {
        if (x.c === 'hl-url') {
          const [url, tail] = splitUrlTail(x.t);
          const href = links ? linkHref(url) : null;
          if (href)
            return (
              <Fragment key={i}>
                <Link href={href} className="hl-url">
                  {url}
                </Link>
                {tail}
              </Fragment>
            );
          return <Fragment key={i}>{x.t}</Fragment>;
        }
        return x.c ? (
          <span key={i} className={x.c}>
            {x.t}
          </span>
        ) : (
          <Fragment key={i}>{x.t}</Fragment>
        );
      })}
    </>
  );
});

/* 缩略图：生成的色块代替图片（真实的图片只出现在网页对话里用户自己拖进来的） */
export function Thumb({
  part,
  w,
  h,
}: {
  part: Partial<ImagePart> & { blob?: string };
  w?: number;
  h?: number;
}) {
  const style: CSSProperties = {};
  if (w) {
    style['--tw'] = w + 'px';
    style['--th'] = h + 'px';
  }
  if (part.blob) {
    style['--img'] = `url("${part.blob}")`;
    return (
      <span className="thumb is-real" role="img" aria-label={part.name || '图片'} style={style} />
    );
  }
  const d = part.demo || { h1: 230, h2: 40, label: '图片' };
  style['--h1'] = d.h1;
  style['--h2'] = d.h2;
  return (
    <span className="thumb" role="img" aria-label={'图片 ' + d.label} style={style}>
      <span>{d.label}</span>
    </span>
  );
}

/* 转圈的符号：一个计时器带动所有的转圈 */
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const spinSet = new Set<HTMLElement>();
let spinI = 0,
  spinTimer: ReturnType<typeof setInterval> | 0 = 0;
const spinTick = () => {
  spinI = (spinI + 1) % SPIN.length;
  spinSet.forEach((el) => {
    if (!el.isConnected) spinSet.delete(el);
    else el.textContent = SPIN[spinI];
  });
  if (!spinSet.size && spinTimer) {
    clearInterval(spinTimer);
    spinTimer = 0;
  }
};
export function Spin() {
  return (
    <span
      className="spin"
      aria-hidden="true"
      ref={(el) => {
        if (!el) return;
        if (motionOn()) {
          el.textContent = SPIN[spinI];
          spinSet.add(el);
          if (!spinTimer) spinTimer = setInterval(spinTick, 80);
        } else el.textContent = '⋯';
      }}
    />
  );
}
