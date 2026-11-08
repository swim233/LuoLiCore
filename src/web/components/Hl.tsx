import { Fragment, memo } from 'react';
import type { CSSProperties } from 'react';
import { motionOn } from '../lib/prefs';
import type { ImagePart } from '../model/types';

/* 正文高亮：网址、@提及、引号里的话、提到洛璃（唤醒词）、数字 */
const HL_RE =
  /(https?:\/\/[^\s，。！？、；：（）()《》“”"'‘’「」<>]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|cn|io|dev|me|jp|edu|gov|info)(?:\/[^\s，。！？、；：（）()《》“”"'‘’「」<>]*)?)|(@[\w一-龥]+)|(“[^”]*”|「[^」]*」|"[^"\n]*"|‘[^’]*’)|(洛璃|\bnori\b)|(\d+(?:[.:]\d+)*%?)/gi;
export interface Tok {
  t: string;
  c: string;
}
export function hlTokens(text: string, hits: boolean): Tok[] {
  const out: Tok[] = [];
  let last = 0,
    m: RegExpExecArray | null;
  const re = new RegExp(HL_RE.source, HL_RE.flags);
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), c: '' });
    let c = '';
    if (m[1]) c = 'hl-url';
    else if (m[2]) c = 'hl-at' + (hits && /^@(洛璃|nori)/i.test(m[2]) ? ' hl-hit' : '');
    else if (m[3]) c = 'hl-q';
    else if (m[4]) c = hits ? 'hl-hit' : '';
    else if (m[5]) c = 'hl-num';
    out.push({ t: m[0], c });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), c: '' });
  return out;
}
export const Hl = memo(function Hl({ text, hits }: { text: string; hits: boolean }) {
  return (
    <>
      {hlTokens(text, hits).map((x, i) =>
        x.c ? (
          <span key={i} className={x.c}>
            {x.t}
          </span>
        ) : (
          <Fragment key={i}>{x.t}</Fragment>
        ),
      )}
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
