import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';

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
