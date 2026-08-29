import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type {
  SandboxContainer,
  SandboxContainerRepository,
  Sqlite,
} from "@luoli/db";
import { deleteAppKv, readAppKv, writeAppKv } from "@luoli/db";
import { KeyedMutex } from "../turn/keyed-mutex.js";
import type { SandboxResult } from "./exec-stream.js";
import { collectProcess } from "./exec-stream.js";

export interface PersistentSandboxConfig {
  enabled: boolean;
  idleTtlMs: number;
  /** 0 表示不设绝对上限（docs/11：本仓库中 0 一律表示不清理）。 */
  maxLifetimeMs: number;
  maxContainers: number;
  /** 与 `sandbox.network` 是两个独立键：前者管理一次性容器，本项管理持久容器。 */
  network: "none" | "bridge";
  reapCron: string;
}

/** `ContainerManager` 实际使用的 `SandboxConfig` 子集，避免它反向依赖 `Sandbox`。 */
export interface ContainerRuntimeConfig {
  dockerBin: string;
  image: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  readOnlyRoot: boolean;
  tmpfsMb: number;
  maxOutputBytes: number;
  persistent: PersistentSandboxConfig;
}

export type ContainerReapReason =
  | "idle"
  | "hard"
  | "respec"
  | "reset"
  | "disabled"
  | "orphan"
  | "exited"
  | "gone";

/** 一次回收 tick 的结果。注册点将其原样写入日志（沿用 `MaintenanceService.cleanup()` 的约定）。 */
export interface ReapCounts {
  idle: number;
  hard: number;
  respec: number;
  exited: number;
  gone: number;
  orphans: number;
  adopted: number;
  /** 带 `luoli.instance` 且非本实例：属于其它实例的容器，一律不处理。多实例部署中该数值正常。 */
  foreign: number;
  /** 带 `luoli.managed=1` 但没有 `luoli.instance`：在引入实例标签之前创建，无法识别归属，同样不处理。
   *  需人工处置，因此注册点发现非零时会将该对账日志提升为 warn。全部重建一轮后自然归零。 */
  legacy: number;
}

/**
 * 本实例的身份标识，写入 `luoli.instance` 标签。
 *
 * 取库文件绝对路径的指纹：哪些容器属于本实例，正是由哪个库存储它们的行来定义的，
 * 而同一个库上只可能存在一个进程（`acquireInstanceLock`）—— 两者结合才使只扫描自身那一份
 * 成为真实判据，而不仅是一项约定。
 *
 * 发布指纹而非路径本身：标签任何人执行 `docker inspect` 都可读取，无需额外泄露部署布局
 * （理由同 `GET /api/messages` 不返回 `local_path`）。
 */
export const instanceLabelOf = (databasePath: string): string =>
  createHash("sha1").update(databasePath).digest("hex").slice(0, 12);

export interface ContainerEvent {
  /** 字段名取 `type` 而非 `kind`：`tests/docs.test.ts` 将源码中的 `kind:` 字面量与
   *  `docs/10 §2` 的表双向绑定，而这几个值不是日志 kind（日志 kind 由装配方拼接为
   *  `sandbox.container.*` 的字面量后再发出）。占用 `kind` 只会给该断言增加一条难以解释的豁免。 */
  type: "created" | "reaped" | "limit" | "exec";
  chatId?: string;
  name?: string;
  ok?: boolean;
  data: Record<string, unknown>;
  durationMs?: number;
}

/** 容器内存放后台进程日志的目录，相对 `/workspace`。`container_logs` 与 `background` 共用该约定。 */
export const BACKGROUND_LOG_DIR = ".luoli-logs";

/**
 * 后台日志名。该值会被拼接进 shell 路径，因此字符集在此处即固定：`..` 或 `/` 进入
 * 等于允许模型向工作区之外写文件。工具层的 zod 也会拦截一次，此处是第二道
 * （同 §3.11 所述目录过滤不构成边界）。
 */
export function sanitizeLogName(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[.-]+/, "");
  return cleaned.slice(0, 64) || "task";
}
/** 容器内存放 exec 进程组 pid 的目录。位于 tmpfs 上，不写入用户的工作区。 */
const EXEC_PID_DIR = "/tmp/.luoli-exec";
const DOCKER_CALL_TIMEOUT_MS = 20_000;
/** 创建容器需启动一个进程，远慢于一次 `docker inspect`，但同样必须设上界（croner 的 `protect:true`
 *  会使一次不返回的回收永久阻塞整条 cron）。 */
const DOCKER_CREATE_TIMEOUT_MS = 60_000;

/**
 * docker 容器名的合法字符集为 `[a-zA-Z0-9][a-zA-Z0-9_.-]*`。chatId 常为负数（`-100123`），
 * 而 WebUI 试跑的 turnId 中还含冒号（`dryrun:<ulid>`）—— 后者属既有缺陷：docker 模式下
 * 该路径的 `bash` 一直以 `invalid name` 结束，而不是给出沙箱层的错误。两处共用这一处理。
 */
export function sanitizeDockerToken(raw: string): string {
  const replaced = raw.replace(/^-/, "n").replace(/[^a-zA-Z0-9_.-]/g, "-");
  return /^[a-zA-Z0-9]/.test(replaced) ? replaced : `x${replaced}`;
}

export function containerNameFor(chatId: string): string {
  return `luoli-box-${sanitizeDockerToken(chatId)}`;
}

/**
 * 容器一旦运行，`--memory` / `--network` / image 均无法修改。将它们的指纹写入 label，
 * 与当前配置不符的容器由回收流程销毁、下次使用时惰性重建 —— 缺少这一条时，运维在 WebUI 更换
 * 镜像后，所有已存在的容器会继续使用旧镜像，而界面显示的是新镜像。
 */
export function specHashOf(config: ContainerRuntimeConfig): string {
  const spec = [
    config.image,
    config.memoryMb,
    config.cpus,
    config.pidsLimit,
    config.readOnlyRoot,
    config.tmpfsMb,
    config.persistent.network,
  ].join("|");
  return createHash("sha256").update(spec).digest("hex").slice(0, 16);
}

/**
 * 到期判定。钉住只豁免滑动 TTL 这一档 —— 若同时豁免绝对上限，该上限即不再成立（docs/05 §5.5）。
 * 纯函数，`tests/sandbox.persistent.test.ts` 直接测试它。
 */
export function reapReasonFor(
  row: Pick<SandboxContainer, "expiresAt" | "hardExpiresAt" | "pinned">,
  now: number,
): "idle" | "hard" | null {
  if (row.hardExpiresAt !== null && row.hardExpiresAt <= now) return "hard";
  if (row.pinned) return null;
  return row.expiresAt <= now ? "idle" : null;
}

/** `maxLifetimeMs: 0` 表示不设上限 → `hard_expires_at` 写入 NULL，而不是 `createdAt + 0`。 */
export function hardExpiryFor(
  createdAt: number,
  maxLifetimeMs: number,
): number | null {
  return maxLifetimeMs > 0 ? createdAt + maxLifetimeMs : null;
}

/**
 * RUNTIME 块中工作目录一行括号内的表述（docs/06 §1）。
 *
 * 剩余时间是近似值：滑动 TTL 每次执行都会重置，给出精确到分钟的值只会使模型据此
 * 制定时间计划，随后发现计算不准。未启用持久化时原样返回 mode —— 该档位表述不变。
 */
export function sandboxLabel(
  mode: string,
  persistent: PersistentSandboxConfig,
  expiry: ContainerExpiryHint,
): string {
  if (mode !== "docker" || !persistent.enabled) return mode;
  const life =
    expiry.state === "pinned"
      ? "已常驻，不会被回收"
      : expiry.state === "none"
        ? `闲置约 ${Math.round(persistent.idleTtlMs / 3_600_000)} 小时后回收`
        : `约 ${Math.max(1, Math.round(expiry.remainingMs / 3_600_000))} 小时后回收，每次执行重新计时`;
  return `${mode} · 常驻容器（${life}；已安装的包与运行中的进程保留至下一轮，后台任务需将输出重定向到文件）· ${persistent.network === "bridge" ? "可出网" : "无网络"}`;
}

/** 无容器 / 已钉住不回收 / 剩余时长。三种状态的表述完全不同，压缩为一个数字只能靠推测。 */
export type ContainerExpiryHint =
  | { state: "none" }
  | { state: "pinned" }
  | { state: "ttl"; remainingMs: number };

const reapMarkerKey = (chatId: string): string => `sandboxReaped:${chatId}`;
const REAP_NOTE: Record<ContainerReapReason, string> = {
  idle: "闲置超时被回收",
  hard: "达到容器最长存活时间被回收",
  respec: "沙箱配置已修改，旧容器已按新配置重建",
  reset: "被 owner 重置",
  disabled: "因持久容器功能停用而被销毁",
  orphan: "与记录不一致，已清理",
  exited: "已自行退出",
  gone: "已丢失",
};

export interface PreparedExec {
  ok: true;
  argv: string[];
  /** 取消、超时或输出超限时调用：终止容器内的进程组，而不是容器本身。 */
  cancel: () => void;
  /** 执行结束后推进滑动到期时间。失败时同样要调用（使用过即计入）。 */
  settle: () => void;
  note?: string;
}

export type PrepareFailure = { ok: false; error: string; hint?: string };

/**
 * 会话级持久容器的生命周期（docs/05 §5.5）。
 *
 * 状态由 DB 与 docker 两侧共同持有并互相校验：DB 存储 docker 无法存储的信息（滑动到期、钉住、
 * spec 指纹 —— label 创建后不可修改），docker 存储容器当前是否存在。进程内不保留任何权威副本
 * （`docs/01 §3.1`），因此重启后先执行对账而非全部销毁，24h 的 TTL 才能跨越一次重启。
 */
export class ContainerManager {
  readonly #mutex = new KeyedMutex();
  /** 见 `instanceLabelOf`。构造时计算一次 —— 库路径在进程生命周期内不变。 */
  readonly #instance: string;

  constructor(
    private readonly db: Sqlite,
    private readonly repo: SandboxContainerRepository,
    private readonly config: () => ContainerRuntimeConfig,
    private readonly onEvent?: (event: ContainerEvent) => void,
  ) {
    this.#instance = instanceLabelOf(db.name);
  }

  /** 本实例为自身容器设置的 `luoli.instance` 标签值。 */
  get instanceLabel(): string {
    return this.#instance;
  }

  enabled(): boolean {
    return this.config().persistent.enabled;
  }

  list(): SandboxContainer[] {
    return this.repo.list();
  }

  capacity(): { used: number; max: number } {
    return {
      used: this.repo.count(),
      max: this.config().persistent.maxContainers,
    };
  }

  /** RUNTIME 块该行需要区分的三种状态（见 `sandboxLabel`）。 */
  expiryHintFor(chatId: string, now = Date.now()): ContainerExpiryHint {
    const row = this.repo.byChat(chatId);
    if (!row) return { state: "none" };
    // 钉住豁免滑动 TTL，但无法豁免绝对上限 —— 两者都不存在时才是真正的不回收。
    if (row.pinned && row.hardExpiresAt === null) return { state: "pinned" };
    const deadline = row.pinned
      ? row.hardExpiresAt!
      : Math.min(row.expiresAt, row.hardExpiresAt ?? row.expiresAt);
    return { state: "ttl", remainingMs: Math.max(0, deadline - now) };
  }

  /** 事件发送不得中断执行：本层的调用点位于返回结果的主路径上。 */
  #emit(event: ContainerEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      /* 观测行为不应使一次成功的执行变为失败 */
    }
  }

  #docker(
    args: string[],
    timeoutMs = DOCKER_CALL_TIMEOUT_MS,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.config().dockerBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (value: {
        code: number | null;
        stdout: string;
        stderr: string;
      }): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          code: null,
          stdout,
          stderr: `${stderr}\ndocker 调用超时（${timeoutMs}ms）`,
        });
      }, timeoutMs);
      timer.unref?.();
      child.once("error", (cause) => {
        clearTimeout(timer);
        finish({ code: null, stdout, stderr: cause.message });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        finish({ code, stdout, stderr });
      });
    });
  }

  /**
   * 检查容器当前是否存在、spec 是否匹配。每次执行前都检查一次 —— 一次 `docker inspect` 约几十
   * 毫秒，而 `docker run` 需数百毫秒，省略它的代价是容器已被 OOM 终止而仍在向其 exec。
   * 同时可在此发现 spec 漂移，无需等待下一次 `reapCron`。
   */
  async #probe(
    name: string,
  ): Promise<{ running: boolean; spec: string | null; exists: boolean }> {
    const result = await this.#docker([
      "inspect",
      "--format",
      '{{.State.Running}}\t{{index .Config.Labels "luoli.spec"}}',
      name,
    ]);
    if (result.code !== 0) return { running: false, spec: null, exists: false };
    const [running, spec] = result.stdout.trim().split("\t");
    return { running: running === "true", spec: spec || null, exists: true };
  }

  async #create(
    chatId: string,
    mountedWorkspace: string,
  ): Promise<{ ok: true; row: SandboxContainer } | PrepareFailure> {
    const config = this.config();
    const { used, max } = this.capacity();
    if (used >= max) {
      this.#emit({ type: "limit", chatId, data: { used, max } });
      return {
        ok: false,
        error: "sandbox_container_limit",
        hint: `持久容器已达上限（${used}/${max}）。当前会话无容器，且不会退回一次性容器。使用 container_list 查看可回收的容器，或调高 sandbox.persistent.maxContainers。`,
      };
    }
    const name = containerNameFor(chatId);
    const specHash = specHashOf(config);
    // 先清理同名残留（上一次进程在创建容器后、写库前崩溃所致），否则 --name 冲突会使此处始终失败。
    await this.#docker(["rm", "-f", name]);
    const started = performance.now();
    const args = [
      "run",
      "-d",
      "--init",
      "--name",
      name,
      "--label",
      "luoli.managed=1",
      "--label",
      `luoli.instance=${this.#instance}`,
      "--label",
      `luoli.chat=${chatId}`,
      "--label",
      `luoli.spec=${specHash}`,
      `--network=${config.persistent.network}`,
      `--memory=${config.memoryMb}m`,
      `--memory-swap=${config.memoryMb}m`,
      `--cpus=${config.cpus}`,
      `--pids-limit=${config.pidsLimit}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=1000:1000",
      `--tmpfs=/tmp:rw,size=${config.tmpfsMb}m,noexec`,
      "-v",
      `${mountedWorkspace}:/workspace:rw`,
      "-w",
      "/workspace",
      "-e",
      "HOME=/workspace",
      "-e",
      "LANG=C.UTF-8",
    ];
    if (config.readOnlyRoot) args.push("--read-only");
    args.push(config.image, "sleep", "infinity");
    const created = await this.#docker(args, DOCKER_CREATE_TIMEOUT_MS);
    if (created.code !== 0) {
      return {
        ok: false,
        error: "sandbox_container_create_failed",
        hint:
          created.stderr.trim().slice(0, 600) ||
          `docker run 以 ${created.code} 退出`,
      };
    }
    // 取消需终止整个进程组，而这依赖 setsid。自带镜像具备（python:3.12-slim 的 util-linux），
    // 自定义镜像未必具备 —— 探测一次并记录，缺少它时取消只能终止单个 pid，该限制必须明确告知。
    const probe = await this.#docker([
      "exec",
      name,
      "sh",
      "-c",
      `command -v setsid >/dev/null && mkdir -p ${EXEC_PID_DIR} ${BACKGROUND_LOG_DIR}`,
    ]);
    const hasSetsid = probe.code === 0;
    if (!hasSetsid)
      await this.#docker([
        "exec",
        name,
        "sh",
        "-c",
        `mkdir -p ${EXEC_PID_DIR} ${BACKGROUND_LOG_DIR}`,
      ]);
    const now = Date.now();
    const row = this.repo.create({
      chatId,
      name,
      containerId: created.stdout.trim().slice(0, 64) || null,
      image: config.image,
      specHash,
      hasSetsid,
      expiresAt: now + config.persistent.idleTtlMs,
      hardExpiresAt: hardExpiryFor(now, config.persistent.maxLifetimeMs),
    });
    this.#emit({
      type: "created",
      chatId,
      name,
      durationMs: Math.round(performance.now() - started),
      data: {
        image: config.image,
        specHash,
        hasSetsid,
        network: config.persistent.network,
      },
    });
    return { ok: true, row };
  }

  /**
   * 获取该会话可用的容器；不存在、已终止或 spec 漂移时重建。按 chatId 串行执行 ——
   * 否则同一会话并发两轮会导致 `--name` 冲突，第二个直接失败。
   */
  async ensure(
    chatId: string,
    mountedWorkspace: string,
  ): Promise<
    { ok: true; row: SandboxContainer; note?: string } | PrepareFailure
  > {
    return this.#mutex.run(chatId, async () => {
      const config = this.config();
      const existing = this.repo.byChat(chatId);
      if (existing) {
        const probe = await this.#probe(existing.name);
        const specHash = specHashOf(config);
        if (probe.exists && probe.running && probe.spec === specHash)
          return { ok: true, row: existing };
        await this.#destroy(
          existing,
          probe.exists ? (probe.running ? "respec" : "exited") : "gone",
        );
      }
      const created = await this.#create(chatId, mountedWorkspace);
      if (!created.ok) return created;
      const marker = readAppKv<{ reason: ContainerReapReason; at: number }>(
        this.db,
        reapMarkerKey(chatId),
      );
      if (!marker) return { ok: true, row: created.row };
      deleteAppKv(this.db, reapMarkerKey(chatId));
      return {
        ok: true,
        row: created.row,
        note: `当前会话的容器为新建：上一个${REAP_NOTE[marker.reason]}。此前安装的软件与运行中的后台进程均已丢失（/workspace 中的文件不受影响）。`,
      };
    });
  }

  /**
   * 将一次执行转换为 `docker exec` 的 argv，并附带一个只终止进程而不终止容器的取消钩子。
   *
   * 在该档位下 `docker kill <容器名>` 是错误的：在一次性容器中它等同于取消该命令，在持久容器中
   * 它等同于销毁该会话的整个环境，而 `/cancel` 与超时走的是同一个 `kill()`（docs/05 §5.5）。
   */
  async prepareExec(input: {
    chatId: string;
    mountedWorkspace: string;
    command: string;
    timeoutMs: number;
    extraEnv?: Readonly<Record<string, string>>;
    background?: { name: string };
  }): Promise<PreparedExec | PrepareFailure> {
    const ready = await this.ensure(input.chatId, input.mountedWorkspace);
    if (!ready.ok) return ready;
    const { row } = ready;
    const config = this.config();
    const execId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const argv = [
      "exec",
      "--user=1000:1000",
      "--workdir=/workspace",
      "-e",
      "HOME=/workspace",
      "-e",
      "LANG=C.UTF-8",
    ];
    for (const [key, value] of Object.entries(input.extraEnv ?? {}))
      argv.push("-e", `${key}=${value}`);
    argv.push(row.name);
    argv.push(
      ...this.#wrap(
        row,
        execId,
        input.command,
        input.timeoutMs,
        input.background,
      ),
    );
    return {
      ok: true,
      argv,
      cancel: () => {
        // 终止进程组。即使未完全终止也不处理容器 —— 宁可残留一个失控进程，也不能因一次取消
        // 而销毁他人的后台服务。
        //
        // `kill` 之后不能写 `--`。dash 的内建 kill 不识别该分隔符，`kill -KILL -- -123`
        // 会直接以 `Illegal number: -` 退出码 2 结束，导致整条取消静默失效 —— 表现为 `/cancel`
        // 之后该命令一直运行到自身 timeout 才结束（实测于 `sandbox.containers.docker.test.ts`）。
        const target = `$(cat ${EXEC_PID_DIR}/${execId} 2>/dev/null || echo 0)`;
        const signal = row.hasSetsid
          ? `kill -KILL -${target} 2>/dev/null`
          : `kill -KILL ${target} 2>/dev/null`;
        void this.#docker(
          [
            "exec",
            row.name,
            "sh",
            "-c",
            `${signal}; rm -f ${EXEC_PID_DIR}/${execId}`,
          ],
          5000,
        );
      },
      settle: () => {
        this.repo.touch(input.chatId, Date.now() + config.persistent.idleTtlMs);
      },
      ...(ready.note ? { note: ready.note } : {}),
    };
  }

  /**
   * 容器内的包装层，负责三件事：将进程组 id 写入 pidfile（取消时使用）、施加硬期限、
   * 将后台任务重定向到文件。
   *
   * 后台任务的重定向是必需项而非便利功能：exec 结束后管道即关闭，后台进程下一次写入 stdout
   * 会收到 SIGPIPE 而终止 —— 启动一个 server 后下一轮发现它已消失正是由此产生。
   */
  #wrap(
    row: SandboxContainer,
    execId: string,
    command: string,
    timeoutMs: number,
    background?: { name: string },
  ): string[] {
    const pidFile = `${EXEC_PID_DIR}/${execId}`;
    const record = `mkdir -p ${EXEC_PID_DIR}; echo $$ > ${pidFile}`;
    if (background) {
      const log = `${BACKGROUND_LOG_DIR}/${sanitizeLogName(background.name)}.log`;
      // 后台档位不施加 `timeout`：它的期限是容器的 TTL，而非本次调用的期限。
      const script = `mkdir -p ${BACKGROUND_LOG_DIR}; ${record}; ${row.hasSetsid ? "setsid " : ""}sh -c ${shellQuote(command)} >> ${log} 2>&1 & echo "$!"`;
      return ["sh", "-c", script];
    }
    const inner = `${record}; exec timeout -s KILL ${Math.ceil(timeoutMs / 1000)} sh -c ${shellQuote(command)}`;
    // `setsid -w` 使被执行的命令成为会话首进程（`$$` 即 pgid），`-w` 保证退出码原样透传。
    return row.hasSetsid
      ? ["setsid", "-w", "sh", "-c", inner]
      : ["sh", "-c", inner];
  }

  /** 不经 `Sandbox.run` 的直接执行（`container_*` 工具走此路径：它需指定会话，而非当前轮次）。 */
  async exec(input: {
    chatId: string;
    mountedWorkspace: string;
    command: string;
    timeoutMs: number;
    abortSignal: AbortSignal;
    background?: { name: string };
  }): Promise<SandboxResult | PrepareFailure> {
    const prepared = await this.prepareExec(input);
    if (!prepared.ok) return prepared;
    const started = performance.now();
    const child = spawn(this.config().dockerBin, prepared.argv, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await collectProcess(child, {
      timeoutMs: input.timeoutMs,
      maxOutputBytes: this.config().maxOutputBytes,
      abortSignal: input.abortSignal,
      kill: prepared.cancel,
    });
    prepared.settle();
    this.#emit({
      type: "exec",
      chatId: input.chatId,
      name: containerNameFor(input.chatId),
      ok: result.ok,
      durationMs: Math.round(performance.now() - started),
      data: {
        exitCode: result.exitCode,
        ms: result.durationMs,
        background: Boolean(input.background),
        killed: result.killed,
      },
    });
    return prepared.note ? { ...result, note: prepared.note } : result;
  }

  /** 容器内运行的进程、资源占用与后台日志列表。三次 docker 调用，任一失败只导致对应段缺失。 */
  async inspect(chatId: string): Promise<
    | {
        ok: true;
        row: SandboxContainer;
        processes: string;
        stats: string;
        logs: string;
      }
    | PrepareFailure
  > {
    const row = this.repo.byChat(chatId);
    if (!row)
      return {
        ok: false,
        error: "container_not_found",
        hint: "当前会话无容器。使用 container_list 查看已有容器，或执行命令以新建容器。",
      };
    const [processes, stats, logs] = await Promise.all([
      this.#docker(["top", row.name, "-eo", "pid,ppid,etime,pcpu,pmem,args"]),
      this.#docker([
        "stats",
        "--no-stream",
        "--format",
        "{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}",
        row.name,
      ]),
      this.#docker([
        "exec",
        row.name,
        "sh",
        "-c",
        `ls -la ${BACKGROUND_LOG_DIR} 2>/dev/null || echo '(没有后台日志)'`,
      ]),
    ]);
    return {
      ok: true,
      row,
      processes: (processes.code === 0
        ? processes.stdout
        : `进程表读取失败：${processes.stderr.trim()}`
      ).slice(0, 8000),
      stats: (stats.code === 0
        ? stats.stdout
        : `资源用量读取失败：${stats.stderr.trim()}`
      ).trim(),
      logs: (logs.code === 0
        ? logs.stdout
        : `日志目录读取失败：${logs.stderr.trim()}`
      ).slice(0, 4000),
    };
  }

  async #destroy(
    row: SandboxContainer,
    reason: ContainerReapReason,
  ): Promise<number> {
    // 销毁前统计剩余的非 PID1 进程数：容器一旦销毁，该会话中运行的 server 即消失，
    // 而用户看到的只是它突然停止工作。
    let aliveProcs = 0;
    if (reason !== "gone") {
      const top = await this.#docker(["top", row.name, "-eo", "pid"], 5000);
      if (top.code === 0)
        aliveProcs = Math.max(0, top.stdout.trim().split("\n").length - 2);
    }
    await this.#docker(["rm", "-f", row.name]);
    this.repo.remove(row.chatId);
    // 下一次为该会话创建容器时将该说明传给模型（docs/06 §1）—— 它没有其它途径得知
    // 自己启动的后台进程为何消失。
    writeAppKv(
      this.db,
      reapMarkerKey(row.chatId),
      { reason, at: Date.now() },
      "sandbox-reap",
    );
    this.#emit({
      type: "reaped",
      chatId: row.chatId,
      name: row.name,
      data: {
        reason,
        aliveProcs,
        ageMs: Date.now() - row.createdAt,
        execCount: row.execCount,
      },
    });
    return aliveProcs;
  }

  /** `container_reset` 与 WebUI 的重置操作：销毁并立即重建。不修改 `/workspace` 中的文件。 */
  async reset(
    chatId: string,
    mountedWorkspace: string,
  ): Promise<{ ok: true; row: SandboxContainer } | PrepareFailure> {
    return this.#mutex.run(chatId, async () => {
      const existing = this.repo.byChat(chatId);
      if (existing) await this.#destroy(existing, "reset");
      else await this.#docker(["rm", "-f", containerNameFor(chatId)]);
      // 刚销毁的标记不应转为上一个容器被回收的提示 —— 重置是 owner 主动执行的操作。
      deleteAppKv(this.db, reapMarkerKey(chatId));
      return this.#create(chatId, mountedWorkspace);
    });
  }

  async destroy(
    chatId: string,
    reason: ContainerReapReason = "reset",
  ): Promise<boolean> {
    const row = this.repo.byChat(chatId);
    if (!row) return false;
    await this.#destroy(row, reason);
    return true;
  }

  keep(
    chatId: string,
    patch: { hours?: number; pin?: boolean },
  ): { ok: true; row: SandboxContainer } | PrepareFailure {
    const row = this.repo.byChat(chatId);
    if (!row)
      return {
        ok: false,
        error: "container_not_found",
        hint: "当前会话无容器。",
      };
    // 续期被限制在绝对上限内：钉住与续期都无法豁免 hard_expires_at（docs/05 §5.5）。
    const requested =
      patch.hours === undefined
        ? undefined
        : Date.now() + Math.round(patch.hours * 3_600_000);
    const expiresAt =
      requested === undefined
        ? undefined
        : row.hardExpiresAt === null
          ? requested
          : Math.min(requested, row.hardExpiresAt);
    this.repo.keep(chatId, {
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(patch.pin === undefined ? {} : { pinned: patch.pin }),
    });
    return { ok: true, row: this.repo.byChat(chatId)! };
  }

  /**
   * 回收与对账。每个 tick 执行三项工作，返回各自的条数由注册点原样写入日志。
   *
   * 启动时同样执行本流程而非全部销毁 —— 24h 的 TTL 需能跨越一次进程重启。
   */
  async reap(now = Date.now()): Promise<ReapCounts> {
    const config = this.config();
    const counts: ReapCounts = {
      idle: 0,
      hard: 0,
      respec: 0,
      exited: 0,
      gone: 0,
      orphans: 0,
      adopted: 0,
      foreign: 0,
      legacy: 0,
    };
    if (!config.persistent.enabled) {
      // 关闭开关不应使已有容器无人管理地留在宿主上 —— 但也不能只删除容器而保留库中的行。
      // 走正常的销毁路径，随后再扫描一遍标签，覆盖库中原本就不存在的那些。
      for (const row of this.repo.list()) {
        await this.#destroy(row, "disabled");
        counts.gone += 1;
      }
      return this.#sweepOrphans(counts, new Set());
    }
    const specHash = specHashOf(config);
    const rows = this.repo.list();
    for (const row of rows) {
      const expiry = reapReasonFor(row, now);
      if (expiry) {
        await this.#destroy(row, expiry);
        counts[expiry] += 1;
        continue;
      }
      const probe = await this.#probe(row.name);
      if (!probe.exists) {
        await this.#destroy(row, "gone");
        counts.gone += 1;
        continue;
      }
      if (!probe.running) {
        await this.#destroy(row, "exited");
        counts.exited += 1;
        continue;
      }
      if (probe.spec !== specHash || row.specHash !== specHash) {
        await this.#destroy(row, "respec");
        counts.respec += 1;
        continue;
      }
      counts.adopted += 1;
    }
    return this.#sweepOrphans(
      counts,
      new Set(this.repo.list().map((row) => row.name)),
    );
  }

  /**
   * 属于本实例但不在库中的容器：上一次进程在创建容器与写库之间崩溃所遗留的。
   *
   * 判据中的 `luoli.instance` 不是可选项。此前此处只判定带 `luoli.managed=1` 且不在本库中，
   * 而该标签不含实例身份 —— 于是在同一宿主上启动第二个实例（即使其 `persistent.enabled`
   * 为关闭，见 `reap()` 开头的分支：known 集为空）即等同于 `docker rm -f` 删除在位实例
   * 正在使用的全部持久容器，连同其中运行的后台进程。实际已发生过。
   *
   * 无法识别归属的一律不处理：删除他人正在使用的容器不可逆，而遗漏一个已停止的孤儿只占用磁盘。
   * 一次性容器（`docker run --rm`）不设置该标签，本就不在此路径上。
   */
  async #sweepOrphans(
    counts: ReapCounts,
    known: Set<string>,
  ): Promise<ReapCounts> {
    const listed = await this.#docker([
      "ps",
      "-a",
      "--filter",
      "label=luoli.managed=1",
      "--format",
      '{{.Names}}\t{{.Label "luoli.instance"}}',
    ]);
    if (listed.code !== 0) return counts;
    for (const line of listed.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      const [name, instance = ""] = line.split("\t");
      if (!name || known.has(name)) continue;
      if (!instance) {
        counts.legacy += 1;
        continue;
      }
      if (instance !== this.#instance) {
        counts.foreign += 1;
        continue;
      }
      await this.#docker(["rm", "-f", name]);
      counts.orphans += 1;
    }
    // 对账日志由调用方（`sandbox-reap` 那条 cron）记录 —— 此处再发一次即同一事件重复记录两遍。
    return counts;
  }
}

/** 单引号包裹并转义内部单引号。命令串只经该层进入 `sh -c`，不做其它拼接。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 容器的 workspace 目录要在建容器之前存在，否则 docker 会在宿主上默默建一个 root 拥有的空目录。 */
export function ensureWorkspaceDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
