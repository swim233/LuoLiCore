import type { UIMessage } from 'ai';
import type {
  ApiMessage,
  ApiSegment,
  ConversationKind,
  ConversationRow,
  ImageInfo,
  MessagePreview,
  MessageEvent as ServerMessageEvent,
  TodaySummary,
  ToolResultInfo,
} from '../../server/types';

/* 客户端数据的结构：和洛璃服务的接口同一种（类型来自 src/server/types.ts，只 import type）。
   正式构建里数据由 live-source 从服务取；开发模式里由 dev/mock-server.ts 按同样的结构造出来。
   「此刻」「对话」两个部件还在用的演示字段（图片色块、思考秒数、工具耗时与摘要）不在这里：
   它们是模拟数据里挂在 part 上的 demo（见 parts.ts 的 demoOf），第 5、6 步换成真实来源后删 */
export type { ApiMessage, ApiSegment, ImageInfo, MessagePreview, TodaySummary, ToolResultInfo };
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

/** 开发模式里「此刻」「对话」用的图片：生成的色块，或网页对话里用户拖进来的 blob 图 */
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

/* 网页对话（useChat 的 Chat）里的消息：metadata 带时间、发言人、中止与出错标记、用量 */
export type ChatMsg = UIMessage<{
  at: number;
  name?: string;
  aborted?: boolean;
  failed?: boolean;
  usage?: { input: number; cache: number; output: number };
  ms?: number;
}>;

/* 网页对话里 useChat 消息的 part：AI SDK 自带的 text、file、reasoning，加上写死 fetch 的 tool-fetch（第 6 步改成按工具名通用）。
   file、reasoning、tool-fetch 上的 demo、blob、sec 是 demo 时期的字段 */
export type ChatPart =
  | { type: 'text'; text: string; state?: 'streaming' | 'done' }
  | {
      type: 'file';
      mediaType: string;
      url: string;
      filename?: string;
      demo?: ImagePart['demo'];
      blob?: string;
    }
  | {
      type: 'reasoning';
      text: string;
      state?: 'streaming' | 'done';
      sec?: number;
      demo?: { sec: number };
    }
  | {
      type: 'tool-fetch';
      toolCallId: string;
      state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
      input?: { url?: string };
      output?: { summary?: string; chars?: number; ms?: number };
      demo?: { ms?: number; summary?: string; image?: ImagePart | null };
    };
