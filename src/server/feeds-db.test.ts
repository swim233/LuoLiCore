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

  it('版本 1 的库（只有每天的请求数）：打开时升到最新的版本，计数还在；关掉再打开，来源和动态都在', () => {
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
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    check.close();
  });

  it('版本 2 的库：打开时升到版本 3，每天的请求数、来源、动态、谁在盯都还在；按来源往前翻、往后看、最后一条照旧', () => {
    const path = tempPath();
    // 版本 2 的样子：照版本 2 的表结构写好数据，不经过版本 3 的程序
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE service_requests (
        service TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (service, day)
      );
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE,
        service TEXT NOT NULL, endpoint TEXT NOT NULL, params TEXT NOT NULL, items TEXT NOT NULL,
        item_key TEXT NOT NULL, created_at TEXT NOT NULL, last_checked_at TEXT, last_success_at TEXT,
        next_check_at TEXT, failing_since TEXT, failures INTEGER NOT NULL DEFAULT 0, failure_kind TEXT,
        failure_status INTEGER, failure_text TEXT, failure_reported INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE feed_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL REFERENCES sources(id),
        item_key TEXT NOT NULL, first_seen_at TEXT NOT NULL, data TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0, UNIQUE (source_id, item_key)
      );
      CREATE TABLE watchers (
        task_id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id),
        cursor INTEGER, created_at TEXT NOT NULL
      );
      CREATE INDEX watchers_source ON watchers(source_id);
      PRAGMA user_version = 2;
    `);
    old
      .prepare(
        `INSERT INTO sources (identity, service, endpoint, params, items, item_key, created_at,
           last_success_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceIdentity(spec),
        spec.service,
        spec.endpoint,
        JSON.stringify({ latitude: 31.23, localTime: true, longitude: 121.47 }),
        spec.items,
        spec.key,
        at,
        at,
      );
    old.exec(`INSERT INTO sources (identity, service, endpoint, params, items, item_key, created_at)
      VALUES ('other', 'demo', 'search', '{}', 'list', 'id', '${at}')`);
    const insert = old.prepare(
      'INSERT INTO feed_items (source_id, item_key, first_seen_at, data) VALUES (?, ?, ?, ?)',
    );
    // 两个来源的动态交错着存：1、3、5 是第一个来源的
    for (const [source, key] of [
      [1, 'a'],
      [2, 'x'],
      [1, 'b'],
      [2, 'y'],
      [1, 'c'],
    ] as const) {
      insert.run(source, key, at, `{"id":"${key}"}`);
    }
    old.exec(`INSERT INTO service_requests VALUES ('qweather', '2026-11-16', 12);
      INSERT INTO watchers VALUES (7, 1, 3, '${at}');`);
    old.close();

    const feeds = openFeedsDb(path);
    expect(feeds.requestsOn('qweather', '2026-11-16')).toBe(12);
    expect(feeds.findSource(spec)).toMatchObject({ id: 1, lastSuccessAt: at });
    expect(feeds.watcher(7)).toEqual({ taskId: 7, sourceId: 1, cursor: 3, createdAt: at });
    expect(feeds.itemCount(1)).toBe(3);
    expect(feeds.lastItemId(1)).toBe(5);
    expect(feeds.itemsAfter(1, 1).map(({ key }) => key)).toEqual(['b', 'c']);
    expect(feeds.itemsBefore(1, undefined, 2).map(({ id, key }) => [id, key])).toEqual([
      [5, 'c'],
      [3, 'b'],
    ]);
    expect(feeds.itemsBefore(1, 3, 10).map(({ key }) => key)).toEqual(['a']);
    expect(feeds.itemsBefore(2, undefined, 10).map(({ key }) => key)).toEqual(['y', 'x']);
    // 升级以后照常写：新的编号接在后面，见过的不再存
    expect(
      feeds.storeItems(
        1,
        [
          { key: 'd', data: '{"id":"d"}' },
          { key: 'a', data: '{"id":"a"}' },
        ],
        at,
      ),
    ).toBe(1);
    expect(feeds.itemsBefore(1, undefined, 1).map(({ key }) => key)).toEqual(['d']);
    feeds.close();

    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    check.close();
  });

  it('新建的库直接是最新的版本；比程序新的库打不开，文件不动', () => {
    const path = tempPath();
    openFeedsDb(path).close();
    const created = new DatabaseSync(path, { readOnly: true });
    expect(created.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    created.close();

    const newer = tempPath();
    const raw = new DatabaseSync(newer);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    expect(() => openFeedsDb(newer)).toThrow('feeds.db 的版本比程序新（文件为 99，程序支持 3）');
    const after = new DatabaseSync(newer, { readOnly: true });
    expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(99);
    after.close();
  });
});
