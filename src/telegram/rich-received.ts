import type { TelegramMessage, TelegramUser } from '@chat-adapter/telegram';
import {
  audioPlaceholder,
  filePlaceholder,
  gifPlaceholder,
  videoPlaceholder,
  voicePlaceholder,
} from './placeholder.js';

/* 收到的富文本消息（Message.rich_message，Bot API 10.1 起）转成 Markdown 文字，记进历史给洛璃读。
   类型照 Bot API 的文档写（https://core.telegram.org/bots/api/types/richblock.md、richtext.md，2026-11-15 取的），
   适配器导出的那一份比文档旧。这是外面来的数据：转换时每一处都先看类型对不对，不对的当那一处没有。 */

type PhotoSize = NonNullable<TelegramMessage['photo']>[number];

/** 富文本（RichText）：字符串、RichText 的数组，或带 type 的对象 */
export type ReceivedRichText =
  | string
  | ReceivedRichText[]
  | {
      type:
        | 'bold'
        | 'italic'
        | 'underline'
        | 'strikethrough'
        | 'spoiler'
        | 'subscript'
        | 'superscript'
        | 'marked'
        | 'code';
      text: ReceivedRichText;
    }
  | { type: 'date_time'; text: ReceivedRichText; unix_time: number; date_time_format: string }
  | { type: 'text_mention'; text: ReceivedRichText; user: TelegramUser }
  | { type: 'custom_emoji'; custom_emoji_id: string; alternative_text: string }
  | { type: 'mathematical_expression'; expression: string }
  | { type: 'url'; text: ReceivedRichText; url: string }
  | { type: 'email_address'; text: ReceivedRichText; email_address: string }
  | { type: 'phone_number'; text: ReceivedRichText; phone_number: string }
  | { type: 'bank_card_number'; text: ReceivedRichText; bank_card_number: string }
  | { type: 'ton_address'; text: ReceivedRichText; address: string }
  | { type: 'mention'; text: ReceivedRichText; username: string }
  | { type: 'hashtag'; text: ReceivedRichText; hashtag: string }
  | { type: 'cashtag'; text: ReceivedRichText; cashtag: string }
  | { type: 'bot_command'; text: ReceivedRichText; bot_command: string }
  | { type: 'button'; button: RichMessageButton }
  | { type: 'anchor'; name: string }
  | { type: 'anchor_link'; text: ReceivedRichText; anchor_name: string }
  | { type: 'reference'; text: ReceivedRichText; name: string }
  | { type: 'reference_link'; text: ReceivedRichText; reference_name: string };

/** 按钮（RichMessageButton）：只用得到上面的字 */
export type RichMessageButton = {
  text: ReceivedRichText;
  style?: string;
  url?: string;
  callback_data?: string;
};

/** 媒体块的说明（RichBlockCaption），credit 是出处 */
export type RichBlockCaption = { text: ReceivedRichText; credit?: ReceivedRichText };

/** 列表的一项（RichBlockListItem）；label 是 Telegram 给的「•」「1.」 */
export type RichBlockListItem = {
  label: string;
  blocks: RichBlock[];
  has_checkbox?: true;
  is_checked?: true;
  value?: number;
  type?: 'a' | 'A' | 'i' | 'I' | '1';
};

/** 表格的一格（RichBlockTableCell）；没有 text 的是看不见的格子 */
export type RichBlockTableCell = {
  text?: ReceivedRichText;
  is_header?: true;
  colspan?: number;
  rowspan?: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
};

/** 富文本消息里的一个块（RichBlock） */
export type RichBlock =
  | { type: 'paragraph' | 'footer' | 'thinking'; text: ReceivedRichText }
  | { type: 'heading'; text: ReceivedRichText; size: number }
  | { type: 'pre'; text: ReceivedRichText; language?: string }
  | { type: 'divider' }
  | { type: 'mathematical_expression'; expression: string }
  | { type: 'anchor'; name: string }
  | { type: 'list'; items: RichBlockListItem[] }
  | { type: 'blockquote'; blocks: RichBlock[]; credit?: ReceivedRichText }
  | {
      type: 'expandable_blockquote' | 'pullquote';
      text: ReceivedRichText;
      credit?: ReceivedRichText;
    }
  | { type: 'collage' | 'slideshow'; blocks: RichBlock[]; caption?: RichBlockCaption }
  | {
      type: 'table';
      cells: RichBlockTableCell[][];
      is_bordered?: true;
      is_striped?: true;
      is_compact?: true;
      caption?: ReceivedRichText;
    }
  | { type: 'details'; summary: ReceivedRichText; blocks: RichBlock[]; is_open?: true }
  | {
      type: 'map';
      location: NonNullable<TelegramMessage['location']>;
      zoom: number;
      width: number;
      height: number;
      caption?: RichBlockCaption;
    }
  | { type: 'buttons'; buttons: RichMessageButton[]; align?: 'left' | 'center' | 'right' }
  | {
      type: 'animation';
      animation: NonNullable<TelegramMessage['animation']>;
      has_spoiler?: true;
      caption?: RichBlockCaption;
    }
  | { type: 'audio'; audio: NonNullable<TelegramMessage['audio']>; caption?: RichBlockCaption }
  | {
      type: 'document';
      document: NonNullable<TelegramMessage['document']>;
      caption?: RichBlockCaption;
    }
  | { type: 'photo'; photo: PhotoSize[]; has_spoiler?: true; caption?: RichBlockCaption }
  | {
      type: 'video';
      video: NonNullable<TelegramMessage['video']>;
      has_spoiler?: true;
      caption?: RichBlockCaption;
    }
  | {
      type: 'voice_note';
      voice_note: NonNullable<TelegramMessage['voice']>;
      caption?: RichBlockCaption;
    };

/** 收到的富文本消息（RichMessage） */
export type RichMessage = { blocks: RichBlock[]; is_rtl?: boolean };

/** 转出来的内容 */
export type ReceivedRich = {
  /** 文字；photo(i) 是第 i 张照片（按出现的顺序）在文字里的占位，照片的说明接在它后面 */
  text(photo: (index: number) => string): string;
  /** 各张照片的各档尺寸，按在文字里出现的顺序；拿不到尺寸的是空数组 */
  photos: PhotoSize[][];
  /** 被 text_mention 提到的用户 id */
  mentions: string[];
};

/** 一行：prefix 是引用、列表加在行首的记号；有 photo 时 prefix 后面先是那张照片的占位，再是 text */
type Line = { prefix: string; photo?: number; text: string };

/** 转换途中记下的照片、被提到的人 */
type Found = { photos: PhotoSize[][]; mentions: string[] };

type Dict = Record<string, unknown>;

/**
 * 收到的 rich_message 转成 Markdown 文字。不认识的类型、缺字段、字段的类型不对，都当那一处没有，
 * 别处照常转。只有病态的输入（比如套了几万层）会抛错，调用方兜底
 */
export function readRichMessage(message: unknown): ReceivedRich {
  const found: Found = { photos: [], mentions: [] };
  const lines = blockList(field(message, 'blocks'), found);
  return {
    text: (photo) =>
      lines
        .map(
          (line) => line.prefix + (line.photo === undefined ? '' : photo(line.photo)) + line.text,
        )
        .join('\n'),
    photos: found.photos,
    mentions: found.mentions,
  };
}

/** 几个块，块之间隔一个空行；什么都没记的块跳过 */
function blockList(value: unknown, found: Found): Line[] {
  return joinBlocks(array(value).map((block) => blockLines(block, found)));
}

/** 几段，段之间隔一个空行；空的跳过 */
function joinBlocks(parts: Line[][]): Line[] {
  const out: Line[] = [];
  for (const lines of parts) {
    if (isEmpty(lines)) continue;
    if (out.length) out.push({ prefix: '', text: '' });
    out.push(...lines);
  }
  return out;
}

function blockLines(block: unknown, found: Found): Line[] {
  if (!isDict(block)) return [];
  switch (block.type) {
    case 'paragraph':
    case 'footer':
      return textLines(inline(block.text, found));
    case 'heading': {
      const text = inline(block.text, found);
      if (!text) return [];
      return textLines(`${'#'.repeat(headingSize(block.size))} ${text}`);
    }
    case 'divider':
      return textLines('---');
    case 'pre':
      return textLines(codeBlock(inline(block.text, found, false), string(block.language)));
    case 'mathematical_expression': {
      const expression = string(block.expression);
      return expression ? textLines(`$$\n${expression}\n$$`) : [];
    }
    case 'list':
      return list(block.items, found);
    case 'blockquote':
      return quote(blockList(block.blocks, found), inline(block.credit, found));
    case 'expandable_blockquote':
    case 'pullquote':
      return quote(textLines(inline(block.text, found)), inline(block.credit, found));
    case 'table':
      return joinBlocks([table(block.cells, found), textLines(inline(block.caption, found))]);
    case 'details':
      return joinBlocks([textLines(inline(block.summary, found)), blockList(block.blocks, found)]);
    case 'collage':
    case 'slideshow':
      return joinBlocks([blockList(block.blocks, found), textLines(caption(block.caption, found))]);
    case 'video':
      return media(videoPlaceholder(seconds(field(block.video, 'duration'))), block, found);
    case 'animation':
      return media(gifPlaceholder, block, found);
    case 'audio':
      return media(
        audioPlaceholder(
          string(field(block.audio, 'title')),
          string(field(block.audio, 'file_name')),
        ),
        block,
        found,
      );
    case 'voice_note':
      return media(voicePlaceholder(seconds(field(block.voice_note, 'duration'))), block, found);
    case 'document':
      return media(filePlaceholder(string(field(block.document, 'file_name'))), block, found);
    case 'map':
      return media('[地图]', block, found);
    case 'photo': {
      // 占位由调用方定（下载了没有、成没成），这里只记位置
      const index = found.photos.push(array(block.photo).filter(isPhotoSize)) - 1;
      const [first, ...rest] = caption(block.caption, found).split('\n');
      return [
        { prefix: '', photo: index, text: first ? ` ${first}` : '' },
        ...rest.map((text) => ({ prefix: '', text })),
      ];
    }
    case 'buttons':
      return textLines(
        array(block.buttons)
          .map((button) => buttonLabel(button, found))
          .filter(Boolean)
          .join(' '),
      );
    default:
      // 锚点、thinking（只用在草稿里）、不认识的：不记
      return [];
  }
}

/** 媒体块：占位，有说明时隔一个空格接在后面 */
function media(placeholder: string, block: Dict, found: Found): Line[] {
  const text = caption(block.caption, found);
  return textLines(text ? `${placeholder} ${text}` : placeholder);
}

/** 媒体块的说明（RichBlockCaption）：说明文字，有出处时接「 —— 出处」 */
function caption(value: unknown, found: Found): string {
  const text = inline(field(value, 'text'), found);
  const credit = inline(field(value, 'credit'), found);
  return [text, credit && `—— ${credit}`].filter(Boolean).join(' ');
}

/** 照片的一档尺寸：要有 file_id 和宽高 */
function isPhotoSize(value: unknown): value is PhotoSize {
  return (
    isDict(value) &&
    typeof value.file_id === 'string' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  );
}

/** 时长：不是不小于 0 的整数时当没有 */
function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 对齐那一行的一格：left（和别的、没写的）是 ---，center 是 :-:，right 是 --: */
function alignMark(align: unknown): string {
  if (align === 'center') return ':-:';
  if (align === 'right') return '--:';
  return '---';
}

/**
 * GFM 的表格：第一行当表头，对齐那一行按第一行各格的 align；格子里的竖线加反斜杠、换行换成空格；
 * 没有 text 的格子是空的，短的行补空格子。合并的格子不还原
 */
function table(cells: unknown, found: Found): Line[] {
  const rows = array(cells).filter((row): row is unknown[] => Array.isArray(row));
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return [];
  const cellText = (cell: unknown) =>
    inline(field(cell, 'text'), found).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const line = (texts: string[]) => `| ${texts.join(' | ')} |`;
  const padded = (row: unknown[]) =>
    Array.from({ length: width }, (_, column) => cellText(row[column]));
  const [header = []] = rows;
  const aligns = Array.from({ length: width }, (_, column) =>
    alignMark(field(header[column], 'align')),
  );
  return textLines(
    [line(padded(header)), line(aligns), ...rows.slice(1).map((row) => line(padded(row)))].join(
      '\n',
    ),
  );
}

/** 引用：每行前面加「> 」（空行是「>」）；有出处时最后加一行「> —— 出处」 */
function quote(content: Line[], credit: string): Line[] {
  const lines = credit ? [...content, ...textLines(`—— ${credit}`)] : content;
  if (isEmpty(lines)) return [];
  return lines.map((line) =>
    isBlank(line) ? { prefix: '>', text: '' } : { ...line, prefix: `> ${line.prefix}` },
  );
}

/**
 * 列表：有 value 的项写成「3. 」（编号是字母、罗马数字的也写成数字），没有的写成「- 」；有勾选框的再加
 * 「[ ] 」「[x] 」。收到的 label（「•」「1.」）不用。一项里的第二个块起缩进到这一项的文字那一列（编号后面），
 * 套着的列表紧跟着上一行，别的块之间空一行
 */
function list(items: unknown, found: Found): Line[] {
  const out: Line[] = [];
  for (const item of array(items)) {
    if (!isDict(item)) continue;
    const value = item.value;
    const marker = typeof value === 'number' && Number.isInteger(value) ? `${value}. ` : '- ';
    const box = item.has_checkbox === true ? (item.is_checked === true ? '[x] ' : '[ ] ') : '';
    const content = itemBlocks(item.blocks, found);
    if (isEmpty(content)) {
      out.push({ prefix: '', text: (marker + box).trimEnd() });
      continue;
    }
    const indent = ' '.repeat(marker.length);
    content.forEach((line, index) => {
      if (index === 0) out.push({ ...line, prefix: marker + box + line.prefix });
      else out.push(isBlank(line) ? line : { ...line, prefix: indent + line.prefix });
    });
  }
  return out;
}

/** 列表一项里的块：套着的列表紧跟着上一行，别的块之间空一行 */
function itemBlocks(blocks: unknown, found: Found): Line[] {
  const out: Line[] = [];
  for (const block of array(blocks)) {
    const lines = blockLines(block, found);
    if (isEmpty(lines)) continue;
    if (out.length && field(block, 'type') !== 'list') out.push({ prefix: '', text: '' });
    out.push(...lines);
  }
  return out;
}

/** 围栏代码块：围栏比里面最长的一串反引号长（至少三个）；语言写在围栏后面（去掉反引号、换行） */
function codeBlock(code: string, language = ''): string {
  const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
  const info = language.replace(/[`\r\n]/g, '');
  return code ? `${fence}${info}\n${code}\n${fence}` : `${fence}${info}\n${fence}`;
}

/** 标题的级别：限在 1 到 6，不是数时为 1 */
function headingSize(size: unknown): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) return 1;
  return Math.min(Math.max(Math.trunc(size), 1), 6);
}

/**
 * 行内的富文本转成 Markdown 的字。字原样，不转义（给模型读的，人发的消息在面板里也是原样显示）。
 * styled 为 false 时只取字（代码块、行内代码里）
 */
function inline(value: unknown, found: Found, styled = true): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => inline(item, found, styled)).join('');
  if (!isDict(value)) return '';
  const inner = () => inline(value.text, found, styled);
  switch (value.type) {
    case 'bold':
      return wrapped('**', inner(), styled);
    case 'italic':
      return wrapped('*', inner(), styled);
    case 'strikethrough':
      return wrapped('~~', inner(), styled);
    case 'code': {
      const code = inline(value.text, found, false);
      return styled ? codeSpan(code) : code;
    }
    case 'mathematical_expression': {
      const expression = string(value.expression) ?? '';
      return styled && expression ? `$${expression}$` : expression;
    }
    case 'url': {
      const text = inner();
      const url = string(value.url);
      if (!styled || !url || sameAsUrl(inline(value.text, found, false), url)) return text;
      return `[${text}](${/\s/.test(url) ? `<${url}>` : url})`;
    }
    case 'custom_emoji':
      return string(value.alternative_text) ?? '';
    case 'button':
      return buttonLabel(value.button, found);
    case 'text_mention': {
      const id = field(value.user, 'id');
      if (typeof id === 'number' || typeof id === 'string') found.mentions.push(String(id));
      return inner();
    }
    case 'anchor':
      return '';
    default:
      // 下划线、剧透、上下标、标记、日期、提到人、话题、邮箱等等，以及以后新加的：只留里面的字
      return 'text' in value ? inner() : '';
  }
}

/** 加粗、斜体、删除线的记号包着字；里面是空的就什么都不写 */
function wrapped(mark: string, text: string, styled: boolean): string {
  if (!text) return '';
  return styled ? `${mark}${text}${mark}` : text;
}

/** 行内代码：用比里面最长的一串反引号多一个的反引号包；开头、结尾是反引号（或两头都是空格）时加空格隔开 */
function codeSpan(code: string): string {
  if (!code) return '';
  const fence = '`'.repeat(longestRun(code, '`') + 1);
  const padded =
    code.startsWith('`') ||
    code.endsWith('`') ||
    (code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '');
  return padded ? `${fence} ${code} ${fence}` : `${fence}${code}${fence}`;
}

/** 字就是这个网址：两者一样，或者只差开头的 http://、https:// 和末尾的斜杠 */
function sameAsUrl(text: string, url: string): boolean {
  const bare = (s: string) => s.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return bare(text) === bare(url);
}

/** 按钮：[按钮 上面的字] */
function buttonLabel(button: unknown, found: Found): string {
  if (!isDict(button)) return '';
  const text = inline(button.text, found);
  return text ? `[按钮 ${text}]` : '[按钮]';
}

/** 一串字里最长的连续 char 有几个 */
function longestRun(text: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (const c of text) {
    run = c === char ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** 一段字拆成行 */
function textLines(text: string): Line[] {
  return text.split('\n').map((line) => ({ prefix: '', text: line }));
}

/** 空行：没有记号、没有照片、没有字 */
function isBlank(line: Line): boolean {
  return line.photo === undefined && line.prefix === '' && line.text === '';
}

/** 什么都没有：没有行，或者每行都是空行 */
function isEmpty(lines: Line[]): boolean {
  return lines.every(isBlank);
}

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isDict(value) ? value[key] : undefined;
}

/** 是字符串时是它，不是时为 undefined */
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 是数组时是它，不是时当空数组 */
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
