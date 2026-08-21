import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AcpRunRecorder, AgentManager, AgentResultStore } from '@luoli/core';
import type { AgentDefinition } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

/**
 * ACP 行（M13）不占 `agent.maxSubagentsPerTurn` 的名额（docs/03 §2.7）。
 *
 * 落库那一行照旧是 `kind='sub'`（迁移 0014 一个 CHECK 都没碰），所以 `spawn()` 那条 COUNT 一旦
 * 只数 `kind`，一次 ACP 调用就吃掉本轮一个真子 agent 的额度 —— 而且因为那一行是**跑完之后**才插的，
 * 吃掉的只是排在它后面的那些，上界取决于调用顺序。用例走**真的写入侧**（`AcpRunRecorder`）造行，
 * 而不是自己拼一条 INSERT：判据认的是 `runs.ts` 真写进去的那几个字段，两边分叉时这里要先红。
 */
function harness(slug: string, maxSubagentsPerTurn: number, extra: AgentDefinition[] = []) {
  const path = `./data/${slug}.test.db`;
  const results = `./data/${slug}-results`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(results, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const manager = new AgentManager(db, new AgentResultStore(results),
    [{ name: 'researcher', description: 'r', modelAlias: 'low', maxSteps: 3, minRole: 'limited', tools: [], resultMaxChars: 100, instructions: 'r' }, ...extra],
    3, maxSubagentsPerTurn);
  return { db, manager, acp: new AcpRunRecorder(db) };
}

function acpRun(turnId: string, agent: string) {
  return { turnId, agent, dir: '/srv/repo', task: 'ship it', ok: true, output: 'done', toolCalls: 3, costUsd: 0.42,
    usage: { source: 'acp' as const }, startedAt: 1, finishedAt: 2 };
}

describe('ACP 行与本轮子 agent 名额', () => {
  it('本轮已有 N 条 ACP 行时，真子 agent 的额度一个不少', () => {
    const { db, manager, acp } = harness('agent-acp-slot', 2);
    const main = manager.createMain('turn-acp', 'trusted', 'main');
    for (const agent of ['claude', 'codex', 'claude']) acp.record(acpRun('turn-acp', agent));
    // 先钉住这几行真的落成了「会被旧口径数进去」的形状 —— 判据认的就是这三个字段。
    expect(db.prepare("SELECT COUNT(*) FROM agent_runs WHERE turn_id='turn-acp' AND kind='sub' AND agent_name LIKE 'acp:%' AND model_alias='external'").pluck().get()).toBe(3);
    expect(manager.spawn(main, 'researcher', 'first real sub agent').run.depth).toBe(1);
    expect(manager.spawn(main, 'researcher', 'second real sub agent').run.depth).toBe(1);
    // 额度是 2，两个真子 agent 已经用光；三条 ACP 行既没提前吃掉它，也没把它撑大。
    expect(() => manager.spawn(main, 'researcher', 'third real sub agent')).toThrow('已达本轮子 agent 数量上限');
    closeDatabase(db);
  });

  it('真子 agent 数满了照旧拒，与之后再落多少 ACP 行无关', () => {
    const { db, manager, acp } = harness('agent-acp-slot-cap', 1);
    const main = manager.createMain('turn-cap', 'trusted', 'main');
    manager.spawn(main, 'researcher', 'the only slot this turn has');
    expect(() => manager.spawn(main, 'researcher', 'one too many')).toThrow('已达本轮子 agent 数量上限');
    acp.record(acpRun('turn-cap', 'claude'));
    expect(() => manager.spawn(main, 'researcher', 'still one too many')).toThrow('已达本轮子 agent 数量上限');
    // 别轮的行同样不算 —— COUNT 的 `turn_id=?` 还在。
    const other = manager.createMain('turn-other', 'trusted', 'main');
    expect(manager.spawn(other, 'researcher', 'a different turn keeps its own slot').run.turnId).toBe('turn-other');
    closeDatabase(db);
  });

  /**
   * 排除判据是「`acp:` 前缀 **且** `model_alias='external'`」，两个都中才算。`agent.agents[].name`
   * 是裸 `z.string()`（文件定义那条路的正则挡得住冒号，DB / WebUI 那条挡不住），所以运维真能建一个
   * 叫 `acp:` 打头的子 agent；只看前缀的话它会被静默漏数 —— 一个人为的越界名字换来无限 fan-out。
   */
  it('叫 acp: 打头的真子 agent 照旧占名额，大小写也不放过', () => {
    const { db, manager } = harness('agent-acp-slot-squatter', 1, [
      { name: 'acp:squatter', description: 's', modelAlias: 'low', maxSteps: 3, minRole: 'limited', tools: [], resultMaxChars: 100, instructions: 's' },
      // 名字与别名都照 ACP 行抄，只差一个大写 —— `GLOB` 是大小写敏感的，`LIKE` 会把它一起漏掉。
      { name: 'ACP:loud', description: 'l', modelAlias: 'external', maxSteps: 3, minRole: 'limited', tools: [], resultMaxChars: 100, instructions: 'l' },
    ]);
    const squatter = manager.createMain('turn-squat', 'trusted', 'main');
    manager.spawn(squatter, 'acp:squatter', 'a real sub agent wearing the acp prefix');
    expect(() => manager.spawn(squatter, 'researcher', 'should be refused')).toThrow('已达本轮子 agent 数量上限');
    const loud = manager.createMain('turn-loud', 'trusted', 'main');
    manager.spawn(loud, 'ACP:loud', 'prefix and alias both mimic an acp row');
    expect(() => manager.spawn(loud, 'researcher', 'should be refused too')).toThrow('已达本轮子 agent 数量上限');
    closeDatabase(db);
  });
});
