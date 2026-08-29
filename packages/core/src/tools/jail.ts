import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

/**
 * 自撰写通道的落点（`skills/` 与 `plugins/`）对 fs 工具一律禁止访问。
 *
 * 由目录配置推导，不写死在 `tools.fs.denyGlobs` 的默认值里。那两个目录可配置
 * （`skills.dir` / `plugins.dir`），而 `denyGlobs` 本身也是运维可改的数组：默认值里的两条字面量
 * 在改过目录或自定义过 denyGlobs 的部署上一条都不生效，而那正是最需要它生效的场景。
 *
 * 拦截的是这条路：`tools.fs.allowHostFsForOwner` 打开时 owner 的 jail 根是 `/`，于是
 * `write_file` 可绕过 `PluginManager.writeSource` 直接修改一个已启用 plugin 的源码，
 * 而内容变更即打回未启用的那道闸位于 `writeSource` 内（docs/07 §6.1）。
 */
export function selfAuthoringDenyGlobs(directories: {
  skillsDir: string;
  pluginsDir: string;
}): string[] {
  return [resolve(directories.skillsDir), resolve(directories.pluginsDir)].map(
    (path) => `${path.replaceAll("\\", "/")}/**`,
  );
}

/**
 * fs 工具（以及 ACP 的 `fs/*`、终端 cwd）的路径边界，与 `sandbox.mode` 无关：
 * 那个键决定执行类工具如何被隔离（`none | docker`），而这里决定哪些路径解析得出来，
 * 在任意沙箱档位下都照样生效，`resolve()` 位于每一次文件调用的主路径上。
 * 仅是名称重合：`sandbox.mode` 曾有一档叫 `jail`，已删除，本类与它无关。
 */
export class PathJail {
  /**
   * 相对路径的解析基点，也是 `FileTools` 回给模型的路径的相对基点，不是可达边界。
   * host-fs 模式（`tools.fs.allowHostFsForOwner`）下边界是 `/` 而这里仍是会话 workspace：
   * 模型写出的 `a.txt` 指向它的工作目录，解析到 `/a.txt` 既写不进也读不回。
   * 两者同源时（默认模式）行为与此前完全一致。docs/28 · L-TOOL-02。
   */
  readonly root: string;
  /** 可达边界；判定一律走 `#inside`，不要在别处重算前缀。 */
  readonly #boundary: string;
  /**
   * `${boundary}${sep}` 在 `boundary === '/'` 时是 `'//'`，而没有任何真实路径以它开头：
   * 该写法曾让 `allowHostFsForOwner=true` 的 owner 每一次 fs 调用都抛
   * `path_outside_workspace`，表现为安全拦截、实为功能性失效（docs/28 · L-TOOL-02）。
   */
  readonly #prefix: string;
  /**
   * `denyGlobs` 再加上：以 `/**` 结尾的每一条各派生一条去掉该后缀的。
   *
   * minimatch 下 `X/**` 不匹配 `X` 自身，而 `tools.fs.denyGlobs` 的默认值几乎全是这个形状
   * （`.ssh` 那条、`<root>/config/**`、`<root>/memory/**`、`<root>/skills/**`、`<root>/plugins/**`，
   * 再加 `selfAuthoringDenyGlobs()` 生成的那两条绝对路径），于是被保护目录本身可以通过，而
   * `FileTools.move` 没有额外的闸：`move_file('skills', 'x')` 把整棵树移出名单，改完再
   * 移回来，`docs/07 §6.1` 内容变更即打回未启用的那道闸被整条绕过（它位于
   * `PluginManager.writeSource`，而这条路根本不经过它）。因此不可访问 X 之下的任何内容
   * 在此蕴含不可移走、不可删除 X 本身；这不是新开入口，而是把既有边界补严。
   * 判据只有这一份：`move` / `remove` / `list` / `grep` / `read` 走的是同一个 `resolve`。
   *
   * 不以 `/**` 结尾的 glob（`*.pem` 那条、`<root>/data/luoli.db*`）语义完全不变。
   * 在构造时算一次：`resolve()` 是每次 fs 调用都走的热路径，不该在其中做字符串推导。
   * 但 `<root>` 仍在匹配时才替换：提前到此处会静默改变进程 cwd 在构造之后变更时的行为。
   */
  readonly #denyGlobs: string[];

  constructor(
    root: string,
    denyGlobs: readonly string[],
    options?: { base?: string },
  ) {
    // `'/**'` 本身（长度 3）去掉后缀是空串，minimatch 对空模式不匹配任何路径，故该条不派生。
    this.#denyGlobs = denyGlobs.flatMap((glob) =>
      glob.length > 3 && glob.endsWith("/**")
        ? [glob, glob.slice(0, -3)]
        : [glob],
    );
    const base = options?.base ?? root;
    // 建 base 不建 root：默认模式下两者是同一个目录；host-fs 模式下 root 是 `/`（必然存在，
    // recursive mkdir 作用于已存在目录只是空转），真正需要创建的是会话 workspace。
    mkdirSync(base, { recursive: true, mode: 0o700 });
    this.root = realpathSync(base);
    this.#boundary = realpathSync(root);
    this.#prefix = this.#boundary.endsWith(sep)
      ? this.#boundary
      : `${this.#boundary}${sep}`;
  }

  #inside(path: string): boolean {
    return path === this.#boundary || path.startsWith(this.#prefix);
  }

  /**
   * 从可达边界起算的层数。`FileTools.remove` 中递归删除仅允许作用于二级及更深路径的那道闸
   * 要的是这个数：它此前量的是 `relative(jail.root, target)`，而 `root` 只是相对路径的解析基点。
   * host-fs 模式下边界是 `/` 而 root 仍是会话 workspace，于是 `<部署根>/skills` 相对化成
   * `../../../skills`、计为 4 层而被放行，该模式恰是 `selfAuthoringDenyGlobs()` 存在的前提。更一般地，
   * 该模式下任何绝对路径都会攒出多个 `..` 段（`/etc` 会算出一个很大的数），那道闸对整个宿主
   * 文件系统近乎失效。默认模式下 `root === boundary`，这个数与从前逐字节相同。
   *
   * 方法留在 jail 内而不是把 `#boundary` 暴露出去：判据一律走这里，不在别处重算前缀。只对
   * `resolve()` 交回的路径有意义；边界外的路径照旧会把 `..` 段数进来（调用方先过 `resolve`）。
   */
  depthFromBoundary(real: string): number {
    return relative(this.#boundary, real).split(sep).filter(Boolean).length;
  }

  resolve(input: string): string {
    if (input.includes("\0")) throw new Error("path_invalid");
    const absolute = resolve(this.root, input);
    let real = absolute;
    if (existsSync(absolute)) {
      real = realpathSync(absolute);
    } else {
      let parent = absolute;
      while (!existsSync(parent)) parent = resolve(parent, "..");
      const realParent = realpathSync(parent);
      real = `${realParent}${absolute.slice(parent.length)}`;
    }
    if (!this.#inside(real)) throw new Error("path_outside_workspace");
    const normalized = real.replaceAll("\\", "/");
    const denied = this.#denyGlobs.some((glob) =>
      minimatch(normalized, glob.replace("<root>", process.cwd()), {
        dot: true,
      }),
    );
    if (denied) throw new Error("path_denied");
    if (existsSync(real) && lstatSync(real).isSymbolicLink()) {
      const target = realpathSync(real);
      if (!this.#inside(target)) throw new Error("path_outside_workspace");
    }
    return real;
  }
}
