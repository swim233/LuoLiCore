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

/** 本进程是否运行在容器内。docker 与 podman 各自留下的标记文件。 */
function detectContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export interface SandboxConfig {
  mode: "none" | "docker";
  bypassRoles: Role[];
  dockerBin: string;
  /** 本进程视角的 workspace 根，用于把 run() 收到的绝对路径换算成相对路径。 */
  workspaceDir: string;
  /** 宿主视角的同一目录；本进程本身在宿主上运行时留空。见 #hostPath。 */
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
   * 会话级持久容器（§5.5）。仅在 `mode='docker'` 且角色不在 `bypassRoles` 内时生效。
   *
   * 可选，缺省为关：装配方不提供该段时，行为与持久化特性落地之前完全一致。未配置该功能与
   * 配置后关闭在运行时本就应等价；强制每个既有构造点写一遍 `persistent: { enabled: false, … }`
   * 只会产生易漂移的重复默认值。
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
 * 一次沙箱执行的事实记录（`docs/10 §2` 的 `sandbox.run`）。`turnId` 使其归入该轮的 trace ——
 * 沙箱执行此前在日志中完全缺席，OOM 或被 SIGKILL 的命令只能从 `tool.call` 的输出推测。
 */
export interface SandboxRunEvent {
  turnId: string;
  role: Role;
  /**
   * `none` 不是一种执行方式，而表示沙箱未启用、本次被拒，只与 `denied` 同时出现。
   * 该档此前借用了另一个执行模式的名字，导致日志、`/api/health/detail`、`GET /api/sandbox`
   * 三处一致地报告了错误的模式 —— 宁可让该联合类型多一个成员，也不能在观测面上失真。
   */
  mode: "none" | "host" | "docker";
  image: string | null;
  exitCode: number | null;
  durationMs: number;
  ok: boolean;
  killed: boolean;
  oom: boolean;
  truncated: boolean;
  /** 被拒（沙箱未启用 / docker 不可用 / 路径映射不成立）的原因，正常执行为 undefined。 */
  denied?: string;
  /**
   * 本次执行所属的父 span —— 调用方给出的 `tool.call` span id（`docs/10 §1`）。
   *
   * 此前只有 `turnId`：进得了 trace，但进不了树。Trace 视图按 `parentSpanId` 计算缩进，
   * `sandbox.run` 因而被画在 0px、与 `turn.start` 同级，一轮内 3 次 `tool.call python` 对应的
   * 3 条 `sandbox.run` 只能按时间戳推测配对 —— 并发沙箱调用下时间戳也不足以区分
   * （docs/29 · `M-LOG-02`）。
   *
   * 非轮次调用（探测、`turnId='adhoc'`）没有父 span，缺省即可。
   */
  parentSpanId?: string;
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
   * config 传 getter 时每次读取最新值。使用启动快照的后果：事故中在 WebUI 把 `docker` 改成
   * `none` 以切断执行类工具，接口返回 200、`GET /api/sandbox` 显示已修改，而 bash/python 仍在执行
   * （docs/20 · W-CFG-02）。
   */
  constructor(
    config: SandboxConfig | (() => SandboxConfig),
    dockerAvailable?: boolean,
    inContainer?: boolean,
    onWarn?: (message: string) => void,
    private readonly onUnavailable?: (reason: string, role: Role) => void,
    /**
     * 每次执行落一条 `sandbox.run`（`docs/10 §2`）。装配方将其接到 `LogSink` 上；此处只发出事实，
     * 不依赖 LogSink：沙箱是 `bash` / `python` / 自撰写工具三条路共用的底层，持有日志接口会引入
     * 多余的依赖方向。可选，测试直接构造时不提供，行为不变。
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
   * 持久容器的管理器，装配期注入而非构造参数：`ContainerManager` 需要 DB 句柄，而
   * `Sandbox` 是不依赖仓储层的底层（同 `onRun` 那条注释）；未注入时整块降级为
   * 一次性容器，行为与本次改动之前一致。
   */
  bindContainers(containers: ContainerManager): void {
    this.#containers = containers;
  }

  containers(): ContainerManager | null {
    return this.#containers;
  }

  /**
   * 某个会话的工作目录在宿主上的路径 —— `docker run -v` 的左半边由宿主 daemon 解析（§5.3）。
   * `container_*` 工具需要为任意会话创建容器，而该路径的换算规则只有此处掌握，因此提供公开
   * 入口而不是让工具层自行拼接（拼接错误的表现是宿主上多出一个空目录，而非报错）。
   * 同时创建本进程视角的对应目录 —— docker 对不存在的宿主路径同样不报错。
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

  /** `mode='docker'` + 持久化开启 + 该角色不 bypass 时，本轮应落入会话的常驻容器。 */
  #usesPersistent(mode: "none" | "host" | "docker"): boolean {
    return (
      mode === "docker" &&
      this.#persistent().enabled &&
      this.#containers !== null
    );
  }

  /** 发事件不得中断执行：本层调用点位于返回结果的主路径上，而 `LogSink.event` 之外的回调不保证不抛。 */
  #emit(event: SandboxRunEvent): void {
    try {
      this.onRun?.(event);
    } catch {
      /* 观测失败不应使一次成功的执行变为失败 */
    }
  }

  /**
   * `docker run -v` 中的路径由宿主 daemon 解析，而 run() 拿到的是本进程视角的路径。
   * 本进程在宿主上时两者相同；本进程在容器内时不同，且 docker 对不存在的宿主路径不报错 ——
   * 它会创建一个空目录，导致 bash 写入的文件 read_file 读不到。因此此处要么映射，要么拒绝。
   */
  #hostPath(workspace: string): string | null {
    if (!this.#cfg().hostWorkspaceDir) return workspace;
    const rel = relative(resolve(this.#cfg().workspaceDir), workspace);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return join(this.#cfg().hostWorkspaceDir, rel);
  }

  /** docker 模式下路径映射不成立的情形；plan() 与 probe() 共用同一份文案。 */
  #mappingError(): string | null {
    if (
      this.#cfg().mode !== "docker" ||
      !this.#inContainer ||
      this.#cfg().hostWorkspaceDir
    )
      return null;
    return "本进程在容器内且未配置 sandbox.hostWorkspaceDir：-v 将挂载到宿主上不存在的路径，沙箱与文件工具将看到两个不同的目录";
  }

  /**
   * `docker pull <sandbox.image>`。镜像名取自配置而非请求体：允许从界面指定任意镜像
   * 等于绕开 `sandbox.image` 这道配置，而沙箱镜像决定了模型在其中可用的能力。
   * 只 pull 不 build —— build 需要 Dockerfile 上下文、会执行任意构建指令、耗时以分钟计，
   * 属于部署动作而非控制台按钮（docs/09 §3.7）。
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
      // 拉取几百 MB 的镜像可能耗时数分钟，但必须有上界：这是一个同步等待的 HTTP 请求。
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
    // 持久容器默认可出网，而 §5.3 的可审计出站代理尚未实现 —— 该事实必须显式告知，
    // 不能由默认值掩盖。按值变化去重：plan() 对每条命令都执行，无条件输出会刷屏。
    const egress =
      mode === "docker" &&
      this.#persistent().enabled &&
      this.#persistent().network === "bridge";
    if (egress !== this.#warnedEgress) {
      if (egress)
        this.#warn?.(
          "sandbox.persistent.network=bridge：持久容器可直连公网与宿主，且无可审计的出站代理。将其改为 none 以断开网络（上方的 sandbox.network 作用于一次性容器，不适用于本项）",
        );
      this.#warnedEgress = egress;
    }
    return { allowed: true, mode };
  }

  /**
   * @param options.extraEnv 追加给子进程的环境变量。三条路都不经 shell 解析 —— docker
   *   （一次性与持久）走 `-e k=v` 的 argv，宿主走 `spawn` 的 options —— 因此这是把模型给出的值
   *   传入脚本时唯一无需做引号决策的通道。键名白名单在调用方（`CustomToolManager`）那一层，
   *   此处只负责叠加在既有三键白名单之上：`BOT_TOKEN` / `LUOLI_MASTER_KEY` 仍不可注入。
   * @param options.chatId 本次执行所属会话。显式传入，不从 workspace 路径反推 ——
   *   路径反推依赖「最后一段恰好是 chatId」这一巧合，而持久容器按会话划分，判断错误会把一个群的
   *   命令送进另一个群的容器。缺省（WebUI 试跑、探测）时退回一次性容器。
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
      /** 调用方 `tool.call` span 的 id。见 `SandboxRunEvent.parentSpanId`。 */
      parentSpanId?: string;
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
    /** 被拒同样落一行：模型侧只看到工具失败，而拒绝原因属于配置层。 */
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
        ...(options.parentSpanId
          ? { parentSpanId: options.parentSpanId }
          : {}),
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
      // 沙箱不可用而非 owner 请求执行属于 docs/10 §6 六类告警之一：对用户表现为工具无故失败，
      // 而运维侧没有任何信号。owner 走 bypass 不计入 —— 那是配置本就允许的形态。
      if (role !== "owner") this.onUnavailable?.(plan.reason ?? "denied", role);
      return denied(plan.reason ?? "denied");
    }
    const mounted =
      plan.mode === "docker" ? this.#hostPath(workspace) : workspace;
    if (mounted === null)
      return denied(
        `workspace 不在 sandbox.workspaceDir 之下，无法换算成宿主路径：${workspace}`,
      );
    // 创建目录放在放行之后：被拒的调用不应在磁盘上留下痕迹。容器内创建的目录经 ./data 绑定挂载
    // 同步到宿主，因此 #hostPath 换算出的路径此刻在宿主上同样存在。
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const timeout = Math.min(timeoutMs, this.#cfg().maxTimeoutMs);
    // 持久容器（§5.5）：`docker exec` 进入该会话的常驻容器，而不是每次新建。
    // 无 chatId 时退回一次性容器 —— 那条路径未作改动。
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
    // 容器名必须带 turnId（docs/05 §5.3）：`Date.now()` 在并发上限 8 的同一毫秒内会重名，
    // `docker run --name` 冲突使第二个容器直接失败；且 /cancel 无法按 turn 定位容器。
    // turnId 需 sanitize：WebUI 试跑路径的 turnId 形如 `dryrun:<ulid>`，而冒号不属于 docker
    // 容器名的合法字符集 —— 该路径的 `bash` 此前一直以 `invalid name` 失败，并非沙箱层的错误。
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
    // 追加 env 必须在 push image 之前：image 之后的 argv 是容器内的命令，`-e` 落到那里会变成
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
    // 子进程 env 白名单：仅这三个字面量。此前后面还接着 `&& !/(TOKEN|KEY|SECRET|LUOLI)/i.test(key)`
    // —— 前半段已限定 key，后半段恒为真（docs/27 · T-03）。白名单本身即是闸门；
    // 若将来改为可配置，再把过滤加回来。
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
        : // 剩余情形只有 `plan.mode === 'host'`（bypassRoles）：`none` 到不了这里，plan 不放行。
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
        // 持久容器这一档不能 `docker kill`：那会连同会话内其他后台进程一起终止整个会话环境，
        // 而超时与 `/cancel` 共用同一个钩子（§5.5）。终止容器内的进程组即可。
        if (persistent) persistent.cancel();
        else if (plan.mode === "docker")
          spawn(this.#cfg().dockerBin, ["kill", name], { stdio: "ignore" });
        else if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* 进程已退出 */
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
      ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
    });
    return persistent?.note ? { ...result, note: persistent.note } : result;
  }
}
