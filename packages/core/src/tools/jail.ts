import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';

/**
 * 自撰写通道的落点（`skills/` 与 `plugins/`）对 fs 工具一律关死。
 *
 * **由目录配置推出来，不写死在 `tools.fs.denyGlobs` 的默认值里。** 那两个目录是可配的
 * （`skills.dir` / `plugins.dir`），而 `denyGlobs` 本身又是运维可改的数组 —— 默认值里的两条字面量
 * 在「改了目录」或「自己写过一份 denyGlobs」的部署上一条都不生效，那正是最需要它的时候。
 *
 * 挡的是这条路：`tools.fs.allowHostFsForOwner` 打开时 owner 的 jail 根是 `/`，于是
 * `write_file` 能绕过 `PluginManager.writeSource` 直接改一个**已启用** plugin 的源码 ——
 * 而那道「内容变了就打回未启用」的闸就住在 `writeSource` 里（docs/07 §6.1）。
 */
export function selfAuthoringDenyGlobs(directories: { skillsDir: string; pluginsDir: string }): string[] {
  return [resolve(directories.skillsDir), resolve(directories.pluginsDir)].map((path) => `${path.replaceAll('\\', '/')}/**`);
}

export class PathJail {
  /**
   * 相对路径的解析基点，也是 `FileTools` 回给模型的路径的相对基点 —— **不是**可达边界。
   * host-fs 模式（`tools.fs.allowHostFsForOwner`）下边界是 `/` 而这里仍是会话 workspace：
   * 模型写出来的 `a.txt` 指的是「我的工作目录」，把它解到 `/a.txt` 去既写不进也读不回。
   * 两者同名同源时（默认模式）行为与从前一个字不变。docs/28 · L-TOOL-02。
   */
  readonly root: string;
  /** 可达边界；判定一律走 `#inside`，不要在别处重算前缀。 */
  readonly #boundary: string;
  /**
   * `${boundary}${sep}` 在 `boundary === '/'` 时是 `'//'`，而没有任何真实路径以它开头 ——
   * 那一行曾让 `allowHostFsForOwner=true` 的 owner **每一次** fs 调用都抛
   * `path_outside_workspace`（长得像安全拦截的功能性打死，docs/28 · L-TOOL-02）。
   */
  readonly #prefix: string;

  constructor(root: string, private readonly denyGlobs: string[], options?: { base?: string }) {
    const base = options?.base ?? root;
    // 建 base 不建 root：默认模式下两者是同一个目录；host-fs 模式下 root 是 `/`（必然存在，
    // recursive mkdir 落在已存在目录上只是白跑一趟），真正需要被建出来的是会话 workspace。
    mkdirSync(base, { recursive: true, mode: 0o700 });
    this.root = realpathSync(base);
    this.#boundary = realpathSync(root);
    this.#prefix = this.#boundary.endsWith(sep) ? this.#boundary : `${this.#boundary}${sep}`;
  }

  #inside(path: string): boolean {
    return path === this.#boundary || path.startsWith(this.#prefix);
  }

  resolve(input: string): string {
    if (input.includes('\0')) throw new Error('path_invalid');
    const absolute = resolve(this.root, input);
    let real = absolute;
    if (existsSync(absolute)) {
      real = realpathSync(absolute);
    } else {
      let parent = absolute;
      while (!existsSync(parent)) parent = resolve(parent, '..');
      const realParent = realpathSync(parent);
      real = `${realParent}${absolute.slice(parent.length)}`;
    }
    if (!this.#inside(real)) throw new Error('path_outside_workspace');
    const normalized = real.replaceAll('\\', '/');
    const denied = this.denyGlobs.some((glob) => minimatch(normalized, glob.replace('<root>', process.cwd()), { dot: true }));
    if (denied) throw new Error('path_denied');
    if (existsSync(real) && lstatSync(real).isSymbolicLink()) {
      const target = realpathSync(real);
      if (!this.#inside(target)) throw new Error('path_outside_workspace');
    }
    return real;
  }
}
