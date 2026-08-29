import { untrusted } from "@luoli/shared";
import { guardedFetch } from "../net/outbound.js";
import { abortablePause, retryDelay } from "../provider/store.js";

/**
 * 单次尝试的墙钟上限与瞬时失败的重试次数。两者缺一不可：
 * - 没有 `timeoutMs` 时，一个无响应地址即可使整轮对话阻塞至 `turnTimeoutMs`（10 分钟）；
 * - 没有 `retries` 时，一次 502 或 TCP 重置会直接转为 `ok:false` 返回给模型，而模型通常只会
 *   换一种表述再调用一次（每次都需重新支付上下文成本），或直接放弃并告知用户无法获取。
 * 只有这两个幂等的读取工具可以这样重试：写入工具重试等同于重复产生副作用（docs/05 §8.1）。
 */
export interface WebRetryOptions {
  timeoutMs: number;
  retries: number;
}
export const DEFAULT_WEB_RETRY: WebRetryOptions = {
  timeoutMs: 15_000,
  retries: 2,
};
// 网页侧的瞬时故障（网关 502、限流、TCP 重置）通常在秒级恢复，无需采用 provider 的 1s→30s
// 节奏：一轮对话的墙钟预算远比一次上游调用紧张。抖动仍复用 retryDelay（真随机，docs/20 · W-PROV-01）。
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 4000;
/** 重试无法改变结果的错误：语义性拒绝、地址非法、重定向环。原样抛给注册表转为 ok:false。 */
const FATAL_ERRORS = new Set([
  "unsupported_protocol",
  "port_blocked",
  "ssrf_blocked",
  "too_many_redirects",
  "redirect_error",
  "unsupported_request_body",
]);

function errorCode(error: unknown): string {
  if (error instanceof Error)
    return error.name === "TimeoutError" || error.name === "AbortError"
      ? "web_timeout"
      : error.message.slice(0, 200);
  return "web_error";
}
function fatal(error: unknown): boolean {
  // URL 解析失败抛出的是 TypeError（`new URL()`）；重试只是重复同一个拼写错误。
  return (
    error instanceof TypeError ||
    (error instanceof Error && FATAL_ERRORS.has(error.message))
  );
}
/** 站点返回的 4xx 属于有效响应，原样交给模型；只有以下几类表示本次未连通。 */
function retriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
function retryAfterMs(
  headers: Record<string, string | string[] | undefined>,
): number | null {
  const raw = headers["retry-after"];
  const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, RETRY_MAX_MS)
    : null;
}

const DROP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
  "iframe",
  "object",
  "canvas",
  "audio",
  "video",
  "title",
]);
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
  "blockquote",
  "pre",
  "table",
  "thead",
  "tbody",
  "ul",
  "ol",
  "dl",
  "dd",
  "dt",
  "main",
  "nav",
  "aside",
  "form",
  "figure",
  "figcaption",
  "hr",
]);
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
};
function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,10});/g,
    (all, body: string) => {
      if (!body.startsWith("#")) return ENTITIES[body.toLowerCase()] ?? all;
      const hex = body.startsWith("#x") || body.startsWith("#X");
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10_ff_ff
        ? String.fromCodePoint(code)
        : all;
    },
  );
}
/**
 * 从已由 `>` 界定的标签体中读取一个属性值。支持三种写法：双引号、单引号、无引号裸值。
 *
 * 开销与该标签的长度线性相关，所有标签之和仍与输入长度线性相关 —— 这是可以加入属性解析的前提
 * （见 `extractHtml` 的注释）。刻意不使用正则：属性值可包含任意字符，而带回溯的模式在
 * 不可信输入上会构成下一个 R-SEC-01。
 *
 * 属性名之前必须是空白，否则 `data-href` 会命中 `href`、`srcset` 会命中 `src`。
 */
function attribute(tag: string, name: string): string | null {
  const lower = tag.toLowerCase();
  let at = 0;
  while (at < lower.length) {
    const found = lower.indexOf(name, at);
    if (found < 0) return null;
    at = found + name.length;
    if (found > 0 && !/\s/.test(lower[found - 1]!)) continue;
    let cursor = at;
    while (cursor < tag.length && /\s/.test(tag[cursor]!)) cursor += 1;
    if (tag[cursor] !== "=") continue;
    cursor += 1;
    while (cursor < tag.length && /\s/.test(tag[cursor]!)) cursor += 1;
    const quote = tag[cursor];
    if (quote === '"' || quote === "'") {
      const close = tag.indexOf(quote, cursor + 1);
      return close < 0 ? tag.slice(cursor + 1) : tag.slice(cursor + 1, close);
    }
    let stop = cursor;
    while (stop < tag.length && !/\s/.test(tag[stop]!)) stop += 1;
    return tag.slice(cursor, stop);
  }
  return null;
}
/**
 * 将相对地址解析为绝对地址。不解析等同于未提供：模型拿到 `/about` 无法再次执行 `web_fetch`。
 * 解析失败时返回原值（相对路径也优于没有）；`javascript:` 与 `data:` 一律丢弃 ——
 * 前者对模型没有意义，后者可达数十 KB，足以耗尽输出预算。
 */
function resolveUrl(raw: string | null, baseUrl?: string): string | null {
  const value = raw?.trim();
  if (
    !value ||
    value.startsWith("#") ||
    /^(javascript|data|vbscript):/i.test(value)
  )
    return null;
  if (!baseUrl) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}
/**
 * 单次抽取最多输出的 URL 数量。导航密集的页面（门户、文档站侧栏）仅链接就可达数千条，
 * 不设上限时保留链接会耗尽 `tools.maxOutputBytes`（64KB），导致正文反而缺失 ——
 * 那正是 docs/26 · B-4 要解决的问题。达到上限后只保留锚文本，并将省略的条数返回给模型。
 */
const LINK_BUDGET = 200;
/** markdown 的 `[]()` 结构不能被链接文字本身破坏，因此 alt 与标题中的方括号一律移除。 */
function inline(value: string): string {
  return value
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ExtractedHtml {
  /** `<title>` 的内容；`head` 整体被丢弃，因此它此前无法传递给模型。不存在时为 `null`。 */
  title: string | null;
  text: string;
  /** 实际写入正文的 URL 条数（链接与图片之和）。 */
  links: number;
  /** 触及 `LINK_BUDGET` 后被省略的 URL 条数。必须返回，否则模型会认为页面上只有这些链接。 */
  linksOmitted: number;
}
/**
 * 将 HTML 转换为带链接与图片标记的正文。此前 `web_fetch` 将整份 HTML 原样交给模型，而普通页面
 * 九成内容是 script / style / 导航 —— 按 `tools.maxOutputBytes`（64KB）截断后常常连正文第一段
 * 都未包含，导致模型抓取成功却读不到内容（docs/05 §3.6 要求的正是转换为 markdown 这一步）。
 *
 * 抽取为纯文本后仍有三处信息丢失，均表现为模型看不到页面上确实存在的内容：
 *
 * - `<title>`：`head` 整体位于 `DROP_TAGS` 中（meta / link / script 确属噪声），标题随之丢失。
 *   它是整页中信息密度最高的一行，需单独识别。
 * - `<a href>`：只保留锚文本而丢弃地址，模型无法沿页面继续访问，只能退回 `web_search` 重新检索。
 * - `<img>`：`img` 既不在 `DROP_TAGS` 也不在 `BLOCK_TAGS`，扫描到它时不输出任何内容 —— alt 与
 *   src 一并消失，模型无从得知此处存在图片，更无法决定是否再次获取。
 *
 * 刻意不使用正则实现：输入是最长 `maxResponseBytes`（2MB）的不可信文本，而
 * `<script[^>]*>[\s\S]*?<\/script>` 这类模式在大量开标签而无闭标签的输入上是 O(n²)
 * 回溯 —— 与 docs/24 · R-SEC-01（grep 改用 RE2）教训相同：接受任意输入就必须保证线性上界。
 * 单趟扫描没有该问题，代价是它不是 DOM，只做取标签之间的文本、在块级标签处换行。
 * 新增的属性解析不破坏该性质：`attribute` 只在当前已由 `>` 界定的 `tag` 子串内扫描。
 *
 * 已知取舍：`tag` 以第一个 `>` 为界，因此 `<a href="a>b">` 会被错误切分。这是扫描器自始就有的
 * 行为（它不是 DOM），改为正确处理需引入引号状态机 —— 而其输入是任意不可信文本。
 */
export function extractHtml(html: string, baseUrl?: string): ExtractedHtml {
  const out: string[] = [];
  let index = 0;
  let dropping: string | null = null;
  let title = "";
  let inTitle = false;
  let titleDone = false;
  let links = 0;
  let linksOmitted = 0;
  /** 当前 `<a>` 的地址，遇到 `</a>` 时补上 `](url)`。嵌套 `<a>` 属非法 HTML，不为其维护栈。 */
  let pendingHref: string | null = null;
  const spend = (): boolean => {
    if (links >= LINK_BUDGET) {
      linksOmitted += 1;
      return false;
    }
    links += 1;
    return true;
  };
  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next < 0) {
      if (!dropping) out.push(html.slice(index));
      break;
    }
    if (!dropping && next > index) out.push(html.slice(index, next));
    else if (inTitle && next > index) title += html.slice(index, next);
    if (html.startsWith("<!--", next)) {
      const close = html.indexOf("-->", next + 4);
      index = close < 0 ? html.length : close + 3;
      continue;
    }
    const end = html.indexOf(">", next);
    // 未闭合的 `<`：其后整段都不是可信的标签结构，在此停止优于输出半个页面的属性内容。
    if (end < 0) break;
    const tag = html.slice(next + 1, end);
    index = end + 1;
    const name = /^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name) continue;
    const closing = tag.startsWith("/");
    if (dropping) {
      if (closing && name === dropping) {
        dropping = null;
        if (inTitle) {
          inTitle = false;
          titleDone = true;
        }
      }
      // `<title>` 位于被丢弃的 `head` 内部，无法进入下方的 `DROP_TAGS` 分支 —— 在此单独识别一次。
      else if (name === "title" && !titleDone) {
        if (closing) {
          inTitle = false;
          titleDone = true;
        } else inTitle = true;
      }
      continue;
    }
    if (!closing && DROP_TAGS.has(name)) {
      if (name === "title" && !titleDone) inTitle = true;
      if (!tag.trimEnd().endsWith("/")) dropping = name;
      continue;
    }
    if (name === "a") {
      if (closing) {
        if (pendingHref) {
          out.push(`](${pendingHref})`);
          pendingHref = null;
        }
        continue;
      }
      const href = resolveUrl(attribute(tag, "href"), baseUrl);
      // 只有在上限之内才输出左括号：输出后无地址可填时，模型看到的是一个未闭合的 `[`。
      if (href && spend()) {
        out.push("[");
        pendingHref = href;
      }
      continue;
    }
    if (name === "img" && !closing) {
      const alt = inline(attribute(tag, "alt") ?? "");
      // `data-src` 是懒加载站点的常见写法，真实 `src` 位置往往只有一张占位图。
      const src = resolveUrl(
        attribute(tag, "src") ?? attribute(tag, "data-src"),
        baseUrl,
      );
      if (src && spend()) out.push(` ![${alt}](${src}) `);
      else if (alt) out.push(` [图：${alt}] `);
      continue;
    }
    if (name === "br") out.push("\n");
    else if (name === "li" && !closing) out.push("\n- ");
    else if (BLOCK_TAGS.has(name)) out.push("\n\n");
  }
  // 未闭合的 `<a>`：`[` 已经输出，不补全等于返回一份格式损坏的 markdown。
  if (pendingHref) out.push(`](${pendingHref})`);
  const tidy = (value: string): string =>
    decodeEntities(value)
      .replaceAll("\r", "")
      .replace(/[^\S\n]+/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return {
    title: title.trim() ? inline(tidy(title)) : null,
    text: tidy(out.join("")),
    links,
    linksOmitted,
  };
}
/** `content-type` 缺失或不准确的站点较多，因此在类型头之外还需检查正文开头的特征。 */
function looksLikeHtml(contentType: string, body: string): boolean {
  if (/^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType))
    return true;
  return !contentType && /^\s*<(!doctype\s+html|html[\s>])/i.test(body);
}
/** 可作为字符串交给模型的类型。`+json` / `+xml` 后缀族（如 `application/ld+json`）一并接受。 */
const TEXTUAL_TYPE =
  /^(text\/|application\/(json|xml|javascript|ecmascript|x-ndjson|x-www-form-urlencoded|xhtml\+xml)|application\/[a-z0-9.-]*\+(json|xml))/i;
/**
 * `content-type` 缺失时的兜底判定：该字节序列能否按 utf8 读取。
 *
 * 判据是 NUL 字节与替换字符的占比 —— 二进制数据经 `toString('utf8')` 读取后会出现大量 U+FFFD，
 * 而真实文本中不应出现。只检查前 4KB：这是能否作为文本的判定，无需读完 2MB。
 */
function looksBinary(body: Buffer): boolean {
  const sample = body.subarray(0, 4096);
  if (sample.includes(0)) return true;
  const text = sample.toString("utf8");
  if (!text.length) return false;
  let bad = 0;
  for (const char of text) if (char === "�") bad += 1;
  return bad / text.length > 0.1;
}
/**
 * 判定该响应应按哪一档交给模型。抽取为纯函数是为了在不出网的情况下穷举测试它 ——
 * `webFetch` 内部写死 `allowPrivate: false`，放行路径在测试中无法执行（`tests/web.test.ts`
 * 开头的注释即说明此事），而分档错误的表现正是 2MB 乱码进入上下文。
 *
 * 判据顺序是刻意的：`content-type` 提供了信息即采信它（不准确的站点最多使 HTML 走 `text` 档，
 * 仍可读），完全没有信息时才检查字节特征。
 */
export function classifyResponse(
  contentType: string,
  body: Buffer,
): "html" | "text" | "image" | "binary" {
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType.startsWith("image/")) return "image";
  // 只检测前 1KB：`<!doctype html>` 位于开头，为一次判定将 2MB 转为字符串是不必要的开销。
  if (!mediaType)
    return looksBinary(body)
      ? "binary"
      : looksLikeHtml("", body.subarray(0, 1024).toString("utf8"))
        ? "html"
        : "text";
  if (!TEXTUAL_TYPE.test(mediaType)) return "binary";
  return looksLikeHtml(mediaType, "") ? "html" : "text";
}

export type WebAttempt<T> = { done: T } | { retry: string; afterMs?: number };
/**
 * 重试骨架。本次是否值得重试由调用方判定（错误分类属各工具自身职责），退避、可中断的等待、
 * 以及重试耗尽后返回什么只实现一份：耗尽时返回结构化失败而非抛出异常，因为模型需要
 * 知道重试次数与失败环节，才能决定更换 URL 还是如实告知用户无法获取。
 */
export async function withWebRetries<T>(
  options: WebRetryOptions,
  abortSignal: AbortSignal,
  run: (attempt: number) => Promise<WebAttempt<T>>,
  exhausted: (failure: string, attempts: number) => T,
): Promise<T> {
  let failure = "web_unreachable";
  let wait: number | null = null;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (attempt)
      await abortablePause(
        wait ?? retryDelay(attempt - 1, null, RETRY_BASE_MS, RETRY_MAX_MS),
        abortSignal,
      );
    const outcome = await run(attempt);
    if ("done" in outcome) return outcome.done;
    failure = outcome.retry;
    wait = outcome.afterMs ?? null;
  }
  return exhausted(failure, options.retries + 1);
}

/**
 * 搜索请求同样走 `guardedFetch` —— 此处此前是全仓库唯一一处裸 `fetch`，且携带搜索 API key
 * （`x-subscription-token` / `x-api-key`）：undici 的 fetch 只按规范移除 `Authorization` / `Cookie` /
 * `Proxy-Authorization`，自定义认证头会随 302 原样发送到新主机，同时缺少 SSRF 策略与响应体
 * 上界（`response.json()` 全量接收）。目标域名是常量，因此这属于纵深防御缺口而非可直接利用的
 * 漏洞，但代价是一次 302 即可窃取搜索 key（docs/27 · S-04）。
 *
 * `maxRedirects: 0`：搜索 API 不需要重定向，一次 3xx 即应视为异常而不是跟随。
 */
export type SearchProvider = "brave" | "serper" | "tavily" | "exa";
/**
 * 四家搜索 API 的差异全部集中在这两个函数中：请求地址、认证头名称、请求体格式、结果数组所在
 * 的键。抽取出来是为了在不出网的情况下对其断言 —— 新增一家 provider 时出错的正是这四项，
 * 而出错的表现是搜索始终返回 0 条或 key 未送达，两者都需实际请求上游才能发现。
 */
export function searchRequest(
  provider: SearchProvider,
  apiKey: string,
  query: string,
  limit: number,
): {
  target: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
} {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (provider === "brave") {
    headers["x-subscription-token"] = apiKey;
    return {
      target: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
      method: "GET",
      headers,
    };
  }
  if (provider === "serper") {
    headers["x-api-key"] = apiKey;
    return {
      target: "https://google.serper.dev/search",
      method: "POST",
      headers,
      body: JSON.stringify({ q: query, num: limit }),
    };
  }
  // exa 不带 `contents` 时每条只有 title/url/publishedDate —— 模型需对每条再执行一次 web_fetch
  // 才能判断是否值得查看。`highlights` 提供命中片段，与 brave 的 description、serper 的 snippet
  // 对齐；全文（`contents.text`）刻意不请求：按页计费，且十条正文足以占用半个上下文窗口。
  if (provider === "exa") {
    headers["x-api-key"] = apiKey;
    return {
      target: "https://api.exa.ai/search",
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        numResults: limit,
        contents: { highlights: true },
      }),
    };
  }
  return {
    target: "https://api.tavily.com/search",
    method: "POST",
    headers,
    body: JSON.stringify({ api_key: apiKey, query, max_results: limit }),
  };
}
/** 结果数组的位置：brave 在 `web.results`，serper 在 `organic`，tavily 与 exa 均在 `results`。 */
export function searchResults(
  provider: SearchProvider,
  raw: Record<string, unknown>,
): unknown[] {
  const values =
    provider === "brave"
      ? (raw.web as { results?: unknown[] } | undefined)?.results
      : provider === "serper"
        ? raw.organic
        : raw.results;
  return Array.isArray(values) ? values : [];
}
export async function webSearch(
  provider: SearchProvider,
  apiKey: string,
  query: string,
  limit: number,
  abortSignal: AbortSignal,
  options: WebRetryOptions = DEFAULT_WEB_RETRY,
  maxBytes = 1_048_576,
): Promise<Record<string, unknown>> {
  if (!apiKey) return { ok: false, error: "web_search_key_missing" };
  const { target, method, headers, body } = searchRequest(
    provider,
    apiKey,
    query,
    limit,
  );
  return await withWebRetries<Record<string, unknown>>(
    options,
    abortSignal,
    async (attempt) => {
      let response;
      try {
        response = await guardedFetch(
          target,
          { method, headers, ...(body ? { body } : {}), signal: abortSignal },
          {
            allowPrivate: false,
            maxRedirects: 0,
            maxBytes,
            timeoutMs: options.timeoutMs,
          },
        );
      } catch (error) {
        if (abortSignal.aborted) throw error;
        // 拒绝类错误（重定向、协议、SSRF）重试三次结果相同。与 `webFetch` 不同之处在于此处
        // 不向上抛出：搜索失败是要交给模型阅读的说明，而非 SSRF 断言所依赖的访问拒绝信号。
        const code = errorCode(error);
        return fatal(error)
          ? { done: { ok: false, error: code } }
          : { retry: code };
      }
      if (!response.ok) {
        const failure = `search_http_${response.status}`;
        return retriableStatus(response.status)
          ? { retry: failure }
          : { done: { ok: false, error: failure } };
      }
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(response.body.toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        return {
          done: {
            ok: false,
            error: response.truncated
              ? "search_response_truncated"
              : "search_bad_json",
          },
        };
      }
      const values = searchResults(provider, raw);
      return {
        done: {
          ok: true,
          provider,
          ...(attempt ? { attempts: attempt + 1 } : {}),
          results: values.slice(0, limit),
          content: untrusted(`search:${provider}`, JSON.stringify(values)),
        },
      };
    },
    (failure, attempts) => ({
      ok: false,
      error: failure,
      attempts,
      hint: `已重试 ${options.retries} 次仍未取到搜索结果（${failure}）；请更换查询表述或稍后重试，不要立即重复调用。`,
    }),
  );
}

/**
 * 抓取到的图片的接收方。提供时才走图片路径 —— 未提供时（子 agent、测试、没有支持图像的别名）
 * `web_fetch` 只报告类型与大小，不伪装成已读取内容。实现见 `media/web-assets.ts`。
 */
export interface WebMediaSink {
  capture(input: { url: string; mediaType: string; body: Buffer }): Promise<
    | {
        ok: true;
        assetId: string;
        mediaType: string;
        data: string;
        width: number;
        height: number;
      }
    | { ok: false; error: string; hint: string }
  >;
}
/**
 * 拒绝类错误照常抛给注册表（由它统一转为 `ok:false`）—— SSRF 相关断言依赖非法目标一律抛出，
 * 而重试耗尽走结构化失败：前者表示访问被拒绝，后者表示尝试三次仍未连通。
 */
export async function webFetch(
  raw: string,
  maxBytes: number,
  abortSignal: AbortSignal,
  options: WebRetryOptions = DEFAULT_WEB_RETRY,
  hosts: { allowlist?: readonly string[]; denylist?: readonly string[] } = {},
  media?: WebMediaSink | null,
): Promise<Record<string, unknown>> {
  return await withWebRetries<Record<string, unknown>>(
    options,
    abortSignal,
    async (attempt) => {
      let response;
      try {
        response = await guardedFetch(
          raw,
          {
            method: "GET",
            signal: abortSignal,
            headers: { "user-agent": "LuoLiCore/0.1" },
          },
          {
            allowPrivate: false,
            maxBytes,
            timeoutMs: options.timeoutMs,
            ...(hosts.allowlist?.length ? { allowHosts: hosts.allowlist } : {}),
            ...(hosts.denylist?.length ? { denyHosts: hosts.denylist } : {}),
          },
        );
      } catch (error) {
        // 用户取消或整轮超时：这不属于上游瞬时故障，重试只会延长一个已无人等待的轮次。
        if (abortSignal.aborted || fatal(error)) throw error;
        return { retry: errorCode(error) };
      }
      if (retriableStatus(response.status)) {
        const advertised = retryAfterMs(response.headers);
        return {
          retry: `web_http_${response.status}`,
          ...(advertised === null ? {} : { afterMs: advertised }),
        };
      }
      const contentType = String(response.headers["content-type"] ?? "");
      const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
      const head = {
        ok: response.ok,
        status: response.status,
        url: response.url,
        ...(attempt ? { attempts: attempt + 1 } : {}),
      };
      const bytes = response.body.length;
      /**
       * 按类型分流，而不是无条件执行 `toString('utf8')`。后者对 `image/png` 之类产出最多
       * 2MB 乱码，再被 `tools.maxOutputBytes`（64KB）截断后进入上下文 —— 比获取失败更糟，
       * 整个工具输出预算消耗在噪声上，而模型仍认为自己读到了页面内容。
       */
      const kind = classifyResponse(contentType, response.body);
      if (kind === "image") {
        // 被截断的图片即损坏图片（`guardedFetch` 触及 `maxResponseBytes` 时会截断）。不存储、
        // 不伪装，如实说明。
        if (response.truncated)
          return {
            done: {
              ...head,
              ok: false,
              kind,
              mediaType,
              bytes,
              error: "image_truncated",
              hint: `图片超过 ${maxBytes} 字节被截断，被截断的图片无法解码；请改用体积更小的图片或由运维调整 tools.web.maxResponseBytes。`,
            },
          };
        const captured = media
          ? await media.capture({
              url: response.url,
              mediaType,
              body: response.body,
            })
          : null;
        // `media` 由 `ToolRegistry.#normalizeOutput` 在序列化之前摘除，再由 `toolModelOutput`
        // 转为多模态 tool-result 交给 provider —— 本步即可被模型看到。跨轮的那一份依靠已注入的
        // 顶层 `webasset://` part，因此此处的 base64 不会写入 `parts_json`。
        if (captured?.ok)
          return {
            done: {
              ...head,
              kind,
              mediaType: captured.mediaType,
              bytes,
              width: captured.width,
              height: captured.height,
              assetId: captured.assetId,
              note: "图片已加入本轮上下文，可直接查看。",
              media: [{ mediaType: captured.mediaType, data: captured.data }],
            },
          };
        return {
          done: {
            ...head,
            kind,
            mediaType,
            bytes,
            ...(captured ? { error: captured.error } : {}),
            hint:
              captured?.hint ??
              "这是一张图片，当前没有能看图的模型，因此仅报告其类型与大小 —— 不要推测其内容。",
          },
        };
      }
      if (kind === "binary") {
        return {
          done: {
            ...head,
            kind,
            ...(mediaType ? { mediaType } : {}),
            bytes,
            truncated: response.truncated,
            hint: "这不是文本，没有正文可读 —— 不要推测其内容。如需查看，请改用返回 HTML / JSON / 纯文本的地址。",
          },
        };
      }
      const body = response.body.toString("utf8");
      if (kind === "text")
        return {
          done: {
            ...head,
            kind,
            ...(mediaType ? { mediaType } : {}),
            content: untrusted(`web:${new URL(response.url).hostname}`, body),
            truncated: response.truncated,
          },
        };
      const page = extractHtml(body, response.url);
      return {
        done: {
          ...head,
          kind,
          // `extracted` 必须返回：模型看到的是抽取后的正文，不告知这一点它会认为页面上本就没有
          // 那些表格与脚本中的数据，而不是理解为此处只提供了正文。
          extracted: "text" as const,
          ...(page.title ? { title: page.title } : {}),
          // 触及链接上限同样要说明：不说明的话模型会认为页面上只有这几个链接。
          ...(page.linksOmitted ? { linksOmitted: page.linksOmitted } : {}),
          content: untrusted(
            `web:${new URL(response.url).hostname}`,
            page.text,
          ),
          truncated: response.truncated,
        },
      };
    },
    (failure, attempts) => ({
      ok: false,
      error: failure,
      attempts,
      hint: `已重试 ${options.retries} 次仍未取回内容（${failure}）；请更换 URL 或稍后重试，不要立即重复调用同一地址。`,
    }),
  );
}
