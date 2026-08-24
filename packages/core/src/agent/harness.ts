import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { elideMiddleBytes } from "@luoli/shared";

/**
 * M11 · HarnessAgent（docs/14 §2 Q8，2026-08-18 拍板要做）。
 *
 * ⚠️ **原问题的前提是错的**：Q8 写着「AI SDK v7 提供了这个抽象」，但 `ai@7` 里只有
 * `ToolLoopAgent`，没有任何 Harness 抽象。所以这里不是「接一个 SDK 类」，而是**起一个外部
 * harness CLI 子进程**（`claude -p "<任务>"` / `codex exec "<任务>"`）并把它的输出收回来。
 *
 * 安全前提写在最前面（docs/14 T8 / T17）：harness 自带一整套工具，`available()` 的注册期
 * fail-closed 与 `execute()` 的二次硬拦截**都看不见它的内部调用**。收窄靠三道门，而且只有三道：
 *
 * 1. 准入 —— 仅 `owner` 且仅私聊（群里任何人的发言都是注入面，而它能改仓库）；
 * 2. 目录 —— 只能在 `agent.harness.allowedDirs` 列出的路径里跑，**默认空 = 整个功能关闭**；
 * 3. 审批 —— 「起 harness」这一个动作走一次审批，批了之后它内部怎么跑不再逐条拦。
 *
 * 不要以为里面还有第四道。
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
 * 请求的目录必须**落在**某个白名单目录之内（等于它，或是它的子目录）。
 * 逐段比较而不是 `startsWith` 字符串前缀：`/srv/app` 不该放行 `/srv/app-secrets`。
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
 * 子进程 env：整份 `process.env` 交过去 —— harness 要用它自己的登录态（`ANTHROPIC_API_KEY`、
 * `~/.claude` 的会话等），把它剥成 `PATH/LANG/TZ` 那样（沙箱的做法）就没法工作了。
 *
 * 但**本项目自己的密钥不给**：`LUOLI_MASTER_KEY` 能解开库里全部 provider key，`BOT_TOKEN` 是
 * bot 身份本身。harness 不需要它们，而它是一个我们看不见内部行为的进程。
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
      hint: "agent.harness.allowedDirs 为空 —— 这个功能默认关闭，要用先在配置里列出允许的仓库路径",
    };
  const dir = resolveHarnessDir(requestedDir, settings.allowedDirs);
  if (!dir)
    return {
      ok: false,
      error: "harness_dir_not_allowed",
      hint: `只能在 agent.harness.allowedDirs 里列出的路径下跑：${settings.allowedDirs.join(" · ")}`,
    };
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    return { ok: false, error: "harness_dir_missing", dir };

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !HARNESS_ENV_DENY.has(key)),
  );
  // **不走 shell**：任务正文是模型生成的，交给 `/bin/sh -c` 等于把命令注入面直接打开。
  // 作为 argv 的最后一项传过去，任何引号、反引号、`$(...)` 都只是普通字符。
  const child = spawn(settings.command, [...settings.args, task], {
    cwd: dir,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let bytes = 0;
  // 边收边截：一个话痨 harness 能吐几百 MB，全收进内存再截等于把上界写在了 OOM 之后。
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
    // 最常见的是 ENOENT：配了 `command: claude` 但那台机器上没装。说清楚比交回一句 spawn 报错有用。
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: "harness_spawn_failed",
      hint: `起不来 ${settings.command}：${message}`,
      dir,
    };
  } finally {
    clearTimeout(deadline);
    abortSignal.removeEventListener("abort", onAbort);
  }
}
