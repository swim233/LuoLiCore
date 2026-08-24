import {
  type Stats,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { minimatch } from "minimatch";
import { basename, dirname, relative } from "node:path";
import { ulid } from "ulid";
import { RE2 } from "re2-wasm";
import { PathJail } from "./jail.js";
function safeRegex(source: string, ignoreCase: boolean): RE2 | null {
  if ([...source].length > 128) return null;
  try {
    return new RE2(source, ignoreCase ? "giu" : "gu");
  } catch {
    return null;
  }
}
const LIST_LIMIT = 500;
const GREP_LIMIT = 200;

/**
 * 行号是 `edit_file` 的对照坐标（docs/05 §3.1）：没有它，模型只能靠「第几个 foo」描述位置。
 * 分隔符用制表符 —— 正文里出现竖线的概率比制表符高得多，而模型把分隔符连着行号一起抄进
 * `oldString` 就是一次必然失败的编辑，所以 `read_file` 的 description 里另有一句明说。
 */
export function numberLines(content: string, firstLine: number): string {
  const lines = content.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => `${firstLine + index}\t${line}`).join("\n");
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
export function readSlice(
  path: string,
  offset: number,
  limit: number,
): { content: string; firstLine: number; size: number; read: number } {
  const size = statSync(path).size;
  const handle = openSync(path, "r");
  try {
    let firstLine = 1;
    if (offset > 0) {
      const scan = Buffer.allocUnsafe(Math.min(offset, SCAN_CHUNK_BYTES));
      for (let position = 0; position < offset;) {
        const got = readSync(
          handle,
          scan,
          0,
          Math.min(scan.length, offset - position),
          position,
        );
        if (!got) break;
        for (let index = 0; index < got; index += 1)
          if (scan[index] === 0x0a) firstLine += 1;
        position += got;
      }
    }
    const want = Math.max(0, Math.min(limit, size - offset));
    const buffer = Buffer.allocUnsafe(want);
    const read = want ? readSync(handle, buffer, 0, want, offset) : 0;
    return {
      content: new TextDecoder("utf-8", { fatal: false }).decode(
        buffer.subarray(0, read),
      ),
      firstLine,
      size,
      read,
    };
  } finally {
    closeSync(handle);
  }
}
/**
 * `endLine` / `lines` 说的是 `content` 真正含住的行；`bytes` 是窗口**在盘上**的字节数。
 *
 * **`overflow` 与 `notUtf8` 时 `content` 一律是空串。** 两者是同一类问题的两种形态：这条路的正文
 * 会被原样写回文件，而「被截断的正文」与「被 U+FFFD 替换过的正文」写回去都是一次静默毁坏，
 * 且返回形状里没有任何字段能让下游**在写之前**知道。所以不产出 —— 让这条保证落在产生侧，
 * 而不是靠调用方记得先看标志位。`read()` 那边照旧有损解码，那是对的：它的正文给模型看，从不写回。
 */
export interface LineWindow {
  content: string;
  startLine: number;
  endLine: number;
  lines: number;
  bytes: number;
  size: number;
  eof: boolean;
  overflow: boolean;
  notUtf8: boolean;
}
/**
 * 行窗口读，正文**不带行号**。`read()` 无条件给正文加 `行号<TAB>` 前缀（见 `numberLines`），
 * 那对模型是对的，但对「读出来的正文要原样写回去」的调用方是一次静默的数据毁坏 ——
 * 读出来改两行写回去，整个文件被换成加了行号的垃圾（docs/05 §3.1）。
 *
 * 内存与 `readSlice` 同一形状（docs/27 · R-02）：起始行靠固定缓冲分块数换行定位，不 `readFileSync`
 * 之后 `split('\n')` —— workspace 里的大文件正是 `bash` / `python` 自己造出来的。
 * 到 `maxBytes` 就停并置 `overflow`：**这一层不判「算错还是算一页」**，因为「截了多少」只有这里
 * 知道，而唯一的调用方对截断的容忍度是 0（`readText`）。**`maxBytes` 不给就是不设上界** ——
 * 内存有界这件事由调用方传预算实现，`readText` 传的是 `tools.fs.maxReadBytes`。
 *
 * 三个数值参数不合形状时当「没给」而不是照算：`Math.max(1, NaN)` 是 NaN，而 NaN 的比较全假 ——
 * 定位阶段整段被跳过、越界判据也失效，交回的会是一段**坐标是 NaN**（JSON 序列化后是 `null`）
 * 的正文，看起来完全正常。真正的拒收在 `readText`，这一层只保证不说假话。
 */
export function readLineWindow(
  path: string,
  startLine = 1,
  limitLines = Number.POSITIVE_INFINITY,
  maxBytes = Number.POSITIVE_INFINITY,
): LineWindow {
  const first = Number.isFinite(startLine)
    ? Math.max(1, Math.trunc(startLine))
    : 1;
  const wanted = Number.isNaN(limitLines)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, limitLines);
  const budget = Number.isNaN(maxBytes)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, maxBytes);
  const size = statSync(path).size;
  const handle = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let position = 0;
    let skip = first - 1;
    while (skip > 0 && position < size) {
      const got = readSync(
        handle,
        chunk,
        0,
        Math.min(SCAN_CHUNK_BYTES, size - position),
        position,
      );
      if (!got) break;
      let index = 0;
      while (index < got && skip > 0) {
        if (chunk[index] === 0x0a) skip -= 1;
        index += 1;
      }
      position += index;
    }
    // 起始行落在文件之外：交回空窗口。退回从头读等于把「你要的那段不存在」说成「这就是那段」。
    if (skip > 0)
      return {
        content: "",
        startLine: first,
        endLine: first - 1,
        lines: 0,
        bytes: 0,
        size,
        eof: true,
        overflow: false,
        notUtf8: false,
      };
    const pieces: Buffer[] = [];
    let bytes = 0,
      newlines = 0,
      overflow = false;
    while (position < size && newlines < wanted && !overflow) {
      const got = readSync(
        handle,
        chunk,
        0,
        Math.min(SCAN_CHUNK_BYTES, size - position),
        position,
      );
      if (!got) break;
      let take = got,
        found = 0;
      for (let index = 0; index < got; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        found += 1;
        if (newlines + found >= wanted) {
          take = index + 1;
          break;
        }
      }
      if (bytes + take > budget) {
        // 裁到预算就停，并把这一块的行数重数一遍：`found` 数的是整块里的换行，越过裁点的那些
        // 不在正文里，报出去会让调用方的 hint 指着一行根本没读到的行。
        take = budget - bytes;
        overflow = true;
        found = 0;
        for (let index = 0; index < take; index += 1)
          if (chunk[index] === 0x0a) found += 1;
      }
      pieces.push(Buffer.from(chunk.subarray(0, take))); // 必须拷贝：下一轮 readSync 覆写同一个 chunk
      bytes += take;
      newlines += found;
      position += take;
    }
    const body = Buffer.concat(pieces);
    // 逐块解码会把跨块的多字节字符切坏，所以拼完再解一次（上界是 maxBytes，不是文件大小）。
    // `ignoreBOM`：默认解码会把 BOM 吃掉，而这里的正文要被原样写回文件 —— 少一个 BOM 也是一次改写。
    // `fatal: true`：坏字节**抛**而不是换成 U+FFFD。有损解码后的正文交给全量覆盖的写端，与截断
    // 是同一类静默毁坏，而返回形状里同样没有字段说得出口（实测 6 字节的非法 UTF-8 解出 12 字节
    // 正文，`bytes` 与 `Buffer.byteLength(content)` 从此不等，没人会去比）。overflow 同理不产出。
    let content = "",
      notUtf8 = false;
    if (!overflow) {
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(body);
      } catch {
        notUtf8 = true;
      }
    }
    const lines =
      newlines + (body.length && body[body.length - 1] !== 0x0a ? 1 : 0);
    return {
      content,
      startLine: first,
      endLine: first + lines - 1,
      lines,
      bytes: body.length,
      size,
      eof: position >= size,
      overflow,
      notUtf8,
    };
  } finally {
    closeSync(handle);
  }
}

interface Child {
  real: string;
  logical: string;
  stat: Stats;
}

export class FileTools {
  constructor(
    private readonly jail: PathJail,
    private readonly maxReadBytes: number,
    private readonly maxWriteBytes: number,
    private readonly options: {
      showHidden?: boolean;
      trashDir?: string;
      backupDir?: string;
    } = {},
  ) {}
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

  /**
   * 目录不是文件。`statSync(目录).size` 在 btrfs 上是 0，于是 `readSlice` 的 `want` 与
   * `readLineWindow` 的 `position < size` 都一次不进 —— `readSync` 从不被调用，**EISDIR 永远不抛**，
   * 交回一个 `ok: true` + 空正文，而空正文交给一个全量覆盖的写端就是一次静默清空。ext4 上目录
   * 的 size 是 4096 会如实抛 EISDIR，也就是说「读一个目录报什么」此前取决于文件系统 —— 那不是
   * 一个能留在判据上的东西，所以在这里显式判（同 `acp/fs.ts` 的 `#target`，那条路早就判过了）。
   */
  #isDirectory(target: string): boolean {
    // 不存在时说「不是目录」：读那两条路随后照旧如实抛 ENOENT，与从前一个字不变。
    try {
      return statSync(target).isDirectory();
    } catch {
      return false;
    }
  }

  read(
    path: string,
    offset = 0,
    limit = this.maxReadBytes,
  ): Record<string, unknown> {
    const target = this.jail.resolve(path);
    if (this.#isDirectory(target))
      return {
        ok: false,
        error: "path_is_directory",
        hint: `${relative(this.jail.root, target) || "."} 是目录不是文件；使用 list_dir 工具查看目录内容`,
      };
    const slice = readSlice(target, offset, Math.min(limit, this.maxReadBytes));
    const more = offset + slice.read < slice.size;
    return {
      ok: true,
      path: relative(this.jail.root, target),
      content: numberLines(slice.content, slice.firstLine),
      firstLine: slice.firstLine,
      offset,
      bytes: Buffer.byteLength(slice.content),
      truncated: more,
      nextOffset: more ? offset + slice.read : null,
    };
  }

  /**
   * 不带行号的读，正文逐字节等于磁盘内容（`readLineWindow`）。给「读出来的正文要原样写回去」的
   * 调用方用 —— `read()` 的 `行号<TAB>` 前缀是给模型的定位坐标，喂给一个全量覆盖的写端就是把
   * 文件换成带行号的垃圾。目录 / 不存在照旧抛（与 `read()` 一致）。
   *
   * **超预算与非 UTF-8 都 fail-closed，绝不交回不能原样写回的正文。** `read()` 能截是因为它的返回形状里有
   * `truncated` + `nextOffset` 把这件事说出口；这条路的调用方响应形状里没有那个位置，于是
   * 「截断的正文 + 全量覆盖」= 静静删掉文件的后半部分。分窗读合法（`endLine` / `eof` 说得出
   * 「这只是一段」），截断不合法。总行数不数：数它要整份扫一遍，那正是这条路存在的理由。
   *
   * 非 UTF-8 同理走 `not_utf8` 而不是有损解码：U+FFFD 替换过的正文写回去也是一次静默毁坏，而
   * 「有损了」这件事在返回形状里同样没有位置。**这一条与 `read()` 刻意分岔** —— 那边的正文给模型
   * 看、从不写回，有损是可接受的；这边的正文要变成文件本身。二进制文件因此在这条路上是硬错误，
   * 不是「读出来一堆问号」。
   */
  readText(
    path: string,
    options: { line?: number; limit?: number } = {},
  ): Record<string, unknown> {
    const target = this.jail.resolve(path); // 先解析：越界是安全信号，不该被一句参数抱怨盖掉
    // 目录同样排在窗口参数之前：`{limit: 0}` 读一个目录时「那是个目录」比「limit 要 ≥1」有用得多，
    // 而两句话里只有前者说得出下一步该做什么。
    if (this.#isDirectory(target))
      return {
        ok: false,
        error: "path_is_directory",
        hint: `${relative(this.jail.root, target) || "."} 是目录不是文件；本次工具调用应查看文件`,
      };
    // 窗口参数照 `read_file` 的 schema 那样收（`z.number().int().positive()`）。这条路的调用方是
    // **外部** agent 的 JSON，而这两个数只被 `Math.max`/`Math.trunc` 摸过 —— 那看起来已经兜住了：
    // NaN 会一路走到「ok:true + 坐标是 NaN 的正文」，`limit: 0` 会走到「ok:true + 空正文」，
    // 而空正文交给一个全量覆盖的写端就是清空文件。这里必须是拒收，不能是纠正。
    for (const [name, value] of [
      ["line", options.line],
      ["limit", options.limit],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        return {
          ok: false,
          error: "invalid_line_window",
          hint: `${name} 要是 ≥1 的整数（line 是 1-based 行号，limit 是行数），收到 ${value}`,
        };
      }
    }
    const window = readLineWindow(
      target,
      options.line ?? 1,
      options.limit ?? Number.POSITIVE_INFINITY,
      this.maxReadBytes,
    );
    const display = relative(this.jail.root, target);
    if (window.overflow) {
      const fits = window.endLine - window.startLine;
      return {
        ok: false,
        error: "read_too_large",
        hint:
          `${display} 有 ${window.size} 字节，超过 tools.fs.maxReadBytes（${this.maxReadBytes}）；从第 ${window.startLine} 行起这份预算读到第 ${window.endLine} 行就用满了。本次调用不截断正文，请带 line + limit 分窗读` +
          (fits > 0
            ? `，例如 line: ${window.startLine}, limit: ${fits}。`
            : `；注意第 ${window.startLine} 行本身就超过预算，这个文件只能用 read_file 的 offset 分页看。`),
      };
    }
    if (window.notUtf8) {
      return {
        ok: false,
        error: "not_utf8",
        hint: `${display} 从第 ${window.startLine} 行起的这段不是合法 UTF-8。，要看内容用 read_file，要处理二进制用 bash。`,
      };
    }
    return {
      ok: true,
      path: display,
      content: window.content,
      startLine: window.startLine,
      endLine: window.endLine,
      lines: window.lines,
      bytes: window.bytes,
      size: window.size,
      eof: window.eof,
    };
  }

  /** 目录去重按 realpath 记：软链自指时同一个真实目录会被再次进入，条数上限拦不住无限递归。 */
  #enter(directory: string, visited: Set<string>): boolean {
    let real: string;
    try {
      real = realpathSync(directory);
    } catch {
      return false;
    }
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
    try {
      return statSync(target);
    } catch {
      skipped.n += 1;
      return null;
    }
  }

  #readdir(directory: string, skipped: { n: number }): string[] {
    try {
      return readdirSync(directory);
    } catch {
      skipped.n += 1;
      return [];
    }
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
      if (!this.options.showHidden && name.startsWith(".")) continue;
      const childLogical = `${logical}/${name}`;
      let resolved: string;
      try {
        resolved = this.jail.resolve(relative(this.jail.root, childLogical));
      } catch {
        skipped.n += 1;
        continue;
      }
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
  list(path = ".", depth = 1): Record<string, unknown> {
    const root = this.jail.resolve(path);
    const entries: Array<{ path: string; type: string; bytes: number }> = [];
    const skipped = { n: 0 };
    const visited = new Set<string>();
    let truncated = false;
    const walk = (real: string, logical: string, level: number): void => {
      if (!this.#enter(real, visited)) return;
      for (const child of this.#children(real, logical, skipped)) {
        if (entries.length >= LIST_LIMIT) {
          truncated = true;
          return;
        }
        entries.push({
          path: relative(this.jail.root, child.logical),
          type: child.stat.isDirectory() ? "directory" : "file",
          bytes: child.stat.size,
        });
        if (child.stat.isDirectory() && level < depth)
          walk(child.real, child.logical, level + 1);
        if (truncated) return;
      }
    };
    walk(root, root, 1);
    return { ok: true, entries, truncated, skipped: skipped.n };
  }

  glob(pattern: string, path = "."): Record<string, unknown> {
    const root = this.jail.resolve(path);
    const matches: string[] = [];
    const skipped = { n: 0 };
    const visited = new Set<string>();
    let truncated = false;
    const walk = (real: string, logical: string): void => {
      if (!this.#enter(real, visited)) return;
      for (const child of this.#children(real, logical, skipped)) {
        if (
          minimatch(
            relative(root, child.logical).replaceAll("\\", "/"),
            pattern,
            { dot: true },
          )
        ) {
          // 「还想再放一条却放不下」才算截断。恰好 500 条而后面本来就没有了报成截断，
          // 模型会去缩范围重查一次已经完整的结果 —— 白跑一步，且它会以为自己没看全。
          if (matches.length >= LIST_LIMIT) {
            truncated = true;
            return;
          }
          matches.push(relative(this.jail.root, child.logical));
        }
        if (child.stat.isDirectory()) walk(child.real, child.logical);
        if (truncated) return;
      }
    };
    walk(root, root);
    return { ok: true, matches, truncated, skipped: skipped.n };
  }

  grep(
    pattern: string,
    path = ".",
    ignoreCase = false,
    include?: string,
    contextLines = 0,
  ): Record<string, unknown> {
    const root = this.jail.resolve(path);
    const regex = safeRegex(pattern, ignoreCase);
    if (!regex) return { ok: false, error: "invalid_pattern" };
    const matches: Array<{
      path: string;
      line: number;
      text: string;
      before?: string[];
      after?: string[];
    }> = [];
    const skipped = { n: 0 };
    const visited = new Set<string>();
    let truncated = false;
    const scan = (real: string, logical: string, stat: Stats): void => {
      if (
        include &&
        !minimatch(relative(root, logical).replaceAll("\\", "/"), include, {
          dot: true,
        })
      )
        return;
      // 超预算的文件和读不出来的文件都要记进 skipped：那个数字是模型判断「我是不是看全了」的
      // 唯一依据（§3.1），静静跳过等于告诉它「这就是全部命中」。
      if (stat.size > this.maxReadBytes * 4) {
        skipped.n += 1;
        return;
      }
      let content: string;
      try {
        content = readFileSync(real, "utf8");
      } catch {
        skipped.n += 1;
        return;
      }
      const display = relative(this.jail.root, logical);
      const lines = content.split("\n");
      for (const [index, line] of lines.entries()) {
        regex.lastIndex = 0;
        if (!regex.test(line)) continue;
        if (matches.length >= GREP_LIMIT) {
          truncated = true;
          return;
        }
        matches.push({
          path: display,
          line: index + 1,
          text: line,
          ...(contextLines
            ? {
                before: lines.slice(Math.max(0, index - contextLines), index),
                after: lines.slice(index + 1, index + 1 + contextLines),
              }
            : {}),
        });
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
    const target = this.jail.resolve(path); // 先解析：越界是安全信号，不该被一句参数抱怨盖掉
    // 写一个目录路径此前死在下面备份那步的 `cpSync` 上，报一句不带 `EISDIR` 的
    // `Recursive option not enabled` —— 模型拿它没法做任何事，还会以为是权限或磁盘问题。
    // 读那两条路已经在判了，这一条是把同一句话补到写侧（判据同 `#isDirectory`）。
    if (this.#isDirectory(target))
      return {
        ok: false,
        error: "path_is_directory",
        hint: `${relative(this.jail.root, target) || "."} 是目录不是文件；要写它下面的文件就把文件名也带上`,
      };
    const bytes = Buffer.byteLength(content);
    if (bytes > this.maxWriteBytes)
      return { ok: false, error: "write_too_large" };
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target)) {
      // 备份名带 ulid：只按毫秒命名时同一毫秒里的两次写入会互相覆盖，而备份存在的意义
      // 恰恰是「上一版还在」——`edit_file` 连续改同一个文件正好落在这个窗口里。
      const backup = this.jail.resolve(
        `${this.options.backupDir ?? ".luoli-bak"}/${Date.now()}-${ulid()}-${basename(target)}`,
      );
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      cpSync(target, backup);
    }
    const temporary = `${target}.${ulid()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, target);
    return { ok: true, path: relative(this.jail.root, target), bytes };
  }

  edit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Record<string, unknown> {
    const target = this.jail.resolve(path);
    // 这一支**必须**整份读（要在全文里数 oldString 的出现次数），所以先量再读。判据用
    // `maxWriteBytes` 而不是 `maxReadBytes`：改完这份内容反正要经 `write()` 那道写入闸，
    // 拿读预算（256 KiB）挡会把一堆正常大小的源码文件一起挡掉（docs/27 · R-02）。
    const size = statSync(target).size;
    if (size > this.maxWriteBytes)
      return {
        ok: false,
        error: "file_too_large_to_edit",
        hint: `${relative(this.jail.root, target)} 有 ${size} 字节，超过 tools.fs.maxWriteBytes（${this.maxWriteBytes}）—— 这个工具要把全文读进内存才能定位 oldString。请改用 bash 里的 sed / python 修改。`,
      };
    const content = readFileSync(target, "utf8");
    const occurrences = content.split(oldString).length - 1;
    // 行号前缀被一起抄进 oldString 是这个工具最常见的失败方式（`read_file` 交回的正文带行号）。
    // 报 `old_string_not_found` 时模型通常只会换一段文字再试一次，说清楚它才会去掉前缀。
    if (!occurrences)
      return {
        ok: false,
        error: "old_string_not_found",
        ...(/^\s*\d+\t/m.test(oldString)
          ? {
              hint: "oldString 里带着 read_file 的行号前缀（`12\\t…`），要去掉行号和制表符，只留文件里真正的正文",
            }
          : {}),
      };
    if (occurrences > 1 && !replaceAll)
      return {
        ok: false,
        error: "old_string_not_unique",
        hint: `matched ${occurrences} times`,
      };
    return this.write(
      path,
      replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString),
    );
  }

  /**
   * 目录整棵搬进回收站等价于 `rm -r`，所以按 docs/05 §3.1 加两道闸：要显式 `recursive`，
   * 且离**可达边界** ≥2 层。审批弹窗上只有一个路径，owner 分不出这一下删的是一个文件还是半个工作
   * 目录，而 `delete_file` 是 `approval: 'always'` —— 点下去就真的搬走了。
   *
   * 回收站的落点按 `jail.root`（会话 workspace）解析，而深度按边界量 —— 两个基准刻意不同。于是
   * host-fs 模式下删 `/home/u/x/y` 会把它搬进会话工作目录里，看着别扭但是对的：回收站必须落在
   * 一个我们确定写得进、且会被 `gcFiles` 收拾的地方，而边界那一侧可能是 `/`。
   */
  remove(path: string, recursive = false): Record<string, unknown> {
    const target = this.jail.resolve(path);
    if (!existsSync(target)) return { ok: false, error: "path_not_found" };
    const inside = relative(this.jail.root, target);
    const directory = statSync(target).isDirectory();
    if (directory) {
      if (!recursive)
        return {
          ok: false,
          error: "path_is_directory",
          hint: `${inside || "."} 是目录；要连里面的内容一起删就显式传 recursive: true`,
        };
      // 深度对着**可达边界**量（`jail.depthFromBoundary`），不是 `inside` 那个基点：`jail.root` 只是
      // 相对路径的解析基点，host-fs 模式下边界是 `/` 而它仍是会话 workspace，于是任何绝对路径都会
      // 攒出一堆 `..` 段被数进来（`/etc` 数出来是个大数），那道闸对整个宿主文件系统近乎无效。
      // `inside` 仍相对 root —— 它是给人看的那一半（回给模型的路径一律以会话目录为基点，原样再交
      // 回来还能解回同一个文件），两个基准刻意不同。
      const depth = this.jail.depthFromBoundary(target);
      if (depth < 2)
        return {
          ok: false,
          error: "recursive_delete_too_shallow",
          hint: `${inside || "."} 在可达边界底下只有 ${depth} 层，递归删除只允许作用在二级及更深的路径上`,
        };
    }
    const trash = this.jail.resolve(
      `${this.options.trashDir ?? ".luoli-trash"}/${Date.now()}-${ulid()}/${basename(target)}`,
    );
    mkdirSync(dirname(trash), { recursive: true, mode: 0o700 });
    renameSync(target, trash);
    return {
      ok: true,
      trashedTo: relative(this.jail.root, trash),
      recursive: directory,
    };
  }

  move(from: string, to: string): Record<string, unknown> {
    const source = this.jail.resolve(from);
    const target = this.jail.resolve(to);
    if (existsSync(target)) return { ok: false, error: "target_exists" };
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(source, target);
    return {
      ok: true,
      from: relative(this.jail.root, source),
      to: relative(this.jail.root, target),
    };
  }
}
