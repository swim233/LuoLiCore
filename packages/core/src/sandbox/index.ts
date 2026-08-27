import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Role } from "@luoli/shared";
import type {
  ContainerManager,
  PersistentSandboxConfig,
} from "./containers.js";
import { sanitizeDockerToken } from "./containers.js";
import type { SandboxResult } from "./exec-stream.js";
import { collectProcess } from "./exec-stream.js";

export type { SandboxResult } from "./exec-stream.js";
export * from "./containers.js";

/** 本进程是否跑在容器里。docker 和 podman 各自留的标记文件。 */
function detectContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export interface SandboxConfig {
  mode: "none" | "docker";
  bypassRoles: Role[];
  dockerBin: string;
  /** 本进程视角的 workspace 根，用来把 run() 收到的绝对路径换算成相对路径。 */
  workspaceDir: string;
  /** 宿主视角的同一个目录；本进程也在宿主上跑时留空。见 #hostPath。 */
  hostWorkspaceDir: string;
  image: string;
  network: "none" | "bridge";
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  readOnlyRoot: boolean;
  tmpfsMb: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  /**
   * 会话级持久容器（§5.5）。只在 `mode='docker'` 且角色不在 `bypassRoles` 里时有意义。
   *
   * **可选，缺省 = 关**：装配方不给这一段时行为与持久化落地之前一个字不差。这不是图省事 ——
   * 「没配过这个功能」和「配了并关掉」在运行时本来就该是同一件事，而让每一个既有构造点
   * 都必须写一遍 `persistent: { enabled: false, … }` 只会让人照着抄一份很快就漂掉的默认值。
   */
  persistent?: PersistentSandboxConfig;
}

const PERSISTENT_OFF: PersistentSandboxConfig = {
  enabled: false,
  idleTtlMs: 86_400_000,
  maxLifetimeMs: 0,
  maxContainers: 16,
  network: "none",
  reapCron: "*/5 * * * *",
};

/**
 * 一次沙箱执行的事实（`docs/10 §2` 的 `sandbox.run`）。`turnId` 让它进得了那一轮的 trace ——
 * 沙箱执行此前在日志里**完全不存在**，一次 OOM 或被 SIGKILL 的命令只能从 `tool.call` 的输出里猜。
 */
export interface SandboxRunEvent {
  turnId: string;
  role: Role;
  /**
   * `none` 不是一种执行方式，而是「沙箱未启用、这次被拒」—— 那一档只会跟着 `denied` 一起出现。
   * 这一档此前借用了另一个执行模式的名字，于是日志、`/api/health/detail`、`GET /api/sandbox`
   * 三处一致地报了个假模式 —— 宁可让这个联合多一个成员，也不要在观测面上说谎。
   */
  mode: "none" | "host" | "docker";
  image: string | null;
  exitCode: number | null;
  durationMs: number;
  ok: boolean;
  killed: boolean;
  oom: boolean;
  truncated: boolean;
  /** 被拒（沙箱未启用 / docker 不可用 / 路径映射不成立）时的原因，正常执行是 undefined。 */
  denied?: string;
}

export class Sandbox {
  #dockerAvailable: boolean | null = null;
  readonly #inContainer: boolean;
  readonly #cfg: () => SandboxConfig;
  readonly #warn: ((message: string) => void) | undefined;
  #warnedEgress = false;
  #seq = 0;
  #containers: ContainerManager | null = null;

  /**
   * config 传 getter 时每次读都取最新值。吃启动快照的后果是：事故中在 WebUI 把 `docker` 改成 `none`
   * 想切断执行类工具，接口返回 200、`GET /api/sandbox` 也显示已改，而 bash/python 照跑不误
   * （docs/20 · W-CFG-02）。
   */
  constructor(
    config: SandboxConfig | (() => SandboxConfig),
    dockerAvailable?: boolean,
    inContainer?: boolean,
    onWarn?: (message: string) => void,
    private readonly onUnavailable?: (reason: string, role: Role) => void,
    /**
     * 每一次执行落一条 `sandbox.run`（`docs/10 §2`）。装配方把它接到 `LogSink` 上 —— 这里只发事实，
     * 不认识 LogSink：沙箱是 `bash` / `python` / 自撰写工具三条路共用的底层，让它持有日志接口
     * 等于给它一个它用不上的依赖方向。可选：测试直接构造时不给，行为一个字不变。
     */
    private readonly onRun?: (event: SandboxRunEvent) => void,
  ) {
    this.#cfg = typeof config === "function" ? config : () => config;
    this.#dockerAvailable = dockerAvailable ?? null;
    this.#inContainer = inContainer ?? detectContainer();
    this.#warn = onWarn;
  }

  setDockerAvailable(available: boolean): void {
    this.#dockerAvailable = available;
  }

  /**
   * 持久容器的管理器。**装配期注入而不是构造参数**：`ContainerManager` 要 DB 句柄，而
   * `Sandbox` 一直是「不认识仓储层」的底层（同 `onRun` 那条注释）；没注入时整块降级成
   * 一次性容器，行为与本次改动之前一个字不差。
   */
  bindContainers(containers: ContainerManager): void {
    this.#containers = containers;
  }

  containers(): ContainerManager | null {
    return this.#containers;
  }

  /**
   * 某个会话的工作目录在**宿主**上的路径 —— `docker run -v` 的左半边由宿主 daemon 解析（§5.3）。
   * `container_*` 工具要给任意会话建容器，而那条路径的换算规则只有这里知道，所以开一个
   * 公开入口而不是让工具层自己拼（拼错的表现是宿主上默默多一个空目录，而不是报错）。
   * 顺手把本进程视角的那个目录建出来 —— docker 对不存在的宿主路径同样不报错。
   */
  hostWorkspaceFor(chatId: string): string | null {
    const workspace = resolve(this.#cfg().workspaceDir, chatId);
    const mounted = this.#hostPath(workspace);
    if (mounted === null) return null;
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return mounted;
  }

  #persistent(): PersistentSandboxConfig {
    return this.#cfg().persistent ?? PERSISTENT_OFF;
  }

  /** `mode='docker'` + 持久化开着 + 这个角色不 bypass 时，这一轮该落进会话的常驻容器。 */
  #usesPersistent(mode: "none" | "host" | "docker"): boolean {
    return (
      mode === "docker" &&
      this.#persistent().enabled &&
      this.#containers !== null
    );
  }

  /** 发事件不许打断执行：这一层的调用点在返回结果的正路上，而 `LogSink.event` 之外的回调不保证不抛。 */
  #emit(event: SandboxRunEvent): void {
    try {
      this.onRun?.(event);
    } catch {
      /* 观测不该把一次成功的执行变成失败 */
    }
  }

  /**
   * `docker run -v` 里的路径由**宿主** daemon 解析，而 run() 拿到的是本进程视角的路径。
   * 本进程也在宿主上时两者相同；本进程在容器里时不同，且 docker 对不存在的宿主路径不会报错——
   * 它会默默建一个空目录，于是 bash 写的文件 read_file 读不到。所以这里要么映射，要么拒绝。
   */
  #hostPath(workspace: string): string | null {
    if (!this.#cfg().hostWorkspaceDir) return workspace;
    const rel = relative(resolve(this.#cfg().workspaceDir), workspace);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return join(this.#cfg().hostWorkspaceDir, rel);
  }

  /** docker 模式下路径映射本身不成立的情况；plan() 与 probe() 共用同一句话。 */
  #mappingError(): string | null {
    if (
      this.#cfg().mode !== "docker" ||
      !this.#inContainer ||
      this.#cfg().hostWorkspaceDir
    )
      return null;
    return "本进程在容器内且未配置 sandbox.hostWorkspaceDir：-v 会挂到宿主上不存在的路径，沙箱与文件工具将看到两个不同的目录";
  }

  /**
   * `docker pull <sandbox.image>`。镜像名取自配置而不是请求体：让人从界面上指定任意镜像
   * 等于绕开 `sandbox.image` 那道配置，而沙箱镜像决定了模型能在里面用什么。
   * **只 pull 不 build** —— build 要有 Dockerfile 上下文、会跑任意构建指令、耗时以分钟计，
   * 那是部署动作不是控制台按钮（docs/09 §3.7）。
   */
  async pullImage(): Promise<{ ok: boolean; image: string; error?: string }> {
    const image = this.#cfg().image;
    return new Promise((resolve) => {
      const child = spawn(this.#cfg().dockerBin, ["pull", image], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let settled = false;
      let error = "";
      const finish = (value: {
        ok: boolean;
        image: string;
        error?: string;
      }): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      child.stderr.on("data", (chunk: Buffer) => {
        error += chunk.toString();
      });
      // 拉一个几百 MB 的镜像可能要几分钟，但不能没有上界：这是一个同步等待的 HTTP 请求。
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, image, error: "pull_timeout" });
      }, 600_000);
      timer.unref?.();
      child.once("error", (cause) => {
        clearTimeout(timer);
        finish({ ok: false, image, error: cause.message });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        finish(
          code === 0
            ? { ok: true, image }
            : {
                ok: false,
                image,
                error: error.trim().slice(0, 500) || `exit_${code}`,
              },
        );
      });
    });
  }

  async probe(): Promise<{
    available: boolean;
    mode: SandboxConfig["mode"];
    error?: string;
  }> {
    if (this.#cfg().mode !== "docker")
      return { available: false, mode: this.#cfg().mode };
    const mapping = this.#mappingError();
    if (mapping) return { available: false, mode: "docker", error: mapping };
    const result = await new Promise<{ available: boolean; error?: string }>(
      (resolve) => {
        const child = spawn(
          this.#cfg().dockerBin,
          ["version", "--format", "{{.Server.Version}}"],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let settled = false;
        const finish = (value: {
          available: boolean;
          error?: string;
        }): void => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        let error = "";
        child.stderr.on("data", (chunk: Buffer) => {
          error += chunk.toString();
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({ available: false, error: "probe_timeout" });
        }, 5000);
        child.once("error", (cause) => {
          clearTimeout(timer);
          finish({ available: false, error: cause.message });
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          finish(
            code === 0
              ? { available: true }
              : { available: false, error: error.trim() || `exit_${code}` },
          );
        });
      },
    );
    this.#dockerAvailable = result.available;
    return result.error
      ? {
          available: result.available,
          mode: this.#cfg().mode,
          error: result.error,
        }
      : { available: result.available, mode: this.#cfg().mode };
  }

  plan(
    role: Role,
    _workspace = ".",
  ): { allowed: boolean; mode: "none" | "host" | "docker"; reason?: string } {
    const mode = this.#cfg().mode;
    if (this.#cfg().bypassRoles.includes(role))
      return { allowed: true, mode: "host" };
    if (mode === "none")
      return {
        allowed: false,
        mode: "none",
        reason: "沙箱未启用，执行类工具已禁用",
      };
    if (mode === "docker" && this.#dockerAvailable === false)
      return {
        allowed: false,
        mode: "docker",
        reason: "Docker 沙箱不可用，执行类工具已禁用",
      };
    const mapping = this.#mappingError();
    if (mapping)
      return {
        allowed: false,
        mode: "docker",
        reason: `${mapping}，执行类工具已禁用`,
      };
    // 持久容器默认出网，而 §5.3 里那个「可审计出站代理」至今没实现 —— 这是一句必须说出口的话，
    // 不能靠默认值糊过去。按「变了才再说一次」去重：plan() 在每条命令上都跑，照实说会刷屏。
    const egress =
      mode === "docker" &&
      this.#persistent().enabled &&
      this.#persistent().network === "bridge";
    if (egress !== this.#warnedEgress) {
      if (egress)
        this.#warn?.(
          "sandbox.persistent.network=bridge：持久容器能直达公网与宿主，且没有可审计的出站代理。要断网把它改成 none（上面的 sandbox.network 管的是一次性容器，不是这个）",
        );
      this.#warnedEgress = egress;
    }
    return { allowed: true, mode };
  }

  /**
   * @param options.extraEnv 追加给子进程的环境变量。**三条路都不经过 shell 解析** —— docker
   *   （一次性与持久）走 `-e k=v` 的 argv，宿主走 `spawn` 的 options —— 所以这是把模型
   *   给的值交进脚本时唯一不需要做引号决策的通道。键名白名单在调用方（`CustomToolManager`）
   *   那一层，这里只负责「叠加在既有三键白名单之上」：`BOT_TOKEN` / `LUOLI_MASTER_KEY` 仍然进不来。
   * @param options.chatId 这一次执行属于哪个会话。**显式传，不从 workspace 路径反推** ——
   *   路径反推靠的是「最后一段恰好是 chatId」这个巧合，而持久容器是按会话分的，认错了就是
   *   把一个群的命令送进另一个群的容器。不给（WebUI 试跑、探测）时退回一次性容器。
   */
  async run(
    command: string,
    role: Role,
    workspace: string,
    abortSignal: AbortSignal,
    timeoutMs = this.#cfg().defaultTimeoutMs,
    turnId = "adhoc",
    options: {
      extraEnv?: Readonly<Record<string, string>>;
      chatId?: string;
    } = {},
  ): Promise<SandboxResult> {
    const extraEnv = options.extraEnv;
    if (abortSignal.aborted)
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "cancelled",
        truncated: false,
        durationMs: 0,
        killed: true,
        oom: false,
      };
    const plan = this.plan(role, workspace);
    /** 被拒也要落一行：模型侧只看到一句工具失败，而「为什么」是配置层的事。 */
    const denied = (reason: string): SandboxResult => {
      this.#emit({
        turnId,
        role,
        mode: plan.mode,
        image: null,
        exitCode: null,
        durationMs: 0,
        ok: false,
        killed: false,
        oom: false,
        truncated: false,
        denied: reason,
      });
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: reason,
        truncated: false,
        durationMs: 0,
        killed: false,
        oom: false,
      };
    };
    if (!plan.allowed) {
      // 「沙箱不可用而有非 owner 请求执行」是 docs/10 §6 那六类告警之一：对用户表现为工具莫名
      // 失败，而运维那边没有任何信号。owner 走 bypass 不算 —— 那是配置本来就允许的形态。
      if (role !== "owner") this.onUnavailable?.(plan.reason ?? "denied", role);
      return denied(plan.reason ?? "denied");
    }
    const mounted =
      plan.mode === "docker" ? this.#hostPath(workspace) : workspace;
    if (mounted === null)
      return denied(
        `workspace 不在 sandbox.workspaceDir 之下，无法换算成宿主路径：${workspace}`,
      );
    // 建目录放在放行之后：被拒的调用不该在盘上留下痕迹。容器内建的目录经 ./data 绑定挂载
    // 同步到宿主，所以 #hostPath 换算出来的路径此刻在宿主上也已存在。
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const timeout = Math.min(timeoutMs, this.#cfg().maxTimeoutMs);
    // 持久容器（§5.5）：`docker exec` 进这个会话的常驻容器，而不是每次新起一个。
    // 拿不到 chatId 就退回一次性容器 —— 那条路一个字没改。
    const persistent =
      this.#usesPersistent(plan.mode) && options.chatId
        ? await this.#containers!.prepareExec({
            chatId: options.chatId,
            mountedWorkspace: mounted,
            command,
            timeoutMs: timeout,
            ...(extraEnv ? { extraEnv } : {}),
          })
        : null;
    if (persistent && !persistent.ok)
      return {
        ...denied(persistent.error),
        ...(persistent.hint ? { hint: persistent.hint } : {}),
      };
    // 名字必须带 turnId（docs/05 §5.3）：`Date.now()` 在并发上限 8 的同一毫秒里会撞名，
    // `docker run --name` 冲突让第二个容器直接失败；而且 /cancel 想按 turn 找容器也无从找起。
    // **turnId 要 sanitize**：WebUI 试跑那条路的 turnId 是 `dryrun:<ulid>`，而冒号不在 docker
    // 容器名的字符集里 —— 那条路的 `bash` 一直以 `invalid name` 收场，不是沙箱层的错误。
    this.#seq += 1;
    const name = `luoli-sbx-${sanitizeDockerToken(turnId)}-${this.#seq}`;
    const dockerArgs = [
      "run",
      "--rm",
      "--name",
      name,
      `--network=${this.#cfg().network}`,
      `--memory=${this.#cfg().memoryMb}m`,
      `--memory-swap=${this.#cfg().memoryMb}m`,
      `--cpus=${this.#cfg().cpus}`,
      `--pids-limit=${this.#cfg().pidsLimit}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=1000:1000",
      `--tmpfs=/tmp:rw,size=${this.#cfg().tmpfsMb}m,noexec`,
      "-v",
      `${mounted}:/workspace:rw`,
      "-w",
      "/workspace",
      "-e",
      "HOME=/workspace",
      "-e",
      "LANG=C.UTF-8",
    ];
    // 追加 env 必须在 push image 之前：image 之后的 argv 是**容器里的命令**，`-e` 落到那边就成了
    // 传给 `timeout` 的参数。
    for (const [key, value] of Object.entries(extraEnv ?? {}))
      dockerArgs.push("-e", `${key}=${value}`);
    if (this.#cfg().readOnlyRoot) dockerArgs.push("--read-only");
    dockerArgs.push(
      this.#cfg().image,
      "timeout",
      "-s",
      "KILL",
      String(Math.ceil(timeout / 1000)),
      "sh",
      "-c",
      command,
    );
    // 子进程 env 白名单：只这三个字面量。此前后面还接着 `&& !/(TOKEN|KEY|SECRET|LUOLI)/i.test(key)`
    // —— 前半段已经把 key 限死了，后半段恒为真（docs/27 · T-03）。白名单本身就是那道闸；
    // 真要让它可配，那时再把过滤加回来。
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ["PATH", "LANG", "TZ"].includes(key),
      ),
    );
    const child =
      plan.mode === "docker"
        ? spawn(
            this.#cfg().dockerBin,
            persistent ? persistent.argv : dockerArgs,
            { stdio: ["ignore", "pipe", "pipe"] },
          )
        : // 剩下的只有 `plan.mode === 'host'`（bypassRoles）：`none` 走不到这里，plan 不放行。
          spawn("/bin/sh", ["-c", command], {
            cwd: workspace,
            env: { ...env, HOME: workspace, ...extraEnv },
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
    const result = await collectProcess(child, {
      timeoutMs: timeout,
      maxOutputBytes: this.#cfg().maxOutputBytes,
      abortSignal,
      kill: () => {
        // **持久容器这一档不能 `docker kill`**：那会把整个会话的环境连同别人的后台进程一起干掉，
        // 而超时与 `/cancel` 走的是同一个钩子（§5.5）。打容器里那个进程组就够了。
        if (persistent) persistent.cancel();
        else if (plan.mode === "docker")
          spawn(this.#cfg().dockerBin, ["kill", name], { stdio: "ignore" });
        else if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* 已退出 */
          }
      },
    });
    persistent?.settle();
    this.#emit({
      turnId,
      role,
      mode: plan.mode,
      image: plan.mode === "docker" ? this.#cfg().image : null,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ok: result.ok,
      killed: result.killed,
      oom: result.oom,
      truncated: result.truncated,
    });
    return persistent?.note ? { ...result, note: persistent.note } : result;
  }
}
