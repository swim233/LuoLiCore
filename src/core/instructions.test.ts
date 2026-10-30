import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readInstructions } from './index.js';

describe('readInstructions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'luolicore-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('读取文件内容并去掉首尾空白', async () => {
    const path = join(dir, 'system.md');
    await writeFile(path, '\n\n  你是助手。\n\n第二段\n  \n');

    expect(await readInstructions(path)).toBe('你是助手。\n\n第二段');
  });

  it('文件不存在时抛错', async () => {
    await expect(readInstructions(join(dir, 'missing.md'))).rejects.toThrow();
  });
});
