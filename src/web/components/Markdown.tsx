import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Token } from 'marked';
import { lexMarkdown } from '../lib/markdown';
import { PENDING_HREF } from '../lib/stream-md';
import { cpLen, makeCuts } from '../lib/typing';
import type { Batch } from '../lib/typing';
import { linkHref } from '@luoli/ui/url';
import { freshNodes } from './Fresh';
import { Hl } from './Hl';
import { Link } from './Link';

/* 洛璃的回复按 Markdown 画：marked 只管把文字拆成词元（lib/markdown.ts），这里把词元画成 React 元素。
   不用 marked 的 HTML 输出，不用 dangerouslySetInnerHTML；原始 HTML 当普通文字显示；图片不加载（面板不访问外网），画成链接。
   支持：加粗、斜体、删除线、行内代码、代码块（语言名、复制）、列表（有序、无序、嵌套、任务）、引用、标题、表格、分隔线、链接。
   没闭合的写法（半个 **、没写完的代码块）marked 本来就不当格式，原样显示（逐字输出时，lib/stream-md.ts 先把放出来的文字改成最终的样子再交给这里，见 Typed.tsx）。

   结构（逐字输出，Typed.tsx，接在这上面）：
   - Markdown 把文字拆成顶层的块，每块一个 Block（memo，按块自己的原文比较）：已经写完的块，后面加字时不重画；
   - 行内的文字走 Hl（网址、@提及、引号、提到洛璃、数字的高亮），代码里不高亮；
   - tail：画在整段内容最后一个字后面的东西（光标）。每一层只把它交给自己的最后一个孩子，
     最后落在：段落、标题的末尾，列表最后一项的末尾，引用的最后一块的末尾，表格最后一个单元格里，代码块的 <code> 里，其余块的后面
     （分隔线后面不放：放了要多占一行，结束时去掉会跳）。所以不管最后一个字在列表项、表格还是代码块里，tail 都紧贴着它；
   - fresh：刚出现的几个字（lib/typing.ts 的 Batch，一个字一批，开始时刻几乎相同的合成一批）。和 tail 一起走到最后一个文字片段（或代码块的 <code>）里，
     把末尾这几批字各包一个落下的 span；最后一个词元是加粗、斜体、删除线、链接、行内代码时，进到它里面的最后一个文字片段里落
     （逐字时没写完的加粗、行内代码、链接一出现就是最终的样子，里面的字也要一个个落下）；
   - 逐字时没写完的链接（lib/stream-md.ts 把网址换成占位 PENDING_HREF）：画成不能点的链接色文字，只有方括号里的字；
   - tokens：调用方自己分好的词元（逐字时用增量分析，不走缓存）；不给就按 text 分。 */
interface Tk {
  type: string;
  raw: string;
  text?: string;
  tokens?: Tk[];
  href?: string;
  lang?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | '';
  items?: Tk[];
  task?: boolean;
  checked?: boolean;
  autolink?: boolean;
  header?: Cell[];
  rows?: Cell[][];
}
interface Cell {
  tokens: Tk[];
  align: 'left' | 'center' | 'right' | null;
}
interface Ctx {
  hits: boolean;
}
/** 画在最后一个字后面的东西和刚放出的字（见文件开头），一起往最后一个孩子里传。
 *  node 为空：只传刚放出的字（走进加粗、链接这类行内元素里面，光标画在它们外面） */
interface Tail {
  node: ReactNode;
  fresh?: readonly Batch[];
}

/* 行内词元 → 节点。inLink：已经在链接的文字里（不能再嵌链接）。tail 接在最后 */
function inlines(tokens: Tk[] | undefined, c: Ctx, inLink: boolean, tail?: Tail): ReactNode[] {
  const list = tokens ?? [];
  const out: ReactNode[] = list.map((t, i) => {
    // 刚放出的字只给最后一个词元；它是加粗、链接这类时，字在它里面的最后一个文字片段里落
    const fresh = i === list.length - 1 ? tail?.fresh : undefined;
    const into = fresh ? { node: null, fresh } : undefined;
    switch (t.type) {
      case 'text':
        // 列表项、引用里的文字块自己带着行内词元
        return t.tokens ? (
          <Fragment key={i}>{inlines(t.tokens, c, inLink, into)}</Fragment>
        ) : (
          <Hl key={i} text={t.text ?? t.raw} hits={c.hits} links={!inLink} fresh={fresh} />
        );
      case 'escape':
        return <Fragment key={i}>{t.text}</Fragment>;
      case 'strong':
        return <strong key={i}>{inlines(t.tokens, c, inLink, into)}</strong>;
      case 'em':
        return <em key={i}>{inlines(t.tokens, c, inLink, into)}</em>;
      case 'del':
        return <del key={i}>{inlines(t.tokens, c, inLink, into)}</del>;
      case 'codespan':
        return (
          <code key={i} className="md-ic">
            {fresh ? freshNodes(t.text ?? '', 0, makeCuts(cpLen(t.text ?? ''), fresh)) : t.text}
          </code>
        );
      case 'br':
        return <br key={i} />;
      case 'link': {
        // 正文里直接写的网址（没有 < >）marked 也认成链接，但它只在空白处断：「https://a.com/x。」连句号和后面的中文都吞进去。
        // 这种交给 Hl，和别人发的消息里的网址同一套认法（遇到中文标点就停，没写协议的域名补 https）
        if (t.autolink && !t.raw.startsWith('<'))
          return <Hl key={i} text={t.raw} hits={c.hits} links={!inLink} />;
        // 逐字时还没写完的链接：只有方括号里的字，链接色，不能点
        if (t.href === PENDING_HREF)
          return (
            <span key={i} className="md-a is-pending">
              {inlines(t.tokens, c, true, into)}
            </span>
          );
        const href = inLink ? null : linkHref(t.href ?? '');
        if (!href)
          return <Fragment key={i}>{inLink ? inlines(t.tokens, c, true) : t.raw}</Fragment>;
        return (
          <Link key={i} href={href} className="md-a">
            {t.autolink ? t.text : inlines(t.tokens, c, true, into)}
          </Link>
        );
      }
      case 'image': {
        // 不加载图片：显示成链接，文字是说明，没有说明就写网址
        if (t.href === PENDING_HREF)
          return (
            <span key={i} className="md-a is-pending">
              {t.text}
            </span>
          );
        const href = inLink ? null : linkHref(t.href ?? '');
        if (!href) return <Fragment key={i}>{t.raw}</Fragment>;
        return (
          <Link key={i} href={href} className="md-a">
            {t.text || t.href}
          </Link>
        );
      }
      default:
        // 原始 HTML 和不认得的：当普通文字
        return <Fragment key={i}>{t.text ?? t.raw}</Fragment>;
    }
  });
  if (tail) out.push(<Fragment key="tail">{tail.node}</Fragment>);
  return out;
}

/* 复制：优先用剪贴板接口，不行（不是安全上下文、没有权限）退回老办法 */
async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok: boolean;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
const COPIED_MS = 1600;
const stopEv = (e: React.SyntheticEvent) => e.stopPropagation();

/* 代码块：等宽字体、不着色、太宽时横向滚动；上面一条小字：左边语言名（有的话），右边「复制」，点了变成「已复制」一会儿再变回来 */
function CodeBlock({ lang, code, tail }: { lang?: string; code: string; tail?: Tail }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const name = (lang ?? '').trim().split(/\s+/)[0];
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-lang">{name}</span>
        <button
          className="md-copy"
          type="button"
          aria-label="复制代码"
          onPointerDown={stopEv}
          onClick={(e) => {
            e.stopPropagation();
            void copyText(code).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
            });
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code>
          {tail?.fresh?.length ? freshNodes(code, 0, makeCuts(cpLen(code), tail.fresh)) : code}
          {tail?.node}
        </code>
      </pre>
    </div>
  );
}

const isBlank = (t: Tk) => t.type === 'space' || t.type === 'def';

/* 块（含列表项、引用里面的）→ 节点。tail 只给最后一个 */
function blocks(tokens: Tk[] | undefined, c: Ctx, tail?: Tail): ReactNode[] {
  const shown = (tokens ?? []).filter((t) => !isBlank(t));
  return shown.map((t, i) => (
    <Fragment key={i}>{block(t, c, i === shown.length - 1 ? tail : undefined)}</Fragment>
  ));
}
function block(t: Tk, c: Ctx, tail?: Tail): ReactNode {
  switch (t.type) {
    case 'paragraph':
      return <p className="md-p">{inlines(t.tokens, c, false, tail)}</p>;
    case 'text':
      // 紧凑列表里的文字：不带段落的间距
      return (
        <>{inlines(t.tokens ?? [{ type: 'text', raw: t.raw, text: t.text }], c, false, tail)}</>
      );
    case 'heading': {
      const d = t.depth ?? 1;
      return (
        <div className={'md-h md-h' + Math.min(d, 4)} role="heading" aria-level={d}>
          {inlines(t.tokens, c, false, tail)}
        </div>
      );
    }
    case 'code':
      return <CodeBlock lang={t.lang} code={t.text ?? ''} tail={tail} />;
    case 'blockquote':
      return <blockquote className="md-q">{blocks(t.tokens, c, tail)}</blockquote>;
    case 'list': {
      const Tag = t.ordered ? 'ol' : 'ul';
      const items = t.items ?? [];
      return (
        <Tag
          className="md-l"
          start={t.ordered && typeof t.start === 'number' && t.start !== 1 ? t.start : undefined}
        >
          {items.map((it, i) => (
            <li key={i} className={it.task ? 'md-task' : undefined}>
              {blocks(it.tokens, c, i === items.length - 1 ? tail : undefined)}
            </li>
          ))}
        </Tag>
      );
    }
    case 'checkbox':
      return (
        <span className="md-box" role="img" aria-label={t.checked ? '已完成' : '未完成'}>
          {t.checked ? '☑' : '☐'}
        </span>
      );
    case 'hr':
      // 光标不放在分隔线后面：要另起一行放，结束时去掉这一行高度会跳
      return <hr className="md-hr" />;
    case 'table': {
      const rows = t.rows ?? [];
      const head = t.header ?? [];
      // 光标放在最后一个有字的单元格里：写到一半的一行，marked 会把没写的格子补成空的，放进最后一个空格子就离字很远了
      let at = [-1, head.length - 1];
      head.forEach((x, k) => {
        if (x.tokens.length) at = [-1, k];
      });
      rows.forEach((r, j) =>
        r.forEach((x, k) => {
          if (x.tokens.length) at = [j, k];
        }),
      );
      const cell = (x: Cell, j: number, k: number, Tag: 'th' | 'td') => (
        <Tag key={k} style={x.align ? { textAlign: x.align } : undefined}>
          {inlines(x.tokens, c, false, at[0] === j && at[1] === k ? tail : undefined)}
        </Tag>
      );
      return (
        <div className="md-tw">
          <table className="md-t">
            <thead>
              <tr>{head.map((x, k) => cell(x, -1, k, 'th'))}</tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>{r.map((x, k) => cell(x, j, k, 'td'))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      // 原始 HTML 块和不认得的：当普通文字，保留换行
      return (
        <p className="md-p md-raw">
          {(t.text ?? t.raw).replace(/\n+$/, '')}
          {tail?.node}
        </p>
      );
  }
}

/* 顶层的块：memo，按块自己的原文和高亮方式比较。后面加字时前面写完的块不重画；最后一块变了（或 tail 变了）才重画 */
const Block = memo(
  function Block({ t, c, tail }: { t: Tk; c: Ctx; tail?: Tail }) {
    return <>{block(t, c, tail)}</>;
  },
  (a, b) => a.t.raw === b.t.raw && a.c.hits === b.c.hits && a.tail === b.tail,
);

export const Markdown = memo(function Markdown({
  text,
  hits = false,
  tail,
  fresh,
  tokens,
}: {
  text: string;
  /** 提到洛璃的名字、唤醒词是不是加亮（洛璃自己的回复不加） */
  hits?: boolean;
  /** 画在最后一个字后面的东西（逐字输出的光标），见文件开头的说明 */
  tail?: ReactNode;
  /** 逐字输出时刚出现的字：各自落下 */
  fresh?: readonly Batch[];
  /** text 已经分好的词元（逐字时用增量分析）；不给就按 text 分 */
  tokens?: Token[];
}) {
  const shown = ((tokens ?? lexMarkdown(text)) as unknown as Tk[]).filter((t) => !isBlank(t));
  const c: Ctx = { hits };
  const end = useMemo<Tail | undefined>(
    () => (tail ? { node: tail, fresh } : undefined),
    [tail, fresh],
  );
  return (
    <div className="md">
      {shown.length
        ? shown.map((t, i) => (
            <Block key={i} t={t} c={c} tail={i === shown.length - 1 ? end : undefined} />
          ))
        : tail}
    </div>
  );
});
