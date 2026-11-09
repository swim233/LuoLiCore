import type { Logger } from '../core/index.js';
import type { Events } from './events.js';
import type { StorageChange } from './observed-storage.js';
import type { Views } from './views.js';

/**
 * 把存储的写入通知转成 SSE 事件，推给连着的面板：
 * - conversation（会话新建、改名、切段）→ 这个会话的 conversation 事件；
 * - message → message 事件（新写入或编辑过的那条），再推这个会话的 conversation 事件
 *   （预览、条数、未读数变了）；
 * - call → today 事件（新的今日概况）；
 * - task → task 事件（这个任务此刻的样子）。
 * 按写入的先后一个个处理，事件的顺序与写入的顺序相同；没有面板连着时不做事。
 * 出错只记日志（只有事件种类与会话 id）
 */
export function relayChanges({
  views,
  events,
  logger,
}: {
  views: Views;
  events: Events;
  logger: Logger;
}): { onChange: (change: StorageChange) => void; settled: () => Promise<void> } {
  let queue = Promise.resolve();

  async function relay(change: StorageChange): Promise<void> {
    if (events.size === 0) return;
    if (change.type === 'call') {
      events.broadcast('today', await views.today());
      return;
    }
    if (change.type === 'task') {
      const task = await views.task(change.taskId);
      if (task) events.broadcast('task', task);
      return;
    }
    if (change.type === 'message') {
      const message = await views.message(change.conversationId, change.messageId);
      if (message) {
        events.broadcast('message', {
          conversationId: change.conversationId,
          message,
          edited: change.edited,
        });
      }
    }
    const row = await views.row(change.conversationId);
    if (row) events.broadcast('conversation', row);
  }

  return {
    onChange(change) {
      queue = queue
        .then(() => relay(change))
        .catch((error: unknown) => {
          logger.error(
            {
              change: change.type,
              conversationId: change.conversationId,
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            },
            'web.relay_failed',
          );
        });
    },
    /** 已经收到的通知都处理完（测试、退出用） */
    settled: () => queue,
  };
}
