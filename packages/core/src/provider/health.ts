import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { Sqlite } from '@luoli/db';
import { AttemptDeadline } from '../agent/fallback-model.js';
import { redact } from '../secrets.js';
import type { LogSink } from '../log/sink.js';

/**
 * provider 健康检查（`docs/04 §5.3` 最后一条）。**这条以前压根没实现**：`main.ts` 那个
 * `provider-health` 任务只调 `ModelRegistry.rebuild()`，一次探测都不发 —— 于是「上游连上了但不
 * 返回」这种故障没有任何一处会记住，`rebuild()` 的 `health_state <> 'down'` 过滤每次都放它过，
 * 链首永远排第一。表现是每一步都要重新熬满 `(maxRetries+1) × requestTimeoutMs`，而一轮只有
 * `concurrency.turnTimeoutMs`：`logs/2026-08-18` 的三轮各在开轮后 363 秒才 fallback，最后全部
 * 以「这一轮太久没有进展」收尾。
 *
 * 判据是**上游到底还答不答**，不是「这个模型这次答得对不对」：
 * - 超时 / 网络错 / 5xx → 计入连续失败。到 `failuresToDown`（默认 3）才标 `down`。
 * - 401/403 → 当场标 `down`。与调用路径（`fallback-model` 的 `onUnavailable`）和 WebUI
 *   「测试连接」（`app.ts`）一致：认证被拒不会自己好。
 * - 其余 4xx（400 参数不合、404 模型不存在）→ **不计**，只记一条 warn。上游答了话就说明它活着；
 *   拿探测模型的参数问题去把整个 provider 判死，会在「换了个模型 id」这种事上误伤。
 */

/**
 * 阈值与探测超时都跟着文档走，**不开新配置键**：`docs/04 §5.3` 把次数定在 3、§5.4 把「测试连接」
 * 的超时定在 15 s，多一个格子只会多一个和文档对不上的地方。真要可调再一起改文档与 schema。
 */
export const PROVIDER_FAILURES_TO_DOWN = 3;
export const PROVIDER_PROBE_TIMEOUT_MS = 15_000;

export interface ProbeSource {
  /** 该 provider 的一个**裸**候选（不能是 `aliasModel` 包过的：那一层自己会 fallback，探测就永远探不出问题）。 */
  probeCandidate(providerId: string): { model: LanguageModel; modelId: string } | null;
}

export interface ProviderHealthOutcome {
  providerId: string;
  name: string;
  modelId: string;
  ok: boolean;
  /** 这次失败是否计入连续失败计数。4xx（非认证）为 false。 */
  counted: boolean;
  failures: number;
  state: 'up' | 'down' | 'unchanged';
  ms: number;
  error?: string;
}

/** 探测与调用路径共用同一个计数器，所以规则只有这一份。`immediate` 给 401/403。 */
export function recordProviderFailure(db: Sqlite, providerId: string, reason: string, failuresToDown: number, immediate = false): { failures: number; down: boolean } {
  const now = Date.now();
  const failures = ((db.prepare('SELECT health_fail_count FROM providers WHERE id=?').pluck().get(providerId) as number | undefined) ?? 0) + 1;
  const down = immediate || failures >= failuresToDown;
  if (down) db.prepare("UPDATE providers SET health_fail_count=?,health_state='down',health_checked_at=?,health_error=? WHERE id=?").run(failures, now, reason.slice(0, 500), providerId);
  // 还没到阈值时**不碰 health_state**：一次抖动不该让 provider 从链里消失，而
  // `health_checked_at` 是冷却期的起点，提前推它会让真的 down 之后的冷却算错。
  else db.prepare('UPDATE providers SET health_fail_count=?,health_error=? WHERE id=?').run(failures, reason.slice(0, 500), providerId);
  return { failures, down };
}

export function recordProviderSuccess(db: Sqlite, providerId: string): void {
  db.prepare("UPDATE providers SET health_fail_count=0,health_state='up',health_checked_at=?,health_error=NULL WHERE id=?").run(Date.now(), providerId);
}

/**
 * 调用路径上「这一次真的服务成功了」。**「连续失败」少了这一条就是「累计失败」** —— 计数在库里、
 * 重启也不清，跨轮次零散攒够三次超时同样能判死一个一直在答话的 provider。
 *
 * 与探测那条（`recordProviderSuccess`）分开是因为守卫：这里每一步模型调用都会调一次，带上
 * 「本来就是 up 且计数为 0 就别写」的条件之后常态命中 0 行，不给每一步加一次真实写入。
 * 返回是否真的改过 —— 调用方拿它决定要不要动进程内那份 `#down`。
 */
export function recordProviderServed(db: Sqlite, providerId: string): boolean {
  return db.prepare(`UPDATE providers SET health_fail_count=0,health_state='up',health_checked_at=?,health_error=NULL
    WHERE id=? AND (health_fail_count<>0 OR COALESCE(health_state,'up')<>'up')`).run(Date.now(), providerId).changes > 0;
}

function errorStatus(error: unknown): number | null {
  // 与 `fallback-model.ts` 的同名判据一致。那边是私有的，为一个三行判据把中间件层反向导进
  // provider 层不值得（provider → agent → provider 的循环）。
  return error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : null;
}

export async function runProviderHealthCheck(
  deps: { db: Sqlite; models: ProbeSource; log: LogSink; keyFor?: (providerId: string) => string | null },
  options: { timeoutMs: number; failuresToDown: number },
): Promise<ProviderHealthOutcome[]> {
  const rows = deps.db.prepare('SELECT id,name FROM providers WHERE enabled=1').all() as Array<{ id: string; name: string }>;
  const outcomes: ProviderHealthOutcome[] = [];
  for (const row of rows) {
    const candidate = deps.models.probeCandidate(row.id);
    // 一个启用的模型都没有的 provider 不在任何链里，探它没有意义（也没有模型可探）。
    if (!candidate) continue;
    const started = Date.now();
    let failure: unknown;
    // 走真实调用那一套 `AttemptDeadline`，而不是光传一个 `AbortSignal.timeout`：**只 abort 是不够的**
    // —— provider 不认那个 signal 时它的 promise 永远不 settle，探测就把这个 cron 挂死在这里，
    // 而 `Cron` 是 `protect: true`，下一次到点会被跳过 = 健康检查从此再也不跑（同 docs/04 §5.3
    // 那条「到点后既 abort 底层请求也停止等待」）。
    const deadline = new AttemptDeadline(undefined);
    try {
      await deadline.guard(generateText({ model: candidate.model, prompt: 'ping', maxOutputTokens: 1, maxRetries: 0, abortSignal: deadline.signal }), options.timeoutMs, 'probe');
    } catch (error) { failure = error; }
    const ms = Date.now() - started;
    if (!failure) {
      recordProviderSuccess(deps.db, row.id);
      outcomes.push({ providerId: row.id, name: row.name, modelId: candidate.modelId, ok: true, counted: false, failures: 0, state: 'up', ms });
      deps.log.event({ level: 'info', kind: 'provider.health', summary: `${row.name} 探测正常`, data: { provider: row.name, providerId: row.id, modelId: candidate.modelId, state: 'up', ms } });
      continue;
    }
    const status = errorStatus(failure);
    const raw = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
    const reason = redact(raw.replace(/\s+/g, ' ').trim(), [deps.keyFor?.(row.id) ?? ''].filter(Boolean)).slice(0, 500);
    const auth = status === 401 || status === 403;
    const counted = auth || status === null || status >= 500;
    if (!counted) {
      // **答了话就算活着，所以计数归零。** 不归零的话：探测模型常年 400（`max_tokens` 下界之类）
      // 而调用路径偶尔攒一次超时，几天下来也能凑够三次，把一个一直好着的 provider 判死。
      // `health_state` / `health_checked_at` 不动：一次 400 只证明网关在答话，不证明这个模型能用。
      deps.db.prepare('UPDATE providers SET health_fail_count=0,health_error=? WHERE id=?').run(reason, row.id);
      outcomes.push({ providerId: row.id, name: row.name, modelId: candidate.modelId, ok: false, counted: false, failures: 0, state: 'unchanged', ms, error: reason });
      deps.log.event({ level: 'warn', kind: 'provider.health', summary: `${row.name} 探测被拒（${status}），不计入连续失败`, data: { provider: row.name, providerId: row.id, modelId: candidate.modelId, state: 'unchanged', status, ms, error: reason } });
      continue;
    }
    const recorded = recordProviderFailure(deps.db, row.id, reason, options.failuresToDown, auth);
    outcomes.push({ providerId: row.id, name: row.name, modelId: candidate.modelId, ok: false, counted: true, failures: recorded.failures, state: recorded.down ? 'down' : 'unchanged', ms, error: reason });
    deps.log.event({ level: recorded.down ? 'error' : 'warn', kind: 'provider.health',
      summary: recorded.down ? `${row.name} 连续失败 ${recorded.failures} 次，已标 down` : `${row.name} 探测失败（${recorded.failures}/${options.failuresToDown}）`,
      data: { provider: row.name, providerId: row.id, modelId: candidate.modelId, state: recorded.down ? 'down' : 'unchanged', status, failures: recorded.failures, ms, error: reason } });
  }
  return outcomes;
}
