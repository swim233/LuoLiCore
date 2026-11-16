import { getToolName, isToolUIPart } from 'ai';
import type { ChatPart } from '@luoli/ui/chat';
import type { ChatMessage } from '../../server/types';
import { argsLine, isFile, isReasoning, isText, isTool, toolName, toolOutput } from './parts';
import type { ReplyEntry } from './replyInfo';
import type { MsgRow } from './types';

/* 气泡里画的东西：一条消息按段的先后变成库的块（@luoli/ui/chat 的 ChatPart：文字、图片、思考、工具）。库不认识 AI SDK 的消息，转换在这里。
   两个来源：历史消息（服务给的整条消息，时间线、对话都用）和自己这个标签页里正在逐字出的回复（useChat 的消息，
   流里没有思考用了几秒、工具的摘要与耗时、工具结果里图片的地址，这些取自 replyInfo.ts 记下的服务的实时事件）。
   回复写入历史后，同一条消息改用历史里的数据，两边是同一种块。
   工具那一行写的话（块里的 label）在这里算好：工具给界面看的一句话，没有就是参数的前一截（argsLine）。 */

/** 思考用了几秒：毫秒四舍五入，至少 1 秒 */
export const secOf = (ms: number | null | undefined) =>
  typeof ms === 'number' ? Math.max(1, Math.round(ms / 1000)) : undefined;

/** 历史消息 → 块 */
export function partsOfRow(row: MsgRow): ChatPart[] {
  const out: ChatPart[] = [];
  let k = 0;
  for (const p of row.message.parts) {
    if (isFile(p)) {
      if (p.mediaType.startsWith('image/'))
        out.push({ kind: 'image', info: row.images[p.url], name: p.filename });
    } else if (isReasoning(p)) {
      out.push({
        kind: 'think',
        text: p.text,
        sec: secOf(row.message.metadata?.reasoningMs?.[k++]),
        streaming: false,
      });
    } else if (isTool(p)) {
      const info = row.tools[p.toolCallId];
      const done = p.state === 'output-available';
      const err = p.state === 'output-error';
      const out_ = done ? toolOutput((p as { output?: unknown }).output) : null;
      const errorText = err ? ((p as { errorText?: string }).errorText ?? '') : undefined;
      out.push({
        kind: 'tool',
        name: toolName(p),
        state: err ? 'error' : done ? 'ok' : 'running',
        input: (p as { input?: unknown }).input,
        label: info?.summary ?? argsLine((p as { input?: unknown }).input),
        ms: info?.durationMs,
        outText: out_?.text,
        chars: info ? info.chars : (out_?.text.length ?? errorText?.length),
        truncated: info?.truncated,
        images: (out_?.images ?? []).map((img) => row.images[img.url]),
        errorText,
      });
    } else if (isText(p)) out.push({ kind: 'text', text: p.text });
  }
  return out;
}

/** 工具结果的文字在气泡里最多显示这么多个字符 */
const OUT_CHARS = 2000;

/** 自己这个标签页里正在逐字出的回复（useChat 的消息）→ 块 */
export function partsOfChat(m: ChatMessage, info: ReplyEntry | undefined): ChatPart[] {
  const out: ChatPart[] = [];
  let k = 0;
  const reasonings = info?.reasonings ?? [];
  for (const p of m.parts) {
    if (p.type === 'text') out.push({ kind: 'text', text: p.text });
    else if (p.type === 'reasoning') {
      const r = reasonings[k++];
      out.push({ kind: 'think', text: p.text, sec: r?.sec, streaming: p.state === 'streaming' });
    } else if (p.type === 'file') {
      if (p.mediaType.startsWith('image/')) out.push({ kind: 'image', info: { src: p.url } });
    } else if (isToolUIPart(p as never)) {
      const t = p as unknown as {
        toolCallId: string;
        state: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
      };
      const live = info?.tools.get(t.toolCallId);
      const done = t.state === 'output-available';
      const err = t.state === 'output-error';
      const o = done ? toolOutput(t.output) : null;
      out.push({
        kind: 'tool',
        name: getToolName(p as never),
        state: err ? 'error' : done ? 'ok' : 'running',
        input: t.input,
        label: live?.summary ?? argsLine(t.input),
        ms: live?.ms,
        outText: o ? o.text.slice(0, OUT_CHARS) : undefined,
        chars: o?.text.length ?? t.errorText?.length,
        truncated: !!o && o.text.length > OUT_CHARS,
        // 结果里的图片：流里是 luoli-file: 地址，真正的取图地址在服务的 tool-end 事件里，按顺序对上
        images: (o?.images ?? []).map((_, i) => live?.images?.[i]),
        errorText: err ? (t.errorText ?? live?.error ?? '') : undefined,
      });
    }
  }
  return out;
}
