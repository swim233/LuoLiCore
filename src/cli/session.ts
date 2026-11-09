import { randomUUID } from 'node:crypto';
import type { Usage } from '../core/message.js';
import { ServiceUnreachable, unreachableText, type Client } from './client.js';
import { errorLine, notice } from './notice.js';
import { printReply } from './print-reply.js';

/** Ctrl+C 后等 abort 段最多这么久，没等到就直接断开 */
export const abortWaitMs = 2000;

/**
 * CLI 的一个会话：一行一行发给洛璃服务，打印回复。会话 id 在发第一句、服务建好会话时才有
 * （--resume 时一开始就有）。连不上服务时打印提示、不退出，这句话没发出去，会话照旧
 */
export function createChatSession({
  client,
  author,
  conversationId: resumed,
  abortWait = abortWaitMs,
  clientId = randomUUID(),
}: {
  client: Client;
  /** 发言人的名字 */
  author: string;
  /** 接着用的会话（--resume）；不给时发第一句时新建 */
  conversationId?: string;
  abortWait?: number;
  /** 这个客户端的 id（每个 CLI 进程一个，随机生成）：排队时服务按它分辨是不是别人的消息 */
  clientId?: string;
}) {
  let conversationId = resumed;

  /**
   * 发一句并打印回复，等回复结束才返回；连不上服务（发不出去、流中途断了、超时）时返回
   * 'unreachable'，别的（完成、出错、中止、排队结束、服务拒绝）返回 'done'。signal 是 Ctrl+C：
   * - 已经知道会话 id、回复在进行：请服务中止（POST abort），等流里来 abort 段；abortWait 内没等到
   *   就断开请求（服务把断开也当作中止）；
   * - 还不知道会话 id（新会话的请求还没回来），或者这条还在排队：直接断开。
   * 都打「（已中止）」
   */
  async function say(text: string, signal?: AbortSignal): Promise<'done' | 'unreachable'> {
    const connection = new AbortController();
    let queued = false;
    let started = false;
    let timer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (conversationId === undefined || (queued && !started)) {
        connection.abort();
        return;
      }
      void client.abort(conversationId);
      timer = setTimeout(() => connection.abort(), abortWait);
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) stop();
      let sent;
      try {
        sent = await client.chat(
          {
            platform: 'cli',
            author,
            clientId,
            text,
            ...(conversationId ? { conversationId } : {}),
          },
          connection.signal,
        );
      } catch (error) {
        if (connection.signal.aborted) {
          notice('（已中止）');
          return 'done';
        }
        if (!(error instanceof ServiceUnreachable)) throw error;
        errorLine(unreachableText(client.address));
        return 'unreachable';
      }
      if (!sent.ok) {
        errorLine(`发送失败：${sent.error}`);
        return 'done';
      }
      conversationId ??= sent.conversationId;
      const result = await printReply(sent.chunks, {
        onConversation: (id) => {
          conversationId ??= id;
        },
        onQueued: () => {
          queued = true;
        },
        onStart: () => {
          started = true;
        },
      });
      switch (result.status) {
        case 'completed': {
          const line = result.usage && formatUsage(result.usage);
          if (line) notice(line);
          break;
        }
        case 'aborted':
          notice('（已中止）');
          break;
        case 'failed':
          // 出错不退出：用户消息已留在历史里，继续下一轮
          errorLine(`回复出错：${result.errorText}（详见服务的日志）`);
          break;
        case 'queue-end':
          notice(
            result.reason === 'merged'
              ? '（会和后面的消息一起回复）'
              : result.reason === 'answered'
                ? '（已和前面的消息一起回复）'
                : '（已中止）',
          );
          break;
        case 'ended':
        case 'broken':
          // 自己断开的是中止；不然是服务那边断了（服务被强行结束、连接断开、超时没有数据）
          if (connection.signal.aborted) notice('（已中止）');
          else if (result.status === 'broken') {
            errorLine(unreachableText(client.address));
            return 'unreachable';
          } else errorLine('回复出错：回复没有正常结束（详见服务的日志）');
          break;
      }
      return 'done';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }

  return {
    say,
    /** 现在的会话 id；还没建时 undefined */
    get conversationId() {
      return conversationId;
    },
  };
}

/**
 * tokens 输入 1234（缓存 1000）· 输出 567。服务端报了缓存数才显示括号；
 * 输入、输出都没报时不打印，只缺一个时那个数显示 ?
 */
export function formatUsage({ input, output, cacheRead }: Usage): string | undefined {
  if (input === undefined && output === undefined) return undefined;
  const cache = cacheRead === undefined ? ' ' : `（缓存 ${cacheRead}）`;
  return `tokens 输入 ${input ?? '?'}${cache}· 输出 ${output ?? '?'}`;
}
