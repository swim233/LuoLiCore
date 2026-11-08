import type { ChatTransport } from 'ai';
import { bus } from './bus';
import { db } from './db';
import type { ChatMsg } from './types';

/* 数据源：数据层（db、bus、status、nowModel）的「进口」。
   部件读的是客户端的数据层，不关心数据从哪来；数据源负责把数据灌进去、把实时事件发到总线上，并提供界面要用的几个操作。
   - 模拟数据源（dev/mock-source.ts）：开发模式用，种子数据加定时脚本；
   - 空数据源（empty-source.ts）：正式构建用，没有会话、没有事件；
   - 真实的数据源在第 4~6 步：启动时从服务取会话与统计、连上 SSE 把事件发到总线，操作变成请求。
   部件现在同步读 db。真实数据是异步的，接法是：数据源在 start() 里把数据取回来放进 db（发 data:reset 通知重画），
   之后随事件增量更新，部件读的仍是内存里的这份；按需取的数据（某个会话的全部消息）也由数据源取回来放进 db 再发事件。 */
export interface DataSource {
  readonly kind: 'mock' | 'empty';
  /** 启动时调用一次：载入初始数据、连上实时事件。返回断开的函数 */
  start(): () => void;
  /** 网页对话现在能不能发。能发返回 null，不能发返回要提示用户的话 */
  chatBlocked(): string | null;
  /** 网页对话（useChat 用的那个 Chat）的 transport。第 6 步在这里带上会话 id、只发最新一条 */
  chatTransport(convId: string): ChatTransport<ChatMsg>;
  /** 会话被看过了：清零未读。第 4 步改成通知服务端 */
  markRead(convId: string): void;
}

let current: DataSource | null = null;
export function setSource(s: DataSource) {
  current = s;
}
export function getSource(): DataSource {
  if (!current) throw new Error('数据源还没有设置');
  return current;
}

/* 未读数现在只在浏览器里：清零并通知列表重画 */
export function clearUnread(convId: string) {
  if (!db.unread.get(convId)) return;
  db.unread.delete(convId);
  bus.emit('unread', { convId });
}
