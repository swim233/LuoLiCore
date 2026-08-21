import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ReadTextFileRequest, WriteTextFileRequest } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpFs, FileTools, PathJail } from '@luoli/core';

/**
 * M13 · `fs/read_text_file` / `fs/write_text_file` 的宿主侧实现（`packages/core/src/acp/fs.ts`）。
 *
 * 这一族用例守的是**同一件事的两半**：交出去的正文能原样写回文件，交不出来的时候一个字节都不给。
 * ACP 的写是**全量覆盖** —— 带行号前缀的、被截断的、被 U+FFFD 替换过的、以及「参数算错之后
 * 纠正出来的空串」，任何一种正文经过 `agent 读 → 改两行 → 写回` 都是一次静默毁坏，而
 * `ReadTextFileResponse` 里只有 `content` 一个字段，没有任何地方说得出「这只是一段」。
 *
 * 第二件事是**拒绝的形状**：这一层的调用方是一台外部 agent 的 JSON-RPC 请求，它只看得见
 * `code` / `message` / `data`。越界被报成 `internalError` 时它会原样重试，而重试是无害的 ——
 * 真正的代价是运维照着那句话去查 agent 的退出码，什么也查不到。所以断言压在 `code` 与
 * `data.reason` 上，不只压在「抛了」上。
 *
 * 真目录、真软链、真文件，不套 mock：`realpathSync` 那道纪律只有在真软链上才被执行到。
 */
const ROOT = resolve('data/acp-fs-root');
const OUTSIDE = resolve('data/acp-fs-outside');
/** JSON-RPC 的三档。SDK 只导出 `ErrorCode` 这个**类型**，所以写字面量 —— 换 SDK 版本改了数就在这儿炸。 */
const INVALID_PARAMS = -32602, NOT_FOUND = -32002;
/** 一旦出现在错误里就说明正文漏出去了。刻意不含路径片段：hint 里本来就带相对路径。 */
const MARKER = 'NEVER-LEAK-THIS-BODY';
/** jail 的 root 必须是 realpath 过的那一份（`session/new` 的 cwd 与边界要是同一套字面量）。 */
let root = '';

/** 照 `AcpManager.#surface` 那三行原样搭起来 —— 换一套参数就不是被测的那条链了。 */
function subject(options: { deny?: string[]; maxRead?: number; maxWrite?: number } = {}): { fs: AcpFs; files: FileTools } {
  const jail = new PathJail(root, options.deny ?? [], { base: root });
  const files = new FileTools(jail, options.maxRead ?? 65_536, options.maxWrite ?? 65_536, { backupDir: '.luoli-bak' });
  return { fs: new AcpFs(files), files };
}
/** 协议里路径恒为绝对路径，`line` / `limit` 是 `number | null`（省略与 null 都得当「没给」）。 */
const read = (path: string, window: { line?: number | null; limit?: number | null } = {}): ReadTextFileRequest => ({ sessionId: 's-1', path, ...window });
const write = (path: string, content: string): WriteTextFileRequest => ({ sessionId: 's-1', path, content });
/**
 * 抛出来的那一个，按 `RequestError` 取回。`toThrow` 只看 message，而这一整份用例一半的判据在
 * `code` 与 `data.reason` 上 —— 那两个才是 agent 分支的依据。
 */
function refused(operation: () => unknown): RequestError {
  try { operation(); } catch (error) { expect(error).toBeInstanceOf(RequestError); return error as RequestError; }
  throw new Error('这次调用本该被拒绝，可它返回了');
}

beforeEach(() => {
  for (const dir of [ROOT, OUTSIDE]) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
  root = realpathSync(ROOT);
});
afterEach(() => { for (const dir of [ROOT, OUTSIDE]) rmSync(dir, { recursive: true, force: true }); });

describe('AcpFs · 交出去的正文就是磁盘上那些字节', () => {
  it('多行文件读回来逐字节等于磁盘，正文里没有 `行号<TAB>` 前缀', () => {
    // 这条是整个文件存在的理由：`FileTools.read()` 无条件加 `行号<TAB>`（对模型是对的，是 edit 的
    // 对照坐标），而 ACP 的写是全量覆盖 —— 走错那条路，agent 改两行就把整个文件换成带行号的垃圾。
    const { fs, files } = subject();
    const text = '1 一行以数字开头\nsecond line\n  两个空格缩进而不是制表符\n最后一行\n';
    writeFileSync(`${root}/notes.txt`, text);
    const content = fs.readTextFile(read(`${root}/notes.txt`)).content;
    expect(content).toBe(text);
    expect(Buffer.from(content, 'utf8').equals(readFileSync(`${root}/notes.txt`))).toBe(true);
    expect(content).not.toContain('\t');
    // 对照：同一个文件走 `read()` 一定带前缀。没有这一行，上面那条断言在验证自己的公理。
    expect(String((files.read(`${root}/notes.txt`) as { content: string }).content)).toContain('\t');
    expect(fs.reads).toBe(1);
  });

  it('分窗读是合法的：line + limit 给回的正好是那两行，同样不带行号', () => {
    // 与「超限」刻意分岔（见下面那一节）：**截断不合法，分窗合法** —— 分窗的边界是 agent 自己
    // 指定的，它知道手里只有一段；截断是我们替它决定的，而它无从知道。
    const { fs } = subject();
    const rows = ['第一行', '第二行', '第三行', '第四行', '第五行'];
    writeFileSync(`${root}/five.txt`, `${rows.join('\n')}\n`);
    const content = fs.readTextFile(read(`${root}/five.txt`, { line: 2, limit: 2 })).content;
    expect(content).toBe('第二行\n第三行\n');
    expect(content).not.toContain('\t');
    expect(content).not.toContain('第一行');
    expect(content).not.toContain('第四行');
    // 窗口正文也是磁盘上那一段的字节，不是「重新拼出来的等价物」。
    expect(Buffer.from(content, 'utf8').equals(readFileSync(`${root}/five.txt`).subarray(Buffer.byteLength('第一行\n'), Buffer.byteLength('第一行\n第二行\n第三行\n')))).toBe(true);
  });
});

describe('AcpFs · 边界上的拒绝说得出是边界拒的', () => {
  it('越界绝对路径读写都拒，报的是 invalidParams 而不是一句 internalError', () => {
    const { fs } = subject();
    // 外面那份真读得出来（内容里有标记），所以「抛了」才等于「一个字节都没交出去」。
    writeFileSync(`${OUTSIDE}/secret.txt`, `${MARKER}\n`);
    writeFileSync(`${root}/inside.txt`, 'ok\n');
    for (const path of [`${OUTSIDE}/secret.txt`, '/etc/passwd', `${root}/../acp-fs-outside/secret.txt`]) {
      const error = refused(() => fs.readTextFile(read(path)));
      expect(error.code).toBe(INVALID_PARAMS);
      expect(error.data).toMatchObject({ path, reason: 'path_outside_workspace' });
      expect(error.message).toContain('目录边界');
      expect(error.message).not.toContain(MARKER);
    }
    // 写侧同一道闸，且判据是**盘上没有那个文件**：错误码对而文件被建出来才是最坏的一种。
    const planted = refused(() => fs.writeTextFile(write(`${OUTSIDE}/planted.txt`, 'x')));
    expect(planted.data).toMatchObject({ reason: 'path_outside_workspace' });
    expect(existsSync(`${OUTSIDE}/planted.txt`)).toBe(false);
    // 同一个 jail 里正常路径照旧走得通 —— 上面几条不是把整条路读死了。
    expect(fs.readTextFile(read(`${root}/inside.txt`)).content).toBe('ok\n');
  });

  it('仓库内指向外面的软链、以及父目录是软链的路径，都在读到内容之前断掉', () => {
    // `realpathSync` 那道纪律就是为这一档存在的：按字符串前缀判边界的实现在这里全数放行，
    // 而 agent 手上拿到的是一条**看起来在仓库里**的路径。
    const { fs } = subject();
    writeFileSync(`${OUTSIDE}/secret.txt`, `${MARKER}\n`);
    symlinkSync(`${OUTSIDE}/secret.txt`, `${root}/escape.txt`);
    symlinkSync(OUTSIDE, `${root}/escape-dir`);
    for (const path of [`${root}/escape.txt`, `${root}/escape-dir/secret.txt`]) {
      const error = refused(() => fs.readTextFile(read(path)));
      expect(error.code).toBe(INVALID_PARAMS);
      expect(error.data).toMatchObject({ reason: 'path_outside_workspace' });
      expect(error.message).not.toContain(MARKER);
      refused(() => fs.writeTextFile(write(path, '覆盖你')));
    }
    // 软链另一头那份文件仍是原来的字节：写侧的拒绝也发生在落盘之前。
    expect(readFileSync(`${OUTSIDE}/secret.txt`, 'utf8')).toBe(`${MARKER}\n`);
    expect(fs.reads).toBe(0);
    expect(fs.writes).toBe(0);
  });

  it('denyGlobs 命中的文件读写都拒，且报的是 path_denied 不是「不在边界内」', () => {
    // 绝对路径形式的 glob。`PathJail` 会把反斜杠归一化，并把 `<root>` 替换成 `process.cwd()`——
    // 这里用 realpath 过的绝对形式，免得用例的成败挂在「仓库路径本身有没有软链」上。
    mkdirSync(`${root}/secret`, { recursive: true });
    writeFileSync(`${root}/secret/creds.txt`, `${MARKER}\n`);
    writeFileSync(`${root}/public.txt`, 'fine\n');
    const { fs } = subject({ deny: [`${root}/secret/**`] });
    const denied = refused(() => fs.readTextFile(read(`${root}/secret/creds.txt`)));
    expect(denied.code).toBe(INVALID_PARAMS);
    expect(denied.data).toMatchObject({ reason: 'path_denied' });
    // 两档分开报得清：`denyGlobs` 是运维配的名单，换个路径没用；越界是换个路径就好。
    expect(denied.message).toContain('denyGlobs');
    expect(denied.message).not.toContain(MARKER);
    refused(() => fs.writeTextFile(write(`${root}/secret/creds.txt`, '覆盖你')));
    expect(readFileSync(`${root}/secret/creds.txt`, 'utf8')).toBe(`${MARKER}\n`);
    // 名单是逐路径的，不是「这个会话别碰 fs 了」。
    expect(fs.readTextFile(read(`${root}/public.txt`)).content).toBe('fine\n');
  });

  /**
   * 这一档 agent 收到会去列目录；混进 `internalError` 的话它只会原样重试到超时，而混进
   * `invalidParams` 的话它会去改自己的参数格式 —— 两条都不是「路径打错了」该走的路。
   *
   * 「目录」与「不存在」是**两档**：前者存在，只是不是文件，所以走 `invalidParams` +
   * `is_a_directory`（`resourceNotFound` 会让 agent 以为路径打错了，然后去列一个它列不了的目录）。
   *
   * ⚠️ 目录那一档由 `AcpFs` 自己在委托 `FileTools` **之前**判掉，而那不是洁癖：`readLineWindow` 的
   * 循环判据是 `position < size`，而 `statSync(<空目录>).size` 在 btrfs 上是 0（ext4 是 4096）——
   * 于是空目录上一个 `readSync` 都不发生、EISDIR 永远不抛，交回的会是 `ok:true` + **空正文**，
   * 而空正文交给一个全量覆盖的写端正是这条链上最怕的那件事。所以用例两种目录都量：
   * **空目录那一条正是没有前置判据时会漏过去的那一条**，而「看文件系统」不能是安全边界上的判据。
   */
  it('不存在报 resourceNotFound，是目录报 invalidParams —— 空目录也一样', () => {
    const { fs } = subject();
    mkdirSync(`${root}/sub`, { recursive: true });
    writeFileSync(`${root}/sub/child.txt`, 'x\n');
    mkdirSync(`${root}/empty`, { recursive: true });
    const missing = refused(() => fs.readTextFile(read(`${root}/nope.txt`)));
    expect(missing.code).toBe(NOT_FOUND);
    expect(missing.message).toContain(`${root}/nope.txt`);
    for (const path of [`${root}/sub`, `${root}/empty`]) {
      const error = refused(() => fs.readTextFile(read(path)));
      expect(error.code).toBe(INVALID_PARAMS);
      expect(error.data).toMatchObject({ reason: 'is_a_directory' });
      // 写一个目录同样在备份那一步之前就被拒 —— 不拦的话它死在 `cpSync` 上，报一句不带 EISDIR 的
      // `Recursive option not enabled`，agent 拿它没法做任何事。
      expect(refused(() => fs.writeTextFile({ sessionId: 's', path, content: 'x' })).data).toMatchObject({ reason: 'is_a_directory' });
    }
    expect(fs.reads).toBe(0);
    expect(fs.writes).toBe(0);
  });
});

describe('AcpFs · 给不出完整正文时宁可什么都不给', () => {
  it('超 maxReadBytes 时抛错，被截断的正文一个字节都不外泄，而错误里带得出走的路', () => {
    const { fs } = subject({ maxRead: 64 });
    const body = `${Array.from({ length: 40 }, (_, index) => `${MARKER}-${index}`).join('\n')}\n`;
    writeFileSync(`${root}/big.txt`, body);
    const error = refused(() => fs.readTextFile(read(`${root}/big.txt`)));
    expect(error.code).toBe(INVALID_PARAMS);
    expect(error.data).toMatchObject({ reason: 'read_too_large' });
    // 判据是**没有正文漏出去**：截断过的正文交给一个全量覆盖的写端，就是静静删掉文件后半部分，
    // 而响应形状里没有任何字段能在写之前说出「这只是一段」。message 与 data 两处都要干净。
    expect(error.message).not.toContain(MARKER);
    expect(JSON.stringify(error.data ?? null)).not.toContain(MARKER);
    // agent 照着 hint 动作，所以 hint 必须指出出路（分窗读），而且那条出路真的走得通。
    expect(error.message).toContain('maxReadBytes');
    expect(error.message).toContain('分窗');
    const limit = Number(/limit: (\d+)/.exec(error.message)![1]);
    expect(limit).toBeGreaterThan(0);
    const page = fs.readTextFile(read(`${root}/big.txt`, { line: 1, limit })).content;
    expect(body.startsWith(page)).toBe(true);
    expect(fs.reads).toBe(1); // 失败那次不计
  });

  it('超 maxWriteBytes 时抛错，目标文件一个字节没动，也没留下半个文件或 .tmp', () => {
    const { fs } = subject({ maxWrite: 16 });
    writeFileSync(`${root}/keep.txt`, '旧的内容还在\n');
    const error = refused(() => fs.writeTextFile(write(`${root}/keep.txt`, 'x'.repeat(100))));
    expect(error.code).toBe(INVALID_PARAMS);
    expect(error.data).toMatchObject({ reason: 'write_too_large' });
    // `write_too_large` 交回来时是光秃秃一个错误码，`CODE_HINTS` 得给外部 agent 补一句 ——
    // 不补的话它只认得出「一个不认识的单词」，然后原样重试。
    expect(error.message).toContain('maxWriteBytes');
    expect(error.message).toContain('一个字节都没写');
    expect(readFileSync(`${root}/keep.txt`, 'utf8')).toBe('旧的内容还在\n');
    // 目录里干干净净：没有 `.tmp` 残留，也没有为一次没发生的写而建的备份目录。
    expect(readdirSync(root)).toEqual(['keep.txt']);
    expect(fs.writes).toBe(0);
  });

  it('非 UTF-8 抛错，不交回被 U+FFFD 替换过的正文', () => {
    // 与超限同一类：替换过的正文经全量覆盖写回去是一次静默毁坏，而返回形状里同样没有位置
    // 说得出「有损了」。所以二进制在这条路上是硬错误，不是「读出来一堆问号」。
    const { fs } = subject();
    writeFileSync(`${root}/blob.bin`, Buffer.from([0xff, 0xfe, 0x00]));
    const error = refused(() => fs.readTextFile(read(`${root}/blob.bin`)));
    expect(error.code).toBe(INVALID_PARAMS);
    expect(error.data).toMatchObject({ reason: 'not_utf8' });
    expect(error.message).toContain('UTF-8');
    expect(error.message).not.toContain('�');
    expect(fs.reads).toBe(0);
  });

  it('窗口参数不合形状一律拒收，而协议里的 null 当「没给」照旧读得通', () => {
    // `{limit: 0}` 纠正成「全读」会把一次分窗读悄悄变成全文读；`NaN` 纠正出来的是空正文，而
    // 空正文交给一个全量覆盖的写端就是**清空文件**。所以这里必须是拒收，不能是纠正。
    const { fs } = subject();
    const text = 'a\nb\nc\n';
    writeFileSync(`${root}/tiny.txt`, text);
    for (const window of [{ line: 0 }, { limit: 0 }, { line: 1.5 }, { limit: 2.5 }, { line: Number.NaN }, { limit: Number.NaN }]) {
      const error = refused(() => fs.readTextFile(read(`${root}/tiny.txt`, window)));
      expect(error.code).toBe(INVALID_PARAMS);
      expect(error.data).toMatchObject({ reason: 'invalid_line_window' });
      expect(error.message).toContain('≥1 的整数');
    }
    expect(fs.reads).toBe(0);
    // `line` / `limit` 在协议里是 `number | null`，null 是「这个字段我没填」而不是一个数值。
    expect(fs.readTextFile(read(`${root}/tiny.txt`, { line: null, limit: null })).content).toBe(text);
    expect(fs.readTextFile(read(`${root}/tiny.txt`, { line: 2, limit: null })).content).toBe('b\nc\n');
    expect(fs.reads).toBe(2);
  });
});

describe('AcpFs · 写路径顺带买到的备份，与那两个给人看的数', () => {
  it('覆盖写把上一版留在 <root>/.luoli-bak 里，而新建文件不留备份', () => {
    const { fs } = subject();
    fs.writeTextFile(write(`${root}/fresh.ts`, 'export const a = 1;\n'));
    expect(readFileSync(`${root}/fresh.ts`, 'utf8')).toBe('export const a = 1;\n');
    // 没有上一版就没有要留的东西：备份目录连建都不该建（凭空多一个目录，运维会来问）。
    expect(existsSync(`${root}/.luoli-bak`)).toBe(false);
    writeFileSync(`${root}/app.ts`, '第一版\n');
    fs.writeTextFile(write(`${root}/app.ts`, '第二版\n'));
    expect(readFileSync(`${root}/app.ts`, 'utf8')).toBe('第二版\n');
    /**
     * ⚠️ 备份落在**目标仓库里**（`<root>/.luoli-bak/<时间>-<ulid>-<文件名>`），于是它会出现在那个
     * 仓库的 `git status` 里。这是刻意的取舍：搬到仓库外就得另建一套「哪个备份属于哪个仓库」的账。
     * 这条断言钉住的正是**位置** —— 没有它，哪天有人觉得这个目录脏、顺手把它挪到仓库外或 tmp 下，
     * 不会有任何东西反对，而那笔账就此没人记得还清。
     */
    const backups = readdirSync(`${root}/.luoli-bak`);
    expect(backups).toHaveLength(1);
    expect(backups[0]!.endsWith('-app.ts')).toBe(true);
    expect(readFileSync(`${root}/.luoli-bak/${backups[0]}`, 'utf8')).toBe('第一版\n');
  });

  it('reads 数成功的次数，writes 数不同的文件，失败的一次都不计', () => {
    // `writes` 是进度卡片终帧给人看的那个数：数写入次数的话，同一个文件被改三遍会报成
    // 「改了 3 个文件」—— 那句话是假的，而看它的人没有别的途径核对。
    const { fs } = subject();
    writeFileSync(`${root}/a.txt`, 'a\n');
    writeFileSync(`${root}/b.txt`, 'b\n');
    fs.readTextFile(read(`${root}/a.txt`));
    fs.readTextFile(read(`${root}/b.txt`));
    fs.readTextFile(read(`${root}/a.txt`));
    expect(fs.reads).toBe(3);
    for (const version of ['一', '二', '三']) fs.writeTextFile(write(`${root}/same.txt`, `${version}\n`));
    expect(fs.writes).toBe(1);
    fs.writeTextFile(write(`${root}/other.txt`, 'x\n'));
    expect(fs.writes).toBe(2);
    // 失败的调用不许挪动这两个数：卡片上「读了 4 个、改了 3 个」而其中一次是越界拒绝，
    // 就把一次被挡住的越界说成了一次正常的读写。
    refused(() => fs.readTextFile(read(`${OUTSIDE}/nope.txt`)));
    refused(() => fs.readTextFile(read(`${root}/missing.txt`)));
    refused(() => fs.writeTextFile(write(`${OUTSIDE}/planted.txt`, 'x')));
    expect(fs.reads).toBe(3);
    expect(fs.writes).toBe(2);
  });
});
