import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { maxItemBytes, openFeedsDb, sourceIdentity, type SourceSpec } from './feeds-db.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'luoli-feeds-'));
  dirs.push(dir);
  return join(dir, 'feeds.db');
}

const spec: SourceSpec = {
  service: 'qweather',
  endpoint: 'weather_alert',
  params: { longitude: 121.47, latitude: 31.23, localTime: true },
  items: 'alerts',
  key: 'id',
};
const at = '2026-11-16T12:00:00.000Z';

describe('feeds.db 的来源、动态、谁在盯', () => {
  it('来源：服务、接口、参数（按名字排好、值按文字比）、条目在哪、认新旧都相同的是同一个', () => {
    const feeds = openFeedsDb(':memory:');
    const source = feeds.ensureSource(spec, at);
    const reordered = { latitude: '31.23', localTime: 'true', longitude: '121.47' };

    expect(feeds.ensureSource({ ...spec, params: reordered }, at).id).toBe(source.id);
    expect(sourceIdentity({ ...spec, params: reordered })).toBe(sourceIdentity(spec));
    for (const other of [
      { ...spec, service: 'other' },
      { ...spec, endpoint: 'weather_now' },
      { ...spec, params: { ...spec.params, lang: 'zh' } },
      { ...spec, items: 'data.alerts' },
      { ...spec, key: 'meta.id' },
    ]) {
      expect(feeds.ensureSource(other, at).id).not.toBe(source.id);
    }
    expect(feeds.source(source.id)).toEqual({
      id: source.id,
      ...spec,
      params: { latitude: 31.23, localTime: true, longitude: 121.47 },
      createdAt: at,
    });
    feeds.close();
  });

  it('动态：同一个编号只存一次，内容变了不更新；按存进来的先后；超过 64 KB 的截掉并标出', () => {
    const feeds = openFeedsDb(':memory:');
    const { id } = feeds.ensureSource(spec, at);
    const other = feeds.ensureSource({ ...spec, key: 'other' }, at).id;

    expect(feeds.lastItemId(id)).toBe(0);
    expect(
      feeds.storeItems(
        id,
        [
          { key: 'a', data: '{"v":1}' },
          { key: 'b', data: '{"v":2}' },
        ],
        at,
      ),
    ).toBe(2);
    expect(
      feeds.storeItems(
        id,
        [
          { key: 'a', data: '{"v":"变了"}' },
          { key: 'c', data: '{}' },
        ],
        at,
      ),
    ).toBe(1);
    // 别的来源里同样的编号是另一条
    expect(feeds.storeItems(other, [{ key: 'a', data: '{}' }], at)).toBe(1);

    const items = feeds.items(id);
    expect(items.map(({ key, data }) => [key, data])).toEqual([
      ['a', '{"v":1}'],
      ['b', '{"v":2}'],
      ['c', '{}'],
    ]);
    expect(feeds.lastItemId(id)).toBe(items[2]!.id);
    expect(feeds.itemsAfter(id, items[0]!.id).map(({ key }) => key)).toEqual(['b', 'c']);

    const huge = JSON.stringify({ text: '字'.repeat(maxItemBytes) });
    feeds.storeItems(id, [{ key: 'big', data: huge }], at);
    const [big] = feeds.itemsAfter(id, items[2]!.id);
    expect(big!.truncated).toBe(true);
    expect(Buffer.byteLength(big!.data)).toBeLessThanOrEqual(maxItemBytes);
    expect(huge.startsWith(big!.data.slice(0, 1000))).toBe(true);
    feeds.close();
  });

  it('检查的状态：成功清掉失败的记录；连续失败记下从什么时候起、几次、最近一次的原因；说过一次；这一轮可以重新算', () => {
    const feeds = openFeedsDb(':memory:');
    const { id } = feeds.ensureSource(spec, at);
    feeds.recordFailure(id, '2026-11-16T12:01:00.000Z', {
      kind: 'status',
      status: 500,
      text: '坏了',
    });
    feeds.recordFailure(id, '2026-11-16T12:03:00.000Z', { kind: 'network', text: '连不上' });
    feeds.markReported(id);
    feeds.setNextCheck(id, '2026-11-16T12:07:00.000Z');

    expect(feeds.source(id)).toMatchObject({
      lastCheckedAt: '2026-11-16T12:03:00.000Z',
      nextCheckAt: '2026-11-16T12:07:00.000Z',
      failure: {
        since: '2026-11-16T12:01:00.000Z',
        count: 2,
        kind: 'network',
        text: '连不上',
        reported: true,
      },
    });
    expect(feeds.source(id)!.failure).not.toHaveProperty('status');
    expect(feeds.source(id)).not.toHaveProperty('lastSuccessAt');

    // 这一轮从这一次重新算：从什么时候起、次数重来，说过没有不变
    feeds.recordFailure(id, '2026-11-16T20:00:00.000Z', {
      kind: 'timeout',
      text: '超时',
      restart: true,
    });
    expect(feeds.source(id)!.failure).toEqual({
      since: '2026-11-16T20:00:00.000Z',
      count: 1,
      kind: 'timeout',
      text: '超时',
      reported: true,
    });

    feeds.recordSuccess(id, '2026-11-16T20:10:00.000Z');
    expect(feeds.source(id)).toMatchObject({
      lastCheckedAt: '2026-11-16T20:10:00.000Z',
      lastSuccessAt: '2026-11-16T20:10:00.000Z',
    });
    expect(feeds.source(id)).not.toHaveProperty('failure');
    feeds.close();
  });

  it('谁在盯：一个任务只盯一个来源，再盯时换过去；游标可以空着；去掉', () => {
    const feeds = openFeedsDb(':memory:');
    const a = feeds.ensureSource(spec, at).id;
    const b = feeds.ensureSource({ ...spec, key: 'other' }, at).id;
    feeds.watch(7, a, undefined, at);
    feeds.watch(8, a, 3, at);

    expect(feeds.watcher(7)).toEqual({ taskId: 7, sourceId: a, createdAt: at });
    feeds.setCursor(7, 5);
    feeds.watch(8, b, 0, at);
    expect(feeds.watchers()).toEqual([
      { taskId: 7, sourceId: a, cursor: 5, createdAt: at },
      { taskId: 8, sourceId: b, cursor: 0, createdAt: at },
    ]);
    feeds.unwatch(7);
    expect(feeds.watcher(7)).toBeUndefined();
    expect(feeds.watchers()).toHaveLength(1);
    feeds.close();
  });

  it('版本 1 的库（只有每天的请求数）：打开时升到版本 2，计数还在；关掉再打开，来源和动态都在', () => {
    const path = tempPath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE service_requests (
        service TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (service, day)
      );
      INSERT INTO service_requests VALUES ('qweather', '2026-11-16', 12);
      PRAGMA user_version = 1;
    `);
    old.close();

    const feeds = openFeedsDb(path);
    expect(feeds.requestsOn('qweather', '2026-11-16')).toBe(12);
    const { id } = feeds.ensureSource(spec, at);
    feeds.storeItems(id, [{ key: 'a', data: '{"id":9007199254740993}' }], at);
    feeds.watch(1, id, feeds.lastItemId(id), at);
    feeds.close();

    const reopened = openFeedsDb(path);
    expect(reopened.items(id).map(({ data }) => data)).toEqual(['{"id":9007199254740993}']);
    expect(reopened.watcher(1)).toMatchObject({ sourceId: id });
    reopened.close();
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    check.close();
  });
});
