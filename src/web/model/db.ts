import { startOfDay, uid } from '../lib/util';
import { LUOLI } from './who';
import type {
  Author,
  ConvKind,
  Conversation,
  Metadata,
  ModelCall,
  MsgRow,
  Part,
  Platform,
  Segment,
} from './types';

/* 客户端的数据层：照 ADR-0005 的表，部件在渲染里同步读它。消息整条存在 ui_message 里；图片是 luoli-file: 引用。
   数据由数据源（source.ts）灌进来：开发模式是模拟数据，正式构建里是空的 */
class Db {
  conversations: Conversation[] = [];
  messages = new Map<string, MsgRow[]>();
  segments = new Map<string, Segment[]>();
  model_calls: ModelCall[] = [];
  unread = new Map<string, number>(); // 网页自己的：未读条数（不在 ADR-0005 里）
  /* 数据版本：列表类视图靠它判断要不要重画 */
  rev = 0;

  conv(id: string | null | undefined) {
    return id ? this.conversations.find((c) => c.id === id) : undefined;
  }
  msgs(id: string) {
    return this.messages.get(id) || [];
  }
  segs(id: string) {
    return this.segments.get(id) || [];
  }
  lastAt(id: string) {
    const m = this.msgs(id);
    if (m.length) return Date.parse(m[m.length - 1].created_at);
    const c = this.conv(id);
    return c ? Date.parse(c.created_at) : 0;
  }
  sorted() {
    return [...this.conversations].sort((a, b) => this.lastAt(b.id) - this.lastAt(a.id));
  }
  lastMsg(id: string) {
    const m = this.msgs(id);
    return m[m.length - 1];
  }
  addConv({
    platform,
    kind,
    title,
    chatId = null,
    at = Date.now(),
    id,
  }: {
    platform: Platform;
    kind: ConvKind;
    title: string;
    chatId?: string | null;
    at?: number;
    id?: string;
  }) {
    const conv: Conversation = {
      id: id || uid('conv'),
      platform,
      platform_conversation_id: chatId,
      title,
      next_seq: 1,
      created_at: new Date(at).toISOString(),
      kind /* 网页自己的：group | private | cli | web */,
    };
    this.conversations.push(conv);
    this.messages.set(conv.id, []);
    this.segments.set(conv.id, []);
    this.rev++;
    return conv;
  }
  removeConv(id: string) {
    this.conversations = this.conversations.filter((c) => c.id !== id);
    this.messages.delete(id);
    this.segments.delete(id);
    this.unread.delete(id);
    this.rev++;
  }
  addSeg(convId: string, reason: Segment['start_reason'], at: number, summary: string | null) {
    const conv = this.conv(convId)!;
    const row: Segment = {
      id: uid('seg'),
      conversation_id: convId,
      start_seq: conv.next_seq,
      start_reason: reason,
      conversation_title: conv.title,
      prior_summary: summary || null,
      created_at: new Date(at).toISOString(),
    };
    this.segs(convId).push(row);
    this.rev++;
    return row;
  }
  /* role: user | assistant；author 是名字快照 {name, uid} */
  addMsg(
    convId: string,
    {
      role,
      author,
      parts,
      at = Date.now(),
      meta = {},
    }: { role: 'user' | 'assistant'; author?: Author; parts: Part[]; at?: number; meta?: Metadata },
  ) {
    const conv = this.conv(convId);
    if (!conv) return null;
    const id = uid('msg');
    const row: MsgRow = {
      id,
      conversation_id: convId,
      seq: conv.next_seq++,
      role,
      author_id: role === 'user' ? author?.uid || null : null,
      platform_message_id: null,
      created_at: new Date(at).toISOString(),
      ui_message: {
        id,
        role,
        parts,
        metadata: Object.assign(
          { author: role === 'user' ? author : { name: LUOLI, uid: null } },
          meta,
        ),
      },
    };
    this.msgs(convId).push(row);
    this.rev++;
    return row;
  }
  addCall(
    row: Partial<ModelCall> & {
      conversation_id: string;
      started_at: string;
      duration_ms: number;
      outcome: ModelCall['outcome'];
    },
  ) {
    this.model_calls.push(
      Object.assign(
        { id: this.model_calls.length + 1, purpose: 'reply', model: '' },
        row,
      ) as ModelCall,
    );
    this.rev++;
  }
  today() {
    const t0 = startOfDay(Date.now());
    const s = {
      replies: 0,
      failed: 0,
      input: 0,
      cache: 0,
      output: 0,
      per: new Map<string, number>(),
    };
    for (const c of this.model_calls) {
      if (Date.parse(c.started_at) < t0 || c.purpose !== 'reply') continue;
      if (c.outcome === 'completed') s.replies++;
      if (c.outcome === 'failed') s.failed++;
      s.input += c.input_tokens || 0;
      s.cache += c.cache_read_tokens || 0;
      s.output += c.output_tokens || 0;
      if (c.outcome === 'completed')
        s.per.set(c.conversation_id, (s.per.get(c.conversation_id) || 0) + 1);
    }
    return s;
  }
  textOf(row: MsgRow) {
    return row.ui_message.parts
      .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }
  preview(row?: MsgRow) {
    if (!row) return '';
    const m = row.ui_message;
    const name = row.role === 'assistant' ? LUOLI : m.metadata.author?.name;
    let t = this.textOf(row).replace(/\s+/g, ' ');
    if (!t && m.parts.some((p) => p.type === 'file')) t = '[图片]';
    else if (m.parts.some((p) => p.type === 'file')) t = '[图片] ' + t;
    return name + '：' + t;
  }
  reset() {
    this.conversations = [];
    this.messages = new Map();
    this.segments = new Map();
    this.model_calls = [];
    this.unread = new Map();
    this.rev++;
  }
}
export const db = new Db();
