import { Fragment, memo, useContext } from 'react';
import type { ReactNode } from 'react';
import { Link } from '../controls';
import { linkHref, splitUrlTail } from '../url';
import { freshNodes } from './Fresh';
import { ChatMentions } from './mentions';
import { cpLen, makeCuts } from './typing';
import type { Batch } from './typing';
import type { ChatMentionsValue } from './types';

/* 正文高亮：网址、@提及、引号里的话、提到助手（名字、唤醒词，由用的项目经 ChatMentions 告诉库；没有就不高亮「提到」，别的照常）、数字。
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
function matcher(a: ChatMentionsValue | null): Matcher {
  const key = JSON.stringify(a ? [a.name, a.wakeWords, a.username] : null);
  if (cache?.key === key) return cache.m;
  const uniq = (xs: readonly string[]) =>
    [...new Set(xs.map((x) => x.trim()).filter(Boolean))].sort((p, q) => q.length - p.length);
  const names = a ? uniq([a.name, ...a.wakeWords]) : [];
  const handles = a ? uniq([a.name, ...a.wakeWords, ...(a.username ? [a.username] : [])]) : [];
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
export function hlTokens(
  text: string,
  hits: boolean,
  mentions: ChatMentionsValue | null = null,
): Tok[] {
  const out: Tok[] = [];
  let last = 0,
    m: RegExpExecArray | null;
  const { re: base, at } = matcher(mentions);
  const re = new RegExp(base.source, base.flags);
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), c: '' });
    let c = '';
    if (m[1]) c = 'll-hi-url';
    else if (m[2]) c = 'll-hi-at' + (hits && at?.test(m[2]) ? ' ll-hi-hit' : '');
    else if (m[3]) c = 'll-hi-q';
    else if (m[4]) c = hits ? 'll-hi-hit' : '';
    else if (m[5]) c = 'll-hi-num';
    out.push({ t: m[0], c });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), c: '' });
  return out;
}
/* links：认出的网址是不是做成能点的链接（默认是；已经在链接里面的文字不能再嵌一层链接，传 false）。
   网址末尾紧跟的标点不算网址；不是 http、https 的（认不出来的）当普通文字。
   fresh：逐字输出时这段文字末尾刚出现的字（Typed.tsx），各包一个落下的 span，其余不变；高亮的外壳（网址、@、引号）照常 */
export const Hl = memo(function Hl({
  text,
  hits,
  links = true,
  fresh,
}: {
  text: string;
  hits: boolean;
  links?: boolean;
  fresh?: readonly Batch[];
}) {
  const mentions = useContext(ChatMentions); // 名字、唤醒词变了（context 的值换了）要重新高亮
  const cuts = fresh?.length ? makeCuts(cpLen(text), fresh) : null;
  let pos = 0; // 已经处理到第几个字，按文字的顺序往后数
  const piece = (str: string): ReactNode => {
    if (!cuts) return str;
    const from = pos;
    pos += cpLen(str);
    return freshNodes(str, from, cuts);
  };
  return (
    <>
      {hlTokens(text, hits, mentions).map((x, i) => {
        if (x.c === 'll-hi-url') {
          const [url, tail] = splitUrlTail(x.t);
          const href = links ? linkHref(url) : null;
          if (href)
            return (
              <Fragment key={i}>
                <Link href={href} variant="auto" className="ll-hi-url">
                  {piece(url)}
                </Link>
                {piece(tail)}
              </Fragment>
            );
          return <Fragment key={i}>{piece(x.t)}</Fragment>;
        }
        return x.c ? (
          <span key={i} className={x.c}>
            {piece(x.t)}
          </span>
        ) : (
          <Fragment key={i}>{piece(x.t)}</Fragment>
        );
      })}
    </>
  );
});
