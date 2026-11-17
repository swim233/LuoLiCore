import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
  checkBrief,
  checkSentence,
  checkState,
  descriptionText,
  dueSentence,
  failingCount,
  scheduleLine,
  tasksProblem,
  tasksThumb,
} from './tasks';
import type { TaskMonitor, TaskRow, TodaySummary } from './types';

/* 监听任务在面板上的说法：右边那一小格、展开里的句子、胶囊那句话。时间一律按服务器的时区（这里固定成 UTC，结果不随跑测试的机器变） */
const TZ = 'UTC';
const NOW = Date.parse('2026-11-16T22:00:00Z');

function monitor(over: Partial<TaskMonitor> = {}): TaskMonitor {
  return {
    description: { service: 'qweather', endpoint: 'weather_alert', interval_minutes: 10 },
    line: '每 10 分钟查一次 · 和风天气 · 天气预警',
    facts: [{ label: '盯的是', text: '和风天气 · 天气预警' }],
    ...over,
  };
}
function row(id: number, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    ref: 't' + id,
    action: '有天气预警就提醒大家',
    scheduleText: '每 10 分钟查一次 · 和风天气 · 天气预警',
    conversation: { id: 'c1', platform: 'telegram', kind: 'group', title: '读书会' },
    schedule: { kind: 'monitor', monitor: {} },
    status: 'active',
    dueCount: 0,
    requestedBy: { name: '小明' },
    createdAt: '2026-11-10T01:00:00Z',
    ...over,
  };
}
function timed(id: number, at: string): TaskRow {
  return row(id, {
    scheduleText: '一次性',
    schedule: { kind: 'once', at },
    nextDueAt: at,
  });
}

describe('监听任务：检查的情况', () => {
  it('查得通：上次检查的时刻；还没查过：什么都没有', () => {
    expect(checkState(monitor({ lastCheckedAt: '2026-11-16T21:38:00Z' }))).toEqual({
      kind: 'ok',
      at: Date.parse('2026-11-16T21:38:00Z'),
    });
    expect(checkState(monitor())).toEqual({ kind: 'never' });
  });

  it('查不到时以 failing 为准，哪怕最近还检查过（那次检查是失败的）', () => {
    const m = monitor({
      lastCheckedAt: '2026-11-16T21:50:00Z',
      lastSuccessAt: '2026-11-16T15:00:00Z',
      failing: { since: '2026-11-16T15:02:00Z', reason: '额度用完了' },
    });
    expect(checkState(m)).toEqual({
      kind: 'failing',
      since: Date.parse('2026-11-16T15:02:00Z'),
      reason: '额度用完了',
    });
  });

  it('右边的小格：今天只写时刻，昨天以前带日期，没执行过写「尚未执行」，执行失败写「执行失败」并在悬停里写从何时起、原因', () => {
    const today = checkBrief(monitor({ lastCheckedAt: '2026-11-16T21:38:00Z' }), TZ, NOW);
    expect(today).toEqual({ kind: 'ok', text: '上次执行 21:38', hint: '上次执行的时间' });
    const yesterday = checkBrief(monitor({ lastCheckedAt: '2026-11-15T21:38:00Z' }), TZ, NOW);
    expect(yesterday.text).toBe('上次执行 昨天 21:38');
    const older = checkBrief(monitor({ lastCheckedAt: '2026-11-12T08:05:00Z' }), TZ, NOW);
    expect(older.text).toBe('上次执行 11-12 08:05');
    expect(checkBrief(monitor(), TZ, NOW)).toMatchObject({
      kind: 'never',
      text: '尚未执行',
      hint: '此任务尚未执行',
    });
    const bad = checkBrief(
      monitor({ failing: { since: '2026-11-16T15:02:00Z', reason: 'HTTP 403：额度用完' } }),
      TZ,
      NOW,
    );
    expect(bad).toEqual({
      kind: 'failing',
      text: '执行失败',
      hint: '自 11-16 15:02 起执行失败：HTTP 403：额度用完',
    });
  });

  it('时间按服务器的时区算，不是浏览器的', () => {
    const m = monitor({ lastCheckedAt: '2026-11-16T21:38:00Z' });
    expect(checkBrief(m, 'Asia/Shanghai', Date.parse('2026-11-17T01:00:00Z')).text).toBe(
      '上次执行 05:38',
    );
  });

  it('展开里的句子', () => {
    expect(checkSentence(monitor({ lastCheckedAt: '2026-11-16T21:38:00Z' }), TZ, NOW)).toBe(
      '上次执行 11-16 21:38，正常',
    );
    expect(checkSentence(monitor(), TZ, NOW)).toBe('尚未执行');
    expect(
      checkSentence(
        monitor({ failing: { since: '2026-11-16T15:02:00Z', reason: '连不上' } }),
        TZ,
        NOW,
      ),
    ).toBe('自 11-16 15:02 起执行失败：连不上');
  });

  it('到点的次数：没到过点时没有这一句，到过的写次数和上次', () => {
    expect(dueSentence(row(1), TZ, NOW)).toBeNull();
    expect(dueSentence(row(1, { dueCount: 3, lastDueAt: '2026-11-16T20:10:00Z' }), TZ, NOW)).toBe(
      '触发 3 次，上次触发 11-16 20:10',
    );
    expect(dueSentence(row(1, { dueCount: 2 }), TZ, NOW)).toBe('触发 2 次');
  });

  it('描述原文：排好版的 JSON', () => {
    expect(descriptionText(monitor({ description: { a: 1, b: ['x'] } }))).toBe(
      '{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}',
    );
  });
});

describe('任务部件的胶囊', () => {
  const put = (...rows: TaskRow[]) => {
    db.today = { timeZone: TZ } as TodaySummary;
    db.tasks = new Map(rows.map((r) => [r.id, r]));
    db.taskLoad = { state: 'ready' };
  };
  beforeEach(() => db.reset());
  afterEach(() => db.reset());

  it('没有监听任务出问题时，句子后面没有那一段', () => {
    put(timed(1, '2026-11-17T01:00:00Z'), timed(2, '2026-11-18T01:00:00Z'));
    expect(tasksThumb(NOW)).toBe('当前有 2 个任务 · 下一个 11-17 01:00');
  });

  it('有执行失败的监听任务时，后面加「 · 1 个执行失败」', () => {
    put(
      timed(1, '2026-11-16T23:00:00Z'),
      row(2, { monitor: monitor({ failing: { since: '2026-11-16T15:02:00Z', reason: 'x' } }) }),
      row(3, { monitor: monitor({ lastCheckedAt: '2026-11-16T21:38:00Z' }) }),
    );
    expect(tasksThumb(NOW)).toMatch(/^当前有 3 个任务 · 下一个 \d\d:\d\d · 1 个执行失败$/);
  });

  it('只有监听任务（没有下次触发的时间）时，也能带上执行失败的个数', () => {
    put(
      row(1, { monitor: monitor({ failing: { since: '2026-11-16T15:02:00Z', reason: 'x' } }) }),
      row(2, { monitor: monitor({ failing: { since: '2026-11-16T16:00:00Z', reason: 'y' } }) }),
    );
    expect(tasksThumb(NOW)).toBe('当前有 2 个任务 · 2 个执行失败');
  });

  it('没有任务时写「当前没有任务」；只有监听任务、都执行正常时，句子里没有下一个时刻也没有失败那一段', () => {
    put();
    expect(tasksThumb(NOW)).toBe('当前没有任务');
    put(row(1, { monitor: monitor({ lastCheckedAt: '2026-11-16T21:38:00Z' }) }));
    expect(tasksThumb(NOW)).toBe('当前有 1 个任务');
  });

  it('已经结束的监听任务不算执行失败', () => {
    const ended = row(1, {
      status: 'cancelled',
      endedAt: '2026-11-16T10:00:00Z',
      monitor: monitor({ failing: { since: '2026-11-16T09:00:00Z', reason: 'x' } }),
    });
    expect(failingCount([ended])).toBe(0);
    put(ended, timed(2, '2026-11-17T01:00:00Z'));
    expect(tasksThumb(NOW)).toBe('当前有 1 个任务 · 下一个 11-17 01:00');
  });
});

describe('任务行的周期和取任务出错的说法', () => {
  beforeEach(() => db.reset());
  afterEach(() => db.reset());

  it('一次性任务写成「一次性 · 时刻」，周期的用服务给的那句话', () => {
    expect(scheduleLine(timed(1, '2026-11-10T01:00:00Z'), TZ)).toBe('一次性 · 11-10 01:00');
    expect(
      scheduleLine(row(2, { scheduleText: '每 10 分钟执行一次 · 和风天气 · 天气预警' }), TZ),
    ).toBe('每 10 分钟执行一次 · 和风天气 · 天气预警');
  });

  it('取任务失败：404 说服务版本旧，别的错误说获取时出错并带原因', () => {
    db.taskLoad = { state: 'error', status: 404, message: '没有这个接口' };
    expect(tasksProblem()).toEqual({ title: '核心服务版本过旧，请重启服务' });
    db.taskLoad = { state: 'error', status: 500, message: '请求失败（HTTP 500）' };
    expect(tasksProblem()).toEqual({ title: '获取任务时出错', detail: '请求失败（HTTP 500）' });
  });
});
