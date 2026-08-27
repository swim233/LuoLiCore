import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

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
export function selfAuthoringDenyGlobs(directories: {
  skillsDir: string;
  pluginsDir: string;
}): string[] {
  return [resolve(directories.skillsDir), resolve(directories.pluginsDir)].map(
    (path) => `${path.replaceAll("\\", "/")}/**`,
  );
}

/**
 * fs 工具（与 ACP 的 `fs/*`、终端 cwd）的路径边界。**和 `sandbox.mode` 没有任何关系** ——
 * 那个键管的是执行类工具怎么被隔离（`none | docker`），而这里是「哪些路径解析得出来」，
 * 在任何一档沙箱设置下都照样生效，`resolve()` 在每一次文件调用的正路上。
 * 名字撞了而已：`sandbox.mode` 曾有一档叫 `jail`，已经删掉，别把这个类当成它的残留。
 */
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
  /**
   * `denyGlobs` 加上「以 `/**` 结尾的那些各再来一条去掉后缀的」。
   *
   * minimatch 下 `X/**` **不匹配 `X` 自己**，而 `tools.fs.denyGlobs` 的默认值形状几乎全是这个
   * （`.ssh` 那条、`<root>/config/**`、`<root>/memory/**`、`<root>/skills/**`、`<root>/plugins/**`，
   * 再加 `selfAuthoringDenyGlobs()` 生成的那两条绝对路径）—— 于是被保护目录**本身**过得去，而
   * `FileTools.move` 一道额外的闸都没有：`move_file('skills', 'x')` 把整棵树搬到名单之外，改完再
   * 搬回来，`docs/07 §6.1`「内容变了就打回未启用」那道闸整条被绕过（它住在
   * `PluginManager.writeSource` 里，而这条路根本不经过它）。所以「你碰不到 X 底下的任何东西」
   * 在这里蕴含「你也搬不走、删不掉 X 本身」—— 这不是新开一道门，是把一道本来就想有的门修严。
   * 判据只有这一份：`move` / `remove` / `list` / `grep` / `read` 走的是同一个 `resolve`。
   *
   * 不以 `/**` 结尾的 glob（`*.pem` 那条、`<root>/data/luoli.db*`）语义一个字不变。
   * 在构造时算一次：`resolve()` 是每次 fs 调用都走的热路径，不该在里面做字符串推导。
   * **但 `<root>` 仍在匹配时才替换** —— 挪到这里会让「进程 cwd 在构造之后变了」的行为静默改变。
   */
  readonly #denyGlobs: string[];

  constructor(
    root: string,
    denyGlobs: readonly string[],
    options?: { base?: string },
  ) {
    // `'/**'` 本身（长度 3）去掉后缀是空串，minimatch 拿空模式什么都不匹配 —— 那一条不派生。
    this.#denyGlobs = denyGlobs.flatMap((glob) =>
      glob.length > 3 && glob.endsWith("/**")
        ? [glob, glob.slice(0, -3)]
        : [glob],
    );
    const base = options?.base ?? root;
    // 建 base 不建 root：默认模式下两者是同一个目录；host-fs 模式下 root 是 `/`（必然存在，
    // recursive mkdir 落在已存在目录上只是白跑一趟），真正需要被建出来的是会话 workspace。
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
   * 从**可达边界**数起有几层。`FileTools.remove` 的「递归删除只允许作用在二级及更深的路径」那道闸
   * 要的是这个数 —— 它此前量的是 `relative(jail.root, target)`，而 `root` 只是相对路径的解析基点：
   * host-fs 模式下边界是 `/` 而 root 仍是会话 workspace，于是 `<部署根>/skills` 相对化成
   * `../../../skills` 数出 4 层、闸放行，而那正是 `selfAuthoringDenyGlobs()` 存在的那个模式。更一般地
   * 那个模式下**任何**绝对路径都会攒出一堆 `..` 段（`/etc` 数出来是一个大数），那道闸对整个宿主
   * 文件系统近乎无效。默认模式下 `root === boundary`，这个数与从前逐字节相同。
   *
   * 方法留在 jail 里而不是把 `#boundary` 暴露出去：判据一律走这里，不在别处重算前缀。只对
   * `resolve()` 交回的路径有意义 —— 边界外的路径照旧会把 `..` 段数进来（调用方先过 `resolve`）。
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
