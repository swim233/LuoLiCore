import { describe, expect, it } from 'vitest';
import { awaitingOwnReply, busyElsewhere } from './replyWait';
import type { ReqLike } from './replyWait';

const req = (over: Partial<ReqLike> = {}): ReqLike => ({
  convId: 'c1',
  finished: false,
  ...over,
});
const none: ReadonlySet<string> = new Set();

/* 对话里要不要先画「正在回复」的气泡：这个标签页发的请求在等回复 */
describe('awaitingOwnReply', () => {
  it('请求还开着、回复还没有内容：在等', () => {
    expect(awaitingOwnReply([req()], 'c1', none)).toBe(true);
  });

  it('回复 id 已经知道、但还没写进历史：在等', () => {
    expect(awaitingOwnReply([req({ replyId: 'r1' })], 'c1', none)).toBe(true);
  });

  it('回复已经写进历史、请求的流还没收尾：不在等（不画「正在回复」）', () => {
    expect(awaitingOwnReply([req({ replyId: 'r1' })], 'c1', new Set(['r1']))).toBe(false);
  });

  it('请求收尾了：不在等', () => {
    expect(awaitingOwnReply([req({ finished: true, replyId: 'r1' })], 'c1', none)).toBe(false);
    expect(awaitingOwnReply([req({ finished: true })], 'c1', none)).toBe(false);
  });

  it('排队的补回复（另一个请求，还没有回复 id）照常在等，哪怕前一个回复已经写进历史', () => {
    const first = req({ replyId: 'r1' });
    const queued = req();
    expect(awaitingOwnReply([first, queued], 'c1', new Set(['r1']))).toBe(true);
  });

  it('补回复开始、回复 id 知道了、也写进历史以后：不在等', () => {
    const first = req({ finished: true, replyId: 'r1' });
    const refill = req({ replyId: 'r2' });
    expect(awaitingOwnReply([first, refill], 'c1', new Set(['r1', 'r2']))).toBe(false);
  });

  it('别的会话的请求不算；没有请求时不在等', () => {
    expect(awaitingOwnReply([req({ convId: 'c2' })], 'c1', none)).toBe(false);
    expect(awaitingOwnReply([], 'c1', none)).toBe(false);
  });
});

/* 输入框上方那一行「正在回复」：这个会话在回复，但不是这个标签页发的 */
describe('busyElsewhere', () => {
  it('别的标签页发的、任务到点触发的（这个标签页没有请求）：是别处', () => {
    expect(busyElsewhere([], 'c1', true, 'r9')).toBe(true);
    expect(busyElsewhere([], 'c1', true, undefined)).toBe(true);
  });

  it('服务没说在回复：不是', () => {
    expect(busyElsewhere([], 'c1', false, undefined)).toBe(false);
  });

  it('没有会话（还没建的新对话）：不是', () => {
    expect(busyElsewhere([], null, true, 'r1')).toBe(false);
  });

  it('这个标签页发的请求还开着：不是别处', () => {
    expect(busyElsewhere([req({ replyId: 'r1' })], 'c1', true, 'r1')).toBe(false);
    expect(busyElsewhere([req()], 'c1', true, 'r9')).toBe(false);
  });

  it('自己的请求刚收尾、服务的「回复结束」还没到（回复 id 一样）：不是别处', () => {
    expect(busyElsewhere([req({ finished: true, replyId: 'r1' })], 'c1', true, 'r1')).toBe(false);
  });

  it('自己的请求收尾了，但进行中的是另一次回复（别的标签页、任务到点触发的）：是别处', () => {
    expect(busyElsewhere([req({ finished: true, replyId: 'r1' })], 'c1', true, 'r2')).toBe(true);
  });

  it('进行中回复的 id 还不知道，自己的请求已经收尾：按别处算（没有别的依据）', () => {
    expect(busyElsewhere([req({ finished: true, replyId: 'r1' })], 'c1', true, undefined)).toBe(
      true,
    );
  });
});
