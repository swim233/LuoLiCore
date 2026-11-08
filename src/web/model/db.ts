import { assistantName } from './who';
import type { Conversation, MsgRow, Segment, TodaySummary } from './types';

/* 客户端的数据层：部件在渲染里同步读它。数据是服务给的样子（会话一行、消息整条 UI 消息、段、今日概况），
   由数据源（source.ts）经 sync.ts 灌进来：正式构建里来自洛璃服务，开发模式里来自模拟服务。
   会话列表整份放在内存里；消息按需取：打开一个会话才取它最近的一批，往上翻再取更早的，已经取到的放在 messages */

/** 一个会话的消息取到哪一步了 */
export interface MsgInfo {
  /** loading：第一批还没到；ready：已有；error：取失败了 */
  state: 'loading' | 'ready' | 'error';
  /** 已取到的最早一条之前，还有没有更早的 */
  hasMore: boolean;
  /** 往上翻时取更早一批的状态 */
  older: 'idle' | 'loading' | 'error';
  /** 第一批在路上时到的新消息，第一批到了以后并进去 */
  pending: MsgRow[];
  /** 每次重新取就换一个：时间线按它判断是不是「重新打开」 */
  token: number;
  error?: string;
}

/** 没有标题的会话（CLI）按种类给个说法 */
export function defaultTitle(kind: Conversation['kind']): string {
  return (
    { group: '群聊', private: '私聊', cli: 'CLI 会话', web: '网页会话', other: '会话' }[kind] ??
    '会话'
  );
}

class Db {
  conversations: Conversation[] = [];
  messages = new Map<string, MsgRow[]>();
  segments = new Map<string, Segment[]>();
  msgInfo = new Map<string, MsgInfo>();
  /** 今日概况；还没取到时为 null */
  today: TodaySummary | null = null;
  /** 刚整批到的会话：列表里这些行出现时不放进场动画 */
  bulk = new Set<string>();
  /** 数据版本：列表类视图靠它判断要不要重画 */
  rev = 0;
  private sortedCache: { rev: number; list: Conversation[] } | null = null;

  conv(id: string | null | undefined) {
    return id ? this.conversations.find((c) => c.id === id) : undefined;
  }
  msgs(id: string): MsgRow[] {
    return this.messages.get(id) || [];
  }
  segs(id: string): Segment[] {
    return this.segments.get(id) || [];
  }
  lastAt(id: string) {
    const c = this.conv(id);
    return c ? Date.parse(c.lastAt) : 0;
  }
  /** 按最后一条消息的时间倒序（同时间的保持原来的先后） */
  sorted(): Conversation[] {
    if (this.sortedCache?.rev !== this.rev) {
      const list = [...this.conversations].sort(
        (a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt),
      );
      this.sortedCache = { rev: this.rev, list };
    }
    return this.sortedCache!.list;
  }
  /** 列表里的预览行：「名字：正文」，只有图时「[图片]」 */
  previewOf(c: Conversation): string {
    const l = c.last;
    if (!l) return '';
    const name = l.role === 'assistant' ? assistantName() : l.author;
    const text = l.text || '（没有文字）';
    return name ? name + '：' + text : text;
  }

  /* ---- 写入（sync.ts 用） ---- */
  setConversations(list: Conversation[]) {
    this.conversations = list;
    this.rev++;
  }
  /** 新增或整行替换；返回之前的那一行（新会话为 undefined） */
  upsert(c: Conversation): Conversation | undefined {
    const i = this.conversations.findIndex((x) => x.id === c.id);
    const prev = i >= 0 ? this.conversations[i] : undefined;
    if (i >= 0) this.conversations[i] = c;
    else this.conversations.push(c);
    this.rev++;
    return prev;
  }
  remove(id: string) {
    this.conversations = this.conversations.filter((c) => c.id !== id);
    this.messages.delete(id);
    this.segments.delete(id);
    this.msgInfo.delete(id);
    this.rev++;
  }
  /** 全部清空（重新连上服务、切换模拟数据时） */
  reset() {
    this.conversations = [];
    this.messages = new Map();
    this.segments = new Map();
    this.msgInfo = new Map();
    this.today = null;
    this.bulk = new Set();
    this.rev++;
  }
}
export const db = new Db();
