import { beforeEach, describe, expect, it } from 'vitest';
import { applyLive, resetLive } from './live-feed';
import { nowModel } from './nowModel';
import { status } from './status';
import type { LiveEvent } from '../../server/types';

/* 「自行决定」的监听回复：洛璃只回了约定的标记，什么都没发出。服务在结束事件里带 discarded，
   「此刻」写「未回复」（悬停说明原因）、不放星尘，状态汇总里的结束方式和正常完成分开（徽记靠它决定闪不闪） */

let seq = 0;
const iso = (sec: number) => new Date(1_700_000_000_000 + sec * 1000).toISOString();
/** 服务推来的一个 live 事件：序号接着往下，其余字段由各个测试写 */
function push(sec: number, rest: Record<string, unknown>) {
  applyLive({
    seq: ++seq,
    conversationId: 'g1',
    replyId: 'r1',
    at: iso(sec),
    state: 'replying',
    ...rest,
  } as LiveEvent);
}
/** 一次监听触发的回复：开始（带任务）、说一句话、结束 */
function run({ decide, discarded }: { decide: boolean; discarded?: boolean }) {
  push(0, {
    type: 'start',
    state: 'thinking',
    tasks: [
      {
        id: 7,
        ref: 't7',
        action: '留意天气预警',
        event: 'monitor',
        ...(decide ? { decide: true } : {}),
      },
    ],
  });
  push(1, { type: 'text-delta', part: 0, step: 1, text: discarded ? '[不回复]' : '有新的预警啦' });
  push(3, {
    type: 'end',
    outcome: 'completed',
    startedAt: iso(0),
    usage: { input: 100, cacheRead: 40, output: 8 },
    lastReply: { conversationId: 'g1', at: iso(3) },
    ...(discarded ? { discarded: true } : {}),
  });
}
const lines = () => nowModel.get('g1')!.lines;
const stats = () => lines().find((l) => l.kind === 'stats');
const spoken = () => lines().find((l) => l.kind === 'luoli');

describe('回复被丢掉（结束事件带 discarded）', () => {
  beforeEach(() => {
    resetLive();
    seq = 0;
  });

  it('「此刻」结束的状态写「未回复」，悬停说明原因，用时留着、不写 token', () => {
    run({ decide: true, discarded: true });
    expect(stats()).toMatchObject({
      text: '未回复 · 3.0s',
      title: '洛璃判断无需告知，此次回复未发出',
    });
    expect(stats()!.text).not.toContain('输入');
  });

  it('触发的那一行照旧写「监听触发 · 做什么」', () => {
    run({ decide: true, discarded: true });
    const marks = lines().filter((l) => l.task);
    expect(marks.map((l) => l.text)).toEqual(['监听触发 · 留意天气预警']);
  });

  it('不标「正常完成」：那一行逐字放完不放星尘', () => {
    run({ decide: true, discarded: true });
    expect(spoken()).toBeDefined();
    expect(spoken()!.completed).toBeFalsy();
  });

  it('状态汇总里这个会话离开进行中的方式是 discard（徽记不闪），但仍算一次回复', () => {
    run({ decide: true, discarded: true });
    expect(status.snapshot().count).toBe(0);
    expect(status.snapshot().ended).toBe('discard');
    expect(status.lastReplyConv).toBe('g1');
    expect(status.lastReplyAt).toBe(Date.parse(iso(3)));
  });
});

describe('正常完成的回复不受影响', () => {
  beforeEach(() => {
    resetLive();
    seq = 0;
  });

  it('「自行决定」的任务触发、洛璃照常回复：写用时和 token，没有悬停说明，标「正常完成」，徽记照旧闪', () => {
    run({ decide: true });
    expect(stats()).toMatchObject({ text: '3.0s · 输入 100（缓存 40） · 输出 8' });
    expect(stats()!.title).toBeUndefined();
    expect(spoken()!.completed).toBe(true);
    expect(status.snapshot().ended).toBe('end');
  });

  it('普通的监听触发（不是自行决定）也一样', () => {
    run({ decide: false });
    expect(stats()!.text).toContain('输入 100');
    expect(status.snapshot().ended).toBe('end');
  });
});

describe('出错、中止的结束不受影响', () => {
  beforeEach(() => {
    resetLive();
    seq = 0;
  });

  it('中止仍然是 abort，「此刻」写「回复被中止」', () => {
    push(0, { type: 'start', state: 'thinking' });
    push(2, { type: 'end', outcome: 'aborted', startedAt: iso(0) });
    expect(status.snapshot().ended).toBe('abort');
    expect(lines().some((l) => l.text?.startsWith('回复被中止'))).toBe(true);
    expect(stats()).toBeUndefined();
  });
});
