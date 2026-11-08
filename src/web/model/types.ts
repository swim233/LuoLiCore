import type { UIMessage } from 'ai';

/* 数据的结构，照 ADR-0005 的表（conversations、messages、segments、model_calls）。
   带 demo 的字段是 demo 时期的演示字段（图片色块、思考秒数、工具耗时与摘要），界面现在读它们；第 4~6 步换成真实来源后删掉 */
export type Platform = 'telegram' | 'cli' | 'web';
export type ConvKind = 'group' | 'private' | 'cli' | 'web';

export interface Conversation {
  id: string;
  platform: Platform;
  platform_conversation_id: string | null;
  title: string;
  next_seq: number;
  created_at: string;
  kind: ConvKind;
}
export interface ImagePart {
  type: 'file';
  mediaType: string;
  url: string;
  demo?: { h1: number; h2: number; label: string; w: number; h: number };
  blob?: string;
  name?: string;
}
export interface TextPart {
  type: 'text';
  text: string;
}
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  demo?: { sec: number };
}
export interface ToolPart {
  type: 'tool-fetch';
  toolCallId: string;
  state: 'output-available' | 'output-error';
  input: { url: string };
  output?: { summary: string; chars: number };
  demo?: { ms: number; image: ImagePart | null };
}
export type Part = ImagePart | TextPart | ReasoningPart | ToolPart;
export interface Author {
  name: string;
  uid: string | null;
}
export interface Metadata {
  author?: Author;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  failed?: boolean;
  aborted?: boolean;
}
export interface MsgRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant';
  author_id: string | null;
  platform_message_id: string | null;
  created_at: string;
  ui_message: { id: string; role: 'user' | 'assistant'; parts: Part[]; metadata: Metadata };
}
export interface Segment {
  id: string;
  conversation_id: string;
  start_seq: number;
  start_reason: 'first' | 'idle' | 'compress';
  conversation_title: string;
  prior_summary: string | null;
  created_at: string;
}
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
   file、reasoning、tool-fetch 上的 demo、blob、sec 是 demo 时期的字段，和 ImagePart、ReasoningPart、ToolPart 里的对应 */
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
      demo?: ToolPart['demo'];
    };
