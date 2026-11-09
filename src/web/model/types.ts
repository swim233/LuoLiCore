import type {
  ApiMessage,
  ApiSegment,
  ConversationKind,
  ConversationRow,
  ImageInfo,
  MessagePreview,
  MessageEvent as ServerMessageEvent,
  TaskBrief,
  TaskRow,
  TodaySummary,
  ToolResultInfo,
} from '../../server/types';

/* 客户端数据的结构：和洛璃服务的接口同一种（类型来自 src/server/types.ts，只 import type）。
   正式构建里数据由 live-source 从服务取；开发模式里由 dev/mock-server.ts 按同样的结构造出来。
   开发模式里图片用生成的色块（ImagePart.demo），只在 dev/ 里用 */
export type {
  ApiMessage,
  ApiSegment,
  ImageInfo,
  MessagePreview,
  TaskBrief,
  TaskRow,
  TodaySummary,
  ToolResultInfo,
};
export type MessageEvent = ServerMessageEvent;
export type ConvKind = ConversationKind;
export type Platform = string;

/** 会话：服务给的一行，标题一定有（CLI 会话服务没有标题，按种类给个说法） */
export type Conversation = Omit<ConversationRow, 'title'> & { title: string };
/** 一条消息：整条 UI 消息，加工具结果的长度与图片的信息 */
export type MsgRow = ApiMessage;
export type Segment = ApiSegment;
/** UI 消息里的一段（text、reasoning、file、工具调用……） */
export type Part = ApiMessage['message']['parts'][number];

/** 开发模式里图片用的色块（dev/ 里造数据用）；blob、name：输入框里待发图片的预览 */
export interface ImagePart {
  type: 'file';
  mediaType: string;
  url: string;
  demo?: { h1: number; h2: number; label: string; w: number; h: number };
  blob?: string;
  name?: string;
}

/** 一次模型调用的记录（模拟服务用它算今日概况） */
export interface ModelCall {
  id: number;
  conversation_id: string;
  reply_id?: string | null;
  started_at: string;
  duration_ms: number;
  first_output_ms?: number;
  attempts?: number;
  outcome: 'completed' | 'failed' | 'aborted';
  finish_reason?: string;
  input_tokens?: number | null;
  cache_read_tokens?: number | null;
  output_tokens?: number | null;
  steps?: number;
  tool_calls?: number;
  error?: string | null;
  purpose: string;
  model: string;
}
