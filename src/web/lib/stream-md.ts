/* 逐字输出时的排版：纯函数，不碰 DOM。
   marked 只在写法闭合时才认格式，逐字输出时每个前缀都按「还没写完」排版，下一个字到了再变样：
   一行文字下面的 `-` 先闪成标题，代码块结尾的反引号先显示成代码里多出的一行，`**加粗**` 闭合时符号消失、气泡变窄，
   链接写到 `)` 时整段网址一下子消失……（诊断见 .grill/ui-polish/diag-bubble.md 第 2 节）。
   这里的办法是：把「已经放出来的文字」改一遍再交给词法分析，让排版只往前走，已经显示出来的字和块不再变小、变回别的样子。
   `settleMarkdown(text)` 只动最后一行（以及最后一行是表头时补一行分隔行），前面的块一字不改，所以增量分析照旧只重新分析最后两块。

   改的规则（text 是放出来的前缀，不是完整的回复）：
   - 代码块里（围栏还没闭合）：最后一行只有一两个和开头同类的符号（可能是结尾）先不显示；
   - 行首还看不出是什么的符号先不显示，等后面的字定了再出现：`-`、`*`、`+`、`_`、`--`、`**`、`__`、`***`、`___`（可能是列表、分隔线、加粗、普通文字）、
     `1`、`1.`、`1)`、`#`～`######`、`>`、一到两个反引号或波浪号、孤零零的 `|`，以及列表标记、引用标记后面还没有内容的（`- `、`1. `、`> `）。
     行首的空白不算（嵌套列表里的 `  -`、`   1.` 一样）。写全了的 `---` 不压（它不会长成别的东西）；`***` 要等换行才是分隔线。
     这一行（连同它前面的换行）整个先去掉，下一个字到了再按最终的样子出现；
   - 表格：表头行（行首是 `|`）有字了就当表格显示，补一行分隔行（列数照补上结尾的符号、去掉空的开头符号以后的表头算，
     不然分隔行和表头的列数对不上，marked 就不认表格）；分隔行写到一半时换成写满的分隔行，字不露出来；
     下一行不是分隔行（很少见）才变回普通文字；数据行只有一个 `|` 时先不显示。没有开头竖线的表头不处理（分不清是表头还是普通的话，
     模型几乎都写开头的竖线），写完分隔行才变成表格；
   - 没写完的行内写法：行尾补上结尾的符号，让它一出现就按最终的样子显示：`**加粗`、`***加粗斜体`、行内代码的反引号、`~~删除`；
     链接 `[文字](网址` 补成指向占位网址（PENDING_HREF）的链接，Markdown.tsx 把它画成不能点的链接色文字，网址不显示；
     开头的符号后面还没有字的，符号不显示；行尾刚到的一个 `*`、`~`（还分不清是一个还是两个）、`!`（可能是 `![` 的前一半）先不显示，
     结尾的符号逐个到达时不会先露出来；
   - 单个 `*`、`_` 的斜体不提前变（`*` 常被当乘号），仍然等闭合；
   - 到这一行结束都没闭合的（后面来了换行）：不再补，变回原样的文字。回复结束时调用方不再调这里，用原文（见 Typed.tsx）。 */

import type { Token } from 'marked';

/** 链接还没写完时代替网址的占位：Markdown.tsx 看到它，把链接画成不能点的、链接色的文字 */
export const PENDING_HREF = 'luoli:pending';

interface Fence {
  ch: string;
  len: number;
}
/* 围栏代码块：开头、结尾可以带缩进和引用的 `>`（列表项、引用里的代码块）；开头还可以紧跟在列表标记后面（`- ```js`） */
const FENCE_OPEN = /^[ \t]*(?:(?:>|[-+*]|\d{1,9}[.)])[ \t]+|>)*(`{3,}|~{3,})(.*)$/;
const FENCE_RUN = /^[ \t]*(?:>[ \t]*)*(`+|~+)[ \t]*$/;

function openFence(line: string): Fence | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  // 反引号围栏的说明文字里不能再有反引号（那是行内代码）
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return { ch: m[1][0], len: m[1].length };
}
function closesFence(line: string, f: Fence): boolean {
  const m = FENCE_RUN.exec(line);
  return !!m && m[1][0] === f.ch && m[1].length >= f.len;
}
/** 这几行读完以后，围栏代码块还开着吗 */
function fenceAfter(lines: readonly string[]): Fence | null {
  let f: Fence | null = null;
  for (const line of lines) {
    if (!line.includes('`') && !line.includes('~')) continue;
    if (f) {
      if (closesFence(line, f)) f = null;
    } else {
      f = openFence(line);
    }
  }
  return f;
}

/* 行首的容器标记：引用 `> `、列表项 `- `、`1. `（可以套着）。后面还没有内容时，这一行还看不出是什么 */
const CONTAINERS = /^(?:[ \t]*(?:>[ \t]?|[-+*][ \t]+|\d{1,9}[.)][ \t]+))*/;
/* 容器标记后面只有这些：可能是列表、分隔线、标题、代码块的开头，也可能是普通文字 */
const UNDECIDED = /^(?:[-+]|--|(?:[*_][ \t]*)+|\d{1,9}[.)]?|#{1,6}|>|`{1,2}|~{1,2}|\|)[ \t]*$/;
/* 写全了的分隔线 `---`、`- - -` 不在其中（它不会长成别的东西）。`***`、`___` 还在：后面接上字就是加粗斜体，不是分隔线 */
const HR = /^[ \t]{0,3}-(?:[ \t]*-){2,}[ \t]*$/;

/* ---- 表格 ---- */
const isRow = (l: string) => l.trimStart().startsWith('|');
const DELIM_LIKE = /^[ \t]*[|:-][ \t|:-]*$/;
const DELIM_CELL = /^:?-+:?$/;
const delimiter = (n: number) => '|' + ' --- |'.repeat(Math.max(1, n));
function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

/* ---- 行内 ---- */
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
function runLen(s: string, i: number, ch: string): number {
  let j = i;
  while (s[j] === ch) j++;
  return j - i;
}
/** 从 from 起找一段正好 len 个 ch 的连续符号，返回开头的位置，没有是 -1 */
function findRun(s: string, from: number, ch: string, len: number): number {
  let i = from;
  while (i < s.length) {
    if (s[i] === ch) {
      const r = runLen(s, i, ch);
      if (r === len) return i;
      i += r;
    } else {
      i++;
    }
  }
  return -1;
}
/** s[p] 是 `(`：找配对的 `)`（里面的括号成对、反斜杠转义），没有是 -1 */
function parenEnd(s: string, p: number): number {
  let depth = 0;
  for (let j = p; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

interface Opener {
  /** triple：`***`（加粗加斜体） */
  kind: 'strong' | 'del' | 'link' | 'triple';
  /** 开头符号的位置（链接是 `[`） */
  at: number;
  /** `![` */
  image?: boolean;
  /** 链接：`]` 的位置（读到了才有） */
  bracket?: number;
}

/**
 * 一行里没写完的行内写法：补上结尾的符号，让它一出现就按最终的样子显示（`**`、`~~`、行内代码的反引号、链接）；
 * 开头的符号后面还没有字、行尾刚到的一个 `*`、`~` 先不显示。只看这一行：到这一行结束都没闭合的，后面来了换行就不再补
 */
export function fixInline(line: string): string {
  const n = line.length;
  const stack: Opener[] = [];
  let code = -1; // 没闭合的行内代码：开头的位置
  let ticks = 0;
  let cut = n; // 这一行只留前 cut 个字
  let i = 0;
  scan: while (i < n) {
    const c = line[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = runLen(line, i, '`');
      const close = findRun(line, i + run, '`', run);
      if (close >= 0) {
        i = close + run;
        continue;
      }
      code = i;
      ticks = run;
      break;
    }
    if (c === '*' || c === '~') {
      const run = runLen(line, i, c);
      const kind = c === '*' ? 'strong' : 'del';
      const next = line[i + run];
      if (run === 2) {
        const top = stack[stack.length - 1];
        if (top?.kind === kind && !isSpace(line[i - 1])) {
          stack.pop(); // 结尾的符号
        } else if (next === undefined) {
          cut = i; // 行尾刚到的 `**`：还没有字，先不显示
          break scan;
        } else if (!isSpace(next) && !stack.some((o) => o.kind === kind)) {
          stack.push({ kind, at: i });
        }
      } else if (run === 3 && c === '*') {
        // `***加粗斜体***`：整个补成一对 `***`；行尾刚到的 `**`、`*`（结尾符号的一部分）照样先不显示
        const top = stack[stack.length - 1];
        if (top?.kind === 'triple' && !isSpace(line[i - 1])) {
          stack.pop();
        } else if (next === undefined) {
          cut = i;
          break scan;
        } else if (!isSpace(next) && !stack.some((o) => o.kind === 'triple')) {
          stack.push({ kind: 'triple', at: i });
        }
      } else if (run === 1 && next === undefined) {
        cut = i; // 行尾刚到的一个：还分不清是一个还是两个
        break scan;
      }
      i += run;
      continue;
    }
    if (c === '!' && i === n - 1) {
      cut = i; // 行尾的 `!`：可能是 `![` 的前一半，先不显示（一个字以后就会出现）
      break;
    }
    if (c === '[') {
      // 链接里不嵌链接：已经有一个 [ 开着时，后面的 [ 是普通字
      if (!stack.some((o) => o.kind === 'link'))
        stack.push({ kind: 'link', at: i, image: line[i - 1] === '!' && line[i - 2] !== '\\' });
      i++;
      continue;
    }
    if (c === ']') {
      const top = stack[stack.length - 1];
      if (top?.kind === 'link') {
        if (i + 1 >= n) {
          top.bracket = i; // `[文字]` 后面还没有字：先当作链接的文字
          break scan;
        }
        if (line[i + 1] === '(') {
          const end = parenEnd(line, i + 1);
          if (end < 0) {
            top.bracket = i; // `](网址` 还没写完
            break scan;
          }
          stack.pop();
          i = end + 1;
          continue;
        }
        stack.pop(); // `[文字]` 后面不是 `(`：字面的方括号
      }
      i++;
      continue;
    }
    i++;
  }
  // 没闭合的行内代码，反引号后面还没有内容：不显示
  if (code >= 0 && line.slice(code + ticks).trim() === '') {
    cut = code;
    code = -1;
  }
  // 开头的符号后面还没有字（`[`、`**`、`~~`）：不显示（连同它外面同样没有字的）
  for (let top = stack[stack.length - 1]; top; top = stack[stack.length - 1]) {
    if (top.kind === 'link' && top.bracket !== undefined) cut = Math.min(cut, top.bracket);
    const open = top.kind === 'link' ? 1 : top.kind === 'triple' ? 3 : 2;
    if (line.slice(top.at + open, cut).trim() !== '') break;
    cut = Math.min(cut, top.kind === 'link' && top.image ? top.at - 1 : top.at);
    stack.pop();
  }
  const body = line.slice(0, cut);
  let tail = code >= 0 ? '`'.repeat(ticks) : '';
  for (let k = stack.length - 1; k >= 0; k--) {
    const o = stack[k];
    tail +=
      o.kind === 'strong'
        ? '**'
        : o.kind === 'triple'
          ? '***'
          : o.kind === 'del'
            ? '~~'
            : `](${PENDING_HREF})`;
  }
  if (!tail) return body;
  // 结尾的符号紧贴最后一个字（空白放在它后面：`**粗 **` 里空白后面的符号认不了）
  const solid = body.trimEnd();
  return solid + tail + body.slice(solid.length);
}

/**
 * text 是已经放出来的前缀：返回交给词法分析的文字（规则见文件开头）。
 * 回复结束、全部放完以后不要调这个，直接用原文
 */
export function settleMarkdown(text: string): string {
  const nl = text.lastIndexOf('\n');
  const head = text.slice(0, nl + 1); // 含最后的换行
  const last = text.slice(nl + 1);
  const lines = head === '' ? [] : head.slice(0, -1).split('\n');
  // 去掉最后一行和它前面的换行
  const drop = () => (head === '' ? '' : head.slice(0, -1));

  const fence = fenceAfter(lines);
  if (fence) {
    // 代码里：最后一行只有一两个和开头同类的符号，可能是结尾。留着前面的换行（marked 不把最后的换行算进代码，光标留在上一行末尾）
    const m = FENCE_RUN.exec(last);
    return m && m[1][0] === fence.ch && m[1].length < fence.len ? head : text;
  }
  if (openFence(last)) return text; // 围栏的开头：一写满三个就是代码块的样子（后面的说明文字也照写）

  // 表格
  const above = lines.at(-1);
  let k = 0; // 紧挨着这一行上面连着几行以 | 开头的
  while (k < lines.length && isRow(lines[lines.length - 1 - k])) k++;
  if (last.trimStart().startsWith('|')) {
    if (k === 1 && DELIM_LIKE.test(last)) return delimRow(text, head, above!, splitCells(last));
    // 补上结尾的符号以后的这一行：以 **、反引号、[ 开头的最后一格还没有字时整格去掉，列数照这个数
    // （分隔行的列数和表头不一样，marked 就不认表格，两行都成了字面的竖线）
    const fixed = fixInline(last);
    const cells = splitCells(fixed);
    if (cells.every((c) => c === '')) return drop();
    return k === 0 ? head + fixed + '\n' + delimiter(cells.length) : head + fixed;
  }
  if (k === 1 && last.trim() === '') {
    // 表头行写完、换行了，分隔行还没有字：表头已经按表格显示着，保持
    const header = splitCells(above!);
    if (header.some((c) => c !== '')) return head + delimiter(header.length);
  }
  // 空行、写全了的分隔线：不用改
  if (last.trim() === '' || HR.test(last)) return text;
  // 补上结尾的符号以后，整行都没有显示的字，或者只剩行首的符号（`-`、`1.`、`>`、`#`……）：还看不出是什么，整行先不显示
  const fixed = fixInline(last);
  // 缩进的（嵌套列表里的 `  -`、`   1.`）也一样：判断前先去掉行首的空白
  const rest = fixed.slice(CONTAINERS.exec(fixed)![0].length).trimStart();
  if (fixed.trim() === '' || rest === '' || UNDECIDED.test(rest)) return drop();
  return head + fixed;
}

/* 分隔行（上一行是表头）：写满了（列数够、每格是 `---`）交给 marked；没写满换成写满的，表头已经按表格显示着，字不露出来 */
function delimRow(text: string, head: string, header: string, cells: string[]): string {
  const n = splitCells(header).length;
  return cells.length >= n && cells.every((c) => DELIM_CELL.test(c)) ? text : head + delimiter(n);
}

/* 链接 `[文字](网址)` 里 `](` 到 `)` 的部分（没写完的到行尾）：显示出来的只有 `[文字]` 里的字，这一段不占逐字的时间（见 typing.ts 的 Spans）。
   围栏代码块里的不算 */
const LINK_TAIL = /\[[^\]\n]*(\]\([^)\n]*(?:\)|$))/g;
/** text（已经到达的全文）里这些部分的位置：[开始, 结束)，UTF-16 下标，按位置排好 */
export function linkTailSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  if (!text.includes('](')) return out;
  let fence: Fence | null = null;
  let pos = 0;
  for (const line of text.split('\n')) {
    const start = pos;
    pos += line.length + 1;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = openFence(line);
    if (fence || !line.includes('](')) continue;
    for (const m of line.matchAll(LINK_TAIL)) {
      const end = start + m.index + m[0].length;
      out.push([end - m[1].length, end]);
    }
  }
  return out;
}

/* ---- 落下的字和显示出来的字对齐 ---- */
type Leaf = Token & {
  tokens?: Token[];
  items?: Leaf[];
  header?: Cell[];
  rows?: Cell[][];
  text?: string;
};
interface Cell {
  tokens: Token[];
}
/** 这些词元显示出来的最后 need 个字（按显示的顺序，没有字的块不算；表格、列表只看最后一个有字的格、项） */
function tailText(tokens: readonly Token[], need: number): string {
  let out = '';
  for (let i = tokens.length - 1; i >= 0 && out.length < need; i--) {
    const t = tokens[i] as Leaf;
    const want = need - out.length;
    let s = '';
    switch (t.type) {
      case 'space':
      case 'def':
      case 'hr':
      case 'br':
      case 'checkbox':
        break;
      case 'table': {
        const cells = [...(t.rows ?? []).flat().reverse(), ...[...(t.header ?? [])].reverse()];
        for (const cell of cells) if ((s = tailText(cell.tokens, want))) break;
        break;
      }
      case 'list': {
        const items = t.items ?? [];
        for (let k = items.length - 1; k >= 0 && !s; k--) s = tailText(items[k].tokens ?? [], want);
        break;
      }
      case 'code':
      case 'codespan':
      case 'image':
      case 'escape':
      case 'html':
        s = (t.text ?? t.raw).slice(-want);
        break;
      default:
        s = t.tokens ? tailText(t.tokens, want) : (t.text ?? t.raw).slice(-want);
    }
    out = s + out;
  }
  return out;
}
const TAIL_CHARS = 8;
/**
 * raw 是放出来的文字，tokens 是它改过以后分析的结果：raw 末尾有几个字（码点）没有显示出来
 * （刚到的结尾符号 `**`、先压住的符号、换行……）。逐字落下的动画按「显示出来的最后几个字」对时刻，
 * 要把这几个没显示的字的时刻去掉，否则结尾的符号一到，前面最后几个字就跟着再落一次。
 * 找法：取显示出来的最后几个字，在 raw 里从后往前找它们（找不到就少取一个字再找；只取一个字时结尾没显示的字里有同一个字就会数错，
 * 所以先试长的：代码块末尾的空行 `\n` 和被去掉的结尾 `\n` 是同一个字，要连着前面的字一起找）
 */
export function hiddenTail(raw: string, tokens: readonly Token[]): number {
  const tail = tailText(tokens, TAIL_CHARS);
  for (let k = tail.length; k >= 1; k--) {
    const s = tail.slice(-k);
    const at = raw.lastIndexOf(s);
    if (at >= 0) return Array.from(raw.slice(at + s.length)).length;
  }
  return 0;
}
