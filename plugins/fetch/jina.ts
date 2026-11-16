import { defaultUserAgents, FetchError, type Requester } from '../../src/plugin-api.js';

/** 怎么找 r.jina.ai：地址（后面直接接完整网址）与单次时限 */
export type JinaOptions = { reader: string; timeoutMs: number };

export const defaultJina: JinaOptions = { reader: 'https://r.jina.ai/', timeoutMs: 20_000 };

// 自报身份的 bot
const userAgent = defaultUserAgents[1]!;
const contentMarker = 'Markdown Content:';

/** r.jina.ai 读到的内容 */
export type JinaPage = {
  title?: string;
  content: string;
  /** 正文超过 5 MB 被截短 */
  truncated: boolean;
};

/**
 * 把网址交给 r.jina.ai（它会执行页面脚本）。不带 key，有单次时限（默认 20 秒）。
 * 状态非 200、有 CAPTCHA 警告、没有正文、超时或网络错误都算失败，返回 undefined；
 * 只有工具的中止信号触发时抛错（照原样往上传）
 */
export async function readViaJina(
  requester: Requester,
  { reader, timeoutMs }: JinaOptions,
  url: string,
  signal: AbortSignal,
): Promise<JinaPage | undefined> {
  let text: string;
  let truncated: boolean;
  try {
    const response = await requester.get(reader + url, {
      userAgent,
      headers: { accept: 'text/markdown' },
      timeoutMs,
      signal,
    });
    if (response.status !== 200) {
      await response.discard();
      return undefined;
    }
    ({ text, truncated } = await response.text());
  } catch (error) {
    if (error instanceof FetchError && error.kind === 'aborted') throw error;
    return undefined;
  }

  // 开头是 Title:、URL Source:、Warning: 等几行，正文在 Markdown Content: 之后；
  // 没有这一行时整个当正文
  const at = text.indexOf(contentMarker);
  const head = at === -1 ? text : text.slice(0, at);
  const content = (at === -1 ? text : text.slice(at + contentMarker.length)).trim();
  if (content === '' || /^Warning:.*captcha/im.test(head)) return undefined;
  const title = head.match(/^Title:[ \t]*(.*)$/m)?.[1]?.trim() || undefined;
  return { title, content, truncated };
}
