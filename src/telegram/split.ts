import type { RichPart } from './markdown.js';
import type { InputRichBlock, RichText } from './rich.js';

/** Telegram 一条文字消息的上限（UTF-16 码元，与 JS 字符串长度一致） */
export const telegramMessageLimit = 4096;

/**
 * 把长回复拆成不超过 limit 的几段。尽量在换行处断开（断点在后半段时），
 * 否则按长度硬断，不拆开代理对。适配器自己只会截断（末尾加 ...），不会拆分
 */
export function splitMessage(text: string, limit = telegramMessageLimit): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 换行连同它自己都要放进这一段，所以只找下标不超过 limit - 1 的换行
    const newline = rest.lastIndexOf('\n', limit - 1);
    let end = newline >= limit / 2 ? newline + 1 : limit;
    // 不在代理对中间断开
    const code = rest.charCodeAt(end - 1);
    if (end === limit && code >= 0xd800 && code <= 0xdbff) end -= 1;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * 一条富文本消息的上限，2026-11-14、11-15 在真的接口上试出来的（.grill/telegram-usage-footer/final.md「真机上验证过的」）：
 * - 字数 32768（真的接口按字数算，32768 个英文字母收、32769 个不收；几个块的字数加在一起）；
 * - 块数 500（块里面的块、列表项都算：500 个段落收、501 个不收）；
 * - 层数 16：每一处最里面的字（或公式）外面一共套了几层，数法见 measureBlock（15 层引用套一个段落收、
 *   16 层不收；段落里样式套 15 层收、16 层不收……试过的边界见 fake-rich.ts 的 depthProbes）。
 */
export const richLimits = { chars: 32768, blocks: 500, depth: 16 } as const;

/**
 * 每条富文本消息都给尾部（见 footer.ts）留的余量：分隔线和下标的段落两个块，那一行的字数。
 * 尾部最长也就五十来个字（「输入 999.9k · 缓存 999.9k · 输出 999.9k · 推理 999.9k · 59m59s」），留 100。
 * 层数不用留：尾部的两块最深 2 层，一条消息的层数看最深的那个块，不是加起来
 */
export const footerReserve = { chars: 100, blocks: 2 } as const;

/** 一个块的三个数（偏保守，宁可多算），见 measureBlock */
export type BlockSize = { chars: number; blocks: number; depth: number };

/**
 * 数一个块：
 * - 字数：块里所有字符串的长度之和（文字、公式、代码，以及链接的网址、代码块的语言），按 JS 字符串的长度
 *   （UTF-16 码元）算。真的接口按字数算，汉字和 emoji 在它那里实际更宽，按码元算只会多不会少；
 * - 块数：这个块自己，加上里面每一个块、每一个列表项、表格的每一行；
 * - 层数：这个块里最深的那个字（或公式）外面一共套了几层，2026-11-15 在真的接口上试出来的数法：
 *   引用、列表（连同列表项只算一层）、带字的块自己（段落、标题、代码块、表格；表格的行和格子不算）各算一层；
 *   文字里每一个带 type 的对象（样式、链接）、每一层数组也各算一层（见 textDepth）；公式、分隔线自己不算。
 */
export function measureBlock(block: InputRichBlock): BlockSize {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return { chars: textLength(block.text), blocks: 1, depth: 1 + textDepth(block.text) };
    case 'pre':
      return {
        chars: textLength(block.text) + (block.language?.length ?? 0),
        blocks: 1,
        depth: 1 + textDepth(block.text),
      };
    case 'mathematical_expression':
      return { chars: block.expression.length, blocks: 1, depth: 0 };
    case 'divider':
      return { chars: 0, blocks: 1, depth: 0 };
    case 'blockquote':
      return wrapping(block.blocks.map(measureBlock), 1);
    case 'list':
      // 每一项也算一个块；层数上列表连同列表项只算一层
      return wrapping(
        block.items.flatMap((item) => item.blocks.map(measureBlock)),
        1 + block.items.length,
      );
    case 'table': {
      const texts = block.cells.flat().map((cell) => cell.text ?? '');
      return {
        chars: texts.reduce((sum, text) => sum + textLength(text), 0),
        // 表格自己，加每一行
        blocks: 1 + block.cells.length,
        depth: 1 + texts.reduce((max, text) => Math.max(max, textDepth(text)), 0),
      };
    }
  }
}

/** 引用、列表：里面的块（inner）加起来，外面再套一层；own 是它自己占的块数 */
function wrapping(inner: BlockSize[], own: number): BlockSize {
  return {
    chars: inner.reduce((sum, size) => sum + size.chars, 0),
    blocks: inner.reduce((sum, size) => sum + size.blocks, own),
    depth: 1 + inner.reduce((max, size) => Math.max(max, size.depth), 0),
  };
}

/** 富文本里所有字符串的长度之和（链接的网址也算） */
function textLength(text: RichText): number {
  if (typeof text === 'string') return text.length;
  if (Array.isArray(text)) return text.reduce((sum, t) => sum + textLength(t), 0);
  if (text.type === 'mathematical_expression') return text.expression.length;
  if (text.type === 'url') return textLength(text.text) + text.url.length;
  return textLength(text.text);
}

/** 富文本的层数：字符串、公式是 0；数组是 1 加上各元素里最深的；带 type 的样式、链接是 1 加上它的文字 */
function textDepth(text: RichText): number {
  if (typeof text === 'string') return 0;
  if (Array.isArray(text)) return 1 + text.reduce((max, t) => Math.max(max, textDepth(t)), 0);
  if (text.type === 'mathematical_expression') return 0;
  return 1 + textDepth(text.text);
}

/**
 * 拆好的一条：rich 是一条富文本消息的块；没有 rich 的是退路，发原文的普通消息。
 * raw 都是这一条的原文（几个块的原文按顺序连起来，去掉首尾的空行）：富文本被拒收时也发它
 */
export type RichPiece = { rich?: InputRichBlock[]; raw: string };

/**
 * 顶层的块按顺序装进几条富文本消息：放不下了另起一条，只在顶层的块之间拆。每条都给尾部留了余量。
 * 单独一个块自己就超了字数、块数，或者层数超过上限：它单独成一条，没有 rich（发它的原文）
 */
export function splitRich(parts: RichPart[]): RichPiece[] {
  const pieces: RichPiece[] = [];
  let blocks: InputRichBlock[] = [];
  let raws: string[] = [];
  let used = { chars: 0, blocks: 0 };
  const close = () => {
    if (blocks.length) pieces.push({ rich: blocks, raw: trimBlankLines(raws.join('')) });
    blocks = [];
    raws = [];
    used = { chars: 0, blocks: 0 };
  };
  const fits = (chars: number, count: number) =>
    chars + footerReserve.chars <= richLimits.chars &&
    count + footerReserve.blocks <= richLimits.blocks;
  for (const { block, raw } of parts) {
    const size = measureBlock(block);
    if (size.depth > richLimits.depth || !fits(size.chars, size.blocks)) {
      close();
      pieces.push({ raw: trimBlankLines(raw) });
      continue;
    }
    if (!fits(used.chars + size.chars, used.blocks + size.blocks)) close();
    blocks.push(block);
    raws.push(raw);
    used = { chars: used.chars + size.chars, blocks: used.blocks + size.blocks };
  }
  close();
  return pieces;
}

/**
 * 去掉开头的空行（只有空格、制表符的行，连同换行），和末尾的换行连同只有空白的行；第一行行首、最后一行行尾的
 * 空格留着。一遍扫过去：不用 /\n\s*$/，它从每个换行起都往后扫，一长串换行后面还有字时是平方级的
 */
function trimBlankLines(text: string): string {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') start = i + 1;
    else if (c !== ' ' && c !== '\t') break;
  }
  // 最后一个不是空白的字（空白和正则的 \s 一样，含全角空格），它后面的第一个换行起都去掉
  let last = text.length - 1;
  while (last >= start && /\s/.test(text[last]!)) last--;
  const cut = text.indexOf('\n', last + 1);
  return text.slice(start, cut < 0 ? text.length : cut);
}
