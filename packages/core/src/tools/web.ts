import { untrusted } from "@luoli/shared";
import { guardedFetch } from "../net/outbound.js";
import { abortablePause, retryDelay } from "../provider/store.js";

/**
 * 单次尝试的墙钟上限与瞬时失败的重试次数。两条都必须有：
 * - 没有 `timeoutMs`，一个黑洞地址就能把整轮对话挂到 `turnTimeoutMs`（10 分钟）为止；
 * - 没有 `retries`，一次 502 / TCP 重置就直接变成 `ok:false` 交给模型，而模型通常只会换个说法
 *   再调一次（每次都要重付一遍上下文），或者干脆放弃并告诉用户「取不到」。
 * 只有这两个**幂等的读工具**能这么重试：写工具重试等于重复副作用（docs/05 §8.1）。
 */
export interface WebRetryOptions {
  timeoutMs: number;
  retries: number;
}
export const DEFAULT_WEB_RETRY: WebRetryOptions = {
  timeoutMs: 15_000,
  retries: 2,
};
// 网页侧的瞬时故障（网关 502、限流、TCP 重置）是秒级恢复的，没必要按 provider 那套 1s→30s 的
// 节奏等：一轮对话的墙钟预算比一次上游调用紧得多。抖动仍复用 retryDelay（真随机，docs/20 · W-PROV-01）。
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 4000;
/** 再试一百次也是同一个结果的错误：语义性拒绝、地址不合法、重定向环。原样抛给注册表转成 ok:false。 */
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
  // URL 解析失败抛的是 TypeError（`new URL()`）；重试它只是在重复同一个拼写错误。
  return (
    error instanceof TypeError ||
    (error instanceof Error && FATAL_ERRORS.has(error.message))
  );
}
/** 站点自己答的 4xx 是「答案」，原样交给模型；只有这几类是「这一次没打通」。 */
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
 * 从**已被 `>` 界定的**标签体里读一个属性值。三种写法都认：双引号、单引号、裸值。
 *
 * 代价与这一个标签的长度线性相关，所有标签之和仍与输入线性相关 —— 这是能加属性解析的前提
 * （见 `extractHtml` 的注释）。刻意不用正则：属性值里可以有任意字符，而带回溯的形状在
 * 不可信输入上就是下一个 R-SEC-01。
 *
 * 名字前面必须是空白，否则 `data-href` 会命中 `href`、`srcset` 会命中 `src`。
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
 * 相对地址解析成绝对地址。**不解析就等于没给**：模型拿到 `/about` 没法再 `web_fetch` 一次。
 * 解析失败交回原样（一个相对路径也比什么都没有好）；`javascript:` / `data:` 一律丢掉 ——
 * 前者对模型无意义，后者能有几十 KB，够把输出预算吃光。
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
 * 一份抽取里最多交出多少个 URL。导航密集的页面（门户、文档站侧栏）光链接就能几千条，
 * 不设上限的话「保住链接」会把 `tools.maxOutputBytes`（64KB）整个吃光，正文反而又没了 ——
 * 那正是 docs/26 · B-4 要修的病。到顶之后只保留锚文本，并把省掉的条数交给模型。
 */
const LINK_BUDGET = 200;
/** markdown 的 `[]()` 结构不能被链接文字自己顶开，所以 alt / 标题里的方括号一律去掉。 */
function inline(value: string): string {
  return value
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ExtractedHtml {
  /** `<title>` 的内容；`head` 整棵被丢，所以它此前永远到不了模型。没有就是 `null`。 */
  title: string | null;
  text: string;
  /** 真正写进正文的 URL 条数（链接 + 图片）。 */
  links: number;
  /** 撞上 `LINK_BUDGET` 之后被省掉的 URL 条数。要交出去，否则模型以为页面上就这么几个链接。 */
  linksOmitted: number;
}
/**
 * HTML → 带链接与图片标记的正文。此前 `web_fetch` 把整份 HTML 原样交给模型，而一个普通页面
 * 九成是 script / style / 导航 —— 按 `tools.maxOutputBytes`（64KB）截断之后经常连正文的第一段
 * 都没进去，模型于是「取回来了但什么也没读到」（docs/05 §3.6 要的是「转 markdown」这一步）。
 *
 * 抽成纯文本之后还剩三处在丢东西，都是「模型看不见页面上明明有的东西」：
 *
 * - **`<title>`**：`head` 整棵在 `DROP_TAGS` 里（meta / link / script 确实都是噪声），标题跟着
 *   一起没了。它是一整页里信息密度最高的一行，单独认一次。
 * - **`<a href>`**：只留锚文本不留地址，模型没法顺着页面往下走，只能退回 `web_search` 再搜一遍。
 * - **`<img>`**：`img` 既不在 `DROP_TAGS` 也不在 `BLOCK_TAGS`，扫到它一个字都不 push —— alt 与
 *   src 一起消失，模型连「这里有张图」都不知道，更不可能决定要不要再取一次。
 *
 * 刻意不用正则拼这件事：输入是最多 `maxResponseBytes`（2MB）的不可信文本，而
 * `<script[^>]*>[\s\S]*?<\/script>` 这类形状在「一堆开标签、没有闭标签」的输入上是 O(n²)
 * 回溯 —— 与 docs/24 · R-SEC-01（grep 换 RE2）同一条教训：接受任意输入就必须有线性上界。
 * 单趟扫描没有这个问题，代价是它不是 DOM，只是「取标签之间的字，块级标签处换行」。
 * **加进来的属性解析不破坏这条**：`attribute` 只在当前那个已被 `>` 界定的 `tag` 子串里扫。
 *
 * 已知取舍：`tag` 以第一个 `>` 为界，所以 `<a href="a>b">` 会被切错。这是扫描器一开始就有的
 * 行为（不是 DOM），换成正确处理等于要认引号状态机 —— 而它的输入是任意不可信文本。
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
  /** 当前 `<a>` 的地址，`</a>` 时补上 `](url)`。嵌套 `<a>` 是非法 HTML，不为它留栈。 */
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
    // 未闭合的 `<`：后面整段都不是可信的标签结构，停在这里比把半个页面的属性倒出来好。
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
      // `<title>` 嵌在被丢弃的 `head` 里面，走不到下面那条 `DROP_TAGS` 分支 —— 在这里单独认一次。
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
      // 上限之内才开括号：开了却没地址填，模型看到的就是一个没有闭合的 `[`。
      if (href && spend()) {
        out.push("[");
        pendingHref = href;
      }
      continue;
    }
    if (name === "img" && !closing) {
      const alt = inline(attribute(tag, "alt") ?? "");
      // `data-src` 是懒加载站点的常规写法，真 `src` 那里往往只有一个占位图。
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
  // 没闭合的 `<a>`：那个 `[` 已经写出去了，不补上等于交一个坏掉的 markdown。
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
/** `content-type` 缺失或撒谎的站点不少，所以类型头之外再看正文开头长什么样。 */
function looksLikeHtml(contentType: string, body: string): boolean {
  if (/^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType))
    return true;
  return !contentType && /^\s*<(!doctype\s+html|html[\s>])/i.test(body);
}
/** 能当字符串交给模型的类型。`+json` / `+xml` 后缀族（`application/ld+json` 之类）一起收。 */
const TEXTUAL_TYPE =
  /^(text\/|application\/(json|xml|javascript|ecmascript|x-ndjson|x-www-form-urlencoded|xhtml\+xml)|application\/[a-z0-9.-]*\+(json|xml))/i;
/**
 * `content-type` 缺失时的兜底：这份字节到底能不能当 utf8 读。
 *
 * 判据是 NUL 字节与替换字符占比 —— 二进制被 `toString('utf8')` 读过之后满是 U+FFFD，而任何
 * 真实文本里一个都不该有。只看头 4KB：这是「能不能当文本」的判断，不需要读完 2MB。
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
 * 这份响应该按哪一档交给模型。抽成纯函数是为了能在**不出网**的情况下穷举它 ——
 * `webFetch` 自己写死 `allowPrivate: false`，放行路径在测试里一次都跑不到（`tests/web.test.ts`
 * 开头那条注释说的就是这件事），而分档错了的表现正是「2MB 乱码进了上下文」。
 *
 * 判据顺序是刻意的：`content-type` 说了话就信它（撒谎的站点最多让 HTML 走 `text` 档，仍可读），
 * 一个字都没说时才去看字节长什么样。
 */
export function classifyResponse(
  contentType: string,
  body: Buffer,
): "html" | "text" | "image" | "binary" {
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType.startsWith("image/")) return "image";
  // 只嗅头 1KB：`<!doctype html>` 就在开头，为一次判断把 2MB 转成字符串是白花的。
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
 * 重试骨架。「这一次算不算值得再试」由调用方判（错误分类是每个工具自己的事），退避、可中断的
 * 等待、以及**耗尽之后交回什么**只写一遍：耗尽时给的是结构化失败而不是抛异常，因为模型需要
 * 知道「试了几次、卡在哪一步」才能决定是换个 URL 还是如实告诉用户取不到。
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
 * 搜索请求**也走 `guardedFetch`** —— 这里此前是全仓库唯一一条裸 `fetch`，而它带着搜索 API key
 * （`x-subscription-token` / `x-api-key`）：undici 的 fetch 只按规范摘 `Authorization` / `Cookie` /
 * `Proxy-Authorization`，自定义认证头会跟着 302 原样送到新主机，同时没有 SSRF 策略、没有响应体
 * 上界（`response.json()` 全收）。目标域名是常量，所以这是纵深防御缺口而不是可直接利用的漏洞，
 * 但代价是一个 302 就能带走搜索 key（docs/27 · S-04）。
 *
 * **`maxRedirects: 0`**：搜索 API 不需要重定向，一次 3xx 就该当异常而不是跟过去。
 */
export type SearchProvider = "brave" | "serper" | "tavily" | "exa";
/**
 * 四家搜索 API 的差异**全在这两个函数里**：打哪个地址、认证头叫什么、请求体怎么写、结果数组藏在
 * 哪个键下面。抽出来是为了能在不出网的情况下断言它 —— 加一家 provider 时错的正是这四件事，
 * 而错了的表现是「搜索永远返回 0 条」或「key 送不上去」，两者都要真打一次上游才看得见。
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
  // exa 不带 `contents` 时每条只有 title/url/publishedDate —— 那要模型对每一条再 web_fetch 一次才
  // 知道值不值得看。`highlights` 给的是命中片段，与 brave 的 description / serper 的 snippet 对齐；
  // 全文（`contents.text`）刻意不要：按页计费，且十条正文足以顶掉半个上下文窗口。
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
/** 结果数组的位置：brave 在 `web.results`、serper 在 `organic`，tavily 与 exa 都在 `results`。 */
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
        // 拒绝类错误（重定向、协议、SSRF）再试三次也是同一个结果。与 `webFetch` 不同的是这里
        // **不往上抛**：搜索失败是要交给模型读的一句话，不是 SSRF 断言依赖的「不许去」。
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
      hint: `已重试 ${options.retries} 次仍未取到搜索结果（${failure}）；换个说法或稍后再试，不要立刻重复调用。`,
    }),
  );
}

/**
 * 抓回来的图片交给谁。**给了才走图片路径** —— 没给（子 agent、测试、没有能看图的别名）时
 * `web_fetch` 只报类型与大小，不假装读到了内容。实现见 `media/web-assets.ts`。
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
 * 拒绝类错误照旧抛给注册表（它统一转成 `ok:false`）—— SSRF 那组断言依赖「不合法的目标一律抛」，
 * 而重试耗尽走的是结构化失败：一个是「不许去」，另一个是「去了三次没通」。
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
        // 用户取消或整轮超时：这不是「上游抖了一下」，重试只会拖着一个已经没人等的轮次。
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
       * **按类型分流，而不是无条件 `toString('utf8')`。** 那一行对 `image/png` 之类产出的是最多
       * 2MB 乱码，再被 `tools.maxOutputBytes`（64KB）截断塞进上下文 —— 比「取不到」更糟，整个
       * 工具输出预算烧在噪声上，而模型还以为自己读到了页面。
       */
      const kind = classifyResponse(contentType, response.body);
      if (kind === "image") {
        // 截断的图就是坏图（`guardedFetch` 撞上 `maxResponseBytes` 会截）。不存、不假装，如实说。
        if (response.truncated)
          return {
            done: {
              ...head,
              ok: false,
              kind,
              mediaType,
              bytes,
              error: "image_truncated",
              hint: `图片超过 ${maxBytes} 字节被截断，截断的图片解不出来；换一张更小的，或让运维调 tools.web.maxResponseBytes。`,
            },
          };
        const captured = media
          ? await media.capture({
              url: response.url,
              mediaType,
              body: response.body,
            })
          : null;
        // `media` 由 `ToolRegistry.#normalizeOutput` 在序列化之前摘走，再由 `toolModelOutput`
        // 变成多模态 tool-result 交给 provider —— 本步就能看到。跨轮那一份靠已经注入的
        // `webasset://` 顶层 part，所以这里的 base64 不会落进 `parts_json`。
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
              note: "图片已放进本轮上下文，直接看即可。",
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
              "这是一张图片，当前没有能看图的模型，所以只报了它的类型与大小 —— 不要猜它画的是什么。",
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
            hint: "这不是文本，没有正文可读 —— 不要猜它的内容。要看的话换一个返回 HTML / JSON / 纯文本的地址。",
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
          // `extracted` 要交出去：模型看到的是抽取后的正文，不知道这一点它会以为页面上就没有那些
          // 表格和脚本里的数据，而不是「这里只给了正文」。
          extracted: "text" as const,
          ...(page.title ? { title: page.title } : {}),
          // 撞上链接上限同样要说：不说的话模型以为页面上就这么几个链接。
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
      hint: `已重试 ${options.retries} 次仍未取回内容（${failure}）；换个 URL 或稍后再试，不要立刻重复调用同一个地址。`,
    }),
  );
}
