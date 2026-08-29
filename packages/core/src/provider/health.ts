import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { Sqlite } from "@luoli/db";
import { AttemptDeadline } from "../agent/fallback-model.js";
import { redact } from "../secrets.js";
import type { LogSink } from "../log/sink.js";

/**
 * provider 健康检查（`docs/04 §5.3` 最后一条）。此前未实现：`main.ts` 的
 * `provider-health` 任务只调 `ModelRegistry.rebuild()`，一次探测都不发，于是上游可连接但不
 * 返回这类故障无处记录，`rebuild()` 的 `health_state <> 'down'` 过滤每次都放行，
 * 链首永远排第一。表现是每一步都要耗满 `(maxRetries+1) × requestTimeoutMs`，而一轮只有
 * `concurrency.turnTimeoutMs`：`logs/2026-08-18` 的三轮各在开轮后 363 秒才 fallback，最终全部
 * 以本轮长时间无进展收尾。
 *
 * 判据是上游是否仍在响应，而非该模型本次回答是否正确：
 * - 超时 / 网络错 / 5xx → 计入连续失败。达到 `failuresToDown`（默认 3）才标 `down`。
 * - 401/403 → 立即标 `down`。与调用路径（`fallback-model` 的 `onUnavailable`）和 WebUI
 *   测试连接（`app.ts`）一致：认证被拒不会自行恢复。
 * - 其余 4xx（400 参数不合、404 模型不存在）→ 不计入，只记一条 warn。上游有响应即说明其存活；
 *   以探测模型的参数问题判死整个 provider，会在更换模型 id 这类场景下误伤。
 */

/**
 * 阈值与探测超时都跟随文档，不新增配置键：`docs/04 §5.3` 将次数定为 3、§5.4 将测试连接
 * 的超时定为 15 s，多一个配置项只会多一处与文档不一致的风险。确需可调时再一并修改文档与 schema。
 */
export const PROVIDER_FAILURES_TO_DOWN = 3;
export const PROVIDER_PROBE_TIMEOUT_MS = 15_000;

export interface ProbeSource {
  /** 该 provider 的一个裸候选（不能是 `aliasModel` 包装过的：那一层自身会 fallback，探测将永远发现不了问题）。 */
  probeCandidate(
    providerId: string,
  ): { model: LanguageModel; modelId: string } | null;
}

export interface ProviderHealthOutcome {
  providerId: string;
  name: string;
  modelId: string;
  ok: boolean;
  /** 这次失败是否计入连续失败计数。4xx（非认证）为 false。 */
  counted: boolean;
  failures: number;
  state: "up" | "down" | "unchanged";
  ms: number;
  error?: string;
}

/** 探测与调用路径共用同一个计数器，因此规则只有这一份。`immediate` 用于 401/403。 */
export function recordProviderFailure(
  db: Sqlite,
  providerId: string,
  reason: string,
  failuresToDown: number,
  immediate = false,
): { failures: number; down: boolean } {
  const now = Date.now();
  const failures =
    ((db
      .prepare("SELECT health_fail_count FROM providers WHERE id=?")
      .pluck()
      .get(providerId) as number | undefined) ?? 0) + 1;
  const down = immediate || failures >= failuresToDown;
  if (down)
    db.prepare(
      "UPDATE providers SET health_fail_count=?,health_state='down',health_checked_at=?,health_error=? WHERE id=?",
    ).run(failures, now, reason.slice(0, 500), providerId);
  // 未达阈值时不改动 health_state：一次抖动不应让 provider 从链中消失，而
  // `health_checked_at` 是冷却期的起点，提前推进会让真正 down 之后的冷却计算出错。
  else
    db.prepare(
      "UPDATE providers SET health_fail_count=?,health_error=? WHERE id=?",
    ).run(failures, reason.slice(0, 500), providerId);
  return { failures, down };
}

export function recordProviderSuccess(db: Sqlite, providerId: string): void {
  db.prepare(
    "UPDATE providers SET health_fail_count=0,health_state='up',health_checked_at=?,health_error=NULL WHERE id=?",
  ).run(Date.now(), providerId);
}

/**
 * 记录调用路径上的一次真实成功。缺这一条，连续失败就退化成累计失败：计数存在库里、
 * 重启也不清零，跨轮次零散攒够三次超时同样会判死一个始终在响应的 provider。
 *
 * 与探测侧的 `recordProviderSuccess` 分开是为了加守卫：这里每一步模型调用都会调用一次，加上
 * 本就是 up 且计数为 0 时不写入的条件后常态命中 0 行，不给每一步增加一次真实写入。
 * 返回是否确实改动过，调用方据此决定是否更新进程内的 `#down`。
 */
export function recordProviderServed(db: Sqlite, providerId: string): boolean {
  return (
    db
      .prepare(
        `UPDATE providers SET health_fail_count=0,health_state='up',health_checked_at=?,health_error=NULL
    WHERE id=? AND (health_fail_count<>0 OR COALESCE(health_state,'up')<>'up')`,
      )
      .run(Date.now(), providerId).changes > 0
  );
}

function errorStatus(error: unknown): number | null {
  // 与 `fallback-model.ts` 的同名判据一致。那边是私有的，为一个三行判据将中间件层反向引入
  // provider 层不值得（会形成 provider → agent → provider 的循环）。
  return error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
    ? error.statusCode
    : null;
}

export async function runProviderHealthCheck(
  deps: {
    db: Sqlite;
    models: ProbeSource;
    log: LogSink;
    keyFor?: (providerId: string) => string | null;
  },
  options: { timeoutMs: number; failuresToDown: number },
): Promise<ProviderHealthOutcome[]> {
  const rows = deps.db
    .prepare("SELECT id,name FROM providers WHERE enabled=1")
    .all() as Array<{ id: string; name: string }>;
  const outcomes: ProviderHealthOutcome[] = [];
  for (const row of rows) {
    const candidate = deps.models.probeCandidate(row.id);
    // 没有任何启用模型的 provider 不在任何链中，探测无意义（也没有可探的模型）。
    if (!candidate) continue;
    const started = Date.now();
    let failure: unknown;
    // 走真实调用那一套 `AttemptDeadline`，而非只传一个 `AbortSignal.timeout`：仅 abort 不够，
    // provider 不认该 signal 时它的 promise 永远不 settle，探测会把这个 cron 挂死在此，
    // 而 `Cron` 是 `protect: true`，下一次到点会被跳过，即健康检查从此不再运行（同 docs/04 §5.3
    // 中到点后既 abort 底层请求也停止等待那条）。
    const deadline = new AttemptDeadline(undefined);
    try {
      await deadline.guard(
        generateText({
          model: candidate.model,
          prompt: "ping",
          maxOutputTokens: 1,
          maxRetries: 0,
          abortSignal: deadline.signal,
        }),
        options.timeoutMs,
        "probe",
      );
    } catch (error) {
      failure = error;
    }
    const ms = Date.now() - started;
    if (!failure) {
      recordProviderSuccess(deps.db, row.id);
      outcomes.push({
        providerId: row.id,
        name: row.name,
        modelId: candidate.modelId,
        ok: true,
        counted: false,
        failures: 0,
        state: "up",
        ms,
      });
      deps.log.event({
        level: "info",
        kind: "provider.health",
        summary: `${row.name} 探测正常`,
        data: {
          provider: row.name,
          providerId: row.id,
          modelId: candidate.modelId,
          state: "up",
          ms,
        },
      });
      continue;
    }
    const status = errorStatus(failure);
    const raw =
      failure instanceof Error
        ? `${failure.name}: ${failure.message}`
        : String(failure);
    const reason = redact(
      raw.replace(/\s+/g, " ").trim(),
      [deps.keyFor?.(row.id) ?? ""].filter(Boolean),
    ).slice(0, 500);
    const auth = status === 401 || status === 403;
    const counted = auth || status === null || status >= 500;
    if (!counted) {
      // 有响应即视为存活，因此计数归零。不归零时：探测模型长期返回 400（如 `max_tokens` 下界）
      // 而调用路径偶尔攒一次超时，几天下来也能凑够三次，判死一个始终正常的 provider。
      // `health_state` / `health_checked_at` 不改动：一次 400 只证明网关在响应，不证明该模型可用。
      deps.db
        .prepare(
          "UPDATE providers SET health_fail_count=0,health_error=? WHERE id=?",
        )
        .run(reason, row.id);
      outcomes.push({
        providerId: row.id,
        name: row.name,
        modelId: candidate.modelId,
        ok: false,
        counted: false,
        failures: 0,
        state: "unchanged",
        ms,
        error: reason,
      });
      deps.log.event({
        level: "warn",
        kind: "provider.health",
        summary: `${row.name} 探测被拒（${status}），不计入连续失败`,
        data: {
          provider: row.name,
          providerId: row.id,
          modelId: candidate.modelId,
          state: "unchanged",
          status,
          ms,
          error: reason,
        },
      });
      continue;
    }
    const recorded = recordProviderFailure(
      deps.db,
      row.id,
      reason,
      options.failuresToDown,
      auth,
    );
    outcomes.push({
      providerId: row.id,
      name: row.name,
      modelId: candidate.modelId,
      ok: false,
      counted: true,
      failures: recorded.failures,
      state: recorded.down ? "down" : "unchanged",
      ms,
      error: reason,
    });
    deps.log.event({
      level: recorded.down ? "error" : "warn",
      kind: "provider.health",
      summary: recorded.down
        ? `${row.name} 连续失败 ${recorded.failures} 次，已标记为 down`
        : `${row.name} 探测失败（${recorded.failures}/${options.failuresToDown}）`,
      data: {
        provider: row.name,
        providerId: row.id,
        modelId: candidate.modelId,
        state: recorded.down ? "down" : "unchanged",
        status,
        failures: recorded.failures,
        ms,
        error: reason,
      },
    });
  }
  return outcomes;
}
