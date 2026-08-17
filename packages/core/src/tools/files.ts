import { type Stats, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { minimatch } from 'minimatch';
import { basename, dirname, relative } from 'node:path';
import { ulid } from 'ulid';
import { RE2 } from 're2-wasm';
import { PathJail } from './jail.js';
function safeRegex(source: string, ignoreCase: boolean): RE2 | null {
  if ([...source].length > 128) return null;
  try { return new RE2(source, ignoreCase ? 'giu' : 'gu'); } catch { return null; }
}


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
    const buffer = readFileSync(target);
    const effective = Math.min(limit, this.maxReadBytes);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const content = decoder.decode(buffer.subarray(offset, offset + effective));
    return { ok: true, path: relative(this.jail.root, target), content, offset, bytes: Buffer.byteLength(content),
      truncated: offset + effective < buffer.length, nextOffset: offset + effective < buffer.length ? offset + effective : null };
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

  list(path = '.', depth = 1): Record<string, unknown> {
    const root = this.jail.resolve(path);
    const entries: Array<{ path: string; type: string; bytes: number }> = [];
    const skipped = { n: 0 };
    const walk = (directory: string, level: number): void => {
      for (const name of this.#readdir(directory, skipped)) {
        if (!this.options.showHidden && name.startsWith('.')) continue;
        const child = this.jail.resolve(relative(this.jail.root, `${directory}/${name}`));
        const stat = this.#stat(child, skipped);
        if (!stat) continue;
        entries.push({ path: relative(this.jail.root, child), type: stat.isDirectory() ? 'directory' : 'file', bytes: stat.size });
        if (stat.isDirectory() && level < depth) walk(child, level + 1);
      }
    };
    walk(root, 1);
    return { ok: true, entries: entries.slice(0, 500), truncated: entries.length > 500, skipped: skipped.n };
  }

  glob(pattern: string, path = '.'): Record<string, unknown> {
    const root = this.jail.resolve(path);
    const matches: string[] = [];
    const skipped = { n: 0 };
    // 已访问目录集合：workspace 里一个指向自身祖先的软链（`ln -s . loop`，bash 就能建）会让递归
    // 无限下去，而条数上限只在**命中**时才起作用（docs/20 · W-FS-01）。
    const visited = new Set<string>();
    const walk = (directory: string): void => {
      if (!this.#enter(directory, visited)) return;
      for (const name of this.#readdir(directory, skipped)) {
        if (!this.options.showHidden && name.startsWith('.')) continue;
        const child = this.jail.resolve(relative(this.jail.root, `${directory}/${name}`));
        const relativePath = relative(root, child).replaceAll('\\', '/');
        const stat = this.#stat(child, skipped);
        if (!stat) continue;
        if (minimatch(relativePath, pattern, { dot: true })) matches.push(relative(this.jail.root, child));
        if (stat.isDirectory() && matches.length < 500) walk(child);
        if (matches.length >= 500) return;
      }
    };
    walk(root);
    return { ok: true, matches, truncated: matches.length >= 500, skipped: skipped.n };
  }

  grep(pattern: string, path = '.', ignoreCase = false): Record<string, unknown> {
    const root = this.jail.resolve(path);
    const regex = safeRegex(pattern, ignoreCase);
    if (!regex) return { ok: false, error: 'invalid_pattern' };
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const skipped = { n: 0 };
    const visited = new Set<string>();
    const walk = (target: string): void => {
      const stat = this.#stat(target, skipped);
      if (!stat) return;
      if (stat.isDirectory()) { if (!this.#enter(target, visited)) return; for (const name of this.#readdir(target, skipped)) { if (!this.options.showHidden && name.startsWith('.')) continue; if (matches.length >= 200) break; walk(this.jail.resolve(relative(this.jail.root, `${target}/${name}`))); } return; }
      if (stat.size > this.maxReadBytes * 4) return;
      let content: string;
      try { content = readFileSync(target, 'utf8'); } catch { return; }
      for (const [index, line] of content.split('\n').entries()) { regex.lastIndex = 0; if (regex.test(line)) matches.push({ path: relative(this.jail.root, target), line: index + 1, text: line }); if (matches.length >= 200) break; }
    };
    walk(root);
    return { ok: true, matches, truncated: matches.length >= 200, skipped: skipped.n };
  }

  write(path: string, content: string): Record<string, unknown> {
    const bytes = Buffer.byteLength(content);
    if (bytes > this.maxWriteBytes) return { ok: false, error: 'write_too_large' };
    const target = this.jail.resolve(path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target)) {
      const backup = this.jail.resolve(`${this.options.backupDir ?? '.luoli-bak'}/${Date.now()}-${basename(target)}`);
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
    const content = readFileSync(target, 'utf8');
    const occurrences = content.split(oldString).length - 1;
    if (!occurrences) return { ok: false, error: 'old_string_not_found' };
    if (occurrences > 1 && !replaceAll) return { ok: false, error: 'old_string_not_unique', hint: `matched ${occurrences} times` };
    return this.write(path, replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString));
  }

  remove(path: string): Record<string, unknown> {
    const target = this.jail.resolve(path);
    if (!existsSync(target)) return { ok: false, error: 'path_not_found' };
    const trash = this.jail.resolve(`${this.options.trashDir ?? '.luoli-trash'}/${Date.now()}-${ulid()}/${basename(target)}`);
    mkdirSync(dirname(trash), { recursive: true, mode: 0o700 });
    renameSync(target, trash);
    return { ok: true, trashedTo: relative(this.jail.root, trash) };
  }

  move(from: string, to: string): Record<string, unknown> {
    const source = this.jail.resolve(from);
    const target = this.jail.resolve(to);
    if (existsSync(target)) return { ok: false, error: 'target_exists' };
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(source, target);
    return { ok: true, from, to };
  }
}
