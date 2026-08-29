import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { elideMiddleBytes } from "@luoli/shared";

/**
 * M11 · HarnessAgent（docs/14 §2 Q8，2026-08-18 决定实现）。
 *
 * ⚠️ 原问题的前提有误：Q8 写着 AI SDK v7 提供了这个抽象，但 `ai@7` 中只有
 * `ToolLoopAgent`，不存在任何 Harness 抽象。因此这里不是接入一个 SDK 类，而是启动一个外部
 * harness CLI 子进程（`claude -p "<任务>"` / `codex exec "<任务>"`）并收集其输出。
 *
 * 安全前提置于最前（docs/14 T8 / T17）：harness 自带完整工具集，`available()` 的注册期
 * fail-closed 与 `execute()` 的二次硬拦截都看不到它的内部调用。收窄依靠三道门，且仅有三道：
 *
 * 1. 准入：仅 `owner` 且仅私聊（群内任何人的发言都是注入面，而它能修改仓库）；
 * 2. 目录：只能在 `agent.harness.allowedDirs` 列出的路径下运行，默认为空即整个功能关闭；
 * 3. 审批：启动 harness 这一动作走一次审批，批准后其内部执行不再逐条拦截。
 *
 * 不存在第四道门。
 */

export interface HarnessSettings {
  command: string;
  args: readonly string[];
  allowedDirs: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface HarnessResult {
  ok: boolean;
  error?: string;
  hint?: string;
  dir?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  output?: string;
  truncated?: boolean;
}

/**
 * 请求的目录必须位于某个白名单目录之内（等于它或为其子目录）。
 * 逐段比较而非 `startsWith` 字符串前缀：`/srv/app` 不应放行 `/srv/app-secrets`。
 */
export function resolveHarnessDir(
  requested: string,
  allowedDirs: readonly string[],
): string | null {
  const target = resolve(requested);
  for (const entry of allowedDirs) {
    const root = resolve(entry);
    if (target === root || target.startsWith(`${root}${sep}`)) return target;
  }
  return null;
}

/**
 * 子进程 env：整份 `process.env` 传入，因为 harness 需要使用它自己的登录态（`ANTHROPIC_API_KEY`、
 * `~/.claude` 的会话等），裁剪成 `PATH/LANG/TZ`（沙箱的做法）会导致其无法工作。
 *
 * 但本项目自身的密钥不传入：`LUOLI_MASTER_KEY` 可解密库中全部 provider key，`BOT_TOKEN` 即
 * bot 身份本身。harness 不需要它们，而它是一个内部行为不可见的进程。
 */
const HARNESS_ENV_DENY = new Set([
  "LUOLI_MASTER_KEY",
  "BOT_TOKEN",
  "WEBUI_PASSWORD",
]);

export async function runHarness(
  task: string,
  requestedDir: string,
  settings: HarnessSettings,
  abortSignal: AbortSignal,
): Promise<HarnessResult> {
  if (!settings.allowedDirs.length)
    return {
      ok: false,
      error: "harness_disabled",
      hint: "agent.harness.allowedDirs 为空 —— 该功能默认关闭，启用前需在配置中列出允许的仓库路径",
    };
  const dir = resolveHarnessDir(requestedDir, settings.allowedDirs);
  if (!dir)
    return {
      ok: false,
      error: "harness_dir_not_allowed",
      hint: `只能在 agent.harness.allowedDirs 列出的路径下运行：${settings.allowedDirs.join(" · ")}`,
    };
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    return { ok: false, error: "harness_dir_missing", dir };

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !HARNESS_ENV_DENY.has(key)),
  );
  // 不经过 shell：任务正文由模型生成，交给 `/bin/sh -c` 等于直接开放命令注入面。
  // 作为 argv 的最后一项传入时，任何引号、反引号、`$(...)` 都只是普通字符。
  const child = spawn(settings.command, [...settings.args, task], {
    cwd: dir,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let bytes = 0;
  // 边接收边截断：输出量大的 harness 可产生数百 MB，全部读入内存后再截断等于把上界设在 OOM 之后。
  const budget = settings.maxOutputBytes * 2;
  const collect = (chunk: Buffer): void => {
    if (bytes >= budget) return;
    bytes += chunk.length;
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  let timedOut = false;
  const stop = (): void => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, settings.timeoutMs);
  const onAbort = (): void => stop();
  abortSignal.addEventListener("abort", onAbort, { once: true });

  try {
    const finished = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((done, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    const clipped = elideMiddleBytes(
      output,
      settings.maxOutputBytes,
      (omitted) => `\n…（略去 ${omitted} 字节）…\n`,
    );
    return {
      ok: !timedOut && finished.code === 0,
      ...(timedOut
        ? { error: "harness_timeout" }
        : finished.code === 0
          ? {}
          : { error: "harness_failed" }),
      dir,
      exitCode: finished.code,
      signal: finished.signal,
      timedOut,
      output: clipped.value,
      truncated: clipped.truncated,
    };
  } catch (error) {
    // 最常见的是 ENOENT：配置了 `command: claude` 但该机器未安装。明确说明比返回一句 spawn 报错更有用。
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: "harness_spawn_failed",
      hint: `无法启动 ${settings.command}：${message}`,
      dir,
    };
  } finally {
    clearTimeout(deadline);
    abortSignal.removeEventListener("abort", onAbort);
  }
}
