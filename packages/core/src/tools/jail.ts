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
  readonly root: string;

  constructor(root: string, private readonly denyGlobs: string[]) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
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
    if (real !== this.root && !real.startsWith(`${this.root}${sep}`)) throw new Error('path_outside_workspace');
    const normalized = real.replaceAll('\\', '/');
    const denied = this.denyGlobs.some((glob) => minimatch(normalized, glob.replace('<root>', process.cwd()), { dot: true }));
    if (denied) throw new Error('path_denied');
    if (existsSync(real) && lstatSync(real).isSymbolicLink()) {
      const target = realpathSync(real);
      if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) throw new Error('path_outside_workspace');
    }
    return real;
  }
}
