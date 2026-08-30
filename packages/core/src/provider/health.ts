import type { Sqlite } from "@luoli/db";
import type { LogSink } from "../log/sink.js";
import { probeProvider } from "./catalog.js";
import type { ProbeCode } from "./catalog.js";

/**
 * provider 健康检查（`docs/04 §5.3` 最后一条）。此前未实现：`main.ts` 的
 * `provider-health` 任务只调 `ModelRegistry.rebuild()`，一次探测都不发，于是上游可连接但不
 * 返回这类故障无处记录，`rebuild()` 的 `health_state <> 'down'` 过滤每次都放行，
 * 链首永远排第一。表现是每一步都要耗满 `(maxRetries+1) × requestTimeoutMs`，而一轮只有
 * `concurrency.turnTimeoutMs`：`logs/2026-08-18` 的三轮各在开轮后 363 秒才 fallback，最终全部
 * 以本轮长时间无进展收尾。
 *
 * **探测请求打模型目录接口（`probeProvider`），不发补全**。与 WebUI 测试连接同一条路径、
 * 同一份错误分类，因此不消耗 token、不占配额、不写入上游侧的对话记录，也不依赖该 provider
 * 是否已配置启用模型。代价记在 `docs/04 §5.3`：目录接口活着不等于补全接口活着，只答目录、
 * 补全挂起的网关要靠调用路径上的超时计数器（`recordProviderFailure`）发现。
 *
 * 判据是上游是否仍在响应：
 * - 超时 / 网络错 / 5xx → 计入连续失败。达到 `failuresToDown`（默认 3）才标 `down`。
 * - 401/403 → 立即标 `down`。与调用路径（`fallback-model` 的 `onUnavailable`）和 WebUI
 *   测试连接（`app.ts`）一致：认证被拒不会自行恢复。
 * - 404 / 其余 4xx / 响应体不是 JSON → 不计入，只记一条 warn。上游有响应即说明其存活；
 *   自建网关不实现 `/models` 是常态，以此判死整个 provider 会打断整条 fallback 链。
 * - 缺 base_url、API key 解不开、被本机出网策略拦下 → 无法探测，跳过，不改动任何状态。
 */

/**
 * 阈值与探测超时都跟随文档，不新增配置键：`docs/04 §5.3` 将次数定为 3、§5.4 将测试连接
 * 的超时定为 15 s，多一个配置项只会多一处与文档不一致的风险。确需可调时再一并修改文档与 schema。
 */
export const PROVIDER_FAILURES_TO_DOWN = 3;
export const PROVIDER_PROBE_TIMEOUT_MS = 15_000;

export interface ProviderHealthOutcome {
  providerId: string;
  name: string;
  ok: boolean;
  /** 这次失败是否计入连续失败计数。4xx（非认证）与无法探测为 false。 */
  counted: boolean;
  failures: number;
  state: "up" | "down" | "unchanged" | "skipped";
  ms: number;
  code: ProbeCode;
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

/**
 * 探测结果 → 连续失败计数的处置。`counted` 只给「上游没有答话」那几档；上游答了话（哪怕是
 * 404 或 HTML 登录页）一律归零并放行，判据见文件头。
 */
function verdict(
  code: ProbeCode,
  status: number | null,
): "ok" | "auth" | "counted" | "responded" | "skipped" {
  if (code === "ok") return "ok";
  if (code === "unauthorized") return "auth";
  if (code === "timeout" || code === "network") return "counted";
  // `blocked` 是本机出网策略拦的，不是上游的事：推理路径走 AI SDK 的 fetch、不过这道守卫，
  // 据此判死会摘掉一个跑在私网上、完全可用的自建 provider。
  if (
    code === "missing_base_url" ||
    code === "no_master_key" ||
    code === "blocked"
  )
    return "skipped";
  // `upstream_error` 覆盖 401/403/404 之外的全部非 2xx；5xx 是上游自己坏了，计入。
  return code === "upstream_error" && status !== null && status >= 500
    ? "counted"
    : "responded";
}

export async function runProviderHealthCheck(
  deps: {
    db: Sqlite;
    log: LogSink;
    /** 解不开时抛出（更换 `LUOLI_MASTER_KEY` 后即如此），该 provider 本轮跳过。 */
    keyFor: (providerId: string) => string | null;
  },
  options: {
    timeoutMs: number;
    failuresToDown: number;
    allowPrivate: boolean;
  },
): Promise<ProviderHealthOutcome[]> {
  /**
   * 与 `rebuild()` 同一份过滤条件。已判 `down` 且仍在冷却期内的不探：冷却到期由 `rebuild()`
   * 写回 `up`，而 `main.ts` 先 rebuild 再探，因此期满的那一个在同一 tick 内就能被探到。
   * 少了这条过滤时，只有目录接口活着的黑洞网关每 10 分钟被探回 `up` 一次，冷却期形同虚设。
   */
  const rows = deps.db
    .prepare(
      `SELECT id,name,kind,base_url AS baseUrl,headers_json AS headers FROM providers
      WHERE enabled=1 AND COALESCE(health_state,'up') <> 'down'`,
    )
    .all() as Array<{
    id: string;
    name: string;
    kind: string;
    baseUrl: string | null;
    headers: string | null;
  }>;
  const outcomes: ProviderHealthOutcome[] = [];
  for (const row of rows) {
    const started = Date.now();
    let apiKey: string | null = null;
    try {
      apiKey = deps.keyFor(row.id);
    } catch {
      outcomes.push({
        providerId: row.id,
        name: row.name,
        ok: false,
        counted: false,
        failures: 0,
        state: "skipped",
        ms: Date.now() - started,
        code: "no_master_key",
        error: "API Key 无法解密",
      });
      deps.log.event({
        level: "warn",
        kind: "provider.health",
        summary: `${row.name} 的 API Key 无法解密，跳过探测`,
        data: {
          provider: row.name,
          providerId: row.id,
          state: "skipped",
          code: "no_master_key",
        },
      });
      continue;
    }
    let headers: Record<string, string> | null = null;
    // `headers_json` 非法只影响自定义头，不影响连通性判定；与 `app.ts` 的测试连接同样容错。
    try {
      headers = row.headers
        ? (JSON.parse(row.headers) as Record<string, string>)
        : null;
    } catch {
      headers = null;
    }
    /**
     * 超时由 `probeProvider` 的 `AbortSignal.timeout` + `guardedFetch` 保证：那一层是本仓库
     * 自己的 `http.request`，abort 即 `destroy`，promise 必定 settle。不需要旧探测那一套
     * `AttemptDeadline`（它防的是第三方 provider SDK 不认 signal 时 promise 永不 settle，
     * 从而把这个 `protect: true` 的 cron 永久挂死）。
     */
    const probe = await probeProvider(
      { name: row.name, kind: row.kind, baseUrl: row.baseUrl, headers },
      apiKey,
      options.timeoutMs,
      options.allowPrivate,
    );
    const ms = Date.now() - started;
    const decision = verdict(probe.code, probe.status);
    const base = {
      providerId: row.id,
      name: row.name,
      ms,
      code: probe.code,
    };
    const logged = {
      provider: row.name,
      providerId: row.id,
      code: probe.code,
      status: probe.status,
      ms,
    };
    if (decision === "ok") {
      recordProviderSuccess(deps.db, row.id);
      outcomes.push({
        ...base,
        ok: true,
        counted: false,
        failures: 0,
        state: "up",
      });
      deps.log.event({
        level: "info",
        kind: "provider.health",
        summary: `${row.name} 探测正常`,
        data: { ...logged, state: "up", models: probe.models.length },
      });
      continue;
    }
    // `probeProvider` 已对响应体做过脱敏与截断（网关常把请求头回显进错误体）。
    const reason = probe.message.slice(0, 500);
    if (decision === "skipped") {
      outcomes.push({
        ...base,
        ok: false,
        counted: false,
        failures: 0,
        state: "skipped",
        error: reason,
      });
      deps.log.event({
        level: "warn",
        kind: "provider.health",
        summary: `${row.name} 无法探测，跳过`,
        data: { ...logged, state: "skipped", error: reason },
      });
      continue;
    }
    if (decision === "responded") {
      // 有响应即视为存活，因此计数归零。不归零时：目录接口长期 404（自建网关不实现它）
      // 而调用路径偶尔攒一次超时，几天下来也能凑够三次，判死一个始终正常的 provider。
      // `health_state` / `health_checked_at` 不改动：404 只证明网关在响应，不证明补全可用。
      deps.db
        .prepare(
          "UPDATE providers SET health_fail_count=0,health_error=? WHERE id=?",
        )
        .run(reason, row.id);
      outcomes.push({
        ...base,
        ok: false,
        counted: false,
        failures: 0,
        state: "unchanged",
        error: reason,
      });
      deps.log.event({
        level: "warn",
        kind: "provider.health",
        summary: `${row.name} 目录接口不可用（${probe.code}），不计入连续失败`,
        data: { ...logged, state: "unchanged", error: reason },
      });
      continue;
    }
    const recorded = recordProviderFailure(
      deps.db,
      row.id,
      reason,
      options.failuresToDown,
      decision === "auth",
    );
    outcomes.push({
      ...base,
      ok: false,
      counted: true,
      failures: recorded.failures,
      state: recorded.down ? "down" : "unchanged",
      error: reason,
    });
    deps.log.event({
      level: recorded.down ? "error" : "warn",
      kind: "provider.health",
      summary: recorded.down
        ? `${row.name} 连续失败 ${recorded.failures} 次，已标记为 down`
        : `${row.name} 探测失败（${recorded.failures}/${options.failuresToDown}）`,
      data: {
        ...logged,
        state: recorded.down ? "down" : "unchanged",
        failures: recorded.failures,
        error: reason,
      },
    });
  }
  return outcomes;
}
