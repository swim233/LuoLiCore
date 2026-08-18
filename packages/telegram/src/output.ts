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
/** `output.parseMode` 的三档。渲染器、分片器、投递时挂的 `parse_mode` 必须同时按它分档（docs/08 §5.3）。 */
export type ParseMode = 'MarkdownV2' | 'HTML' | 'none';

export function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL, '\\$&');
}

/**
 * Telegram HTML 模式的文本转义。**`&` 必须第一个换** —— 反过来的话 `<` 产出的 `&lt;` 会被
 * `&` 那条规则再转一遍成 `&amp;lt;`，用户看到的是字面的 `&lt;`。一次 `replace` 走三个字符
 * 因此比三次链式 `replaceAll` 更难写错。
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}
/** `href` 里额外要挡 `"`：属性值是用双引号括的。 */
function escapeHtmlAttribute(url: string): string {
  return escapeHtml(url).replaceAll('"', '&quot;');
}
/**
 * `class="language-xxx"` 里的语言名来自模型写的围栏标记，是外部输入 —— 按白名单收，不是转义。
 * **截断到第一个非法字符，而不是把非法字符滤掉**：```` ```js"><script> ```` 滤出来是
 * `jsscript`（安全，但那不是任何一种语言），截出来是 `js`。顺带也把空格后面那截去掉了。
 */
const LANG_PREFIX = /^[A-Za-z0-9+#._-]*/;
/**
 * 长过这个数就当没写语言。真实语言标识符最长也就 `objective-c` 这个量级，而这个值是**分片的**
 * 前提而不只是整洁：`<pre><code class="language-…">` 是一个不可切开的构造，它加上自己的
 * `</code>` 一旦长过 `maxMessageChars`，这个元素就没有任何切法能既装进一片又保持成对，分片器
 * 只能硬切、让 Telegram 整条拒收（实测 120 个字符的「语言名」配 `maxMessageChars: 150`）。
 */
const LANG_MAX = 24;

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
 * 把通用 Markdown 渲染成 Telegram HTML（docs/08 §5.3.2）。
 *
 * 走的是 MarkdownV2 那棵**同一棵** AST，节点降级也一致 —— 差别只有输出的标签与转义规则。
 * 两条红线跟着 §5.3.1 走：转义只发生在文本节点上；渲染绝不成为投递失败的新来源。
 */
export function safeRenderHtml(markdown: string): string {
  const text = markdown.replaceAll('\u0000', '');
  try { return renderBlocksHtml(marked.lexer(text, LEXER_OPTIONS)); }
  catch { return escapeHtml(text); }
}

function renderBlocksHtml(tokens: readonly Token[], depth = 0): string {
  return tokens.filter((token) => token.type !== 'def')
    .map((token) => renderBlockHtml(token, depth) + trailingNewlines(token.raw)).join('');
}

function renderBlockHtml(token: Token, depth: number): string {
  switch (token.type) {
    case 'space': return '';
    case 'paragraph': return renderInlineHtml(token.tokens, token.text);
    // 同 MarkdownV2：Telegram 的 HTML 模式也没有标题实体。整段已经是粗体，所以照样带着
    // `strong` 进去 —— 否则 `### **小标题**` 会输出一层空的 `<b><b>`。
    case 'heading': return `<b>${renderInlineHtml(token.tokens, token.text, ['strong'])}</b>`;
    case 'code': return fenceHtml(token.text, token.lang);
    case 'table': return fenceHtml(token.raw.replace(/\n+$/, ''), '');
    case 'hr': return '——————';
    // MarkdownV2 那边「内含围栏就退掉 `>` 前缀」的妥协在这里不需要：那条妥协是因为逐行前缀会
    // 把 `pre` 实体拆开，而 HTML 的嵌套是显式的，`<pre>` 待在 `<blockquote>` 里没问题。
    case 'blockquote': return `<blockquote>${renderBlocksHtml(token.tokens ?? [], depth)}</blockquote>`;
    case 'list': return renderListHtml(token as Tokens.List, depth);
    case 'text': return token.tokens?.length ? renderInlineHtml(token.tokens, token.text) : escapeHtml(token.text);
    default: return escapeHtml((token.raw ?? '').replace(/\n+$/, ''));
  }
}

function renderInlineHtml(tokens: readonly Token[] | undefined, fallback: string, open: readonly Emphasis[] = []): string {
  if (!tokens?.length) return escapeHtml(fallback);
  return tokens.map((token): string => {
    switch (token.type) {
      case 'text': return token.tokens?.length ? renderInlineHtml(token.tokens, token.text, open) : escapeHtml(token.text);
      case 'escape': return escapeHtml(token.text);
      // 代码实体内部照样要转这三个：Telegram 的 HTML 模式在 `code` / `pre` 里也解析实体。
      case 'codespan': return `<code>${escapeHtml(token.text)}</code>`;
      case 'strong': return emphasisHtml('strong', 'b', token, open);
      case 'em': return emphasisHtml('em', 'i', token, open);
      case 'del': return emphasisHtml('del', 's', token, open);
      case 'br': return '\n';
      case 'link': return linkHtml(token.href, renderInlineHtml(token.tokens, token.text, open), token.raw);
      case 'image': return linkHtml(token.href, escapeHtml(token.text?.trim() || '图片'), token.raw);
      default: return escapeHtml(token.raw ?? '');
    }
  }).join('');
}

/**
 * HTML 没有 MarkdownV2 那条「同种强调不能自嵌套」的限制，所以这里抑制重复只是为了不输出
 * `<b><b>x</b></b>` 这种空壳 —— 判据与 `emphasis` 共用一份 `open`，两个渲染器因此对
 * `### **小标题**` 给出同一个结构。
 */
function emphasisHtml(kind: Emphasis, tag: string, token: { tokens?: readonly Token[]; text?: string }, open: readonly Emphasis[]): string {
  if (open.includes(kind)) return renderInlineHtml(token.tokens, token.text ?? '', open);
  return `<${tag}>${renderInlineHtml(token.tokens, token.text ?? '', [...open, kind])}</${tag}>`;
}

/** scheme 白名单与 MarkdownV2 那条共用：正文里可能带被注入的链接（docs/08 §5.3 第二条约束）。 */
function linkHtml(href: string | undefined, label: string, raw: string): string {
  if (!href || !LINK_SCHEME.test(href)) return escapeHtml(raw);
  return `<a href="${escapeHtmlAttribute(href)}">${label}</a>`;
}

function fenceHtml(body: string, lang: string | undefined): string {
  const extracted = LANG_PREFIX.exec((lang ?? '').trim())![0];
  const tag = extracted.length <= LANG_MAX ? extracted : '';
  const inner = escapeHtml(body);
  return tag ? `<pre><code class="language-${tag}">${inner}</code></pre>` : `<pre>${inner}</pre>`;
}

function renderListHtml(token: Tokens.List, depth: number): string {
  const indent = '  '.repeat(depth);
  const start = Number(token.start || 1);
  // Telegram 的标签子集里没有 `ul` / `ol`，所以列表在两档里都是「靠字符排版」而不是靠标签。
  return token.items.map((item, index) => {
    const marker = token.ordered ? `${start + index}.` : '•';
    const box = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
    const inner = item.tokens.map((child) => renderBlockHtml(child, depth + 1)).filter(Boolean).join('\n');
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

/** 降级回调的载荷。`phase` 区分发送与编辑两条路 —— 后者在 `stream-output.ts` 里。 */
export interface ParseFallbackInfo {
  chars: number;
  error: string;
  phase: 'send' | 'edit';
}

/**
 * MarkdownV2 渲染失败时退回纯文本重发一次。所有投递路径共用它：`safeRender` 已经很细，但按字符数
 * 切分仍可能把 `*bold*` 的配对切开，而裸调 `sendMessage` 抛出去会把整轮打成 failed —— 用户明明
 * 已经看到前半段回复，却又收到一句「出了点问题」（docs/20 · W-TG-03 / W-TG-04）。
 *
 * 纯文本重发**自己也要有兜底**：它此前是裸调，第二次失败（重渲染后超长、429 flood wait、
 * chat migrated）照样打穿整轮，正是上面那句话说要防的事。第二次失败时抛回**第一个**错误 ——
 * 排障要看的是「为什么 MarkdownV2 崩了」，第二次通常只是派生现象。
 *
 * @param onFallback 降级成功时回调一次。这一跳此前一个字都不落，于是行内代码那个 bug 只能靠翻
 *   下一次模型调用的 context blob 反推（docs/00 §2.3）。可选：`tools.ts` 那条路拿不到 LogSink。
 */
/** `output.parseMode`：`none` 时直接发纯文本（不试 Markdown 也就不会有回退那一跳）。 */
export async function sendWithFallback(api: Api, chatId: string, text: string, extra: Record<string, unknown> = {}, parseMode: ParseMode = 'MarkdownV2',
  onFallback?: (info: ParseFallbackInfo) => void): Promise<Message> {
  if (parseMode === 'none') return api.sendMessage(chatId, text, extra);
  try { return await api.sendMessage(chatId, text, { parse_mode: parseMode, ...extra }); }
  catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    if (!/parse entities/i.test(description)) throw error;
    // try/catch 而不是 `.catch()`：同步抛的 `sendMessage` 压根没有 promise 可以挂回调
    // （同 `approvals.ts` 那处「同步抛也不能影响审批」）。
    let sent: Message;
    try { sent = await api.sendMessage(chatId, toPlainText(text, parseMode), extra); }
    catch { throw error; }
    onFallback?.({ chars: text.length, error: description, phase: 'send' });
    return sent;
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

/** 每切一段算一次：这一段要补的收尾、下一段要补的开头。跨片保持实体成对的唯一出口。 */
interface Seal { suffix: string; prefix: string }
const NO_SEAL: Seal = { suffix: '', prefix: '' };

/** MarkdownV2：只有 ` ``` ` 围栏跨得过片。奇数个 = 切口落在围栏里面。 */
function sealMarkdown(part: string): Seal {
  return (part.match(/```/g) ?? []).length % 2 === 1 ? { suffix: '\n```', prefix: '```\n' } : NO_SEAL;
}

/** HTML：切口处还张着的标签，本片按栈逆序闭合，下一片原样重开（属性也得原样带回去）。 */
function sealHtml(part: string): Seal {
  const stack: Array<{ name: string; open: string }> = [];
  // 渲染器保证输出里每个裸 `<` 都是标签开头（文本节点里的 `<` 已经是 `&lt;`），所以这条正则够用。
  for (const match of part.matchAll(/<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi)) {
    const name = match[2]!.toLowerCase();
    if (!match[1]) { stack.push({ name, open: match[0] }); continue; }
    // 正常输出里闭合的一定是栈顶；对不上时宁可不动栈，也别把成对关系改坏。
    if (stack.at(-1)?.name === name) stack.pop();
  }
  if (!stack.length) return NO_SEAL;
  return { suffix: [...stack].reverse().map((entry) => `</${entry.name}>`).join(''), prefix: stack.map((entry) => entry.open).join('') };
}

/**
 * HTML 那一档「这个下标前面可不可以断开」的掩码。标签 `<…>` 与实体 `&…;` 内部一律不许断：
 * `<a href="…">` 与 `<pre><code class="…">` 里都有空格，而断点候选里就有 `' '` —— 不挡的话
 * 会切出一个 `<a` 加一个 `href="…">`（docs/08 §5.3.4）。
 */
function htmlBreakable(codepoints: readonly string[]): boolean[] {
  const breakable = new Array<boolean>(codepoints.length + 1).fill(true);
  for (let index = 0; index < codepoints.length; index += 1) {
    const char = codepoints[index];
    if (char !== '<' && char !== '&') continue;
    const closer = char === '<' ? '>' : ';';
    let end = index + 1;
    let literal = false;
    while (end < codepoints.length && codepoints[end] !== closer) {
      // 实体只可能是 `&amp; &lt; &gt; &quot;`：撞上非实体字符说明这个 `&` 是字面量，不是构造。
      if (char === '&' && !/[A-Za-z0-9#]/.test(codepoints[end]!)) { literal = true; break; }
      end += 1;
    }
    if (literal) continue;
    const truncated = end >= codepoints.length;
    for (let inner = index + 1; inner <= (truncated ? codepoints.length : end); inner += 1) breakable[inner] = false;
    if (truncated) break;
    index = end;
  }
  return breakable;
}

/** 把断点退到掩码允许的位置。没有掩码（MarkdownV2 / none）时原样返回。 */
function retreat(boundary: number, breakable: readonly boolean[] | null): number {
  if (!breakable) return boundary;
  let at = boundary;
  while (at > 0 && !breakable[at]) at -= 1;
  return at;
}

function chooseBoundary(codepoints: readonly string[], limit: number, breakable: readonly boolean[] | null): number {
  const window = codepoints.slice(0, limit);
  // 断点只在码点数组上找。String#lastIndexOf 给的是 UTF-16 下标，一条 emoji 就让它比码点下标大 1；
  // 拿它去切码点数组，body 取不满而 remaining 多跳，中间那段直接消失（实测 5001 码点丢 1105 个，
  // docs/24 · R-TG-01）。boundary 由此恒 ≤ limit，也就不会切出超长的 part。
  const candidates = [lastIndexOfPair(window, '\n', '\n'), window.lastIndexOf('\n'),
    Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？')), window.lastIndexOf(' ')]
    .map((value) => retreat(value, breakable));
  const chosen = candidates.find((value) => value >= Math.floor(limit * 0.5)) ?? retreat(limit, breakable);
  // 退无可退（单个标签就长过一整片，比如 URL 有几千字符）：硬切。切坏的标签会让 Telegram 报解析
  // 失败，而 `sendWithFallback` 会降级成纯文本 —— 消息还在。死循环才是真的不可接受。
  return chosen > 0 ? chosen : limit;
}

/**
 * 按 `maxMessageChars` 分片。**渲染在分片之前**（转义会让长度翻倍，按源文本切没法保证渲染后
 * 不超上限），所以每一档都要认自己那套不可切开的构造 —— 见 docs/08 §5.3.4 那张表。
 */
export function splitTelegramText(text: string, max = 3900, parseMode: ParseMode = 'MarkdownV2'): string[] {
  // `none` 只摘 NUL（正文里的 NUL 没有任何显示意义），其余原样 —— 这一档的语义就是「别动我的文本」。
  const rendered = parseMode === 'none' ? text.replaceAll('\u0000', '')
    : parseMode === 'HTML' ? safeRenderHtml(text) : safeRender(text);
  const sealer = parseMode === 'HTML' ? sealHtml : parseMode === 'MarkdownV2' ? sealMarkdown : null;
  // MarkdownV2 的收尾长度是定值（`\n``` `），预留掉就一次切成；HTML 的取决于切口处张着哪些标签，
  // **一律不预留**，靠下面那个重试按真实超出量回退。按最坏情况（白名单里每个标签都张着 = 59 字符）
  // 悲观预留过一版：`maxMessageChars` 调到 100 时窗口只剩 41，一个 `<a href="…">` 都放不下，
  // `retreat` 退到 0 之后硬切，把标签切成两半 —— 正是这一整块要防的事（4000 轮随机用例实测）。
  const reserve = parseMode === 'MarkdownV2' ? 4 : 0;
  const parts: string[] = [];
  let remaining = [...rendered];
  let seal: Seal = NO_SEAL;
  // 条件里带上**重开前缀的长度**：`remaining.length <= max` 只说正文装得下，而收尾那一片还要
  // 把前缀拼上去。不带的话最后一片会超上限（MarkdownV2 最多超 4 个字符，HTML 能超一整条 URL），
  // 而超长不是解析失败、`sendWithFallback` 兜不住 —— Telegram 直接 message is too long。
  while ([...seal.prefix].length + remaining.length > max) {
    const breakable = parseMode === 'HTML' ? htmlBreakable(remaining) : null;
    // **前缀一旦决定要带就必须带到底。** 试过「装不下就放弃重开」，那是错的：不重开的那一片是
    // 纯文本没问题，但流里后面**仍然会来那个 `</b>`** —— 它于是变成下一片开头一个没有配对的闭合
    // 标签（4000 轮随机用例才逼出来，因为按片统计「开了几个/闭了几个」的弱判据看不见野闭合标签）。
    // 唯一的例外是前缀自己就长过一整片：那时它怎么都带不进去，而那一档的标签本来也已经被硬切了。
    const prefix = [...seal.prefix].length < max ? seal.prefix : '';
    let limit = Math.max(1, max - [...prefix].length - reserve);
    let boundary = 0;
    let body = '';
    let next: Seal = NO_SEAL;
    for (;;) {
      boundary = chooseBoundary(remaining, limit, breakable);
      body = remaining.slice(0, boundary).join('').trimEnd();
      next = sealer ? sealer(prefix + body) : NO_SEAL;
      const size = [...prefix].length + [...body].length + [...next.suffix].length;
      if (size <= max || boundary <= 1) break;
      // 收尾比预期长（嵌套里切了一刀，闭合链比上一轮更深）：把断点往前挪掉超出的量再来一次。
      // limit 单调下降，所以必然收敛。
      limit = Math.max(1, limit - (size - max));
    }
    // 退到这里还超上限，只可能是前缀几乎占满了一整片（实测 96 字符的 `<a href="…">` 配
    // `maxMessageChars: 100`：每片都是前缀 + 1 个字 + 闭合 = 101 字符，超上限而且永远切不完）。
    // 这一档**宁可丢格式也不能超上限**：超长会被 Telegram 以 message is too long 硬拒，而
    // `sendWithFallback` 只兜得住解析失败；不成对至少还能降级成纯文本把话说出去。
    if (prefix && [...prefix].length + [...body].length + [...next.suffix].length > max) {
      next = sealer ? sealer(body) : NO_SEAL;
      parts.push(`${body}${next.suffix}`);
    } else parts.push(`${prefix}${body}${next.suffix}`);
    remaining = remaining.slice(boundary);
    while (remaining[0]?.trim() === '') remaining.shift();
    seal = next;
  }
  // 前缀带得进去是上面那个 while 条件保证的，所以这里直接拼。
  if (remaining.length) parts.push(`${seal.prefix}${remaining.join('')}`);
  return parts;
}

/**
 * 渲染结果反推回纯文本。解析失败降级时用它，而不是把渲染结果原样按纯文本发出去 —— 后者在
 * MarkdownV2 下是满屏 `\-`，在 HTML 下更糟：用户直接看到 `<b>` 标签。`sendWithFallback` 的
 * 承诺是「格式丢掉，消息还在」，那就得真的只丢格式。
 */
export function toPlainText(rendered: string, parseMode: ParseMode): string {
  if (parseMode === 'none') return rendered;
  if (parseMode === 'HTML') {
    // 链接的 URL 单独捞出来：标签一律剥掉的话它会**连内容一起丢**，那不是丢格式而是丢信息。
    return rendered.replace(/<a href="([^"]*)">(.*?)<\/a>/gs, (_whole, href: string, label: string) => `${label} (${href})`)
      // 只剥**完整**标签。被硬切开的半截标签（`<a href="…` 结尾、`…">` 开头）故意留着：
      // 它出现在「单个构造比整片还长」那一档，而那一档里 `<a href="` 后面跟的就是那条长 URL 本身。
      // 试过顺手擦掉这两个半截，代价是把 URL 一起吃了 —— 少几个字面尖括号远不如「消息还在」重要。
      .replace(/<[^>]*>/g, '')
      // 解码顺序与 `escapeHtml` 的转义顺序相反：`&amp;` 最后，否则 `&amp;lt;` 会被解成 `<`。
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&');
  }
  return rendered.replace(/\\([\\_*[\]()~`>#+\-=|{}.!])/g, '$1');
}
