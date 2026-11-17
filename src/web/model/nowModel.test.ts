import { beforeEach, describe, expect, it } from 'vitest';
import { bus } from './bus';
import { nowModel } from './nowModel';
import type { MsgRow } from './types';

/* 「此刻」的会话：被拿掉（结束后清理）的会话，已有的行留着，同一个会话再回复时接着往下写 */
function reply(convId: string, text: string) {
  const replyId = 'r-' + convId + '-' + text;
  bus.emit('reply:start', { convId, replyId });
  bus.emit('reply:think', { convId, replyId, part: 0 });
  bus.emit('reply:thinkEnd', { convId, replyId, sec: 2, text: '想一想' });
  bus.emit('reply:delta', { convId, replyId, text, part: 1 });
  bus.emit('reply:end', { convId, replyId, ms: 1500, usage: { input: 10, output: 2 } });
}
let seq = 0;
/** 别人发的一条用户消息（和服务推来的 message 事件里的一样） */
function say(convId: string, text: string, id = 'm' + ++seq) {
  const row = {
    seq,
    id,
    role: 'user',
    createdAt: new Date().toISOString(),
    message: {
      id,
      role: 'user',
      parts: [{ type: 'text', text }],
      metadata: { author: { id: '1001', name: '小明' } },
    },
    tools: {},
    images: {},
  } as unknown as MsgRow;
  bus.emit('message', { convId, row });
  return row;
}
const texts = (convId: string) => nowModel.get(convId)?.lines.map((l) => l.text ?? l.kind) ?? [];

describe('nowModel：结束后被拿掉的会话保留已有的行', () => {
  beforeEach(() => nowModel.reset());

  it('清理已结束的会话后，同一个会话再回复，接着原来的行往下写', () => {
    reply('a', '第一轮');
    const first = texts('a');
    expect(first).toContain('第一轮');
    nowModel.clearEnded();
    expect(nowModel.get('a')).toBeUndefined();
    reply('a', '第二轮');
    const lines = texts('a');
    expect(lines.slice(0, first.length)).toEqual(first);
    expect(lines).toContain('第二轮');
    // 第二轮开始时接着用原来的会话，上一轮的思考行、用量行都还在
    expect(nowModel.get('a')!.lines.filter((l) => l.kind === 'think')).toHaveLength(2);
    expect(nowModel.get('a')!.lines.filter((l) => l.kind === 'stats')).toHaveLength(2);
  });

  it('别的会话回复结束时，更早结束的会话被拿掉、行也留着', () => {
    reply('a', 'A 的回复');
    reply('b', 'B 的回复'); // b 结束时拿掉已结束的 a
    expect(nowModel.get('a')).toBeUndefined();
    reply('a', 'A 又回复');
    expect(texts('a')).toContain('A 的回复');
    expect(texts('a')).toContain('A 又回复');
  });

  it('会话被拿掉以后别人说的话（含触发下一次回复的那一句）下一轮里看得到，按到达的顺序', () => {
    reply('a', '第一轮');
    nowModel.clearEnded();
    say('a', '空闲时说的话');
    say('a', '触发回复的那句');
    reply('a', '第二轮');
    const lines = texts('a');
    const at = (t: string) => lines.indexOf(t);
    expect(at('第一轮')).toBeGreaterThanOrEqual(0);
    expect(at('空闲时说的话')).toBeGreaterThan(at('第一轮'));
    expect(at('触发回复的那句')).toBeGreaterThan(at('空闲时说的话'));
    expect(at('第二轮')).toBeGreaterThan(at('触发回复的那句'));
  });

  it('同一条消息收到两次只显示一次（复活后也一样）', () => {
    reply('a', '第一轮');
    nowModel.clearEnded();
    const row = say('a', '只说一次', 'dup-1');
    reply('a', '第二轮');
    bus.emit('message', { convId: 'a', row });
    expect(texts('a').filter((t) => t === '只说一次')).toHaveLength(1);
  });

  it('重连（按现场重建）以后不再保留：这些会话再回复时按新建的来', () => {
    reply('a', '第一轮');
    nowModel.clearEnded();
    nowModel.rebuild(new Set(), () => {});
    reply('a', '第二轮');
    expect(texts('a')).not.toContain('第一轮');
  });

  it('最多留最近回复过的 20 个会话', () => {
    for (let i = 0; i < 25; i++) {
      reply('c' + i, '回复' + i);
      nowModel.clearEnded();
    }
    // 最早的 5 个被挤掉：再回复时只有这一轮的行
    reply('c0', '再来');
    expect(texts('c0')).not.toContain('回复0');
    // 最近的 20 个还在
    reply('c24', '再来');
    expect(texts('c24')).toContain('回复24');
  });

  it('会话被删除（conv:remove）后不再保留', () => {
    reply('a', '第一轮');
    nowModel.clearEnded();
    bus.emit('conv:remove', { id: 'a' });
    reply('a', '第二轮');
    expect(texts('a')).not.toContain('第一轮');
  });

  it('每个会话最多 140 行，超出的从最前面丢', () => {
    for (let i = 0; i < 100; i++) reply('a', '第 ' + i + ' 轮');
    const lines = nowModel.get('a')!.lines;
    expect(lines).toHaveLength(140);
    expect(lines.at(-1)!.kind).toBe('stats');
  });
});

describe('「此刻」标出任务触发的回复', () => {
  beforeEach(() => nowModel.reset());
  const marks = (convId: string) =>
    nowModel
      .get(convId)!
      .lines.filter((l) => l.task)
      .map((l) => l.text);

  it('定时任务写「任务触发」，监听任务按服务给的 event 写「监听触发」「监听失败」，一次回复里几个任务都列出来', () => {
    bus.emit('reply:start', {
      convId: 'a',
      replyId: 'r1',
      tasks: [
        { id: 1, ref: 't1', action: '提醒小明交周报' },
        { id: 2, ref: 't2', action: '盯着天气预警', event: 'monitor' },
        { id: 3, ref: 't3', action: '盯着杭州的预警', event: 'monitor-failed' },
      ],
    });
    expect(marks('a')).toEqual([
      '任务触发 · 提醒小明交周报',
      '监听触发 · 盯着天气预警',
      '监听失败 · 盯着杭州的预警',
    ]);
  });

  it('人发消息触发的回复没有这几行', () => {
    bus.emit('reply:start', { convId: 'b', replyId: 'r2' });
    expect(marks('b')).toEqual([]);
  });
});
