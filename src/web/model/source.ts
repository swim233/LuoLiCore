import type { ChatTransport } from 'ai';
import type { ChatMsg, ImageInfo, ModelCall, MsgRow, Part, ToolResultInfo } from './types';

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
  /** 网页对话现在能不能发。能发返回 null，不能发返回要提示用户的话 */
  chatBlocked(): string | null;
  /** 网页对话（useChat 用的那个 Chat）的 transport。第 6 步在这里带上会话 id、只发最新一条 */
  chatTransport(convId: string): ChatTransport<ChatMsg>;
  /** 网页对话把消息记进「服务」的几个操作：第 6 步之前只有模拟数据源有（真实数据源的 chatBlocked 挡住了发送） */
  webChat: WebChatStore | null;
}

/** 新写进服务的一条消息 */
export interface NewMessage {
  role: 'user' | 'assistant';
  /** 用户消息的发言人 */
  author?: { id?: string; name: string };
  parts: Part[];
  /** 消息里的图片：luoli-file: 地址 → 信息 */
  images?: Record<string, ImageInfo | null>;
  /** 有结果的工具调用：toolCallId → 结果长度 */
  tools?: Record<string, ToolResultInfo>;
  /** 消息时间，默认现在 */
  at?: number;
  meta?: {
    aborted?: true;
    failed?: true;
    usage?: { input?: number; output?: number; cacheRead?: number };
  };
}
export type NewCall = Partial<ModelCall> & {
  conversation_id: string;
  started_at: string;
  duration_ms: number;
  outcome: ModelCall['outcome'];
};
export interface WebChatStore {
  newConv(): string;
  setTitle(convId: string, title: string): void;
  addMessage(convId: string, m: NewMessage): MsgRow | null;
  addCall(call: NewCall): void;
}

let current: DataSource | null = null;
export function setSource(s: DataSource) {
  current = s;
}
export function getSource(): DataSource {
  if (!current) throw new Error('数据源还没有设置');
  return current;
}
