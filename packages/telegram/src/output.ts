import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { marked, type MarkedOptions, type Token, type Tokens } from 'marked';

/**
 * 普通文本里要转义的全集。**`\` 必须在内** —— 漏掉它时 `C:\x` 会被 Telegram 当成「转义 x」，
 * 反斜杠静静消失（docs/08 §5.3 第 4 条）。
 */
const SPECIAL = /[\\_*\[\]()~`>#+\-=|{}.!]/g;
/** `pre` / `code` 实体内部只有这两个要转义，别的字符按字面走。 */
const CODE_SPECIAL = /[\\`]/g;
/** `[…](url)` 的 URL 部分只有这两个要转义。 */
const LINK_SPECIAL = /[\\)]/g;
/** 可点链接的 scheme 白名单。回复正文里可能带被注入的内容，这里必须是白名单而不是黑名单。 */
const LINK_SCHEME = /^(?:https?|tg|mailto):/i;
/** 显式传全套开关：`marked.lexer` 不带 options 时吃的是全局 `marked.use()` 的残留。 */
const LEXER_OPTIONS: MarkedOptions = { gfm: true, breaks: false, pedantic: false };

export function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL, '\\$&');
}

/**
 * 把通用 Markdown 渲染成 Telegram MarkdownV2（docs/08 §5.3）。
 *
 * **转义只发生在文本节点上**，这是这一节的红线。旧实现走的是反过来那条路 —— 逐行全量转义之后
 * 只把 `\*\*x\*\*` 反解回 `*x*` —— 于是每个不在反解白名单里的构造都降级成字面转义符：行内代码
 * 从来没被反解过（用户看到的是两个反引号），`heading` 生成的 `*粗体*` 因为在转义之前生成、又只有
 * 双星号那一条反解规则，同样被自己的转义吃掉。这类漏洞不会报错，只会看起来朴素，所以补白名单
 * 修不完 —— 只有「先解析、再逐节点输出」能一次性关掉整类。
 */
export function safeRender(markdown: string): string {
  // NUL 在 Telegram 正文里没有任何显示意义，进门就摘掉。占位符方案（docs/27 · C-07）已经不用了，
  // 但「正文里的 NUL 不该出去」这条仍然成立。
  const text = markdown.replaceAll('\u0000', '');
  // 渲染器不许成为投递失败的新来源：lexer 对任何输入都该有结果，真抛了就退回全文字面转义 ——
  // 格式丢掉，消息还在。
  try { return renderBlocks(marked.lexer(text, LEXER_OPTIONS)); }
  catch { return escapeMarkdownV2(text); }
}

/** 块级节点的尾随换行照 `raw` 原样带出去：段落间的空行数量因此和模型写的一模一样。 */
function trailingNewlines(raw: string | undefined): string {
  return /\n*$/.exec(raw ?? '')![0];
}

function renderBlocks(tokens: readonly Token[], depth = 0): string {
  // `def`（`[a]: url` 那种链接定义）不是正文，连它占的那几个换行一起丢掉。
  return tokens.filter((token) => token.type !== 'def')
    .map((token) => renderBlock(token, depth) + trailingNewlines(token.raw)).join('');
}

function renderBlock(token: Token, depth: number): string {
  switch (token.type) {
    case 'space': return '';
    case 'paragraph': return renderInline(token.tokens, token.text);
    // 降级：Telegram 没有标题实体（docs/08 §5.3 第 3 条）。整段已经是粗体，所以带着 `strong`
    // 进去 —— `### **小标题**` 否则会渲染成 `**小标题**`，那是两个空粗体夹着文字，Telegram 判解析失败。
    case 'heading': return `*${renderInline(token.tokens, token.text, ['strong'])}*`;
    case 'code': return fence(token.text, token.lang);
    // 表格按 raw 原样进等宽块：按码点补齐列宽在中英混排下只会更歪（CJK 是双宽）。
    case 'table': return fence(token.raw.replace(/\n+$/, ''), '');
    case 'hr': return '——————';
    // `Token` 这个联合里带一个 `Tokens.Generic`（`type: string` + 索引签名），switch 收窄不掉它 ——
    // 这两处因此要自己兜一下，而不是靠收窄。
    case 'blockquote': return quote(renderBlocks(token.tokens ?? [], depth));
    case 'list': return renderList(token as Tokens.List, depth);
    case 'text': return token.tokens?.length ? renderInline(token.tokens, token.text) : escapeMarkdownV2(token.text);
    // 块级 HTML 与任何未知节点：按字面显示。尾随换行由 trailingNewlines 补，这里先摘掉免得算两遍。
    default: return escapeMarkdownV2((token.raw ?? '').replace(/\n+$/, ''));
  }
}

/** `open` 记的是「此刻已经张着哪几种强调实体」，用途见 `emphasis`。 */
type Emphasis = 'strong' | 'em' | 'del';

function renderInline(tokens: readonly Token[] | undefined, fallback: string, open: readonly Emphasis[] = []): string {
  if (!tokens?.length) return escapeMarkdownV2(fallback);
  return tokens.map((token): string => {
    switch (token.type) {
      case 'text': return token.tokens?.length ? renderInline(token.tokens, token.text, open) : escapeMarkdownV2(token.text);
      // lexer 已经把 `\*` 拆成 escape 节点、text 是还原后的 `*`：再转义一次就无损转回去了。
      case 'escape': return escapeMarkdownV2(token.text);
      case 'codespan': return `\`${token.text.replace(CODE_SPECIAL, '\\$&')}\``;
      case 'strong': return emphasis('strong', '*', token, open);
      case 'em': return emphasis('em', '_', token, open);
      case 'del': return emphasis('del', '~', token, open);
      case 'br': return '\n';
      case 'link': return link(token.href, renderInline(token.tokens, token.text, open), token.raw);
      case 'image': return link(token.href, escapeMarkdownV2(token.text?.trim() || '图片'), token.raw);
      default: return escapeMarkdownV2(token.raw ?? '');
    }
  }).join('');
}

/**
 * 同一种强调实体在 MarkdownV2 里不能自嵌套（`*a *b* c*` 直接解析失败）：已经张着就只渲染内容。
 * 形参收成最小结构而不是 `Tokens.Strong | …`：`Token` 联合里那个 `Tokens.Generic` 收窄不掉。
 */
function emphasis(kind: Emphasis, mark: string, token: { tokens?: readonly Token[]; text?: string }, open: readonly Emphasis[]): string {
  if (open.includes(kind)) return renderInline(token.tokens, token.text ?? '', open);
  return `${mark}${renderInline(token.tokens, token.text ?? '', [...open, kind])}${mark}`;
}

/** scheme 不在白名单里就退回字面 raw —— 丢掉可点性，但一个字符都不隐藏。 */
function link(href: string | undefined, label: string, raw: string): string {
  if (!href || !LINK_SCHEME.test(href)) return escapeMarkdownV2(raw);
  return `[${label}](${href.replace(LINK_SPECIAL, '\\$&')})`;
}

function fence(body: string, lang: string | undefined): string {
  const tag = (lang ?? '').trim().split(/\s+/)[0] ?? '';
  return `\`\`\`${tag.replace(CODE_SPECIAL, '\\$&')}\n${body.replace(CODE_SPECIAL, '\\$&')}\n\`\`\``;
}

/**
 * 引用块 = 每行一个不转义的 `>`。**内含围栏时整段退掉前缀**：`>` 逐行前缀会把 `pre` 实体拆开，
 * Telegram 判解析失败 —— 宁可丢引用样式，不要让整条消息掉回纯文本。
 */
function quote(inner: string): string {
  if (inner.includes('```')) return inner;
  return inner.split('\n').map((line) => `>${line}`).join('\n');
}

function renderList(token: Tokens.List, depth: number): string {
  const indent = '  '.repeat(depth);
  const start = Number(token.start || 1);
  return token.items.map((item, index) => {
    // 无序项用 `•` 而不是 `-`：`-` 在 MarkdownV2 里要转义，`\-` 打头是一串纯噪音。
    const marker = token.ordered ? `${start + index}\\.` : '•';
    const box = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
    // 子块用 `\n` 拼而不是照 raw 的尾随换行拼：列表项的 raw 尾随换行属于列表布局，
    // 嵌套列表自己已经按 depth+1 缩进了，再叠一层就成了阶梯。
    const inner = item.tokens.map((child) => renderBlock(child, depth + 1)).filter(Boolean).join('\n');
    return `${indent}${marker} ${box}${inner}`.trimEnd();
  }).join('\n');
}

/**
 * 秒回读起来像自动应答机，流式模式下第一帧还几乎是空的。距离用户那条消息不足
 * `output.replyDelayMs` 就先压住不发；期间 typing 动作照常，所以看起来是在打字而不是卡住。
 */
export async function holdReply(since: number, delayMs: number): Promise<void> {
  // setTimeout 可以比 Date.now() 的读数早醒 1ms，单次 sleep 会让「至少等这么久」这条下限偶发地
  // 差一毫秒不成立（tests/output.pacing.test.ts 因此约 8% 概率变红）。补睡到真的过线为止。
  for (let remaining = delayMs - (Date.now() - since); remaining > 0; remaining = delayMs - (Date.now() - since)) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

/**
 * MarkdownV2 渲染失败时退回纯文本重发一次。所有投递路径共用它：`safeRender` 已经很细，但按字符数
 * 切分仍可能把 `*bold*` 的配对切开，而裸调 `sendMessage` 抛出去会把整轮打成 failed —— 用户明明
 * 已经看到前半段回复，却又收到一句「出了点问题」（docs/20 · W-TG-03 / W-TG-04）。
 */
/** `output.parseMode`：`none` 时直接发纯文本（不试 Markdown 也就不会有回退那一跳）。 */
export async function sendWithFallback(api: Api, chatId: string, text: string, extra: Record<string, unknown> = {}, parseMode: 'MarkdownV2' | 'HTML' | 'none' = 'MarkdownV2'): Promise<Message> {
  if (parseMode === 'none') return api.sendMessage(chatId, text, extra);
  try { return await api.sendMessage(chatId, text, { parse_mode: parseMode, ...extra }); }
  catch (error) {
    if (!/parse entities/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return api.sendMessage(chatId, text, extra);
  }
}

/**
 * `output.maxMentions`：一条消息里最多保留几个 `@用户名`，多出来的去掉 `@` 只留名字。
 * 这是防「模型被诱导 @全群」的护栏 —— 提示词里说好不要这么做，但那不是边界，投递侧才是。
 * 0 表示不限。
 *
 * 前置条件是「前一个字符不是 `[\w@]`」，而不是「前面是空白或左括号」：`,@bob`、`.@cindy`、
 * `;@daisy` 这些 Telegram 照样解析成 mention，而旧判据在 `max=1` 下让它们全部逃过
 * （docs/27 · S-10 实测三种全漏）。投递侧的判据必须跟 Telegram 的一致。
 * 排掉 `@` 是为了不把 `@@name` 的第二个 `@` 当成新的 mention；排掉 `\w` 是因为 `foo@bar`
 * 在 Telegram 那边也不是 mention。
 */
export function capMentions(text: string, max: number): string {
  if (max <= 0) return text;
  let seen = 0;
  return text.replace(/(?<![\w@])@([A-Za-z][\w]{4,31})\b/g, (whole, name: string) => {
    seen += 1;
    return seen <= max ? whole : name;
  });
}

/** 码点数组上的 `lastIndexOf('\n\n')`。见下方 splitTelegramText 里为什么不能用 String 版。 */
function lastIndexOfPair(haystack: readonly string[], first: string, second: string): number {
  for (let start = haystack.length - 2; start >= 0; start -= 1) if (haystack[start] === first && haystack[start + 1] === second) return start;
  return -1;
}

export function splitTelegramText(text: string, max = 3900): string[] {
  const parts: string[] = [];
  let remaining = [...safeRender(text)];
  let reopenFence = false;
  while (remaining.length > max) {
    const prefix: string = reopenFence ? '```\n' : '';
    const budget = max - [...prefix].length - 4;
    const window = remaining.slice(0, budget);
    // 断点只在码点数组上找。String#lastIndexOf 给的是 UTF-16 下标，一条 emoji 就让它比码点下标大 1；
    // 拿它去切码点数组，body 取不满而 remaining 多跳，中间那段直接消失（实测 5001 码点丢 1105 个，
    // docs/24 · R-TG-01）。boundary 由此恒 ≤ budget，也就不会切出超长的 part。
    const candidates = [lastIndexOfPair(window, '\n', '\n'), window.lastIndexOf('\n'),
      Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？')), window.lastIndexOf(' ')];
    const boundary = candidates.find((value) => value >= Math.floor(budget * 0.5)) ?? budget;
    const body = window.slice(0, boundary).join('').trimEnd();
    const open: boolean = ((prefix + body).match(/```/g) ?? []).length % 2 === 1;
    parts.push(`${prefix}${body}${open ? '\n```' : ''}`);
    remaining = remaining.slice(boundary);
    while (remaining[0]?.trim() === '') remaining.shift();
    reopenFence = open;
  }
  if (remaining.length) parts.push(`${reopenFence ? '```\n' : ''}${remaining.join('')}`);
  return parts;
}
