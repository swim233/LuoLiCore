import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { marked, type MarkedOptions, type Token, type Tokens } from "marked";
import { KeyedMutex } from "@luoli/core";

/**
 * 普通文本需转义的字符全集。必须包含 `\`：遗漏时 `C:\x` 会被 Telegram 解析为转义 x，
 * 反斜杠被静默丢弃（docs/08 §5.3 第 4 条）。
 */
const SPECIAL = /[\\_*\[\]()~`>#+\-=|{}.!]/g;
/** `pre` / `code` 实体内部只需转义这两个字符，其余按字面输出。 */
const CODE_SPECIAL = /[\\`]/g;
/** `[…](url)` 的 URL 部分只需转义这两个字符。 */
const LINK_SPECIAL = /[\\)]/g;
/** 可点击链接的 scheme 白名单。回复正文可能含被注入的内容，此处必须用白名单而非黑名单。 */
const LINK_SCHEME = /^(?:https?|tg|mailto):/i;
/** 显式传入全部开关：`marked.lexer` 不带 options 时会沿用全局 `marked.use()` 的残留配置。 */
const LEXER_OPTIONS: MarkedOptions = {
  gfm: true,
  breaks: false,
  pedantic: false,
};
/** `output.parseMode` 的三个档位。渲染器、分片器与投递时的 `parse_mode` 必须按同一档位取值（docs/08 §5.3）。 */
export type ParseMode = "MarkdownV2" | "HTML" | "none";

export function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL, "\\$&");
}

/**
 * Telegram HTML 模式的文本转义。`&` 必须最先替换：顺序颠倒时 `<` 产出的 `&lt;` 会被 `&` 规则
 * 二次转义为 `&amp;lt;`，用户看到字面的 `&lt;`。单次 `replace` 处理三个字符比三次链式
 * `replaceAll` 更不易出错。
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;",
  );
}
/** `href` 需额外转义 `"`：属性值由双引号包裹。 */
function escapeHtmlAttribute(url: string): string {
  return escapeHtml(url).replaceAll('"', "&quot;");
}
/**
 * `class="language-xxx"` 中的语言名来自模型写的围栏标记，属于外部输入，按白名单收敛而非转义。
 * 截断到第一个非法字符，而不是过滤掉非法字符：```` ```js"><script> ```` 过滤后得到 `jsscript`
 * （安全但不对应任何语言），截断后得到 `js`。该规则同时去掉了空格之后的部分。
 */
const LANG_PREFIX = /^[A-Za-z0-9+#._-]*/;
/**
 * 超过该长度即视为未指定语言。真实语言标识符最长约为 `objective-c` 的量级，而这个上限是分片的
 * 前提而不只是整洁性要求：`<pre><code class="language-…">` 是不可切分的构造，它与配对的 `</code>`
 * 一旦超过 `maxMessageChars`，该元素就没有任何切法能既装入单片又保持成对，分片器只能硬切，
 * 导致 Telegram 拒收整条消息（实测 120 字符的「语言名」配 `maxMessageChars: 150`）。
 */
const LANG_MAX = 24;

/**
 * 把通用 Markdown 渲染成 Telegram MarkdownV2（docs/08 §5.3）。
 *
 * 转义只发生在文本节点上，这是本节的硬约束。旧实现采用相反路径：逐行全量转义后只把 `\*\*x\*\*`
 * 反解回 `*x*`，于是每个不在反解白名单内的构造都退化为字面转义符。行内代码从未被反解（用户看到
 * 两个反引号）；`heading` 生成的 `*粗体*` 因为产生于转义之前且只有双星号一条反解规则，同样被自身
 * 转义吞掉。这类缺陷不报错、只是显示朴素，因此靠补白名单无法修完，只有「先解析、再逐节点输出」
 * 才能一次性消除整类问题。
 */
export function safeRender(markdown: string): string {
  // NUL 在 Telegram 正文中无任何显示意义，入口即剔除。占位符方案（docs/27 · C-07）已废弃，
  // 但「正文中的 NUL 不应外发」这条仍然成立。
  const text = markdown.replaceAll("\u0000", "");
  // 渲染器不得成为投递失败的新来源：lexer 对任何输入都应有结果，一旦抛出则退回全文字面转义，
  // 丢掉格式但保住消息。
  try {
    return renderBlocks(marked.lexer(text, LEXER_OPTIONS));
  } catch {
    return escapeMarkdownV2(text);
  }
}

/** 块级节点的尾随换行按 `raw` 原样保留，使段落间空行数量与模型输出完全一致。 */
function trailingNewlines(raw: string | undefined): string {
  return /\n*$/.exec(raw ?? "")![0];
}

function renderBlocks(tokens: readonly Token[], depth = 0): string {
  // `def`（`[a]: url` 形式的链接定义）不属于正文，连同其占用的换行一并丢弃。
  return tokens
    .filter((token) => token.type !== "def")
    .map((token) => renderBlock(token, depth) + trailingNewlines(token.raw))
    .join("");
}

function renderBlock(token: Token, depth: number): string {
  switch (token.type) {
    case "space":
      return "";
    case "paragraph":
      return renderInline(token.tokens, token.text);
    // 降级处理：Telegram 没有标题实体（docs/08 §5.3 第 3 条）。整段已是粗体，因此把 `strong`
    // 一并传入；否则 `### **小标题**` 会渲染成 `**小标题**`，即两个空粗体夹文字，Telegram 判定解析失败。
    case "heading":
      return `*${renderInline(token.tokens, token.text, ["strong"])}*`;
    case "code":
      return fence(token.text, token.lang);
    // 表格按 raw 原样放入等宽块：按码点补齐列宽在中英混排下反而更不齐（CJK 为双宽字符）。
    case "table":
      return fence(token.raw.replace(/\n+$/, ""), "");
    case "hr":
      return "——————";
    // `Token` 联合中包含 `Tokens.Generic`（`type: string` + 索引签名），switch 无法将其收窄，
    // 因此这两处需自行断言而不能依赖类型收窄。
    case "blockquote":
      return quote(renderBlocks(token.tokens ?? [], depth));
    case "list":
      return renderList(token as Tokens.List, depth);
    case "text":
      return token.tokens?.length
        ? renderInline(token.tokens, token.text)
        : escapeMarkdownV2(token.text);
    // 块级 HTML 与任何未知节点按字面显示。尾随换行由 trailingNewlines 补齐，此处先去除以免重复计入。
    default:
      return escapeMarkdownV2((token.raw ?? "").replace(/\n+$/, ""));
  }
}

/** `open` 记录当前已打开的强调实体种类，用途见 `emphasis`。 */
type Emphasis = "strong" | "em" | "del";

function renderInline(
  tokens: readonly Token[] | undefined,
  fallback: string,
  open: readonly Emphasis[] = [],
): string {
  if (!tokens?.length) return escapeMarkdownV2(fallback);
  return tokens
    .map((token): string => {
      switch (token.type) {
        case "text":
          return token.tokens?.length
            ? renderInline(token.tokens, token.text, open)
            : escapeMarkdownV2(token.text);
        // lexer 已把 `\*` 解析为 escape 节点，text 是还原后的 `*`；再转义一次即可无损还原。
        case "escape":
          return escapeMarkdownV2(token.text);
        case "codespan":
          return `\`${token.text.replace(CODE_SPECIAL, "\\$&")}\``;
        case "strong":
          return emphasis("strong", "*", token, open);
        case "em":
          return emphasis("em", "_", token, open);
        case "del":
          return emphasis("del", "~", token, open);
        case "br":
          return "\n";
        case "link":
          return link(
            token.href,
            renderInline(token.tokens, token.text, open),
            token.raw,
          );
        case "image":
          return link(
            token.href,
            escapeMarkdownV2(token.text?.trim() || "图片"),
            token.raw,
          );
        default:
          return escapeMarkdownV2(token.raw ?? "");
      }
    })
    .join("");
}

/**
 * 同种强调实体在 MarkdownV2 中不能自嵌套（`*a *b* c*` 会解析失败），已打开时只渲染内容。
 * 形参取最小结构而非 `Tokens.Strong | …`：`Token` 联合中的 `Tokens.Generic` 无法收窄。
 */
function emphasis(
  kind: Emphasis,
  mark: string,
  token: { tokens?: readonly Token[]; text?: string },
  open: readonly Emphasis[],
): string {
  if (open.includes(kind))
    return renderInline(token.tokens, token.text ?? "", open);
  return `${mark}${renderInline(token.tokens, token.text ?? "", [...open, kind])}${mark}`;
}

/** scheme 不在白名单内时退回字面 raw：失去可点击性，但不隐藏任何字符。 */
function link(href: string | undefined, label: string, raw: string): string {
  if (!href || !LINK_SCHEME.test(href)) return escapeMarkdownV2(raw);
  return `[${label}](${href.replace(LINK_SPECIAL, "\\$&")})`;
}

function fence(body: string, lang: string | undefined): string {
  const tag = (lang ?? "").trim().split(/\s+/)[0] ?? "";
  return `\`\`\`${tag.replace(CODE_SPECIAL, "\\$&")}\n${body.replace(CODE_SPECIAL, "\\$&")}\n\`\`\``;
}

/**
 * 引用块即每行一个不转义的 `>`。内含代码围栏时整段去掉前缀：逐行 `>` 前缀会拆开 `pre` 实体，
 * 导致 Telegram 判定解析失败。宁可丢失引用样式，也不让整条消息退化为纯文本。
 */
function quote(inner: string): string {
  if (inner.includes("```")) return inner;
  return inner
    .split("\n")
    .map((line) => `>${line}`)
    .join("\n");
}

function renderList(token: Tokens.List, depth: number): string {
  const indent = "  ".repeat(depth);
  const start = Number(token.start || 1);
  return token.items
    .map((item, index) => {
      // 无序项用 `•` 而非 `-`：`-` 在 MarkdownV2 中需转义，行首的 `\-` 是纯噪音。
      const marker = token.ordered ? `${start + index}\\.` : "•";
      const box = item.task ? (item.checked ? "☑ " : "☐ ") : "";
      // 子块用 `\n` 拼接而非沿用 raw 的尾随换行：列表项的 raw 尾随换行属于列表布局，
      // 嵌套列表已按 depth+1 缩进，再叠加一层会形成阶梯状缩进。
      const inner = item.tokens
        .map((child) => renderBlock(child, depth + 1))
        .filter(Boolean)
        .join("\n");
      return `${indent}${marker} ${box}${inner}`.trimEnd();
    })
    .join("\n");
}

/**
 * 把通用 Markdown 渲染成 Telegram HTML（docs/08 §5.3.2）。
 *
 * 使用与 MarkdownV2 相同的 AST，节点降级规则也一致，差别仅在输出标签与转义规则。
 * 两条硬约束沿用 §5.3.1：转义只发生在文本节点上；渲染不得成为投递失败的新来源。
 */
export function safeRenderHtml(markdown: string): string {
  const text = markdown.replaceAll("\u0000", "");
  try {
    return renderBlocksHtml(marked.lexer(text, LEXER_OPTIONS));
  } catch {
    return escapeHtml(text);
  }
}

function renderBlocksHtml(tokens: readonly Token[], depth = 0): string {
  return tokens
    .filter((token) => token.type !== "def")
    .map((token) => renderBlockHtml(token, depth) + trailingNewlines(token.raw))
    .join("");
}

function renderBlockHtml(token: Token, depth: number): string {
  switch (token.type) {
    case "space":
      return "";
    case "paragraph":
      return renderInlineHtml(token.tokens, token.text);
    // 同 MarkdownV2：Telegram 的 HTML 模式同样没有标题实体。整段已是粗体，因此照样传入
    // `strong`，否则 `### **小标题**` 会输出一层空的 `<b><b>`。
    case "heading":
      return `<b>${renderInlineHtml(token.tokens, token.text, ["strong"])}</b>`;
    case "code":
      return fenceHtml(token.text, token.lang);
    case "table":
      return fenceHtml(token.raw.replace(/\n+$/, ""), "");
    case "hr":
      return "——————";
    // MarkdownV2 中「内含围栏则去掉 `>` 前缀」的妥协在此不需要：该妥协源于逐行前缀会拆开 `pre`
    // 实体，而 HTML 的嵌套是显式的，`<pre>` 位于 `<blockquote>` 内没有问题。
    case "blockquote":
      return `<blockquote>${renderBlocksHtml(token.tokens ?? [], depth)}</blockquote>`;
    case "list":
      return renderListHtml(token as Tokens.List, depth);
    case "text":
      return token.tokens?.length
        ? renderInlineHtml(token.tokens, token.text)
        : escapeHtml(token.text);
    default:
      return escapeHtml((token.raw ?? "").replace(/\n+$/, ""));
  }
}

function renderInlineHtml(
  tokens: readonly Token[] | undefined,
  fallback: string,
  open: readonly Emphasis[] = [],
): string {
  if (!tokens?.length) return escapeHtml(fallback);
  return tokens
    .map((token): string => {
      switch (token.type) {
        case "text":
          return token.tokens?.length
            ? renderInlineHtml(token.tokens, token.text, open)
            : escapeHtml(token.text);
        case "escape":
          return escapeHtml(token.text);
        // 代码实体内部同样要转义这三个字符：Telegram 的 HTML 模式在 `code` / `pre` 内也解析实体。
        case "codespan":
          return `<code>${escapeHtml(token.text)}</code>`;
        case "strong":
          return emphasisHtml("strong", "b", token, open);
        case "em":
          return emphasisHtml("em", "i", token, open);
        case "del":
          return emphasisHtml("del", "s", token, open);
        case "br":
          return "\n";
        case "link":
          return linkHtml(
            token.href,
            renderInlineHtml(token.tokens, token.text, open),
            token.raw,
          );
        case "image":
          return linkHtml(
            token.href,
            escapeHtml(token.text?.trim() || "图片"),
            token.raw,
          );
        default:
          return escapeHtml(token.raw ?? "");
      }
    })
    .join("");
}

/**
 * HTML 没有 MarkdownV2「同种强调不能自嵌套」的限制，此处抑制重复只是为了避免输出
 * `<b><b>x</b></b>` 这类空壳。判据与 `emphasis` 共用同一份 `open`，两个渲染器因此对
 * `### **小标题**` 产出相同结构。
 */
function emphasisHtml(
  kind: Emphasis,
  tag: string,
  token: { tokens?: readonly Token[]; text?: string },
  open: readonly Emphasis[],
): string {
  if (open.includes(kind))
    return renderInlineHtml(token.tokens, token.text ?? "", open);
  return `<${tag}>${renderInlineHtml(token.tokens, token.text ?? "", [...open, kind])}</${tag}>`;
}

/** 与 MarkdownV2 共用同一份 scheme 白名单：正文可能含被注入的链接（docs/08 §5.3 第二条约束）。 */
function linkHtml(
  href: string | undefined,
  label: string,
  raw: string,
): string {
  if (!href || !LINK_SCHEME.test(href)) return escapeHtml(raw);
  return `<a href="${escapeHtmlAttribute(href)}">${label}</a>`;
}

function fenceHtml(body: string, lang: string | undefined): string {
  const extracted = LANG_PREFIX.exec((lang ?? "").trim())![0];
  const tag = extracted.length <= LANG_MAX ? extracted : "";
  const inner = escapeHtml(body);
  return tag
    ? `<pre><code class="language-${tag}">${inner}</code></pre>`
    : `<pre>${inner}</pre>`;
}

function renderListHtml(token: Tokens.List, depth: number): string {
  const indent = "  ".repeat(depth);
  const start = Number(token.start || 1);
  // Telegram 的标签子集不含 `ul` / `ol`，因此两个档位的列表都靠字符排版而非标签实现。
  return token.items
    .map((item, index) => {
      const marker = token.ordered ? `${start + index}.` : "•";
      const box = item.task ? (item.checked ? "☑ " : "☐ ") : "";
      const inner = item.tokens
        .map((child) => renderBlockHtml(child, depth + 1))
        .filter(Boolean)
        .join("\n");
      return `${indent}${marker} ${box}${inner}`.trimEnd();
    })
    .join("\n");
}

/**
 * 即时回复读起来像自动应答机，流式模式下第一帧几乎为空。距用户消息不足 `output.replyDelayMs`
 * 时先延迟发送；期间 typing 动作照常，因此表现为正在输入而非卡住。
 */
export async function holdReply(since: number, delayMs: number): Promise<void> {
  // setTimeout 可能比 Date.now() 的读数提前 1ms 唤醒，单次 sleep 会使「至少等待该时长」的下限偶发
  // 差一毫秒不成立（tests/output.pacing.test.ts 因此约有 8% 概率失败）。循环补足到真正达标为止。
  for (
    let remaining = delayMs - (Date.now() - since);
    remaining > 0;
    remaining = delayMs - (Date.now() - since)
  ) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

/** 降级回调的载荷。`phase` 区分发送与编辑两条路径，后者位于 `stream-output.ts`。 */
export interface ParseFallbackInfo {
  chars: number;
  error: string;
  phase: "send" | "edit";
}

/**
 * MarkdownV2 渲染失败时退回纯文本重发一次，所有投递路径共用。`safeRender` 已经足够细致，但按字符数
 * 分片仍可能切开 `*bold*` 的配对，而直接调用 `sendMessage` 抛出会把整轮标记为 failed：用户已经看到
 * 前半段回复，却又收到一条错误提示（docs/20 · W-TG-03 / W-TG-04）。
 *
 * 纯文本重发自身也需要兜底：此前它是裸调用，第二次失败（重渲染后超长、429 flood wait、chat migrated）
 * 同样会打穿整轮，正是上述要防止的情况。第二次失败时抛出第一个错误：排障需要的是 MarkdownV2 失败的
 * 原因，第二次通常只是派生现象。
 *
 * @param onFallback 降级成功时回调一次。此前该分支不记录任何日志，导致行内代码那个缺陷只能靠翻查
 *   下一次模型调用的 context blob 反推（docs/00 §2.3）。可选参数：`tools.ts` 路径拿不到 LogSink。
 */
/** `output.parseMode` 为 `none` 时直接发送纯文本：不尝试 Markdown，也就不存在回退分支。 */
export async function sendWithFallback(
  api: Api,
  chatId: string,
  text: string,
  extra: Record<string, unknown> = {},
  parseMode: ParseMode = "MarkdownV2",
  onFallback?: (info: ParseFallbackInfo) => void,
): Promise<Message> {
  if (parseMode === "none") return api.sendMessage(chatId, text, extra);
  try {
    return await api.sendMessage(chatId, text, {
      parse_mode: parseMode,
      ...extra,
    });
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    if (!/parse entities/i.test(description)) throw error;
    // 用 try/catch 而非 `.catch()`：`sendMessage` 同步抛出时没有 promise 可挂回调
    // （同 `approvals.ts` 中「同步抛出也不能影响审批」的处理）。
    let sent: Message;
    try {
      sent = await api.sendMessage(chatId, toPlainText(text, parseMode), extra);
    } catch {
      throw error;
    }
    onFallback?.({ chars: text.length, error: description, phase: "send" });
    return sent;
  }
}

/**
 * 单条消息的分段批次按 chat 串行（docs/28 · L-TG-02）。
 *
 * 每一段各自经过一次 `apiThrottler`（`bot.ts` 中的 `out: { minTime: 1000 }`），段与段之间存在
 * 「上一段送达后才排下一段」的空档，其他轮次的 `sendMessage` 会在空档中插入队列。实测一条 9469 字的
 * 回复切成 3 条，Telegram 返回的 id 为 1458 / 1459 / 1467，中间隔着三轮后续对话，用户在屏幕上确认
 * 第三段是在后面三条回复之后才出现的。
 *
 * 该锁只覆盖单条消息的分段批次，不覆盖流式过程中的增量编辑：覆盖整轮会使同一群内的并发轮次实质串行
 * （前一轮结束后才能看到后一轮输出），等于把投递顺序问题换成吞吐问题。
 *
 * 模块级单例：同一 chat 的所有轮次必须排入同一队列，每轮新建实例等同于没有锁。进程内顺序与
 * `bot.ts` 的 `ingressOrder` 同级：它排的是该 grammY api 客户端的调用顺序，而该客户端本就只存在于
 * 本进程内（`docs/01 §3.1` 为横向扩展保留的抽象仍是 `KeyedMutex` 本身）。
 */
export const deliveryOrder = new KeyedMutex();

/**
 * `output.maxMentions`：单条消息最多保留的 `@用户名` 个数，超出部分去掉 `@` 只保留名字。
 * 这是防止模型被诱导 @全群的护栏：提示词中已作要求，但提示词不是边界，投递侧才是。0 表示不限制。
 *
 * 前置条件是「前一个字符不属于 `[\w@]`」，而非「前面是空白或左括号」：`,@bob`、`.@cindy`、`;@daisy`
 * 都会被 Telegram 解析为 mention，而旧判据在 `max=1` 下让它们全部漏过（docs/27 · S-10 实测三种全漏）。
 * 投递侧的判据必须与 Telegram 一致。排除 `@` 是为了不把 `@@name` 的第二个 `@` 当作新的 mention；
 * 排除 `\w` 是因为 `foo@bar` 在 Telegram 侧同样不是 mention。
 */
export function capMentions(text: string, max: number): string {
  if (max <= 0) return text;
  let seen = 0;
  return text.replace(
    /(?<![\w@])@([A-Za-z][\w]{4,31})\b/g,
    (whole, name: string) => {
      seen += 1;
      return seen <= max ? whole : name;
    },
  );
}

/** 码点数组上的 `lastIndexOf('\n\n')`。不能用 String 版本的原因见下方 splitTelegramText。 */
function lastIndexOfPair(
  haystack: readonly string[],
  first: string,
  second: string,
): number {
  for (let start = haystack.length - 2; start >= 0; start -= 1)
    if (haystack[start] === first && haystack[start + 1] === second)
      return start;
  return -1;
}

/** 每切分一段计算一次：本段需补的收尾与下一段需补的开头。这是跨片保持实体成对的唯一出口。 */
interface Seal {
  suffix: string;
  prefix: string;
}
const NO_SEAL: Seal = { suffix: "", prefix: "" };

/** MarkdownV2 中只有 ` ``` ` 围栏可能跨片。出现奇数个即表示切口落在围栏内部。 */
function sealMarkdown(part: string): Seal {
  return (part.match(/```/g) ?? []).length % 2 === 1
    ? { suffix: "\n```", prefix: "```\n" }
    : NO_SEAL;
}

/** HTML：切口处仍打开的标签，本片按栈逆序闭合，下一片原样重开（属性也需原样带回）。 */
function sealHtml(part: string): Seal {
  const stack: Array<{ name: string; open: string }> = [];
  // 渲染器保证输出中每个裸 `<` 都是标签起始（文本节点内的 `<` 已转为 `&lt;`），因此该正则足够。
  for (const match of part.matchAll(/<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi)) {
    const name = match[2]!.toLowerCase();
    if (!match[1]) {
      stack.push({ name, open: match[0] });
      continue;
    }
    // 正常输出中闭合的必定是栈顶；不匹配时宁可不动栈，也不要破坏成对关系。
    if (stack.at(-1)?.name === name) stack.pop();
  }
  if (!stack.length) return NO_SEAL;
  return {
    suffix: [...stack]
      .reverse()
      .map((entry) => `</${entry.name}>`)
      .join(""),
    prefix: stack.map((entry) => entry.open).join(""),
  };
}

/**
 * HTML 档位下「该下标之前是否可断开」的掩码。标签 `<…>` 与实体 `&…;` 内部一律不可断开：
 * `<a href="…">` 与 `<pre><code class="…">` 中都含空格，而断点候选包含 `' '`，不拦截就会切出
 * 一个 `<a` 和一个 `href="…">`（docs/08 §5.3.4）。
 */
function htmlBreakable(codepoints: readonly string[]): boolean[] {
  const breakable = new Array<boolean>(codepoints.length + 1).fill(true);
  for (let index = 0; index < codepoints.length; index += 1) {
    const char = codepoints[index];
    if (char !== "<" && char !== "&") continue;
    const closer = char === "<" ? ">" : ";";
    let end = index + 1;
    let literal = false;
    while (end < codepoints.length && codepoints[end] !== closer) {
      // 实体只可能是 `&amp; &lt; &gt; &quot;`：遇到非实体字符说明该 `&` 是字面量而非构造。
      if (char === "&" && !/[A-Za-z0-9#]/.test(codepoints[end]!)) {
        literal = true;
        break;
      }
      end += 1;
    }
    if (literal) continue;
    const truncated = end >= codepoints.length;
    for (
      let inner = index + 1;
      inner <= (truncated ? codepoints.length : end);
      inner += 1
    )
      breakable[inner] = false;
    if (truncated) break;
    index = end;
  }
  return breakable;
}

/** 把断点回退到掩码允许的位置。无掩码时（MarkdownV2 / none）原样返回。 */
function retreat(
  boundary: number,
  breakable: readonly boolean[] | null,
): number {
  if (!breakable) return boundary;
  let at = boundary;
  while (at > 0 && !breakable[at]) at -= 1;
  return at;
}

function chooseBoundary(
  codepoints: readonly string[],
  limit: number,
  breakable: readonly boolean[] | null,
): number {
  const window = codepoints.slice(0, limit);
  // 断点只在码点数组上查找。String#lastIndexOf 返回的是 UTF-16 下标，一个 emoji 就使其比码点下标大 1；
  // 用它切分码点数组会导致 body 取不满而 remaining 多跳，中间一段直接丢失（实测 5001 码点丢失 1105 个，
  // docs/24 · R-TG-01）。boundary 因此恒 ≤ limit，不会切出超长的 part。
  const candidates = [
    lastIndexOfPair(window, "\n", "\n"),
    window.lastIndexOf("\n"),
    Math.max(
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
    ),
    window.lastIndexOf(" "),
  ].map((value) => retreat(value, breakable));
  const chosen =
    candidates.find((value) => value >= Math.floor(limit * 0.5)) ??
    retreat(limit, breakable);
  // 无法继续回退时（单个标签就超过整片长度，例如数千字符的 URL）执行硬切。被切坏的标签会让
  // Telegram 报解析失败，而 `sendWithFallback` 会降级为纯文本，消息仍能送达；死循环才是不可接受的。
  return chosen > 0 ? chosen : limit;
}

/**
 * 按 `maxMessageChars` 分片。渲染发生在分片之前（转义会使长度翻倍，按源文本切分无法保证渲染后不超
 * 上限），因此每个档位都要识别各自不可切分的构造，见 docs/08 §5.3.4 的对照表。
 */
export function splitTelegramText(
  text: string,
  max = 3900,
  parseMode: ParseMode = "MarkdownV2",
): string[] {
  // `none` 只剔除 NUL（正文中的 NUL 无显示意义），其余原样保留：该档位的语义就是不修改文本。
  const rendered =
    parseMode === "none"
      ? text.replaceAll("\u0000", "")
      : parseMode === "HTML"
        ? safeRenderHtml(text)
        : safeRender(text);
  const sealer =
    parseMode === "HTML"
      ? sealHtml
      : parseMode === "MarkdownV2"
        ? sealMarkdown
        : null;
  // MarkdownV2 的收尾长度是定值（`\n``` `），预留后可一次切成；HTML 的收尾长度取决于切口处打开了哪些
  // 标签，一律不预留，改由下面的重试按实际超出量回退。曾按最坏情况（白名单中所有标签都打开 = 59 字符）
  // 悲观预留过一版：`maxMessageChars` 设为 100 时窗口只剩 41，连一个 `<a href="…">` 都放不下，
  // `retreat` 回退到 0 后硬切，把标签切成两半，正是本段要防止的情况（4000 轮随机用例实测）。
  const reserve = parseMode === "MarkdownV2" ? 4 : 0;
  const parts: string[] = [];
  let remaining = [...rendered];
  let seal: Seal = NO_SEAL;
  // 条件中要计入重开前缀的长度：`remaining.length <= max` 只说明正文装得下，而最后一片还要拼上前缀。
  // 不计入时最后一片会超出上限（MarkdownV2 最多超 4 个字符，HTML 可超出一整条 URL），
  // 而超长属于长度错误而非解析失败，`sendWithFallback` 兜不住，Telegram 直接返回 message is too long。
  while ([...seal.prefix].length + remaining.length > max) {
    const breakable = parseMode === "HTML" ? htmlBreakable(remaining) : null;
    // 前缀一旦决定携带就必须贯彻到底。曾尝试「装不下就放弃重开」，该做法是错的：不重开的那一片是
    // 纯文本没有问题，但后续流中仍会出现对应的 `</b>`，它会变成下一片开头一个无配对的闭合标签
    // （4000 轮随机用例才复现，因为按片统计开闭数量的弱判据看不出孤立闭合标签）。
    // 唯一例外是前缀自身超过整片长度：此时无论如何都带不进去，而该档位的标签本就已被硬切。
    const prefix = [...seal.prefix].length < max ? seal.prefix : "";
    let limit = Math.max(1, max - [...prefix].length - reserve);
    let boundary = 0;
    let body = "";
    let next: Seal = NO_SEAL;
    for (;;) {
      boundary = chooseBoundary(remaining, limit, breakable);
      body = remaining.slice(0, boundary).join("").trimEnd();
      next = sealer ? sealer(prefix + body) : NO_SEAL;
      const size =
        [...prefix].length + [...body].length + [...next.suffix].length;
      if (size <= max || boundary <= 1) break;
      // 收尾长度超出预期（切口落在嵌套中，闭合链比上一轮更深）：把断点前移超出的量后重试。
      // limit 单调下降，因此必然收敛。
      limit = Math.max(1, limit - (size - max));
    }
    // 到此仍超上限，只可能是前缀几乎占满整片（实测 96 字符的 `<a href="…">` 配 `maxMessageChars: 100`：
    // 每片都是前缀 + 1 个字 + 闭合 = 101 字符，既超上限又永远切不完）。
    // 该档位宁可丢失格式也不能超上限：超长会被 Telegram 以 message is too long 直接拒绝，而
    // `sendWithFallback` 只能兜住解析失败；标签不成对至少还能降级为纯文本把内容发出去。
    if (
      prefix &&
      [...prefix].length + [...body].length + [...next.suffix].length > max
    ) {
      next = sealer ? sealer(body) : NO_SEAL;
      parts.push(`${body}${next.suffix}`);
    } else parts.push(`${prefix}${body}${next.suffix}`);
    remaining = remaining.slice(boundary);
    while (remaining[0]?.trim() === "") remaining.shift();
    seal = next;
  }
  // 前缀能装下由上面的 while 条件保证，因此这里直接拼接。
  if (remaining.length) parts.push(`${seal.prefix}${remaining.join("")}`);
  return parts;
}

/**
 * 把渲染结果反推回纯文本。解析失败降级时使用它，而不是把渲染结果原样按纯文本发送：后者在
 * MarkdownV2 下是满屏 `\-`，在 HTML 下更糟，用户会直接看到 `<b>` 标签。`sendWithFallback` 承诺的是
 * 「丢掉格式、保住消息」，因此必须真的只丢格式。
 */
export function toPlainText(rendered: string, parseMode: ParseMode): string {
  if (parseMode === "none") return rendered;
  if (parseMode === "HTML") {
    // 链接的 URL 需单独提取：一律剥离标签会连同内容一起丢失，那是丢信息而非丢格式。
    return (
      rendered
        .replace(
          /<a href="([^"]*)">(.*?)<\/a>/gs,
          (_whole, href: string, label: string) => `${label} (${href})`,
        )
        // 只剥离完整标签。被硬切开的半截标签（以 `<a href="…` 结尾、以 `…">` 开头）刻意保留：
        // 它出现在「单个构造超过整片长度」的档位，而该档位中 `<a href="` 后面跟的就是那条长 URL 本身。
        // 曾尝试一并清除这两个半截，代价是把 URL 也吃掉；少几个字面尖括号远不如保住消息内容重要。
        .replace(/<[^>]*>/g, "")
        // 解码顺序与 `escapeHtml` 的转义顺序相反，`&amp;` 放在最后，否则 `&amp;lt;` 会被解成 `<`。
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&")
    );
  }
  return rendered.replace(/\\([\\_*[\]()~`>#+\-=|{}.!])/g, "$1");
}

/**
 * 分片的两组结果：`rendered[i]` 是实际发送的内容，`archived[i]` 是写入 `messages.text` 的内容。
 * 两个数组等长，出站路径按下标把 `message_id` 与文本对应起来。
 */
export interface TelegramSegments {
  rendered: string[];
  archived: string[];
}

/**
 * 分片并生成逐段的归档文本（docs/28 · L-TG-03）。
 *
 * 此前三条出站路径都为每一段存储完整全文：一条 9469 字的回复切成 3 条后，`messages` 三行各 9469 字、
 * head/tail 完全相同，`messages_fts` 同样是三份，导致 `search_messages` 把同一条回复搜出三次、
 * 归档体积按分段数翻倍。上下文侧一直是正确的：`context_messages` 只存一条完整全文。
 *
 * 归档存储的是渲染前的正文（`safeRender` 产生的 MarkdownV2 转义符不应入库，否则 WebUI 会话页与
 * `read_messages` 看到的 bot 发言会带一串 `\-` `\.`）。而渲染发生在分片之前，分片点是渲染后码点数组
 * 上的下标，无法反推回源文本下标：转义、`###` 降级为粗体、列表符号替换、表格转入围栏，都不是可逆的
 * 1:1 映射。因此：
 *
 * - 只有一片（绝大多数消息）：该片即整条源文本，`archived` 直接取源文本，口径完全一致。
 * - 确实切分了：按 `toPlainText` 逐段反推。它是 `sendWithFallback` 解析失败降级时实际发送的内容，
 *   同样不含转义符。代价是若干标记形态会被归一（`**粗**` → `*粗*`、`- 项` → `• 项`），换来的是每段
 *   只存储自身内容。近似的是字面形态，而非段与 `message_id` 的对应关系。
 */
export function segmentTelegramText(
  text: string,
  max = 3900,
  parseMode: ParseMode = "MarkdownV2",
): TelegramSegments {
  const rendered = splitTelegramText(text, max, parseMode);
  return {
    rendered,
    archived:
      rendered.length > 1
        ? rendered.map((part) => toPlainText(part, parseMode))
        : rendered.map(() => text),
  };
}
