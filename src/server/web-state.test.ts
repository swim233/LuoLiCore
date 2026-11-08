import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openWebState, type WebState } from './web-state.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'luoli-webdb-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'web.db');
}

async function open(path: string, initial: Array<[string, number]> = []) {
  let asked = 0;
  const state = await openWebState(path, async () => {
    asked++;
    return initial;
  });
  cleanups.push(async () => state.close());
  return { state, asked: () => asked };
}

describe('网页状态库（web.db）', () => {
  it('第一次建立时用现有会话初始化已读位置；没记过的会话为 0', async () => {
    const { state, asked } = await open(await tempPath(), [
      ['a', 12],
      ['b', 3],
    ]);

    expect(asked()).toBe(1);
    expect(state.readSeq('a')).toBe(12);
    expect(state.readSeq('b')).toBe(3);
    expect(state.readSeq('new')).toBe(0);
  });

  it('再打开已有的文件：不再初始化，已读位置还在', async () => {
    const path = await tempPath();
    const first = await open(path, [['a', 5]]);
    first.state.advanceRead('a', 9);
    first.state.close();

    const second = await open(path, [['a', 100]]);
    expect(second.asked()).toBe(0);
    expect(second.state.readSeq('a')).toBe(9);
  });

  it('已读位置只往前走', async () => {
    const { state } = await open(await tempPath(), [['a', 5]]);

    expect(state.advanceRead('a', 8)).toBe(8);
    expect(state.advanceRead('a', 6)).toBe(8);
    expect(state.advanceRead('a', 8)).toBe(8);
    expect(state.advanceRead('new', 2)).toBe(2);
    expect(state.readSeq('a')).toBe(8);
  });

  it('文件的版本比程序新时报错，不动文件', async () => {
    const path = await tempPath();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    await expect(openWebState(path, async () => [])).rejects.toThrow('版本比程序新');
  });

  it('初始化出错时不留下半截：下次打开重新初始化', async () => {
    const path = await tempPath();
    await expect(
      openWebState(path, async () => {
        throw new Error('读不了会话');
      }),
    ).rejects.toThrow('读不了会话');

    const { state, asked } = await open(path, [['a', 4]]);
    expect(asked()).toBe(1);
    expect(state.readSeq('a')).toBe(4);
  });

  it('关闭后可以再关闭', async () => {
    const { state } = await open(await tempPath());
    state.close();
    expect(() => (state as WebState).close()).not.toThrow();
  });
});
