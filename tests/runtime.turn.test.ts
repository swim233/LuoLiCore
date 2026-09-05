import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMainAgent } from '@luoli/core';
import { startTestRuntime } from './support/runtime.js';
import { startFakeUpstream } from './support/upstream.js';

/**
 * T1.2 验收②：`composeRuntime`（T1.1）装起的运行时能跑完一轮完整轮次——`openTurn` → 模型
 * （`tests/support/upstream.ts` 的假 upstream）→ `appendDelta` → `commitTurn`，`context_commits`
 * / `refs` 推进，回复落库。这正是原欠账 D-04（`docs/reviews/27 §8`）存在的目的：D-04 修复之前，
 * 仓储与工具全部散落在 `main.ts` 顶层，集成测试装不起一份可用的运行时，只能像
 * `tests/agent.model-wiring.test.ts` 那样绕过真实 `ModelRegistry`、直接喂一个假的 `LanguageModel`。
 *
 * 轮次入口选 `runMainAgent`（`@luoli/core`）加 `ContextEngine` 的三步，而不是
 * `ScheduledJobRunner.fire()` 或 `packages/telegram/src/bot.ts` 的 `onTurn`：前者要求
 * `telegram()` 非空（`tests/support/runtime.ts` 不写 `slots.bot`，`telegram()` 因此恒为 null，
 * `fire()` 会以 `telegram_unavailable` 直接跳过，见 `packages/core/src/schedule/runner.ts`）；
 * 后者需要一个真实 grammY `Bot` 实例，而本仓没有为它单独抽出可注入的入口。`runMainAgent` 加
 * `openTurn` / `appendDelta` / `commitTurn` 正是这两条生产路径唯一共用的部分——`bot.ts:1991-1999`
 * 与 `apps/bot/src/compose.ts` 里 `scheduleRunner` 的 `runAgent` 闭包都是同一序列，本用例按同一
 * 顺序原样复现，只是调用方从「HTTP / Telegram 入口」换成测试本身。
 */
describe('composeRuntime 装起的运行时能跑完一轮', () => {
  it('openTurn → 模型 → appendDelta → commitTurn：commit 推进、done 指向它、回复落库', async () => {
    const upstream = await startFakeUpstream('早上好，这是一条测试回复。');
    const runtime = await startTestRuntime('runtime-fullturn');
    try {
      // 真实 `ModelRegistry` 从 `providers` / `models` / `model_aliases` 三张表现读现建，
      // 没有等价的直接注入点：让 provider 行的 `base_url` 指向假 upstream 是唯一的接入方式。
      const providerId = runtime.deps.providers.save({
        name: 'fake', kind: 'openai-compatible', baseUrl: upstream.url,
        apiKey: 'sk-fake-0123456789abcdef',
      });
      const now = Date.now();
      const modelRowId = `${providerId}:fake-model`;
      runtime.db
        .prepare(
          `INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,enabled,sort,created_at,updated_at)
        VALUES (?,?,?,128000,4096,'{}',1,2,1,0,?,?)`,
        )
        .run(modelRowId, providerId, 'fake-model', now, now);
      runtime.db
        .prepare('INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)')
        .run('main', JSON.stringify([modelRowId]), now);
      // 装配期建过一次注册表，那时 provider/model 行还不存在——重建之后 'main' 别名才可用。
      runtime.deps.rebuildModels();
      expect(runtime.deps.modelRegistry.aliases()).toContain('main');

      const chatId = 'c1';
      const key = 'chat:c1';
      const scoped = runtime.deps.archive.scope(chatId, null);
      const trigger = scoped.append({
        chatId, messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user',
        fromUserId: 'u1', fromName: '阿离', fromUsername: null, kind: 'text', text: '早上好',
        tgDate: now, raw: {}, triggered: false, triggerReason: null,
      });

      const turn = await runtime.deps.context.openTurn({
        chatId, threadId: null, key, initiatorUserId: 'u1', effectiveRole: 'trusted', isPrivate: true,
        trigger, abortSignal: new AbortController().signal, config: runtime.config,
      });
      runtime.deps.turns.create({
        id: turn.turnId, key, chatId, threadId: null, userId: 'u1', role: 'trusted',
        triggerMessageId: trigger.id, triggerReason: 'trigger', baseCommitId: turn.baseCommitId,
      });

      // 依赖对象照抄 `apps/bot/src/compose.ts` 里 `scheduleRunner` 的 `runAgent` 闭包
      // （非流式：与它同一理由，本用例没有 Telegram 流消费者）。
      const answer = await runMainAgent(turn, {
        config: runtime.config,
        db: runtime.db,
        registry: runtime.deps.modelRegistry,
        tools: runtime.deps.toolRegistry,
        prompts: runtime.deps.promptAssembler,
        documents: runtime.deps.promptDocuments,
        skills: runtime.deps.skills,
        plugins: runtime.deps.plugins,
        agents: runtime.deps.agents,
        customTools: runtime.deps.customTools,
        containers: runtime.deps.containers,
        ledger: runtime.deps.ledger,
        context: runtime.deps.context,
        quota: runtime.deps.quota,
        reservation: null,
        log: runtime.deps.log,
        turns: runtime.deps.turns,
        workspace: resolve(runtime.config.sandbox.workspaceDir, chatId),
      });
      // 假 upstream 真的被调用过，且模型返回的正文原样穿透了整条 agent 循环。
      expect(upstream.requests.length).toBeGreaterThanOrEqual(1);
      expect(answer).toContain('早上好，这是一条测试回复。');

      // `packages/telegram/src/bot.ts:1991-1999` 的形状：先 appendDelta 一条完整全文，再 commitTurn。
      runtime.deps.context.appendDelta(turn, {
        id: turn.turnId, role: 'assistant', origin: 'assistant',
        parts: [{ type: 'text', text: answer }], textPreview: answer.slice(0, 240), pruneLevel: 0,
      });
      const committed = await runtime.deps.context.commitTurn(turn);
      runtime.deps.turns.finish(turn.turnId, {
        state: 'committed', commitId: committed.commit.id, rebased: committed.rebased,
      });

      expect(runtime.db.prepare('SELECT COUNT(*) FROM context_commits WHERE key=?').pluck().get(key)).toBe(1);
      expect(runtime.db.prepare("SELECT commit_id FROM refs WHERE key=? AND name='done'").pluck().get(key))
        .toBe(committed.commit.id);
      const assistantRow = runtime.db
        .prepare("SELECT parts_json FROM context_messages WHERE key=? AND role='assistant'")
        .get(key) as { parts_json: string } | undefined;
      expect(assistantRow, '回复没有落进 context_messages').toBeDefined();
      expect(assistantRow!.parts_json).toContain('早上好，这是一条测试回复。');
      expect(runtime.db.prepare('SELECT state FROM turns WHERE id=?').pluck().get(turn.turnId)).toBe('committed');
    } finally {
      await runtime.dispose();
      await upstream.close();
    }
  });
});
