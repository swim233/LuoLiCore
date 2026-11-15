import type { InputRichBlock, InputRichMessage, RichText } from './rich.js';

/* 测试用的本地 Bot API（fake-api.ts）怎么收富文本消息：照 2026-11-14、11-15 在真的接口上试出来的
   （.grill/telegram-usage-footer/final.md「真机上验证过的」）。
   - 认我们会发的块（段落、标题、代码块、分隔线、块公式、引用、列表、表格）和行内的类型（加粗、斜体、删除线、
     行内代码、下标、链接、公式）。别的类型、少了要写的字段、字段的值不对，回 400；多写了不认识的字段也回 400
     （比真的接口严，好抓字段名写错）；
   - 守上限：字数 32768（照真的接口按字数，也就是码点，数文字、公式、代码）、块数 500、层数 16、表格 20 列；
     blocks 是空数组也不收。说明文字照真的接口。
   - 空的东西（2026-11-15 试的）：标题、代码块里一个字都没有不收（RICH_MESSAGE_CONTENT_REQUIRED），公式的内容是
     空字符串不收（RICH_MESSAGE_MATH_SOURCE_REQUIRED），顶层全是分隔线不收（RICH_MESSAGE_EMPTY）；空段落、
     空的样式、字是空的链接照收。标题的 size 不在 1 到 6 也不收。
   - 层数：每一处最里面的字（或公式）外面一共套了几层。引用、列表（连同列表项只算一层）、带字的块自己（段落、
     标题、代码块、表格；表格的行和格子不算）、文字里每一个带 type 的对象（样式、链接）、每一层数组各算一层；
     公式、分隔线自己不算。试过的边界见下面的 depthProbes。 */

const LIMITS = { chars: 32768, blocks: 500, depth: 16, columns: 20 };

/** 整条消息加起来的字数、块数，最宽的表格的列数 */
type Size = { chars: number; blocks: number; columns: number };

class Rejected extends Error {}

const parseError = (what: string) =>
  new Rejected(`Bad Request: can't parse InputRichBlock: ${what}`);

/** 真的接口会怎么拒收这条富文本消息（400 的说明）；收下时为 undefined */
export function richRejection(message: unknown): string | undefined {
  const blocks = (message as { blocks?: unknown } | undefined)?.blocks;
  if (!Array.isArray(blocks))
    return 'Bad Request: can\'t parse InputRichMessage: field "blocks" is wrong';
  // 一个块都没有，或者顶层全是分隔线（一条、几条都是）：没有内容
  if (blocks.every((block) => (block as { type?: unknown } | null)?.type === 'divider')) {
    return 'Bad Request: RICH_MESSAGE_EMPTY';
  }
  const size: Size = { chars: 0, blocks: 0, columns: 0 };
  let depth = 0;
  try {
    for (const block of blocks) depth = Math.max(depth, checkBlock(block, size));
  } catch (error) {
    if (error instanceof Rejected) return error.message;
    throw error;
  }
  if (size.columns > LIMITS.columns) return 'Bad Request: RICH_MESSAGE_TABLE_COLS_TOO_MANY';
  if (depth > LIMITS.depth) return 'Bad Request: RICH_MESSAGE_DEPTH_INVALID';
  if (size.blocks > LIMITS.blocks) return 'Bad Request: RICH_MESSAGE_BLOCKS_TOO_MANY';
  if (size.chars > LIMITS.chars) return 'Bad Request: RICH_MESSAGE_TEXT_TOO_LONG';
  return undefined;
}

function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw parseError('not an object');
  const object = value as Record<string, unknown>;
  for (const key of required) if (!(key in object)) throw parseError(`field "${key}" is missing`);
  for (const key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key))
      throw parseError(`field "${key}" is unknown`);
  }
  return object;
}

const isTrue = (value: unknown) => value === undefined || value === true;
const chars = (s: string) => [...s].length;

/** 检查一个块，字数、块数、列数记进 size；返回它的层数（里面最深的字外面套了几层） */
function checkBlock(block: unknown, size: Size): number {
  size.blocks += 1;
  const type = (block as { type?: unknown } | null)?.type;
  switch (type) {
    case 'paragraph':
      return 1 + checkText(fields(block, ['type', 'text']).text, size);
    case 'heading': {
      const b = fields(block, ['type', 'text', 'size']);
      if (!Number.isInteger(b.size)) throw parseError('field "size" is wrong');
      if ((b.size as number) < 1 || (b.size as number) > 6) {
        throw new Rejected('Bad Request: invalid section heading size specified');
      }
      return 1 + checkFilled(b.text, size);
    }
    case 'pre': {
      const b = fields(block, ['type', 'text'], ['language']);
      if (b.language !== undefined && typeof b.language !== 'string') {
        throw parseError('field "language" is wrong');
      }
      return 1 + checkFilled(b.text, size);
    }
    case 'divider':
      fields(block, ['type']);
      return 0;
    case 'mathematical_expression':
      size.chars += checkExpression(fields(block, ['type', 'expression']).expression);
      return 0;
    case 'blockquote': {
      const b = fields(block, ['type', 'blocks'], ['credit']);
      if (!Array.isArray(b.blocks)) throw parseError('field "blocks" is wrong');
      let depth = 0;
      for (const inner of b.blocks) depth = Math.max(depth, checkBlock(inner, size));
      return 1 + depth;
    }
    case 'list': {
      const b = fields(block, ['type', 'items']);
      if (!Array.isArray(b.items)) throw parseError('field "items" is wrong');
      let depth = 0;
      for (const raw of b.items) {
        const item = fields(raw, ['blocks'], ['has_checkbox', 'is_checked', 'value', 'type']);
        if (!Array.isArray(item.blocks)) throw parseError('field "blocks" is wrong');
        if (!isTrue(item.has_checkbox) || !isTrue(item.is_checked)) {
          throw parseError('field "has_checkbox" is wrong');
        }
        if (item.value !== undefined && !Number.isInteger(item.value)) {
          throw parseError('field "value" is wrong');
        }
        if (item.type !== undefined && !['a', 'A', 'i', 'I', '1'].includes(item.type as string)) {
          throw parseError('field "type" is wrong');
        }
        size.blocks += 1;
        for (const inner of item.blocks) depth = Math.max(depth, checkBlock(inner, size));
      }
      // 列表连同列表项只算一层
      return 1 + depth;
    }
    case 'table': {
      const b = fields(
        block,
        ['type', 'cells'],
        ['is_bordered', 'is_striped', 'is_compact', 'caption'],
      );
      if (!Array.isArray(b.cells)) throw parseError('field "cells" is wrong');
      let depth = 0;
      for (const row of b.cells) {
        if (!Array.isArray(row)) throw parseError('field "cells" is wrong');
        size.blocks += 1;
        size.columns = Math.max(size.columns, row.length);
        for (const raw of row) {
          const cell = fields(
            raw,
            ['align', 'valign'],
            ['text', 'is_header', 'colspan', 'rowspan'],
          );
          if (!['left', 'center', 'right'].includes(cell.align as string)) {
            throw parseError('field "align" is wrong');
          }
          if (!['top', 'middle', 'bottom'].includes(cell.valign as string)) {
            throw parseError('field "valign" is wrong');
          }
          if (!isTrue(cell.is_header)) throw parseError('field "is_header" is wrong');
          if (cell.text !== undefined) depth = Math.max(depth, checkText(cell.text, size));
        }
      }
      // 表格一层，行和格子不算
      return 1 + depth;
    }
    default:
      throw parseError(`type "${String(type)}" is unsupported`);
  }
}

/** 检查一段富文本，字数记进 size；返回它的层数：字符串、公式是 0，数组、带 type 的样式和链接各套一层 */
function checkText(text: unknown, size: Size): number {
  if (typeof text === 'string') {
    size.chars += chars(text);
    return 0;
  }
  if (Array.isArray(text)) {
    let depth = 0;
    for (const t of text) depth = Math.max(depth, checkText(t, size));
    return 1 + depth;
  }
  const type = (text as { type?: unknown } | null)?.type;
  switch (type) {
    case 'bold':
    case 'italic':
    case 'strikethrough':
    case 'code':
    case 'subscript':
      return 1 + checkText(fields(text, ['type', 'text']).text, size);
    case 'url': {
      const t = fields(text, ['type', 'text', 'url']);
      if (typeof t.url !== 'string') throw parseError('field "url" is wrong');
      return 1 + checkText(t.text, size);
    }
    case 'mathematical_expression':
      size.chars += checkExpression(fields(text, ['type', 'expression']).expression);
      return 0;
    default:
      throw parseError('Unsupported rich text type');
  }
}

/**
 * 标题、代码块的文字：照 checkText 检查，另外里面要有字（一个字符，空格也算；或者一个公式）。空字符串、空数组、
 * 空的样式、字是空的链接都不收（链接的网址不算字）。返回层数
 */
function checkFilled(text: unknown, size: Size): number {
  const depth = checkText(text, size);
  if (!filled(text)) throw new Rejected('Bad Request: RICH_MESSAGE_CONTENT_REQUIRED');
  return depth;
}

/** 已经检查过的富文本里有没有字 */
function filled(text: unknown): boolean {
  if (typeof text === 'string') return text !== '';
  if (Array.isArray(text)) return text.some(filled);
  const t = text as { type: string; text?: unknown };
  return t.type === 'mathematical_expression' || filled(t.text);
}

/** 公式（块公式、行内公式）的内容：要是字符串，空字符串不收（只有空格的收）。返回字数 */
function checkExpression(expression: unknown): number {
  if (typeof expression !== 'string') throw parseError('field "expression" is wrong');
  if (expression === '') throw new Rejected('Bad Request: RICH_MESSAGE_MATH_SOURCE_REQUIRED');
  return chars(expression);
}

/* 2026-11-15 在真的接口上试过的层数的边界（final.md「真机上验证过的」的「嵌套」）。block(n) 是套了 n 层的一个块：
   套 accepted 层的收，套 rejected 层的回 RICH_MESSAGE_DEPTH_INVALID。我们的数法（split.ts 的 measureBlock）和
   假接口都拿它核对 */

/** n 层引用，最里面是 inner */
function quotes(n: number, inner: InputRichBlock): InputRichBlock {
  return n === 0 ? inner : { type: 'blockquote', blocks: [quotes(n - 1, inner)] };
}

/** n 层样式（加粗、斜体、删除线、链接轮着套），最里面是字 */
function styles(n: number): RichText {
  if (n === 0) return 'x';
  const text = styles(n - 1);
  switch (n % 4) {
    case 1:
      return { type: 'bold', text };
    case 2:
      return { type: 'italic', text };
    case 3:
      return { type: 'strikethrough', text };
    default:
      return { type: 'url', text, url: 'https://example.com/' };
  }
}

/** n 层数组，最里面是字 */
function arrays(n: number): RichText {
  return n === 0 ? 'x' : ['a', arrays(n - 1)];
}

/** 数组和加粗交替套 n 对，最里面是字 */
function alternating(n: number): RichText {
  return n === 0 ? 'x' : ['a', { type: 'bold', text: alternating(n - 1) }];
}

/** n 层列表（项里是下一层列表），最里面的项里是一个段落 */
function lists(n: number): InputRichBlock {
  return n === 0
    ? { type: 'paragraph', text: 'x' }
    : { type: 'list', items: [{ blocks: [lists(n - 1)] }] };
}

export const depthProbes: Array<{
  name: string;
  block: (n: number) => InputRichBlock;
  accepted: number;
  rejected: number;
}> = [
  {
    name: '引用套一个段落',
    block: (n) => quotes(n, { type: 'paragraph', text: 'x' }),
    accepted: 15,
    rejected: 16,
  },
  {
    name: '引用套一个块公式',
    block: (n) => quotes(n, { type: 'mathematical_expression', expression: 'x^2' }),
    accepted: 16,
    rejected: 17,
  },
  {
    name: '段落里样式套样式',
    block: (n) => ({ type: 'paragraph', text: styles(n) }),
    accepted: 15,
    rejected: 16,
  },
  {
    name: '标题里样式套样式',
    block: (n) => ({ type: 'heading', text: styles(n), size: 2 }),
    accepted: 15,
    rejected: 16,
  },
  {
    name: '表格的格子里样式套样式',
    block: (n) => ({
      type: 'table',
      cells: [[{ text: styles(n), align: 'left', valign: 'top' }]],
    }),
    accepted: 15,
    rejected: 16,
  },
  {
    name: '段落里数组套数组',
    block: (n) => ({ type: 'paragraph', text: arrays(n) }),
    accepted: 15,
    rejected: 16,
  },
  {
    name: '段落里数组和样式交替（n 对）',
    block: (n) => ({ type: 'paragraph', text: alternating(n) }),
    accepted: 7,
    rejected: 8,
  },
  { name: '列表套列表', block: lists, accepted: 15, rejected: 16 },
  { name: '引用套一个列表', block: (n) => quotes(n, lists(1)), accepted: 14, rejected: 15 },
];

/**
 * 富文本消息里群里看到的正文与尾部。尾部只认末尾的「分隔线加一个只有下标的段落」（footer.ts 的样子），
 * 正文里别处的分隔线不算。text 是各个块的字（样式去掉）：块和块之间空一行，引用、列表、表格里的一行一个，
 * 表格的格子之间用「 | 」隔开；分隔线不出字
 */
export function richParts(message: InputRichMessage): { text: string; footer?: string } {
  const blocks = message.blocks;
  const [divider, last] = blocks.slice(-2);
  const subscript =
    last?.type === 'paragraph' &&
    typeof last.text === 'object' &&
    !Array.isArray(last.text) &&
    last.text.type === 'subscript'
      ? last.text
      : undefined;
  if (blocks.length >= 2 && divider?.type === 'divider' && subscript) {
    return { text: joinBlocks(blocks.slice(0, -2), '\n\n'), footer: plainOf(subscript.text) };
  }
  return { text: joinBlocks(blocks, '\n\n') };
}

function joinBlocks(blocks: InputRichBlock[], separator: string): string {
  return blocks
    .map(blockText)
    .filter((text) => text !== '')
    .join(separator);
}

function blockText(block: InputRichBlock): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'pre':
      return plainOf(block.text);
    case 'mathematical_expression':
      return block.expression;
    case 'divider':
      return '';
    case 'blockquote':
      return joinBlocks(block.blocks, '\n');
    case 'list':
      return block.items.map((item) => joinBlocks(item.blocks, '\n')).join('\n');
    case 'table':
      return block.cells
        .map((row) =>
          row.map((cell) => (cell.text === undefined ? '' : plainOf(cell.text))).join(' | '),
        )
        .join('\n');
  }
}

/** 富文本里的字：样式去掉，链接只留文字，公式是它的原文 */
function plainOf(text: RichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(plainOf).join('');
  if (text.type === 'mathematical_expression') return text.expression;
  return plainOf(text.text);
}
