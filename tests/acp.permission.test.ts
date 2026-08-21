import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase, OperationsRepository, type Sqlite } from '@luoli/db';
import { ACP_PERMISSION_TOOL_NAME, AcpManager, DatabaseApprovalBroker, EventBus, LogSink, PathJail, acpPermissionGate, acpPermissionRisk, configSchema, type AcpSettings, type ToolExecutionContext } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * M13 · `session/request_permission` → 真审批（`docs/05 §3.5.3`）。
 *
 * **真 SQLite、真审批 broker、真 fixture agent，没有 mock 层。** 这一整块最容易「通过得毫无意义」：
 * 去掉 `exemptOwnerSkip` 之后每一次 permission 都变成静默的 `approved: true`，而一条只断言
 * 「最后拿到了 allow」的用例照旧全绿。所以关键几条的判据都是**库里那一行**（pending 出现过、
 * `approvals` 涨了几条、`decided_by` 是什么），不是最终那个 outcome。
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
 * `skipForOwner` **默认真而这里显式写真**：这一节的全部意义就是「owner-only 的路径上审批仍然生效」，
 * 而那只有在这个开关开着时才是一句有内容的话。
 */
function harness(options: { permissionMode?: 'ask' | 'auto' | 'deny'; channel?: boolean; ttlMs?: number } = {}) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true });
  db = openDatabase(DB_PATH);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' },
    approval: { enabled: true, skipForOwner: true, ttlMs: options.ttlMs ?? 10_000, rules: [] },
    agent: { acp: { enabled: true, allowedDirs: [realpathSync(ROOT)], permissionMode: options.permissionMode ?? 'ask',
      agents: [{ name: 'fixture', command: FIXTURE, profile: '', tools: [], handshakeTimeoutMs: 4000, timeoutMs: 8000 }] } } });
  const log = new LogSink(new OperationsRepository(db), './data/acp-perm-logs');
  const bus = new EventBus();
  // 真的挂一条裁决通道（WebUI 的 SSE）：不挂的话走的是「两条通道都没有 → 当场拒」那一支，
  // 测的就不是这些用例想测的东西了。
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
    // **判据是 pending 那一行真的出现过。** 去掉 `exemptOwnerSkip` 之后这里会一行都没有，而
    // 「最后拿到了 allow」照旧成立 —— 那正是这一整块能被静默摘掉又全绿的形态。
    await waitUntil(() => pending().length === 1);
    const row = pending()[0]!;
    expect(row.tool).toBe(ACP_PERMISSION_TOOL_NAME);
    // input 里带着足够精准的判据，所以不必为每种 kind 编一个假工具名（`approval.rules` 只吃
    // 名字 + `JSON.stringify(input)`）。
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
    // 拒掉一步不等于整轮失败：agent 收到 reject 之后自己决定怎么办（换个做法、或者报告做不了）。
    expect(await pendingRun).toMatchObject({ ok: true });
    expect(methods().some((line) => line.includes('"optionId":"reject_once"'))).toBe(true);
    expect(rows()[0]).toMatchObject({ state: 'denied' });
    // 拒绝那一次记 warn —— 「它想干什么、我们没让」值得在日志里有一行。
    expect(events.some((event) => event.kind === 'acp.permission' && event.level === 'warn')).toBe(true);
    await manager.close();
  });

  it('风险档由 kind 推，未知值落 medium，越界一律抬 high', () => {
    for (const kind of ['execute', 'delete'] as const) expect(acpPermissionRisk(kind, false)).toBe('high');
    for (const kind of ['edit', 'move'] as const) expect(acpPermissionRisk(kind, false)).toBe('medium');
    for (const kind of ['read', 'search', 'fetch', 'think'] as const) expect(acpPermissionRisk(kind, false)).toBe('low');
    // 这一层的输入是外部 agent 写的 JSON：一个我们不认识的 kind 更可能是新增的危险动作，
    // 而不是一次无害的读。**不猜低档。**
    expect(acpPermissionRisk('switch_mode', false)).toBe('medium');
    expect(acpPermissionRisk('other', false)).toBe('medium');
    expect(acpPermissionRisk(undefined, false)).toBe('medium');
    expect(acpPermissionRisk(null, false)).toBe('medium');
    // 越界压过一切：那时它要动的东西已经出了这次会话该碰的范围，kind 说什么都不重要了。
    for (const kind of ['read', 'think', undefined] as const) expect(acpPermissionRisk(kind, true)).toBe('high');
  });

  it('路径落在 jail 外时抬到 high，并在库里那一行标出来', async () => {
    const subject = harness();
    askScript({ kind: 'read', paths: ['/etc/passwd'] });
    const manager = new AcpManager(fakeLog);
    const pendingRun = run(manager, subject);
    await waitUntil(() => pending().length === 1);
    const row = pending()[0]!;
    // `read` 本来是 low。抬成 high 的判据是路径，而 `outsideJail` 要在 input 里说得出来 ——
    // 审批页上那一行得让人看出「它要读的是仓库外的东西」。
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
      // 给了 hook 也不该被调到：`ask` 之外那两档由 `floorPermission` 直接答，两者**不串联**。
      expect(rows()).toHaveLength(0);
      expect(methods().some((line) => line.includes(permissionMode === 'auto' ? '"optionId":"allow_once"' : '"optionId":"reject_once"'))).toBe(true);
      await manager.close();
    });
  }
});

describe('ACP 逐条审批 · always 只活在这一次调用里', () => {
  it('第二条不再挂 pending，但**照旧落一条 approvals 行**', async () => {
    const subject = harness();
    // agent 给的是 `*_always` 那一档 —— 也就是我们一旦选中就已经告诉它「以后都这样」。
    askScript({ kinds: 'allow_always,reject_always', count: 2 });
    const manager = new AcpManager(fakeLog);
    const pendingRun = run(manager, subject);
    await waitUntil(() => pending().length === 1);
    subject.broker.decide(pending()[0]!.id, true, 'owner', 'webui');
    expect(await pendingRun).toMatchObject({ ok: true });
    // 第二次同 (kind, 目录) 不再问人 —— 答案已经给出去了，再问一次是纯粹的表演。
    expect(methods().filter((line) => line.startsWith('permission:'))).toHaveLength(2);
    expect(pending()).toHaveLength(0);
    // **但审计行照旧一条一条落。** 不落的话「批了一次之后它改了 40 个文件」在审计里只剩最初那一条，
    // 而 always 恰恰是最需要被数出来的那一档。
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ state: 'approved', decidedBy: 'owner' });
    expect(all[1]).toMatchObject({ state: 'approved', decidedBy: 'acp:always', channel: 'acp:always' });
    await manager.close();
  });

  /**
   * ⚠️ 这一条与 `approval.rememberWithinTurn` **不是同一件事**，而两者很容易互相顶掉：那一份按
   * `turnId + toolName + JSON.stringify(input)` 记，**跨调用同轮照旧命中**。所以 fixture 的
   * `toolCallId` 带 pid（真 agent 本来也每次一个新 id）—— 不带的话第二次调用命中的是它，
   * 而这条用例就变成在量另一个机制。
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
    // 存下来就把「一次审批」偷偷改成「一次审批、此后永久」—— 与会话不落库是同一条纪律。
    expect(rows().filter((row) => row.decidedBy === 'owner')).toHaveLength(2);
    expect(rows().filter((row) => row.decidedBy === 'acp:always')).toHaveLength(0);
    await manager.close();
  });
});

describe('ACP 逐条审批 · 答不出来与被取消', () => {
  it('agent 一个 reject 档都没给时回 error + 取消整轮，**不假装是取消**', async () => {
    const subject = harness();
    // 只给 allow：我们的结论是「拒绝」，而它给的选项里没有一个能表达这句话。
    askScript({ kinds: 'allow_once' });
    const manager = new AcpManager(fakeLog);
    const pendingRun = run(manager, subject);
    await waitUntil(() => pending().length === 1);
    subject.broker.decide(pending()[0]!.id, false, 'owner', 'webui');
    const result = await pendingRun;
    // `cancelled` 在协议里的意思是「client 取消了这一轮」。把「人拒绝了」说成那个，会让 agent
    // 记错这一轮到底发生了什么（前者该停、后者该等下一条指令）。所以是一个 JSON-RPC error。
    expect(methods().some((line) => line.startsWith('permission_error:'))).toBe(true);
    expect(methods().some((line) => line.startsWith('permission:'))).toBe(false);
    expect(result).toMatchObject({ ok: false, error: 'acp_permission_unanswerable' });
    expect(methods()).toContain('session/cancel');
    await manager.close();
  });

  it('signal 触发时必须 settle，且这一档回 cancelled 是真话', async () => {
    // 直接量那个处理器：`signal` 在请求被取消 / 连接关闭时触发，不 settle 的话 SDK 那侧留着一个
    // 永不应答的请求，而 agent 就挂在那儿 —— 那正是「先申报后实现」那一版的形态。
    const subject = harness();
    const root = realpathSync(ROOT);
    const never = { requestExternal: () => new Promise<never>(() => undefined), recordDecided: () => undefined };
    const gate = acpPermissionGate({ approvals: never, context: subject.context, agent: 'fixture', log: fakeLog,
      jail: new PathJail(root, [], { base: root }), onUnanswerable: () => undefined });
    const controller = new AbortController();
    const answered = gate({ sessionId: 's', toolCall: { toolCallId: 't', kind: 'edit' },
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } as never, controller.signal);
    controller.abort();
    // 这一档 `cancelled` 是真话：协议里它的意思正是「client 取消了这次请求」，而这里确实是。
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
    // 审批那一侧认 `turn.abortSignal`（既有行为），所以等待者不会挂满 ttlMs；而这一轮本身
    // 因为被取消而不算成功 —— 「协议说它正常结束」与「人按了取消」冲突时，后者赢。
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
    // 判据是**时间**：走「挂一条 pending 再等」那条路的话这里要 60 秒。
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(rows()).toHaveLength(0);
    expect(methods().some((line) => line.includes('"optionId":"reject_once"'))).toBe(true);
    await manager.close();
  });
});
