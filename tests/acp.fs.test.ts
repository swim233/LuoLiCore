import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ReadTextFileRequest, WriteTextFileRequest } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpFs, FileTools, PathJail } from '@luoli/core';

/**
 * M13 · `fs/read_text_file` / `fs/write_text_file` 的宿主侧实现（`packages/core/src/acp/fs.ts`）。
 *
 * 本组用例验证同一件事的两个方面：返回的正文能原样写回文件，无法返回时不输出任何字节。
 * ACP 的写入是全量覆盖，带行号前缀的、被截断的、被 U+FFFD 替换过的，以及参数计算错误后
 * 纠正得到的空串，任何一种正文经过 agent 读取、修改两行、写回的流程都会造成静默破坏，而
 * `ReadTextFileResponse` 中只有 `content` 一个字段，无处说明这只是部分内容。
 *
 * 第二个方面是拒绝的形式：这一层的调用方是外部 agent 的 JSON-RPC 请求，它只能看到
 * `code`、`message` 与 `data`。越界被报为 `internalError` 时它会原样重试，重试本身无害，
 * 真正的代价是运维据此去查 agent 的退出码而查不到任何信息。因此断言落在 `code` 与
 * `data.reason` 上，而不仅是是否抛错。
 *
 * 使用真实目录、真实软链、真实文件，不使用 mock：`realpathSync` 那道约束只有在真实软链上才会被执行。
 */
const ROOT = resolve('data/acp-fs-root');
const OUTSIDE = resolve('data/acp-fs-outside');
/** JSON-RPC 的三档。SDK 只导出 `ErrorCode` 类型，因此这里写字面量；SDK 版本变更数值时会在此报错。 */
const INVALID_PARAMS = -32602, NOT_FOUND = -32002;
/** 一旦出现在错误中即说明正文已泄漏。有意不含路径片段：hint 中本就包含相对路径。 */
const MARKER = 'NEVER-LEAK-THIS-BODY';
/** jail 的 root 必须是经 realpath 处理的那一份（`session/new` 的 cwd 与边界需使用同一套字面量）。 */
let root = '';

/** 按 `AcpManager.#surface` 的三行原样构造：更换参数后即不再是被测的那条链路。 */
function subject(options: { deny?: string[]; maxRead?: number; maxWrite?: number } = {}): { fs: AcpFs; files: FileTools } {
  const jail = new PathJail(root, options.deny ?? [], { base: root });
  const files = new FileTools(jail, options.maxRead ?? 65_536, options.maxWrite ?? 65_536, { backupDir: '.luoli-bak' });
  return { fs: new AcpFs(files), files };
}
/** 协议中路径恒为绝对路径，`line` 与 `limit` 为 `number | null`（省略与 null 都视为未提供）。 */
const read = (path: string, window: { line?: number | null; limit?: number | null } = {}): ReadTextFileRequest => ({ sessionId: 's-1', path, ...window });
const write = (path: string, content: string): WriteTextFileRequest => ({ sessionId: 's-1', path, content });
/**
 * 取回抛出的那个错误，按 `RequestError` 处理。`toThrow` 只检查 message，而本文件一半的判据在
 * `code` 与 `data.reason` 上，这两项才是 agent 分支判断的依据。
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
    // 这条是本文件存在的核心理由：`FileTools.read()` 无条件添加 `行号<TAB>`（对模型是正确的，用作 edit 的
    // 对照坐标），而 ACP 的写入是全量覆盖；走错该路径时，agent 修改两行即会把整个文件替换为带行号的内容。
    const { fs, files } = subject();
    const text = '1 一行以数字开头\nsecond line\n  两个空格缩进而不是制表符\n最后一行\n';
    writeFileSync(`${root}/notes.txt`, text);
    const content = fs.readTextFile(read(`${root}/notes.txt`)).content;
    expect(content).toBe(text);
    expect(Buffer.from(content, 'utf8').equals(readFileSync(`${root}/notes.txt`))).toBe(true);
    expect(content).not.toContain('\t');
    // 对照组：同一文件经 `read()` 必定带前缀。没有这一行时，上面那条断言只是在验证自身前提。
    expect(String((files.read(`${root}/notes.txt`) as { content: string }).content)).toContain('\t');
    expect(fs.reads).toBe(1);
  });

  it('分窗读是合法的：line + limit 给回的正好是那两行，同样不带行号', () => {
    // 与超限有意分开处理（见下一节）：截断不合法而分窗合法。分窗的边界由 agent 自行
    // 指定，它知道自己只取了一段；截断是本方替它决定的，而它无从知晓。
    const { fs } = subject();
    const rows = ['第一行', '第二行', '第三行', '第四行', '第五行'];
    writeFileSync(`${root}/five.txt`, `${rows.join('\n')}\n`);
    const content = fs.readTextFile(read(`${root}/five.txt`, { line: 2, limit: 2 })).content;
    expect(content).toBe('第二行\n第三行\n');
    expect(content).not.toContain('\t');
    expect(content).not.toContain('第一行');
    expect(content).not.toContain('第四行');
    // 窗口正文同样是磁盘上该段的原始字节，而非重新拼接的等价内容。
    expect(Buffer.from(content, 'utf8').equals(readFileSync(`${root}/five.txt`).subarray(Buffer.byteLength('第一行\n'), Buffer.byteLength('第一行\n第二行\n第三行\n')))).toBe(true);
  });
});

describe('AcpFs · 边界上的拒绝说得出是边界拒的', () => {
  it('越界绝对路径读写都拒，报的是 invalidParams 而不是一句 internalError', () => {
    const { fs } = subject();
    // 外部那份确实可读（内容中含标记），因此抛错才等价于未返回任何字节。
    writeFileSync(`${OUTSIDE}/secret.txt`, `${MARKER}\n`);
    writeFileSync(`${root}/inside.txt`, 'ok\n');
    for (const path of [`${OUTSIDE}/secret.txt`, '/etc/passwd', `${root}/../acp-fs-outside/secret.txt`]) {
      const error = refused(() => fs.readTextFile(read(path)));
      expect(error.code).toBe(INVALID_PARAMS);
      expect(error.data).toMatchObject({ path, reason: 'path_outside_workspace' });
      expect(error.message).toContain('目录边界');
      expect(error.message).not.toContain(MARKER);
    }
    // 写入侧使用同一道闸，且判据是磁盘上不存在该文件：错误码正确但文件已被创建是最糟的情形。
    const planted = refused(() => fs.writeTextFile(write(`${OUTSIDE}/planted.txt`, 'x')));
    expect(planted.data).toMatchObject({ reason: 'path_outside_workspace' });
    expect(existsSync(`${OUTSIDE}/planted.txt`)).toBe(false);
    // 同一 jail 内的正常路径仍然可用：上面几条并未阻断整条路径。
    expect(fs.readTextFile(read(`${root}/inside.txt`)).content).toBe('ok\n');
  });

  it('仓库内指向外面的软链、以及父目录是软链的路径，都在读到内容之前断掉', () => {
    // `realpathSync` 那道约束正是为该档位而设：按字符串前缀判定边界的实现在此会全部放行，
    // 而 agent 拿到的是一条看似位于仓库内的路径。
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
    // 软链指向的那份文件仍保持原有字节：写入侧的拒绝同样发生在落盘之前。
    expect(readFileSync(`${OUTSIDE}/secret.txt`, 'utf8')).toBe(`${MARKER}\n`);
    expect(fs.reads).toBe(0);
    expect(fs.writes).toBe(0);
  });

  it('denyGlobs 命中的文件读写都拒，且报的是 path_denied 不是「不在边界内」', () => {
    // 绝对路径形式的 glob。`PathJail` 会归一化反斜杠，并把 `<root>` 替换为 `process.cwd()`；
    // 这里使用经 realpath 处理的绝对形式，避免用例结果取决于仓库路径本身是否包含软链。
    mkdirSync(`${root}/secret`, { recursive: true });
    writeFileSync(`${root}/secret/creds.txt`, `${MARKER}\n`);
    writeFileSync(`${root}/public.txt`, 'fine\n');
    const { fs } = subject({ deny: [`${root}/secret/**`] });
    const denied = refused(() => fs.readTextFile(read(`${root}/secret/creds.txt`)));
    expect(denied.code).toBe(INVALID_PARAMS);
    expect(denied.data).toMatchObject({ reason: 'path_denied' });
    // 两档分开报告更清晰：`denyGlobs` 是运维配置的名单，更换路径无效；越界则更换路径即可解决。
    expect(denied.message).toContain('denyGlobs');
    expect(denied.message).not.toContain(MARKER);
    refused(() => fs.writeTextFile(write(`${root}/secret/creds.txt`, '覆盖你')));
    expect(readFileSync(`${root}/secret/creds.txt`, 'utf8')).toBe(`${MARKER}\n`);
    // 名单按路径生效，而不是禁止该会话使用 fs。
    expect(fs.readTextFile(read(`${root}/public.txt`)).content).toBe('fine\n');
  });

  /**
   * 该档位下 agent 收到后会去列目录；若归入 `internalError`，它只会原样重试直至超时；若归入
   * `invalidParams`，它会去调整自身的参数格式，两者都不是路径错误应走的处理路径。
   *
   * 目录与不存在属于两个档位：前者存在，只是不是文件，因此使用 `invalidParams` 加
   * `is_a_directory`（`resourceNotFound` 会让 agent 误以为路径写错，进而去列一个它无法列出的目录）。
   *
   * ⚠️ 目录档位由 `AcpFs` 在委托 `FileTools` 之前自行判定，这并非多余：`readLineWindow` 的
   * 循环判据是 `position < size`，而 `statSync(<空目录>).size` 在 btrfs 上为 0（ext4 上为 4096），
   * 于是空目录上不会发生任何 `readSync`、EISDIR 永不抛出，返回的会是 `ok:true` 加空正文，
   * 而空正文交给全量覆盖的写入端正是这条链路上最危险的情形。因此用例覆盖两种目录：
   * 空目录那一条正是缺少前置判据时会漏过的情形，而依赖文件系统行为不能作为安全边界的判据。
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
      // 写入目录同样在备份步骤之前即被拒绝：不拦截时它会在 `cpSync` 处失败，报出不含 EISDIR 的
      // `Recursive option not enabled`，agent 据此无法采取任何操作。
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
    // 判据是没有正文泄漏：截断后的正文交给全量覆盖的写入端，等同于静默删除文件的后半部分，
    // 而响应结构中没有任何字段能在写入前说明这只是部分内容。message 与 data 两处都必须不含正文。
    expect(error.message).not.toContain(MARKER);
    expect(JSON.stringify(error.data ?? null)).not.toContain(MARKER);
    // agent 会按 hint 操作，因此 hint 必须给出可行方案（分窗读取），且该方案确实可用。
    expect(error.message).toContain('maxReadBytes');
    expect(error.message).toContain('分窗');
    const limit = Number(/limit: (\d+)/.exec(error.message)![1]);
    expect(limit).toBeGreaterThan(0);
    const page = fs.readTextFile(read(`${root}/big.txt`, { line: 1, limit })).content;
    expect(body.startsWith(page)).toBe(true);
    expect(fs.reads).toBe(1); // 失败的那次不计入
  });

  it('超 maxWriteBytes 时抛错，目标文件一个字节没动，也没留下半个文件或 .tmp', () => {
    const { fs } = subject({ maxWrite: 16 });
    writeFileSync(`${root}/keep.txt`, '旧的内容还在\n');
    const error = refused(() => fs.writeTextFile(write(`${root}/keep.txt`, 'x'.repeat(100))));
    expect(error.code).toBe(INVALID_PARAMS);
    expect(error.data).toMatchObject({ reason: 'write_too_large' });
    // `write_too_large` 返回时只有一个错误码，`CODE_HINTS` 需为外部 agent 补充说明；
    // 不补充时它只会得到一个无法识别的标识，然后原样重试。
    expect(error.message).toContain('maxWriteBytes');
    expect(error.message).toContain('一个字节都没写');
    expect(readFileSync(`${root}/keep.txt`, 'utf8')).toBe('旧的内容还在\n');
    // 目录中不应有残留：既没有 `.tmp` 文件，也没有为一次未发生的写入而创建的备份目录。
    expect(readdirSync(root)).toEqual(['keep.txt']);
    expect(fs.writes).toBe(0);
  });

  it('非 UTF-8 抛错，不交回被 U+FFFD 替换过的正文', () => {
    // 与超限属同一类：替换过的正文经全量覆盖写回是一次静默破坏，而返回结构中同样没有字段
    // 能说明内容已受损。因此二进制内容在这条路径上属于硬错误，而不是读出一串替换字符。
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
    // 把 `{limit: 0}` 纠正为全量读取会将一次分窗读取静默变成全文读取；`NaN` 纠正后得到空正文，而
    // 空正文交给全量覆盖的写入端等于清空文件。因此这里必须拒绝，而不是纠正。
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
    // `line` 与 `limit` 在协议中为 `number | null`，null 表示该字段未填写，而非一个数值。
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
    // 不存在上一版本时没有需要保留的内容：备份目录不应被创建，否则会凭空多出一个目录。
    expect(existsSync(`${root}/.luoli-bak`)).toBe(false);
    writeFileSync(`${root}/app.ts`, '第一版\n');
    fs.writeTextFile(write(`${root}/app.ts`, '第二版\n'));
    expect(readFileSync(`${root}/app.ts`, 'utf8')).toBe('第二版\n');
    /**
     * ⚠️ 备份位于目标仓库内（`<root>/.luoli-bak/<时间>-<ulid>-<文件名>`），因此它会出现在该
     * 仓库的 `git status` 中。这是有意的取舍：移到仓库外就需要另建一套备份与仓库的对应关系记录。
     * 本断言固定的正是位置；缺少它时，若有人认为该目录冗余而将其移到仓库外或 tmp 下，
     * 不会有任何机制阻止，而那套对应关系也将无人维护。
     */
    const backups = readdirSync(`${root}/.luoli-bak`);
    expect(backups).toHaveLength(1);
    expect(backups[0]!.endsWith('-app.ts')).toBe(true);
    expect(readFileSync(`${root}/.luoli-bak/${backups[0]}`, 'utf8')).toBe('第一版\n');
  });

  it('reads 数成功的次数，writes 数不同的文件，失败的一次都不计', () => {
    // `writes` 是进度卡片终帧展示给用户的数值：若统计写入次数，同一文件被修改三次会报为
    // 修改了 3 个文件，该表述不成立，而查看者没有其他途径核对。
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
    // 失败的调用不得改变这两个数值：卡片上显示读取 4 个、修改 3 个而其中一次是越界拒绝时，
    // 就把一次被拦截的越界表述成了一次正常读写。
    refused(() => fs.readTextFile(read(`${OUTSIDE}/nope.txt`)));
    refused(() => fs.readTextFile(read(`${root}/missing.txt`)));
    refused(() => fs.writeTextFile(write(`${OUTSIDE}/planted.txt`, 'x')));
    expect(fs.reads).toBe(3);
    expect(fs.writes).toBe(2);
  });
});
