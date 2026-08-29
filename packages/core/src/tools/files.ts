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
 * 行号是 `edit_file` 的定位坐标（docs/05 §3.1）：没有它，模型只能以第几个匹配项描述位置。
 * 分隔符使用制表符 —— 正文中出现竖线的概率远高于制表符，而模型将分隔符连同行号一起写入
 * `oldString` 会导致编辑必然失败，因此 `read_file` 的 description 中另有一句明确说明。
 */
export function numberLines(content: string, firstLine: number): string {
  const lines = content.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => `${firstLine + index}\t${line}`).join("\n");
}
/** 统计换行时使用的固定缓冲。分块只为保证内存有界，具体大小不敏感，足以摊平系统调用即可。 */
const SCAN_CHUNK_BYTES = 65_536;
/**
 * 定位读取。先整份 `readFileSync` 再 `subarray` 只裁剪了交给模型的那一段 —— 读盘时仍是整份进入
 * 内存，而 `tools.fs.maxReadBytes`（默认 256 KiB）对其无效。workspace 中的大文件正是由
 * `bash` / `python` 自身产生的（`dd`、日志、下载），`read_file` 读取一个 2 GB 文件即产生一次 2 GB
 * 分配（docs/27 · R-02；`grep` 早已有 `size > maxReadBytes*4` 的闸门，read / edit 则没有）。
 *
 * 分页语义完全不变，行号也仍然精确：第二页的起始行号需接续第一页，因此前 `offset`
 * 字节按固定缓冲分块扫描一遍换行 —— I/O 与此前相同，内存从 O(文件) 降为 O(1)。
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
 * `endLine` / `lines` 表示 `content` 实际包含的行；`bytes` 是该窗口在磁盘上的字节数。
 *
 * `overflow` 与 `notUtf8` 时 `content` 一律为空串。两者是同一类问题的两种形态：该路径的正文
 * 会被原样写回文件，而被截断的正文与被 U+FFFD 替换过的正文写回都属于静默损坏，
 * 且返回结构中没有任何字段能让下游在写入之前得知。因此不产出内容 —— 让该保证落在产生侧，
 * 而不依赖调用方记得先检查标志位。`read()` 仍采用有损解码，那是正确的：其正文供模型阅读，从不写回。
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
 * 行窗口读取，正文不带行号。`read()` 无条件为正文添加 `行号<TAB>` 前缀（见 `numberLines`），
 * 这对模型是正确的，但对需要将读出正文原样写回的调用方构成静默的数据损坏 ——
 * 读出后修改两行再写回，整个文件会被替换为带行号的无效内容（docs/05 §3.1）。
 *
 * 内存形态与 `readSlice` 一致（docs/27 · R-02）：起始行通过固定缓冲分块统计换行定位，不采用
 * `readFileSync` 后 `split('\n')` —— workspace 中的大文件正是由 `bash` / `python` 自身产生的。
 * 达到 `maxBytes` 即停止并置 `overflow`：本层不区分是参数错误还是正常分页，因为截断量只有此处
 * 知晓，而唯一的调用方对截断的容忍度为 0（`readText`）。`maxBytes` 未提供即不设上界 ——
 * 内存有界由调用方传入预算实现，`readText` 传入的是 `tools.fs.maxReadBytes`。
 *
 * 三个数值参数形状非法时按未提供处理而不是照常计算：`Math.max(1, NaN)` 为 NaN，而 NaN 的比较
 * 全部为假 —— 定位阶段整段被跳过、越界判据也失效，返回的会是一段坐标为 NaN（JSON 序列化后为
 * `null`）的正文，表面看完全正常。真正的拒绝在 `readText`，本层只保证不给出错误信息。
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
    // 起始行位于文件范围之外：返回空窗口。退回从头读取等于把请求的区间不存在表述为这就是该区间。
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
        // 达到预算即停止，并重新统计该块的行数：`found` 统计的是整块内的换行，超出裁剪点的部分
        // 不在正文中，上报后会使调用方的 hint 指向一行根本未读取的内容。
        take = budget - bytes;
        overflow = true;
        found = 0;
        for (let index = 0; index < take; index += 1)
          if (chunk[index] === 0x0a) found += 1;
      }
      pieces.push(Buffer.from(chunk.subarray(0, take))); // 必须拷贝：下一轮 readSync 会覆写同一个 chunk
      bytes += take;
      newlines += found;
      position += take;
    }
    const body = Buffer.concat(pieces);
    // 逐块解码会破坏跨块的多字节字符，因此拼接完成后再解码一次（上界为 maxBytes，而非文件大小）。
    // `ignoreBOM`：默认解码会移除 BOM，而此处的正文要原样写回文件 —— 缺少一个 BOM 同样构成改写。
    // `fatal: true`：非法字节抛出异常而不是替换为 U+FFFD。有损解码后的正文交给全量覆盖的写入端，
    // 与截断属于同一类静默损坏，且返回结构中同样没有字段可表达（实测 6 字节的非法 UTF-8 解出 12
    // 字节正文，`bytes` 与 `Buffer.byteLength(content)` 从此不等，而无人会去比对）。overflow 同理不产出。
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
   * jail 内的绝对路径。供需要传出文件而非读入文件的调用方使用（`send_file` / `send_photo`
   * 需将路径传给 grammy 的 InputFile）—— 50MB 的附件不应先读入内存再发送。
   * 解析失败照常抛出 `path_outside_workspace` / `path_denied`：越界必须在获得路径之前就被拦截。
   */
  resolve(path: string): string {
    return this.jail.resolve(path);
  }

  /**
   * 目录不是文件。`statSync(目录).size` 在 btrfs 上为 0，因而 `readSlice` 的 `want` 与
   * `readLineWindow` 的 `position < size` 都不成立 —— `readSync` 从不被调用，EISDIR 永不抛出，
   * 返回 `ok: true` 与空正文，而空正文交给全量覆盖的写入端即构成一次静默清空。ext4 上目录
   * 的 size 为 4096，会如实抛出 EISDIR，也就是说读取目录的报错此前取决于文件系统 —— 这不是
   * 可作为判据的因素，因此在此显式判定（同 `acp/fs.ts` 的 `#target`，该路径早已判定）。
   */
  #isDirectory(target: string): boolean {
    // 不存在时返回不是目录：两条读取路径随后照常如实抛出 ENOENT，行为与此前完全一致。
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
   * 不带行号的读取，正文逐字节等同于磁盘内容（`readLineWindow`）。供需要将读出正文原样写回的
   * 调用方使用 —— `read()` 的 `行号<TAB>` 前缀是给模型的定位坐标，传给全量覆盖的写入端会把
   * 文件替换为带行号的无效内容。目录与不存在照常抛出（与 `read()` 一致）。
   *
   * 超预算与非 UTF-8 均 fail-closed，绝不返回无法原样写回的正文。`read()` 可以截断是因为其返回
   * 结构中有 `truncated` 与 `nextOffset` 可表达该事实；本路径的调用方响应结构中没有对应字段，
   * 因此截断的正文加全量覆盖等于静默删除文件的后半部分。分窗读取合法（`endLine` / `eof` 可表达
   * 这只是一段），截断不合法。不统计总行数：统计需整份扫描，而避免整份扫描正是本路径存在的理由。
   *
   * 非 UTF-8 同样走 `not_utf8` 而非有损解码：经 U+FFFD 替换的正文写回同样是静默损坏，而
   * 有损这一事实在返回结构中同样无处表达。这一点与 `read()` 刻意分岔 —— 后者的正文供模型阅读、
   * 从不写回，有损可接受；本路径的正文将成为文件本身。二进制文件因此在本路径上是硬错误，
   * 而不是读出一串替换字符。
   */
  readText(
    path: string,
    options: { line?: number; limit?: number } = {},
  ): Record<string, unknown> {
    const target = this.jail.resolve(path); // 先解析：越界属安全信号，不应被参数校验错误覆盖
    // 目录判定同样排在窗口参数之前：以 `{limit: 0}` 读取目录时，提示这是目录比提示 limit 需 ≥1
    // 更有价值，两者中只有前者能说明下一步应做什么。
    if (this.#isDirectory(target))
      return {
        ok: false,
        error: "path_is_directory",
        hint: `${relative(this.jail.root, target) || "."} 是目录不是文件；本次工具调用应查看文件`,
      };
    // 窗口参数按 `read_file` 的 schema 校验（`z.number().int().positive()`）。本路径的调用方是
    // 外部 agent 的 JSON，而这两个数值仅经过 `Math.max` / `Math.trunc` 处理 —— 看似已被覆盖，实则
    // NaN 会一路到达 ok:true 加坐标为 NaN 的正文，`limit: 0` 会到达 ok:true 加空正文，
    // 而空正文交给全量覆盖的写入端即清空文件。此处必须是拒绝，而不是纠正。
    for (const [name, value] of [
      ["line", options.line],
      ["limit", options.limit],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        return {
          ok: false,
          error: "invalid_line_window",
          hint: `${name} 须为 ≥1 的整数（line 是 1-based 行号，limit 是行数），收到 ${value}`,
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
          `${display} 有 ${window.size} 字节，超过 tools.fs.maxReadBytes（${this.maxReadBytes}）；从第 ${window.startLine} 行起，该预算在读到第 ${window.endLine} 行时耗尽。本次调用不截断正文，请带 line + limit 分窗读取` +
          (fits > 0
            ? `，例如 line: ${window.startLine}, limit: ${fits}。`
            : `；注意第 ${window.startLine} 行本身即超过预算，该文件只能使用 read_file 的 offset 分页读取。`),
      };
    }
    if (window.notUtf8) {
      return {
        ok: false,
        error: "not_utf8",
        hint: `${display} 从第 ${window.startLine} 行起的这段不是合法 UTF-8。查看内容请使用 read_file，处理二进制请使用 bash。`,
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

  /** 目录去重按 realpath 记录：软链自指时同一真实目录会被重复进入，条数上限无法阻止无限递归。 */
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
   * 无法读取的条目跳过，而不是使整次调用失败。一个断链软链（`ln -s /nowhere x`，下载失败也会
   * 产生）会使 `statSync` 抛出 ENOENT，此前整个 list/glob/grep 因此返回 `ok:false` —— 目录中另外
   * 数百个正常文件一并不可见（docs/22 · I-03）。跳过的条数返回给模型，避免它认为已看到全部。
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
   * 单层目录中可用的条目。`jail.resolve` 抛错的条目与 `statSync` 抛错的条目一样跳过并计数 ——
   * 一个越界软链（`ln -s /etc x`，用 `bash` 一行即可创建）会使其抛出 `path_outside_workspace`，
   * 而此前该异常无人捕获，整次 list/glob/grep 返回 `ok:false`，同目录中另外数百个正常条目一并
   * 不可见。这与 docs/22 · I-03 属同一类，只是那一轮只修复了断链的一侧。
   *
   * `logical` 是软链名一侧的路径，与 `real` 分开携带：`jail.resolve` 返回的是 realpath，
   * 用它作显示路径会把 `loop -> .` 报为空串，而模型以空串调用 `read_file` 就读到了目录本身。
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
   * `depth` 只限制递归层数，无法阻止同一棵树被重复进入：`ln -s . loop` 之下一棵三条目的树可列出
   * 十七条，重复项还会占满 500 条的预算，而模型看到的是一份自相矛盾的目录。因此此处与
   * `glob` / `grep` 使用同一套 realpath 去重（后两者已在 docs/20 · W-FS-01 修复，`list` 当时遗漏）。
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
          // 只有仍有条目但无法放入时才算截断。恰好 500 条且后续本就没有内容却报为截断，
          // 会使模型缩小范围重新查询一份已完整的结果 —— 浪费一步，且它会认为自己未看全。
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
      // 超预算的文件与无法读取的文件都要计入 skipped：该数字是模型判断是否看全的唯一依据
      // （§3.1），静默跳过等于告知它这就是全部命中结果。
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
    const target = this.jail.resolve(path); // 先解析：越界属安全信号，不应被参数校验错误覆盖
    // 写入目录路径此前会在下方备份步骤的 `cpSync` 处失败，报出不含 `EISDIR` 的
    // `Recursive option not enabled` —— 模型无法据此采取任何行动，还会误认为是权限或磁盘问题。
    // 两条读取路径已有该判定，本条是将同一提示补到写入侧（判据同 `#isDirectory`）。
    if (this.#isDirectory(target))
      return {
        ok: false,
        error: "path_is_directory",
        hint: `${relative(this.jail.root, target) || "."} 是目录不是文件；写入其下的文件需在路径中包含文件名`,
      };
    const bytes = Buffer.byteLength(content);
    if (bytes > this.maxWriteBytes)
      return { ok: false, error: "write_too_large" };
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target)) {
      // 备份名包含 ulid：仅按毫秒命名时，同一毫秒内的两次写入会互相覆盖，而备份存在的意义
      // 正是保留上一个版本 —— `edit_file` 连续修改同一文件恰好落在该时间窗口内。
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
    // 该分支必须整份读取（需在全文中统计 oldString 的出现次数），因此先量长度再读取。判据使用
    // `maxWriteBytes` 而非 `maxReadBytes`：修改后的内容无论如何都要经过 `write()` 的写入闸，
    // 用读取预算（256 KiB）拦截会同时拦下大量正常大小的源码文件（docs/27 · R-02）。
    const size = statSync(target).size;
    if (size > this.maxWriteBytes)
      return {
        ok: false,
        error: "file_too_large_to_edit",
        hint: `${relative(this.jail.root, target)} 有 ${size} 字节，超过 tools.fs.maxWriteBytes（${this.maxWriteBytes}）—— 该工具需将全文读入内存才能定位 oldString。请改用 bash 的 sed / python 修改。`,
      };
    const content = readFileSync(target, "utf8");
    const occurrences = content.split(oldString).length - 1;
    // 行号前缀被一并写入 oldString 是该工具最常见的失败方式（`read_file` 返回的正文带行号）。
    // 仅报 `old_string_not_found` 时模型通常只会更换一段文字重试，明确说明后它才会去掉前缀。
    if (!occurrences)
      return {
        ok: false,
        error: "old_string_not_found",
        ...(/^\s*\d+\t/m.test(oldString)
          ? {
              hint: "oldString 中带有 read_file 的行号前缀（`12\\t…`），需去掉行号和制表符，只保留文件中的实际正文",
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
   * 将整棵目录移入回收站等价于 `rm -r`，因此按 docs/05 §3.1 设置两道闸门：必须显式 `recursive`，
   * 且距可达边界 ≥2 层。审批弹窗上只显示一个路径，owner 无法区分本次删除的是单个文件还是半个
   * 工作目录，而 `delete_file` 为 `approval: 'always'` —— 一旦批准即真正移除。
   *
   * 回收站位置按 `jail.root`（会话 workspace）解析，而深度按边界计算 —— 两个基准刻意不同。因此
   * host-fs 模式下删除 `/home/u/x/y` 会将其移入会话工作目录，看似不直观但是正确的：回收站必须位于
   * 一个确定可写、且会被 `gcFiles` 清理的位置，而边界一侧可能是 `/`。
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
          hint: `${inside || "."} 是目录；连同其中内容一并删除需显式传入 recursive: true`,
        };
      // 深度相对可达边界计算（`jail.depthFromBoundary`），而非 `inside` 的基点：`jail.root` 只是
      // 相对路径的解析基点，host-fs 模式下边界为 `/` 而它仍是会话 workspace，因此任何绝对路径都会
      // 产生大量 `..` 段被计入（`/etc` 计算结果是一个很大的数），该闸门对整个宿主文件系统近乎无效。
      // `inside` 仍相对 root —— 它是面向使用者的一侧（返回给模型的路径一律以会话目录为基点，原样
      // 传回时仍能解析到同一文件），两个基准刻意不同。
      const depth = this.jail.depthFromBoundary(target);
      if (depth < 2)
        return {
          ok: false,
          error: "recursive_delete_too_shallow",
          hint: `${inside || "."} 距可达边界只有 ${depth} 层，递归删除只允许作用于二级及更深的路径`,
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
