/* 对话里「在等回复」的两个判断（纯函数；chatCore.ts 把这个标签页发的请求交给它们，Chat.tsx 画界面时用）。
   真实的服务里「回复写进历史（SSE 的 message 事件）」「服务说回复结束（SSE 的 live 事件）」「这个标签页的请求的流收尾（POST /api/chat）」
   是三个来源，先后不定、前后差几毫秒到几百毫秒。判断按「这次回复是不是这个标签页自己发起的」来，不按谁先到：
   自己发起的回复已经写进历史、或者它的请求刚收尾，都不能再当成「还在等」「别处在回复」，否则会闪一下「正在回复」。 */

/** 这个标签页发的一个请求（Req）里判断要用的几项 */
export interface ReqLike {
  convId: string | null;
  /** 流收尾了（完成、出错、中止） */
  finished: boolean;
  /** 回复 id：流里的 start 段带来，回复写入历史后就是那条助手消息的 id */
  replyId?: string;
}

/**
 * 对话里要不要画「正在回复」的气泡（这个标签页发的、还没有内容的回复）：
 * 这个会话里有这个标签页发的请求还开着，并且它的回复还没写进历史（written 是历史里的消息 id）。
 * 回复已经写进历史、请求的流还没收尾的那一小段不算：历史里已经有这条回复了，
 * 排队的补回复（另一个请求，还没有回复 id）照常算
 */
export function awaitingOwnReply(
  reqs: readonly ReqLike[],
  convId: string | null,
  written: ReadonlySet<string>,
): boolean {
  return reqs.some(
    (r) =>
      r.convId === convId && !r.finished && !(r.replyId !== undefined && written.has(r.replyId)),
  );
}

/**
 * 这个会话在回复，但不是这个标签页发的（别的标签页发的，或者任务到点触发的，没有哪个请求接着它的流）：
 * 输入框上方写一行「正在回复」。active 是服务说这个会话有进行中的回复，activeReplyId 是它的回复 id（知道时）。
 * 这个标签页发的请求还开着，不算；请求刚收尾、服务的「回复结束」还没到时，进行中的回复就是这个请求的回复
 * （回复 id 一样），也不算
 */
export function busyElsewhere(
  reqs: readonly ReqLike[],
  convId: string | null,
  active: boolean,
  activeReplyId: string | undefined,
): boolean {
  if (convId === null || !active) return false;
  if (reqs.some((r) => r.convId === convId && !r.finished)) return false;
  if (activeReplyId !== undefined && reqs.some((r) => r.replyId === activeReplyId)) return false;
  return true;
}
