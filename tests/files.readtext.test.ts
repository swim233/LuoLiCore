import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTools, PathJail, readLineWindow } from '@luoli/core';

/**
 * `FileTools.readText()` —— 不带行号的读（docs/05 §3.1）。
 *
 * 这一族用例守的是一次**静默的数据毁坏**：`read()` 无条件给正文加 `行号<TAB>` 前缀（对模型是
 * 对的，是 `edit_file` 的对照坐标），而将来要接上来的外部编码 agent 的写是**全量覆盖** ——
 * 「读出来 → 改两行 → 写回去」一旦走的是带前缀的那条路，整个文件就被换成加了行号的垃圾。
 * 所以「正文逐字节等于磁盘内容」那一条是这里最重要的断言，且它带一条 `read()` 的对照，
 * 免得断言退化成重言式。
 *
 * 第二件事是**超预算 fail-closed**：调用方的响应形状里没有 truncated 的位置，截断了没有任何
 * 地方能说出口，而「截断的正文 + 全量覆盖」= 静静删掉文件的后半部分。
 */

function jail(name: string, maxRead = 1024, denyGlobs: string[] = []): { root: string; outside: string; files: FileTools } {
  const root = resolve(`data/readtext-${name}`);
  const outside = resolve(`data/readtext-${name}-outside`);
  for (const dir of [root, outside]) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
  return { root, outside, files: new FileTools(new PathJail(root, denyGlobs), maxRead, 65_536) };
}

describe('readText 的正文逐字节等于磁盘内容', () => {
  it('不带行号前缀，且 CRLF / 多字节 / 结尾换行都原样留住', () => {
    const { root, files } = jail('round-trip', 65_536);
    // 刻意混进：行首数字（前缀混进来就分不清了）、CRLF、四字节 emoji、CJK、结尾换行。
    const text = '1 一行以数字开头\r\n第二行 🍥 与中文\nlast\n';
    writeFileSync(`${root}/round-trip.txt`, text);
    const result = files.readText('round-trip.txt') as { ok: boolean; content: string; lines: number; eof: boolean; bytes: number };
    expect(result.ok).toBe(true);
    expect(Buffer.from(result.content, 'utf8').equals(readFileSync(`${root}/round-trip.txt`))).toBe(true);
    expect(result.content).toBe(text);
    expect(result.content).not.toContain('\t');
    expect(/^\s*\d+\t/m.test(result.content)).toBe(false);
    expect(result).toMatchObject({ lines: 3, eof: true, bytes: Buffer.byteLength(text) });
    // 对照：同一个文件走 `read()` 一定带前缀。没有这一行，上面那条断言在验证自己的公理。
    expect(/^1\t/.test((files.read('round-trip.txt') as { content: string }).content)).toBe(true);
  });

  it('BOM 不被吃掉 —— 少一个 BOM 也是一次改写', () => {
    const { root, files } = jail('bom', 65_536);
    const text = '﻿head\nbody\n';
    writeFileSync(`${root}/bom.txt`, text);
    const result = files.readText('bom.txt') as { content: string };
    expect(result.content.startsWith('﻿')).toBe(true);
    expect(Buffer.from(result.content, 'utf8').equals(readFileSync(`${root}/bom.txt`))).toBe(true);
  });

  it('末行没有换行时也不补一个出来', () => {
    const { root, files } = jail('no-eol', 65_536);
    writeFileSync(`${root}/no-eol.txt`, 'a\nb');
    const result = files.readText('no-eol.txt') as { content: string; lines: number; endLine: number };
    expect(result).toMatchObject({ content: 'a\nb', lines: 2, endLine: 2 });
  });
});

describe('readText 的行窗口', () => {
  const ten = `${Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n')}\n`;

  it('起始行 1-based，行数按 limit，正文仍不带前缀', () => {
    const { root, files } = jail('window', 65_536);
    writeFileSync(`${root}/ten.txt`, ten);
    expect(files.readText('ten.txt', { line: 3, limit: 2 })).toMatchObject({ ok: true, content: 'line-3\nline-4\n', startLine: 3, endLine: 4, lines: 2, eof: false });
    expect(files.readText('ten.txt', { line: 1, limit: 1 })).toMatchObject({ content: 'line-1\n', endLine: 1 });
  });

  it('最后一窗不足 limit 时读到文件末尾并置 eof', () => {
    const { root, files } = jail('window-tail', 65_536);
    writeFileSync(`${root}/ten.txt`, ten);
    expect(files.readText('ten.txt', { line: 9, limit: 5 })).toMatchObject({ content: 'line-9\nline-10\n', startLine: 9, endLine: 10, lines: 2, eof: true });
    // 末行无换行的同一个边界：窗口要含住那半行，而不是当它不存在。
    writeFileSync(`${root}/nine.txt`, ten.slice(0, -1));
    expect(files.readText('nine.txt', { line: 10, limit: 5 })).toMatchObject({ content: 'line-10', endLine: 10, lines: 1, eof: true });
  });

  it('起始行越过文件末尾交回空窗口，而不是退回从头读', () => {
    const { root, files } = jail('window-past', 65_536);
    writeFileSync(`${root}/ten.txt`, ten);
    expect(files.readText('ten.txt', { line: 99 })).toMatchObject({ ok: true, content: '', lines: 0, endLine: 98, eof: true });
  });

  it('拼接后再解码：多字节字符不会在分块边界上被切坏', () => {
    const { root, files } = jail('chunk-utf8', 1 << 20);
    // 64KiB 的扫描缓冲边界上必然落在一个四字节字符中间（padding 长度与 4 不互质地错开）。
    writeFileSync(`${root}/wide.txt`, `${'x'.repeat(65_535)}🍥\ntail\n`);
    const result = files.readText('wide.txt') as { content: string };
    expect(result.content).not.toContain('�');
    expect(Buffer.from(result.content, 'utf8').equals(readFileSync(`${root}/wide.txt`))).toBe(true);
  });
});

describe('readText 的路径边界与 read() 同一道闸', () => {
  it('越界绝对路径与仓库内指向外面的软链都在读到内容之前就断', () => {
    const { root, outside, files } = jail('escape', 65_536);
    // 外面那份是真能读出来的（内容里有标记），所以「抛了」就等于「一个字节都没交出去」。
    writeFileSync(`${outside}/secret.txt`, 'MARKER-DO-NOT-LEAK\n');
    symlinkSync(`${outside}/secret.txt`, `${root}/escape`);
    writeFileSync(`${root}/inside.txt`, 'ok\n');
    expect(() => files.readText('escape')).toThrow('path_outside_workspace');
    expect(() => files.readText(`${outside}/secret.txt`)).toThrow('path_outside_workspace');
    expect(() => files.readText('../')).toThrow('path_outside_workspace');
    // 同一个 jail 里正常路径照旧能读 —— 上面三条不是把整条路读死了。
    expect(files.readText('inside.txt')).toMatchObject({ ok: true, content: 'ok\n' });
  });

  it('denyGlobs 命中的路径抛 path_denied（字面量按现有用例与日志匹配）', () => {
    const { root, files } = jail('deny', 65_536, ['**/.env*']);
    writeFileSync(`${root}/.env`, 'LUOLI_MASTER_KEY=x\n');
    expect(() => files.readText('.env')).toThrow('path_denied');
  });
});

describe('readText 超预算一律 fail-closed', () => {
  it('不带窗口且超 maxReadBytes：报 read_too_large，不交回任何正文', () => {
    const { root, files } = jail('too-large', 1024);
    const big = `${Array.from({ length: 400 }, (_, index) => `line-${index + 1}`).join('\n')}\n`;
    writeFileSync(`${root}/big.txt`, big);
    const result = files.readText('big.txt') as { ok: boolean; error: string; hint: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('read_too_large');
    // 截断的正文 + 全量覆盖 = 静静删掉文件后半部分，所以结果里连一个正文字段都不能有。
    expect(result).not.toHaveProperty('content');
    expect(Object.keys(result).sort()).toEqual(['error', 'hint', 'ok']);
    expect(result.hint).toContain('line');
    expect(result.hint).toContain('limit');
    expect(result.hint).toContain(String(Buffer.byteLength(big)));
    // hint 里那个 limit 建议真的读得动。
    const suggested = Number(/limit: (\d+)/.exec(result.hint)![1]);
    expect(suggested).toBeGreaterThan(0);
    expect(files.readText('big.txt', { line: 1, limit: suggested })).toMatchObject({ ok: true, eof: false });
  });

  it('窗口本身超预算同样报错，而不是悄悄少给几行', () => {
    const { root, files } = jail('window-too-large', 64);
    writeFileSync(`${root}/mid.txt`, `${Array.from({ length: 40 }, () => 'abcdefgh').join('\n')}\n`);
    expect(files.readText('mid.txt', { line: 1, limit: 40 })).toMatchObject({ ok: false, error: 'read_too_large' });
    expect(files.readText('mid.txt', { line: 1, limit: 5 })).toMatchObject({ ok: true, lines: 5 });
  });

  it('恰好用满预算不算 overflow，多一个字节才算', () => {
    const { root, files } = jail('budget-edge', 1024);
    // fail-closed 的闸最容易错的就是这一个字节，所以断言压在 maxReadBytes 与 +1 上。
    writeFileSync(`${root}/exact.txt`, `${'z'.repeat(1023)}\n`);
    expect(files.readText('exact.txt')).toMatchObject({ ok: true, bytes: 1024, lines: 1, eof: true });
    writeFileSync(`${root}/over.txt`, `${'z'.repeat(1024)}\n`);
    expect(files.readText('over.txt')).toMatchObject({ ok: false, error: 'read_too_large' });
    // 窗口正好用满而文件后面还有内容：仍是 ok，且 eof 说得出「这只是一段」。
    writeFileSync(`${root}/paged.txt`, `${'z'.repeat(1023)}\n${'w'.repeat(2000)}\n`);
    expect(files.readText('paged.txt', { line: 1, limit: 1 })).toMatchObject({ ok: true, bytes: 1024, endLine: 1, eof: false });
  });

  it('窗口参数不合形状一律拒收，不静静纠正成另一个窗口', () => {
    const { root, files } = jail('bad-window', 1024);
    writeFileSync(`${root}/ten.txt`, 'a\nb\nc\n');
    // NaN 走不到这道闸的话：`Math.max(1, NaN)` 是 NaN 且 NaN 的比较全假 —— 定位阶段整段被跳过，
    // 交回的是「第 1 行起的窗口」而坐标是 NaN（JSON 序列化后是 null）。
    for (const line of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(files.readText('ten.txt', { line })).toMatchObject({ ok: false, error: 'invalid_line_window' });
    }
    // `limit: 0` 更危险：它此前是 ok:true + 空正文，而空正文交给全量覆盖的写端就是清空文件。
    for (const limit of [Number.NaN, 0, -3, 2.5]) {
      expect(files.readText('ten.txt', { limit })).toMatchObject({ ok: false, error: 'invalid_line_window' });
    }
    expect(files.readText('ten.txt', { line: 2, limit: 1 })).toMatchObject({ ok: true, content: 'b\n' });
    // 越界仍然优先：安全信号不该被一句参数抱怨盖掉。
    expect(() => files.readText('../', { limit: 0 })).toThrow('path_outside_workspace');
  });

  it('单行就超预算时 hint 说清这条路走不通，不给一个读不动的 limit', () => {
    const { root, files } = jail('one-long-line', 64);
    writeFileSync(`${root}/long.txt`, `${'x'.repeat(500)}\n`);
    const result = files.readText('long.txt') as { ok: boolean; hint: string };
    expect(result.ok).toBe(false);
    expect(result.hint).not.toMatch(/limit: \d/);
    expect(result.hint).toContain('read_file');
  });
});

describe('readLineWindow 自己也不产出被截断的正文', () => {
  it('overflow 时 content 是空串 —— 不变量落在产生侧，不靠调用方记得别读', () => {
    const { root } = jail('producer-side', 65_536);
    writeFileSync(`${root}/big.txt`, `${'q'.repeat(400)}\n`.repeat(10));
    const window = readLineWindow(`${root}/big.txt`, 1, 10, 1024);
    expect(window.overflow).toBe(true);
    expect(window.content).toBe('');
    // 但「读到哪儿」照旧说得出口 —— 那是 hint 唯一的依据。
    expect(window.bytes).toBe(1024);
    expect(window.endLine).toBeGreaterThanOrEqual(window.startLine);
  });
});

/**
 * 非 UTF-8 与超预算是同一类问题的两种形态：正文会被原样写回文件，而「被 U+FFFD 替换过」与
 * 「被截断」都毁文件，且返回形状里都没有字段能在写之前说出口。所以这条路 `fatal: true`，
 * **与 `read()` 刻意分岔**（那边的正文给模型看、从不写回，有损是可接受的）。
 */
describe('readText 对非 UTF-8 也 fail-closed', () => {
  it('坏字节报 not_utf8，不交回被替换过的正文', () => {
    const { root, files } = jail('not-utf8', 65_536);
    // 0xFF / 0xFE 在 UTF-8 里永远非法。6 个字节有损解码会解出 12 字节正文（每个变 U+FFFD），
    // 于是 bytes 与 Buffer.byteLength(content) 从此不等 —— 而没人会去比这两个数，这正是要拒的理由。
    writeFileSync(`${root}/blob.bin`, Buffer.from([0xff, 0xfe, 0xff, 0xfe, 0xff, 0xfe]));
    const result = files.readText('blob.bin') as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['error', 'hint', 'ok']);
    expect(result).toMatchObject({ ok: false, error: 'not_utf8' });
    expect(String(result.hint)).toContain('read_file');
  });

  it('对照：同一个文件走 read() 照旧有损解码交回正文', () => {
    const { root, files } = jail('not-utf8-contrast', 65_536);
    writeFileSync(`${root}/blob.bin`, Buffer.from([0xff, 0xfe, 0xff]));
    // 没有这一条，上面那条断言证明不了「分岔」是有意的 —— 只能证明这个文件读不出来。
    const lossy = files.read('blob.bin') as { ok?: boolean; content?: string };
    expect(lossy.content).toContain('�');
  });

  it('合法 UTF-8 被窗口切在多字节字符中间时不误报 not_utf8', () => {
    const { root, files } = jail('window-boundary', 65_536);
    // 窗口只在换行处或预算处切，而预算处一律 overflow 不产出正文 —— 所以窗口切分本身
    // 永远不该造出一次假的 not_utf8。这条守的是 fatal:true 不会带来误伤。
    writeFileSync(`${root}/wide.txt`, `${'🍥'.repeat(200)}\n${'漢'.repeat(200)}\n`);
    const result = files.readText('wide.txt', { line: 2, limit: 1 }) as { ok: boolean; content: string };
    expect(result.ok).toBe(true);
    expect(result.content).toBe(`${'漢'.repeat(200)}\n`);
  });

  it('readLineWindow 自己在 notUtf8 时也不产出正文', () => {
    const { root } = jail('not-utf8-producer', 65_536);
    writeFileSync(`${root}/blob.bin`, Buffer.from([0xc0, 0x80]));
    const window = readLineWindow(`${root}/blob.bin`, 1, Number.POSITIVE_INFINITY, 65_536);
    expect(window.notUtf8).toBe(true);
    expect(window.content).toBe('');
    expect(window.bytes).toBe(2); // 「读到多少字节」照旧说得出口
  });
});

describe('readLineWindow 的内存上界', () => {
  it('8MB 文件里取两行不把整份读进内存', () => {
    const { root } = jail('bounded');
    const path = `${root}/huge.txt`;
    // 8MB：远超 256KiB 的预算。旧形状（`readFileSync().split('\n')`）在这里一次分配 8MB，
    // 而 workspace 里的大文件正是 `bash` / `python` 自己造出来的（docs/27 · R-02）。
    writeFileSync(path, `${'y'.repeat(99)}\n`.repeat(80_000));
    // Buffer 走的是 ArrayBuffer 外部内存，heapUsed 看不见它 —— 判据只能是 `arrayBuffers`。
    const before = process.memoryUsage().arrayBuffers;
    const window = readLineWindow(path, 2, 2, 256 * 1024);
    const windowDelta = process.memoryUsage().arrayBuffers - before;
    expect(window).toMatchObject({ startLine: 2, endLine: 3, lines: 2, bytes: 200, eof: false, overflow: false });
    expect(window.content).toBe(`${'y'.repeat(99)}\n${'y'.repeat(99)}\n`);
    // 对照：整份读同一个文件。没有这一头，上面那个 delta 无从判断大小。
    const controlBefore = process.memoryUsage().arrayBuffers;
    const whole = readFileSync(path);
    const controlDelta = process.memoryUsage().arrayBuffers - controlBefore;
    expect(whole.length).toBe(8_000_000);
    expect(controlDelta).toBeGreaterThan(4 * 1024 * 1024);
    expect(windowDelta).toBeLessThan(1024 * 1024);
    rmSync(root, { recursive: true, force: true }); // 只有这一条留 8MB 在盘上，用完删掉
  }, 30_000);
});
