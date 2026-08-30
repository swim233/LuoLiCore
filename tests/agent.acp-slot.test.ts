import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AcpRunRecorder, AgentManager, AgentResultStore } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

/**
 * 外部那两条 worker（ACP 与 harness）不占 `agent.maxWorkersPerTurn` 的名额（docs/03 §2.7、docs/04 §4.4）。
 *
 * 三条 worker 路径落库时都是 `kind='sub'`（那一列上的 CHECK 一个都没碰），区分靠 `worker_kind`
 * （迁移 0018）。`spawn()` 那条 COUNT 一旦只数 `kind`，一次 ACP 调用就吃掉本轮一个真 worker 的额度
 * —— 而且因为那一行是**跑完之后**才插的，吃掉的只是排在它后面的那些，上界取决于调用顺序。
 *
 * 用例走**真的写入侧**（`AcpRunRecorder` / `AgentManager.recordHarness`）造行，而不是自己拼一条
 * INSERT：判据认的是那两处真写进去的字段，两边分叉时这里要先红。
 */
function harness(slug: string, maxWorkersPerTurn: number) {
  const path = `./data/${slug}.test.db`;
  const results = `./data/${slug}-results`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(results, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const manager = new AgentManager(db, new AgentResultStore(results), maxWorkersPerTurn);
  return { db, manager, acp: new AcpRunRecorder(db) };
}

function acpRun(turnId: string, agent: string) {
  return { turnId, agent, dir: '/srv/repo', task: 'ship it', ok: true, output: 'done', toolCalls: 3, costUsd: 0.42,
    usage: { source: 'acp' as const }, startedAt: 1, finishedAt: 2 };
}

describe('外部 worker 行与本轮 lw-worker 名额', () => {
  it('本轮已有 N 条 ACP 行时，lw-worker 的额度一个不少', () => {
    const { db, manager, acp } = harness('agent-acp-slot', 2);
    const main = manager.createMain('turn-acp', 'trusted', 'main');
    for (const agent of ['claude', 'codex', 'claude']) acp.record(acpRun('turn-acp', agent));
    // 先钉住这几行真的落成了「会被旧口径数进去」的形状：`kind='sub'`，只有 `worker_kind` 区分得开。
    expect(db.prepare("SELECT COUNT(*) FROM agent_runs WHERE turn_id='turn-acp' AND kind='sub' AND worker_kind='acp'").pluck().get()).toBe(3);
    expect(manager.spawn(main, 'first real worker', 'low').depth).toBe(1);
    expect(manager.spawn(main, 'second real worker', 'low').depth).toBe(1);
    // 额度是 2，两个 lw-worker 已经用光；三条 ACP 行既没提前吃掉它，也没把它撑大。
    expect(() => manager.spawn(main, 'third real worker', 'low')).toThrow('已达本轮 worker 数量上限');
    closeDatabase(db);
  });

  it('lw-worker 数满了照旧拒，与之后再落多少 ACP 行无关', () => {
    const { db, manager, acp } = harness('agent-acp-slot-cap', 1);
    const main = manager.createMain('turn-cap', 'trusted', 'main');
    manager.spawn(main, 'the only slot this turn has', 'low');
    expect(() => manager.spawn(main, 'one too many', 'low')).toThrow('已达本轮 worker 数量上限');
    acp.record(acpRun('turn-cap', 'claude'));
    expect(() => manager.spawn(main, 'still one too many', 'low')).toThrow('已达本轮 worker 数量上限');
    // 别轮的行同样不算 —— COUNT 的 `turn_id=?` 还在。
    const other = manager.createMain('turn-other', 'trusted', 'main');
    expect(manager.spawn(other, 'a different turn keeps its own slot', 'low').turnId).toBe('turn-other');
    closeDatabase(db);
  });

  /**
   * harness 行同理。它是本次新落的一条（此前 `spawn_harness` 压根不落库），走的是同一列 ——
   * 判据写成列而不是名字之后，这一条与上面那条 ACP 的用同一个答案，不需要再各写一份字符串判据。
   */
  it('harness 行也不占名额', () => {
    const { db, manager } = harness('agent-harness-slot', 1);
    const main = manager.createMain('turn-harness', 'trusted', 'main');
    manager.recordHarness({ id: 'harness-run-1', turnId: 'turn-harness', command: 'claude', task: 'fix it', ok: true, output: 'done', startedAt: 1, finishedAt: 2 });
    expect(db.prepare("SELECT worker_kind FROM agent_runs WHERE id='harness-run-1'").pluck().get()).toBe('harness');
    // 那一行的 `cost_usd` 恒 0：harness 烧的是它自己那份 provider 额度（docs/04 §6.2）。
    expect(db.prepare("SELECT cost_usd FROM agent_runs WHERE id='harness-run-1'").pluck().get()).toBe(0);
    expect(manager.spawn(main, 'the lw slot is still here', 'low').depth).toBe(1);
    expect(() => manager.spawn(main, 'now it is used up', 'low')).toThrow('已达本轮 worker 数量上限');
    closeDatabase(db);
  });

  /** worker 是叶子：`AgentManager.spawn()` 的兜底拒绝（真正的闸是 `toolCallableBy`）。 */
  it('worker 派不出 worker', () => {
    const { db, manager } = harness('agent-worker-leaf', 5);
    const main = manager.createMain('turn-leaf', 'trusted', 'main');
    const worker = manager.spawn(main, 'a task that would like to delegate', 'low');
    expect(() => manager.spawn(worker, 'a nested task', 'low')).toThrow('worker 不能再派发 worker');
    closeDatabase(db);
  });

  /** 有效角色照抄父 run —— 不提权，也不收窄（docs/04 §3.3）。 */
  it('worker 的有效角色等于父 run 的', () => {
    const { db, manager } = harness('agent-worker-role', 5);
    for (const role of ['owner', 'trusted', 'limited'] as const) {
      const main = manager.createMain(`turn-role-${role}`, role, 'main');
      expect(manager.spawn(main, `a task under ${role}`, 'low').effectiveRole).toBe(role);
    }
    closeDatabase(db);
  });
});
