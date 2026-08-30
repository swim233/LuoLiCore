-- 三种 worker（lw / harness / acp）在 agent_runs 上认自己的那一列。
--
-- **一个 CHECK 都不碰**，与 0014 逐字同形同理由：kind 上那条 CHECK (kind IN ('main','sub'))
-- 要加一档就得整表重建，而 agent_runs 是 trace 的骨架表（03 §4）—— 重建期间 parent_run_id、
-- tasks.agent_run_id、usage_ledger.agent_run_id、approvals.agent_run_id 四处引用全在半空中。
-- 所以三种 worker 照旧记 kind='sub'，认它靠这一列。
--
-- **新列刻意不加 CHECK。** 本次迁移存在的全部理由就是「kind 上那个 CHECK 扩不动」，
-- 在同一张表上再加一个同样扩不动的枚举，下一种 worker 出现时会撞上一模一样的墙。
-- 取值域焊在 TS 的 WORKER_KINDS 联合类型与唯一那个插入口（AgentManager）上。
ALTER TABLE agent_runs ADD COLUMN worker_kind TEXT;

-- **必须回填。** 不回填的话本轮名额那条 COUNT 的判据要写成「worker_kind='lw' OR (worker_kind
-- IS NULL AND kind='sub' AND NOT 旧的字符串判据)」两分支，而第二支会静默把存量 ACP 行数进名额里。
-- 顺序不能反：先认 ACP（它是 kind='sub' 的子集），剩下的 sub 才是 lw。
UPDATE agent_runs SET worker_kind = 'acp'
  WHERE kind = 'sub' AND agent_name GLOB 'acp:*' AND model_alias = 'external';
UPDATE agent_runs SET worker_kind = 'lw'
  WHERE kind = 'sub' AND worker_kind IS NULL;

-- 部分索引，先例是 0001 的 ix_agentmsg_pending … WHERE state='sent'：主 run 在这张表里是绝大多数，
-- 全量索引等于为少数行让多数行各留一个条目。
CREATE INDEX ix_agentruns_worker ON agent_runs(worker_kind, started_at DESC)
  WHERE worker_kind IS NOT NULL;
