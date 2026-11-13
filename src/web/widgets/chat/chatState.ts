import { createStore } from '@luoli/ui/store';
import { bus } from '../../model/bus';
import { db } from '../../model/db';
import type { UploadResponse } from '../../../server/types';

/* 网页自己的状态：当前对话、每个对话的草稿（文字、待发的图片和上传状态，只存内存） */

/** 一条消息最多这么多张图，每张不超过这么多字节，只收这几种格式（和服务端一致；动图服务端会拒收） */
export const MAX_IMAGES = 10;
export const MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** 待发的一张图片 */
export interface Att {
  id: string;
  file: File;
  /** 预览用的 blob 地址 */
  url: string;
  name: string;
  type: string;
  bytes: number;
  /** ready：还没上传（发送时才传）；uploading；done：已经传上去了；failed：上传失败，error 是原因 */
  state: 'ready' | 'uploading' | 'done' | 'failed';
  error?: string;
  /** 上传成功后文件存储里的引用 */
  ref?: UploadResponse;
}
export interface Draft {
  text: string;
  atts: Att[];
  /** 输入框上的提示（超限、上传失败） */
  note?: { text: string; err: boolean };
  /** 正在上传、发出（这时不能再发） */
  sending: boolean;
}

/** 还没建的新对话的草稿用这个键 */
export const NEW_KEY = '__new__';
export const draftKey = (convId: string | null) => convId ?? NEW_KEY;
export const drafts = new Map<string, Draft>();
export const draftOf = (key: string): Draft => {
  let d = drafts.get(key);
  if (!d) drafts.set(key, (d = { text: '', atts: [], sending: false }));
  return d;
};
/** 草稿变了（文字之外的：图片、上传状态、提示），输入框要重画 */
export const draftChanged = () => bus.emit('chat:draft');

/**
 * cur：选中的对话；isNew：正在写一个还没建的新对话（点了「＋ 新对话」，发出第一句时服务才建）；
 * creating：从新对话里发出的那个请求的 id，服务还没回应（不知道会话 id）时，对话里先显示它；
 *   服务一回应（收下）就切到新建的会话，不等 SSE 把会话推来
 */
export const chatState = createStore<{
  cur: string | null;
  isNew: boolean;
  creating: string | null;
}>({ cur: null, isNew: false, creating: null });

export const webConvs = () => db.sorted().filter((c) => c.platform === 'web');
/** 当前显示的对话；null 是新对话（还没建） */
export function chatCur(): string | null {
  const s = chatState.get();
  if (s.isNew) return null;
  if (s.cur && db.conv(s.cur)) return s.cur;
  return webConvs()[0]?.id ?? null;
}
/** 写一个新对话：现在不写数据库，发出第一句时才建 */
export function newWebConv() {
  chatState.set({ isNew: true, cur: null });
  bus.emit('chat:switch', {});
}
export function switchTo(id: string) {
  chatState.set({ cur: id, isNew: false });
  bus.emit('chat:switch', {});
}
export function resetChatState() {
  chatState.set({ cur: null, isNew: false, creating: null });
  for (const d of drafts.values()) for (const a of d.atts) URL.revokeObjectURL(a.url);
  drafts.clear();
}
