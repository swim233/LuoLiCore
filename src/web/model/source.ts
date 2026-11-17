import type { ChatApi } from './chat-api';
import type { ImageInfo, ModelCall, Part, ToolResultInfo } from './types';

/* 数据源：数据层（db、bus、status、nowModel）的「进口」。
   部件读的是客户端的数据层，不关心数据从哪来；数据源负责把数据灌进去、把实时事件发到总线上，并提供界面要用的几个操作。
   - live-source.ts：正式构建用，连洛璃服务（取会话与今日概况、连上 SSE、按需取消息、标记已读）；
   - dev/mock-source.ts：开发模式用，模拟服务的数据加定时脚本。
   两者灌数据的做法是同一份（sync.ts）：服务给的会话行、消息、段、今日概况放进 db，再发总线事件。
   部件读 db（同步）；按需取的数据（某个会话的消息）由数据源取回来放进 db，再发 conv:messages。 */
export interface DataSource {
  readonly kind: 'mock' | 'live';
  /** 启动时调用一次：载入初始数据、连上实时事件。返回断开的函数 */
  start(): () => void;
  /** 打开一个会话：取它最近的一批消息和全部段，放进 db（状态见 db.msgInfo）。取过的不重复取 */
  openConversation(convId: string): void;
  /** 往上翻：取更早的一批。manual：用户点了重试 */
  loadOlder(convId: string, manual?: boolean): void;
  /** 已经看到了这个会话的第 seq 条消息（一般是最后一条）：未读清零 */
  markRead(convId: string, seq: number): void;
  /** 取消一个任务：成功了任务这一行换成取消后的样子；失败时抛错，说明原因（已经结束了、没有这个任务、连不上） */
  cancelTask(id: number): Promise<void>;
  /** 网页对话要用的服务接口：发消息、中止、上传图片（正式构建是洛璃服务的 HTTP 接口，开发模式在浏览器里模拟） */
  chat: ChatApi;
}

/** 新写进服务的一条消息 */
export interface NewMessage {
  /** 消息 id；回复写入历史时用回复 id，和真实的服务一样 */
  id?: string;
  role: 'user' | 'assistant';
  /** 用户消息的发言人 */
  author?: { id?: string; name: string };
  parts: Part[];
  /** 消息里的图片：luoli-file: 地址 → 信息 */
  images?: Record<string, ImageInfo | null>;
  /** 有结果的工具调用：toolCallId → 结果长度、摘要、耗时 */
  tools?: Record<string, ToolResultInfo>;
  /** 消息时间，默认现在 */
  at?: number;
  /** 事件（任务触发、任务超时、监听触发、监听失败）：没有发言人的用户消息，说的是哪个任务 */
  event?: { type: 'task' | 'task-missed' | 'monitor' | 'monitor-failed'; taskId: number };
  meta?: {
    aborted?: true;
    failed?: true;
    usage?: { input?: number; output?: number; cacheRead?: number };
    /** 每段思考用了多少毫秒（按 reasoning 段的顺序） */
    reasoningMs?: (number | null)[];
  };
}
export type NewCall = Partial<ModelCall> & {
  conversation_id: string;
  started_at: string;
  duration_ms: number;
  outcome: ModelCall['outcome'];
};

let current: DataSource | null = null;
export function setSource(s: DataSource) {
  current = s;
}
export function getSource(): DataSource {
  if (!current) throw new Error('数据源还没有设置');
  return current;
}
