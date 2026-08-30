import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase, OperationsRepository, type Sqlite } from '@luoli/db';
import { ACP_PERMISSION_TOOL_NAME, AcpManager, DatabaseApprovalBroker, EventBus, LogSink, PathJail, acpPermissionGate, acpPermissionRisk, configSchema, type AcpSettings, type ToolExecutionContext } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * M13 · `session/request_permission` → 真审批（`docs/05 §3.5.3`）。
 *
 * 真 SQLite、真审批 broker、真 fixture agent，没有 mock 层。这一整块最容易出现通过但无意义：
 * 去掉 `exemptOwnerSkip` 之后每一次 permission 都变成静默的 `approved: true`，而只断言最终
 * 拿到 allow 的用例照旧全绿。因此关键几条的判据都落在库里那一行（pending 是否出现过、
 * `approvals` 增加了几条、`decided_by` 是什么），而不是最终那个 outcome。
 */
const FIXTURE = resolve('tests/fixtures/acp-agent.mjs');
const ROOT = resolve('data/acp-perm-work');
const DB_PATH = './data/acp-permission.test.db';
let METHOD_LOG = '';
let caseSeq = 0;
let db: Sqlite | null = null;

const events: Array<{ level: string; kind: string; summary: string; data?: Record<string, unknown> }> = [];
const fakeLog = { event: (event: { level: string; kind: string; summary: string }) => { events.push(event); return 1; },
  publish: () => undefined, span: () => ({ id: 's', end: () => undefined }) } as never;

const lines = (path: string): string[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
const methods = (): string[] => lines(METHOD_LOG);
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
}

interface ApprovalRow { id: string; state: string; risk: string; decidedBy: string | null; channel: string | null; tool: string; input: string }
const rows = (): ApprovalRow[] => (db
  ? db.prepare('SELECT id,state,risk,decided_by AS decidedBy,decision_channel AS channel,tool_name AS tool,input_json AS input FROM approvals ORDER BY rowid').all() as ApprovalRow[]
  : []);
const pending = (): ApprovalRow[] => rows().filter((row) => row.state === 'pending');

/**
 * `skipForOwner` 默认为真，这里显式写真：本节的意义在于 owner-only 的路径上审批仍然生效，
 * 而该结论只有在这个开关开着时才成立。
 */
function harness(options: { permissionMode?: 'ask' | 'auto' | 'deny'; channel?: boolean; ttlMs?: number } = {}) {
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true });
  db = openDatabase(DB_PATH);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' },
    approval: { enabled: true, skipForOwner: true, ttlMs: options.ttlMs ?? 10_000, rules: [] },
    agent: { acp: { enabled: true, allowedDirs: [realpathSync(ROOT)], permissionMode: options.permissionMode ?? 'ask',
      agents: [{ name: 'fixture', command: FIXTURE, profile: '', tools: [], handshakeTimeoutMs: 4000, timeoutMs: 8000 }] } } });
  const log = new LogSink(new OperationsRepository(db));
  const bus = new EventBus();
  // 确实挂一条裁决通道（WebUI 的 SSE）：不挂时走的是两条通道都没有即当场拒绝那一支，
  // 测到的就不是这些用例的目标。
  if (options.channel !== false) bus.subscribe(() => undefined, { channel: true });
  const broker = new DatabaseApprovalBroker(db, config, bus, log);
  const abort = new AbortController();
  const turn = { turnId: 'turn-acp', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '1',
    effectiveRole: 'owner', isPrivate: true, baseCommitId: null,
    snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [], abortSignal: abort.signal, config } satisfies RuntimeTurnContext;
  const context: ToolExecutionContext = { turn, workspace: './data', agentKind: 'main' };
  return { broker, abort, context, acp: config.agent.acp as AcpSettings };
}

/** 逐条审批那条 hook，接法与 `spawn_acp.execute` 逐字相同。 */
const hooks = (broker: DatabaseApprovalBroker, context: ToolExecutionContext) => ({
  permission: (binding: { jail: PathJail; agent: string; onUnanswerable: () => void }) =>
    acpPermissionGate({ approvals: broker, context, log: fakeLog, ...binding }),
});
const host = () => ({
  fs: { denyGlobs: [] as string[], maxReadBytes: 262_144, maxWriteBytes: 5_242_880, backupDir: '.luoli-bak' },
  exec: { maxTimeoutMs: 5000, maxOutputBytes: 65_536 },
  plan: () => ({ mode: 'host' as const }),
});
const run = (manager: AcpManager, subject: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
  manager.run({ task: 'x'.repeat(20), dir: ROOT }, subject.acp, { abortSignal: subject.abort.signal, outputBudgetBytes: 65_536,
    dirWaitMs: 500, host: host() as never, hooks: hooks(subject.broker, subject.context) as never, ...extra });

/** 脚本化 fixture 的一次 permission 询问。`paths` 落在 ROOT 之内，所以 `outsideJail` 是 false。 */
function askScript(options: { kinds?: string; count?: number; kind?: string; paths?: string[] } = {}): void {
  process.env.ACP_PERMISSION = '1';
  process.env.ACP_PERMISSION_OPTIONS = options.kinds ?? 'allow_once,reject_once';
  process.env.ACP_PERMISSION_COUNT = String(options.count ?? 1);
  if (options.kind) process.env.ACP_PERMISSION_KIND = options.kind;
  process.env.ACP_PERMISSION_PATHS = (options.paths ?? [resolve(realpathSync(ROOT), 'app.ts')]).join(',');
}

beforeEach(() => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(resolve(ROOT, 'app.ts'), 'export const a = 1;\n');
  chmodSync(FIXTURE, 0o755);
  caseSeq += 1;
  METHOD_LOG = resolve(`data/acp-perm-methods-${caseSeq}.log`);
  rmSync(METHOD_LOG, { force: true });
  for (const key of Object.keys(process.env)) if (key.startsWith('ACP_')) delete process.env[key];
  process.env.ACP_METHOD_LOG = METHOD_LOG;
  events.length = 0;
});
afterEach(() => { if (db) { closeDatabase(db); db = null; } });

describe('ACP 逐条审批 · 往返', () => {
  it('agent 问 → 库里挂一条 pending → 人批 → agent 拿到 allow 那一档', async () => {
    const subject = harness();
    askScript();
    const manager = new AcpManager(fakeLog);
    const pendingRun = run(manager, subject);
    // 判据是 pending 那一行确实出现过。去掉 `exemptOwnerSkip` 之后这里一行都不会有，而
    // 最终拿到 allow 照旧成立，那正是这一整块被静默摘除后仍然全绿的形态。
    await waitUntil(() => pending().length === 1);
    const row = pending()[0]!;
    expect(row.tool).toBe(ACP_PERMISSION_TOOL_NAME);
    // input 里已带足够精确的判据，因此不必为每种 kind 构造一个假工具名（`approval.rules` 只接受
    // 名字加 `JSON.stringify(input)`）。
    expect(JSON.parse(row.input)).toMatchObject({ agent: 'fixture', kind: 'execute', outsideJail: false });
    expect(row.risk).toBe('high');
    expect(subject.broker.decide(row.id, true, 'owner', 'webui')).toBe(true);
    expect(await pendingRun).toMatchObject({ ok: true });
    expect(methods().some((line) => line.includes('"optionId":"allow_once"'))).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ state: 'approved', decidedBy: 'owner', channel: 'webui' });
    await manager.close();
  });

  it('人拒绝时 agent 拿到 reject 那一档，而这一轮照旧算跑完了', async () => {
    const subject = harness();
    askScript();
    const manager = new AcpManager(fakeLog);
    const pendingRun = run(manager, subject);
    await waitUntil(() => pending().length === 1);
    subject.broker.decide(pending()[0]!.id, false, 'owner', 'webui');
    // 拒绝一步不等于整轮失败：agent 收到 reject 后自行决定后续处理（换一种做法，或报告无法完成）。
    expect(await pendingRun).toMatchObject({ ok: true });
    expect(methods().some((line) => line.includes('"optionId":"reject_once"'))).toBe(true);
    expect(rows()[0]).toMatchObject({ state: 'denied' });
    // 拒绝那一次记 warn：请求了什么动作、被拒绝，这件事需要在日志里留一行。
    expect(events.some((event) => event.kind === 'acp.permission' && event.level === 'warn')).toBe(true);
    await manager.close();
  });

  it('风险档由 kind 推，未知值落 medium，越界一律抬 high', () => {
    for (const kind of ['execute', 'delete'] as const) expect(acpPermissionRisk(kind, false)).toBe('high');
    for (const kind of ['edit', 'move'] as const) expect(acpPermissionRisk(kind, false)).toBe('medium');
    for (const kind of ['read', 'search', 'fetch', 'think'] as const) expect(acpPermissionRisk(kind, false)).toBe('low');
    // 这一层的输入是外部 agent 写的 JSON：无法识别的 kind 更可能是新增的危险动作，
    // 而不是一次无害的读，因此不向低档推断。
    expect(acpPermissionRisk('switch_mode', false)).toBe('medium');
    expect(acpPermissionRisk('other', false)).toBe('medium');
    expect(acpPermissionRisk(undefined, false)).toBe('medium');
    expect(acpPermissionRisk(null, false)).toBe('medium');
    // 越界优先级最高：此时目标已超出本次会话可触及的范围，kind 是什么已不重要。
    for (const kind of ['read', 'think', undefined] as const) expect(acpPermissionRisk(kind, true)).toBe('high');
  });

  it('路径落在 jail 外时抬到 high，并在库里那一行标出来', async () => {
    const subject = harness();
    askScript({ kind: 'read', paths: ['/etc/passwd'] });
    const manager = new AcpManager(fakeLog);
    const pendingRun = run(manager, subject);
    await waitUntil(() => pending().length === 1);
    const row = pending()[0]!;
    // `read` 原本是 low，抬成 high 的判据是路径，而 `outsideJail` 必须能在 input 里表达出来：
    // 审批页上那一行要让人看出读取目标位于仓库之外。
    expect(row.risk).toBe('high');
    expect(JSON.parse(row.input)).toMatchObject({ outsideJail: true, paths: ['/etc/passwd'] });
    subject.broker.decide(row.id, false, 'owner', 'webui');
    await pendingRun;
    await manager.close();
  });
});

describe('ACP 逐条审批 · 不问人的那两档', () => {
  for (const permissionMode of ['auto', 'deny'] as const) {
    it(`${permissionMode} 一行都不落库 —— 它们的语义就是「不问」`, async () => {
      const subject = harness({ permissionMode });
      askScript();
      const manager = new AcpManager(fakeLog);
      expect(await run(manager, subject)).toMatchObject({ ok: true });
      // 即使提供 hook 也不应被调用：`ask` 之外那两档由 `floorPermission` 直接给出结论，两者不串联。
      expect(rows()).toHaveLength(0);
      expect(methods().some((line) => line.includes(permissionMode === 'auto' ? '"optionId":"allow_once"' : '"optionId":"reject_once"'))).toBe(true);
      await manager.close();
    });
  }
});

describe('ACP 逐条审批 · always 只活在这一次调用里', () => {
  it('第二条不再挂 pending，但**照旧落一条 approvals 行**', async () => {
    const subject = harness();
    // agent 给的是 `*_always` 那一档：一旦选中即等于告知它此后按同样方式处理。
    askScript({ kinds: 'allow_always,reject_always', count: 2 });
    const manager = new AcpManager(fakeLog);
    const pendingRun = run(manager, subject);
    await waitUntil(() => pending().length === 1);
    subject.broker.decide(pending()[0]!.id, true, 'owner', 'webui');
    expect(await pendingRun).toMatchObject({ ok: true });
    // 第二次相同的 (kind, 目录) 不再询问：答案已经给出，重复询问没有意义。
    expect(methods().filter((line) => line.startsWith('permission:'))).toHaveLength(2);
    expect(pending()).toHaveLength(0);
    // 但审计行仍逐条落库。不落库时，一次批准之后修改了 40 个文件在审计里只剩最初那一条，
    // 而 always 恰恰是最需要被计数的那一档。
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ state: 'approved', decidedBy: 'owner', channel: 'webui' });
    // 通道与主体是两列：`acp:always` 表示裁决者，通道是 `acp`。两列同值时审批卡会重复渲染同一个
    // 字符串，而按通道分桶的查询会多出一个取值域外的桶（docs/21 §18）。
    expect(all[1]).toMatchObject({ state: 'approved', decidedBy: 'acp:always', channel: 'acp' });
    await manager.close();
  });

  /**
   * 这一条与 `approval.rememberWithinTurn` 不是同一件事，而两者很容易相互覆盖：那一份按
   * `turnId + toolName + JSON.stringify(input)` 记录，同轮跨调用照旧命中。因此 fixture 的
   * `toolCallId` 带 pid（真实 agent 本身也是每次一个新 id）：不带时第二次调用命中的是它，
   * 这条用例就变成在测量另一个机制。
   */
  it('always 那份记忆是这次调用的局部变量 —— 下一次调用照旧从头问', async () => {
    const subject = harness();
    askScript({ kinds: 'allow_always,reject_always', count: 1 });
    const manager = new AcpManager(fakeLog);
    for (let round = 0; round < 2; round += 1) {
      const pendingRun = run(manager, subject);
      await waitUntil(() => pending().length === 1);
      subject.broker.decide(pending()[0]!.id, true, 'owner', 'webui');
      expect(await pendingRun).toMatchObject({ ok: true });
    }
    // 存下来即把一次审批改成一次审批并永久生效，与会话不落库属于同一条纪律。
    expect(rows().filter((row) => row.decidedBy === 'owner')).toHaveLength(2);
    expect(rows().filter((row) => row.decidedBy === 'acp:always')).toHaveLength(0);
    await manager.close();
  });
});

describe('ACP 逐条审批 · 答不出来与被取消', () => {
  it('agent 一个 reject 档都没给时回 error + 取消整轮，**不假装是取消**', async () => {
    const subject = harness();
    // 只给 allow：本方结论是拒绝，而它提供的选项中没有一个能表达该结论。
    askScript({ kinds: 'allow_once' });
    const manager = new AcpManager(fakeLog);
    const pendingRun = run(manager, subject);
    await waitUntil(() => pending().length === 1);
    subject.broker.decide(pending()[0]!.id, false, 'owner', 'webui');
    const result = await pendingRun;
    // `cancelled` 在协议里的含义是 client 取消了这一轮。把人工拒绝表述成它，会让 agent
    // 误判本轮实际发生的事（前者应停止，后者应等待下一条指令）。因此这里返回 JSON-RPC error。
    expect(methods().some((line) => line.startsWith('permission_error:'))).toBe(true);
    expect(methods().some((line) => line.startsWith('permission:'))).toBe(false);
    expect(result).toMatchObject({ ok: false, error: 'acp_permission_unanswerable' });
    expect(methods()).toContain('session/cancel');
    await manager.close();
  });

  it('signal 触发时必须 settle，且这一档回 cancelled 是真话', async () => {
    // 直接测量那个处理器：`signal` 在请求被取消或连接关闭时触发，不 settle 时 SDK 一侧会留下一个
    // 永不应答的请求，agent 随之挂起，那正是先申报后实现那一版的形态。
    const subject = harness();
    const root = realpathSync(ROOT);
    const never = { requestExternal: () => new Promise<never>(() => undefined), recordDecided: () => undefined };
    const gate = acpPermissionGate({ approvals: never, context: subject.context, agent: 'fixture', log: fakeLog,
      jail: new PathJail(root, [], { base: root }), onUnanswerable: () => undefined });
    const controller = new AbortController();
    const answered = gate({ sessionId: 's', toolCall: { toolCallId: 't', kind: 'edit' },
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } as never, controller.signal);
    controller.abort();
    // 这一档使用 `cancelled` 是准确的：协议里它的含义正是 client 取消了这次请求，而此处确实如此。
    expect(await answered).toEqual({ outcome: { outcome: 'cancelled' } });
    // 已经 abort 过的 signal 也要立刻 settle，而不是等一个永远不来的事件。
    expect(await gate({ sessionId: 's', toolCall: { toolCallId: 't2', kind: 'edit' },
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] } as never, controller.signal)).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('轮次被取消时那条 pending 落成 denied/system，agent 收到 reject 而不是挂着', async () => {
    const subject = harness();
    askScript();
    const manager = new AcpManager(fakeLog);
    const pendingRun = run(manager, subject);
    await waitUntil(() => pending().length === 1);
    subject.abort.abort();
    const result = await pendingRun;
    // 审批一侧识别 `turn.abortSignal`（既有行为），因此等待者不会挂满 ttlMs；而本轮因被取消
    // 不算成功：协议报告正常结束与用户执行取消冲突时，以后者为准。
    expect(rows()[0]).toMatchObject({ state: 'denied', decidedBy: 'system' });
    expect(result).toMatchObject({ ok: false, error: 'acp_cancelled' });
    await manager.close();
  });

  it('没有裁决通道时当场拒，不让这一轮干等满 ttlMs', async () => {
    const subject = harness({ channel: false, ttlMs: 60_000 });
    askScript();
    const manager = new AcpManager(fakeLog);
    const started = performance.now();
    expect(await run(manager, subject)).toMatchObject({ ok: true });
    // 判据是耗时：若走挂一条 pending 再等待那条路径，这里需要 60 秒。
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(rows()).toHaveLength(0);
    expect(methods().some((line) => line.includes('"optionId":"reject_once"'))).toBe(true);
    await manager.close();
  });
});
