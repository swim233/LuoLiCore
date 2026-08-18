import { type Stats, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { minimatch } from 'minimatch';
import { basename, dirname, relative } from 'node:path';
import { ulid } from 'ulid';
import { RE2 } from 're2-wasm';
import { PathJail } from './jail.js';
function safeRegex(source: string, ignoreCase: boolean): RE2 | null {
  if ([...source].length > 128) return null;
  try { return new RE2(source, ignoreCase ? 'giu' : 'gu'); } catch { return null; }
}
const LIST_LIMIT = 500;
const GREP_LIMIT = 200;

/**
 * 行号是 `edit_file` 的对照坐标（docs/05 §3.1）：没有它，模型只能靠「第几个 foo」描述位置。
 * 分隔符用制表符 —— 正文里出现竖线的概率比制表符高得多，而模型把分隔符连着行号一起抄进
 * `oldString` 就是一次必然失败的编辑，所以 `read_file` 的 description 里另有一句明说。
 */
export function numberLines(content: string, firstLine: number): string {
  const lines = content.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => `${firstLine + index}\t${line}`).join('\n');
}
/** 数换行时的固定缓冲。分块只是为了让内存有界，大小无所谓，够摊平系统调用就行。 */
const SCAN_CHUNK_BYTES = 65_536;
/**
 * 定位读。整份 `readFileSync` 之后再 `subarray` 只裁了「交给模型的那一段」——**读盘那一下仍是
 * 整份进内存**，而 `tools.fs.maxReadBytes`（默认 256 KiB）管不到它。workspace 里的大文件正是
 * `bash` / `python` 自己造出来的（`dd`、日志、下载），`read_file` 一个 2 GB 文件就是一次 2 GB
 * 分配（docs/27 · R-02；`grep` 早就有 `size > maxReadBytes*4` 那道闸，read / edit 没有）。
 *
 * 分页语义一个字不变，行号也仍然精确：第二页的起始行号要接着第一页往下数，所以前 `offset`
 * 字节按固定缓冲分块扫一遍换行 —— I/O 与从前一样，内存从 O(文件) 变成 O(1)。
 */
export function readSlice(path: string, offset: number, limit: number): { content: string; firstLine: number; size: number; read: number } {
  const size = statSync(path).size;
  const handle = openSync(path, 'r');
  try {
    let firstLine = 1;
    if (offset > 0) {
      const scan = Buffer.allocUnsafe(Math.min(offset, SCAN_CHUNK_BYTES));
      for (let position = 0; position < offset;) {
        const got = readSync(handle, scan, 0, Math.min(scan.length, offset - position), position);
        if (!got) break;
        for (let index = 0; index < got; index += 1) if (scan[index] === 0x0A) firstLine += 1;
        position += got;
      }
    }
    const want = Math.max(0, Math.min(limit, size - offset));
    const buffer = Buffer.allocUnsafe(want);
    const read = want ? readSync(handle, buffer, 0, want, offset) : 0;
    return { content: new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, read)), firstLine, size, read };
  } finally { closeSync(handle); }
}

interface Child { real: string; logical: string; stat: Stats }

export class FileTools {
  constructor(private readonly jail: PathJail, private readonly maxReadBytes: number, private readonly maxWriteBytes: number, private readonly options: { showHidden?: boolean; trashDir?: string; backupDir?: string } = {}) {}
  exists(path: string): boolean {
    return existsSync(this.jail.resolve(path));
  }

  /**
   * jail 内的绝对路径。给「把文件交出去而不是读进来」的调用方用（`send_file` / `send_photo`
   * 要把路径递给 grammy 的 InputFile）—— 50MB 的附件不该先进内存再发一遍。
   * 解析失败照旧抛 `path_outside_workspace` / `path_denied`：越界必须在拿到路径之前就断掉。
   */
  resolve(path: string): string {
    return this.jail.resolve(path);
  }

  read(path: string, offset = 0, limit = this.maxReadBytes): Record<string, unknown> {
    const target = this.jail.resolve(path);
    const slice = readSlice(target, offset, Math.min(limit, this.maxReadBytes));
    const more = offset + slice.read < slice.size;
    return { ok: true, path: relative(this.jail.root, target), content: numberLines(slice.content, slice.firstLine), firstLine: slice.firstLine, offset, bytes: Buffer.byteLength(slice.content),
      truncated: more, nextOffset: more ? offset + slice.read : null };
  }

  /** 目录去重按 realpath 记：软链自指时同一个真实目录会被再次进入，条数上限拦不住无限递归。 */
  #enter(directory: string, visited: Set<string>): boolean {
    let real: string;
    try { real = realpathSync(directory); } catch { return false; }
    if (visited.has(real)) return false;
    visited.add(real);
    return true;
  }

  /**
   * 读不到的条目跳过而不是让整次调用失败。一个断链软链（`ln -s /nowhere x`，下载失败也会留）
   * 让 `statSync` 抛 ENOENT，此前整个 list/glob/grep 就返回 `ok:false` —— 目录里另外几百个
   * 好文件一并看不见了（docs/22 · I-03）。跳过的条数交回给模型，别让它以为自己看全了。
   */
  #stat(target: string, skipped: { n: number }): Stats | null {
    try { return statSync(target); } catch { skipped.n += 1; return null; }
  }

  #readdir(directory: string, skipped: { n: number }): string[] {
    try { return readdirSync(directory); } catch { skipped.n += 1; return []; }
  }

  /**
   * 一层目录里可用的条目。`jail.resolve` 抛错的条目和 `statSync` 抛错的条目一样跳过并记数 ——
   * 一个**越界软链**（`ln -s /etc x`，`bash` 一行就能建）让它抛 `path_outside_workspace`，
   * 而此前那一抛没人接，整次 list/glob/grep 返回 `ok:false`，同目录里另外几百个好条目一并
   * 看不见。这与 docs/22 · I-03 是同一类，只是那一轮只修了断链那半边。
   *
   * `logical` 是软链名那一侧的路径，跟 `real` 分开带：`jail.resolve` 交回的是 realpath，
   * 拿它当显示路径会把 `loop -> .` 报成空串，而模型拿空串去 `read_file` 就读到了目录本身。
   */
  #children(real: string, logical: string, skipped: { n: number }): Child[] {
    const values: Child[] = [];
    for (const name of this.#readdir(real, skipped)) {
      if (!this.options.showHidden && name.startsWith('.')) continue;
      const childLogical = `${logical}/${name}`;
      let resolved: string;
      try { resolved = this.jail.resolve(relative(this.jail.root, childLogical)); } catch { skipped.n += 1; continue; }
      const stat = this.#stat(resolved, skipped);
      if (stat) values.push({ real: resolved, logical: childLogical, stat });
    }
    return values;
  }

  /**
   * `depth` 只挡递归层数，挡不住同一棵树被反复走进去：`ln -s . loop` 之下一棵三条目的树能列出
   * 十七条，重复项还会把 500 条的预算占满，而模型看到的是一份自相矛盾的目录。所以这里和
   * `glob`/`grep` 用同一套 realpath 去重（那两个在 docs/20 · W-FS-01 修过，`list` 当时漏了）。
   */
  list(path = '.', depth = 1): Record<string, unknown> {
    const root = this.jail.resolve(path);
    const entries: Array<{ path: string; type: string; bytes: number }> = [];
    const skipped = { n: 0 };
    const visited = new Set<string>();
    let truncated = false;
    const walk = (real: string, logical: string, level: number): void => {
      if (!this.#enter(real, visited)) return;
      for (const child of this.#children(real, logical, skipped)) {
        if (entries.length >= LIST_LIMIT) { truncated = true; return; }
        entries.push({ path: relative(this.jail.root, child.logical), type: child.stat.isDirectory() ? 'directory' : 'file', bytes: child.stat.size });
        if (child.stat.isDirectory() && level < depth) walk(child.real, child.logical, level + 1);
        if (truncated) return;
      }
    };
    walk(root, root, 1);
    return { ok: true, entries, truncated, skipped: skipped.n };
  }

  glob(pattern: string, path = '.'): Record<string, unknown> {
    const root = this.jail.resolve(path);
    const matches: string[] = [];
    const skipped = { n: 0 };
    const visited = new Set<string>();
    let truncated = false;
    const walk = (real: string, logical: string): void => {
      if (!this.#enter(real, visited)) return;
      for (const child of this.#children(real, logical, skipped)) {
        if (minimatch(relative(root, child.logical).replaceAll('\\', '/'), pattern, { dot: true })) {
          // 「还想再放一条却放不下」才算截断。恰好 500 条而后面本来就没有了报成截断，
          // 模型会去缩范围重查一次已经完整的结果 —— 白跑一步，且它会以为自己没看全。
          if (matches.length >= LIST_LIMIT) { truncated = true; return; }
          matches.push(relative(this.jail.root, child.logical));
        }
        if (child.stat.isDirectory()) walk(child.real, child.logical);
        if (truncated) return;
      }
    };
    walk(root, root);
    return { ok: true, matches, truncated, skipped: skipped.n };
  }

  grep(pattern: string, path = '.', ignoreCase = false, include?: string, contextLines = 0): Record<string, unknown> {
    const root = this.jail.resolve(path);
    const regex = safeRegex(pattern, ignoreCase);
    if (!regex) return { ok: false, error: 'invalid_pattern' };
    const matches: Array<{ path: string; line: number; text: string; before?: string[]; after?: string[] }> = [];
    const skipped = { n: 0 };
    const visited = new Set<string>();
    let truncated = false;
    const scan = (real: string, logical: string, stat: Stats): void => {
      if (include && !minimatch(relative(root, logical).replaceAll('\\', '/'), include, { dot: true })) return;
      // 超预算的文件和读不出来的文件都要记进 skipped：那个数字是模型判断「我是不是看全了」的
      // 唯一依据（§3.1），静静跳过等于告诉它「这就是全部命中」。
      if (stat.size > this.maxReadBytes * 4) { skipped.n += 1; return; }
      let content: string;
      try { content = readFileSync(real, 'utf8'); } catch { skipped.n += 1; return; }
      const display = relative(this.jail.root, logical);
      const lines = content.split('\n');
      for (const [index, line] of lines.entries()) {
        regex.lastIndex = 0;
        if (!regex.test(line)) continue;
        if (matches.length >= GREP_LIMIT) { truncated = true; return; }
        matches.push({ path: display, line: index + 1, text: line,
          ...(contextLines ? { before: lines.slice(Math.max(0, index - contextLines), index), after: lines.slice(index + 1, index + 1 + contextLines) } : {}) });
      }
    };
    const walk = (real: string, logical: string): void => {
      if (!this.#enter(real, visited)) return;
      for (const child of this.#children(real, logical, skipped)) {
        if (child.stat.isDirectory()) walk(child.real, child.logical);
        else scan(child.real, child.logical, child.stat);
        if (truncated) return;
      }
    };
    const start = this.#stat(root, skipped);
    if (start?.isDirectory()) walk(root, root);
    else if (start) scan(root, root, start);
    return { ok: true, matches, truncated, skipped: skipped.n };
  }

  write(path: string, content: string): Record<string, unknown> {
    const bytes = Buffer.byteLength(content);
    if (bytes > this.maxWriteBytes) return { ok: false, error: 'write_too_large' };
    const target = this.jail.resolve(path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target)) {
      // 备份名带 ulid：只按毫秒命名时同一毫秒里的两次写入会互相覆盖，而备份存在的意义
      // 恰恰是「上一版还在」——`edit_file` 连续改同一个文件正好落在这个窗口里。
      const backup = this.jail.resolve(`${this.options.backupDir ?? '.luoli-bak'}/${Date.now()}-${ulid()}-${basename(target)}`);
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      cpSync(target, backup);
    }
    const temporary = `${target}.${ulid()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, target);
    return { ok: true, path: relative(this.jail.root, target), bytes };
  }

  edit(path: string, oldString: string, newString: string, replaceAll = false): Record<string, unknown> {
    const target = this.jail.resolve(path);
    // 这一支**必须**整份读（要在全文里数 oldString 的出现次数），所以先量再读。判据用
    // `maxWriteBytes` 而不是 `maxReadBytes`：改完这份内容反正要经 `write()` 那道写入闸，
    // 拿读预算（256 KiB）挡会把一堆正常大小的源码文件一起挡掉（docs/27 · R-02）。
    const size = statSync(target).size;
    if (size > this.maxWriteBytes) return { ok: false, error: 'file_too_large_to_edit',
      hint: `${relative(this.jail.root, target)} 有 ${size} 字节，超过 tools.fs.maxWriteBytes（${this.maxWriteBytes}）—— 这个工具要把全文读进内存才能定位 oldString。改用 bash 里的 sed / python 就地改。` };
    const content = readFileSync(target, 'utf8');
    const occurrences = content.split(oldString).length - 1;
    // 行号前缀被一起抄进 oldString 是这个工具最常见的失败方式（`read_file` 交回的正文带行号）。
    // 报 `old_string_not_found` 时模型通常只会换一段文字再试一次，说清楚它才会去掉前缀。
    if (!occurrences) return { ok: false, error: 'old_string_not_found',
      ...(/^\s*\d+\t/m.test(oldString) ? { hint: 'oldString 里带着 read_file 的行号前缀（`12\\t…`），要去掉行号和制表符，只留文件里真正的正文' } : {}) };
    if (occurrences > 1 && !replaceAll) return { ok: false, error: 'old_string_not_unique', hint: `matched ${occurrences} times` };
    return this.write(path, replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString));
  }

  /**
   * 目录整棵搬进回收站等价于 `rm -r`，所以按 docs/05 §3.1 加两道闸：要显式 `recursive`，
   * 且路径深度 ≥2。审批弹窗上只有一个路径，owner 分不出这一下删的是一个文件还是半个工作
   * 目录，而 `delete_file` 是 `approval: 'always'` —— 点下去就真的搬走了。
   */
  remove(path: string, recursive = false): Record<string, unknown> {
    const target = this.jail.resolve(path);
    if (!existsSync(target)) return { ok: false, error: 'path_not_found' };
    const inside = relative(this.jail.root, target);
    const directory = statSync(target).isDirectory();
    if (directory) {
      if (!recursive) return { ok: false, error: 'path_is_directory', hint: `${inside || '.'} 是目录；要连里面的内容一起删就显式传 recursive: true` };
      const depth = inside.split('/').filter(Boolean).length;
      if (depth < 2) return { ok: false, error: 'recursive_delete_too_shallow', hint: `${inside || '.'} 的深度是 ${depth}，递归删除只允许作用在工作目录的二级及更深路径上` };
    }
    const trash = this.jail.resolve(`${this.options.trashDir ?? '.luoli-trash'}/${Date.now()}-${ulid()}/${basename(target)}`);
    mkdirSync(dirname(trash), { recursive: true, mode: 0o700 });
    renameSync(target, trash);
    return { ok: true, trashedTo: relative(this.jail.root, trash), recursive: directory };
  }

  move(from: string, to: string): Record<string, unknown> {
    const source = this.jail.resolve(from);
    const target = this.jail.resolve(to);
    if (existsSync(target)) return { ok: false, error: 'target_exists' };
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(source, target);
    return { ok: true, from: relative(this.jail.root, source), to: relative(this.jail.root, target) };
  }
}
