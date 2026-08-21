-- M13 · ACP（外部编码 agent）跑完之后把它自己报的花费与用量落库，但**与本系统的计价彻底隔开**。
--
-- 为什么另开两列而不是用 cost_usd：那个数字不是我们的钱。它来自 usage_update.cost.amount ——
-- 一台外部 agent 自己那份 provider 账单的累计值，口径由它定、我们无法核对、也没有 tokens × prices
-- 可以重算。写进 cost_usd 就等于让它出现在每一个 SUM(cost_usd) 里，摆在我们自己的成本旁边就是
-- 邀请人把两者相加。所以 ACP 行的 cost_usd 恒为 0（结构上挡在聚合之外），真实数字在这里。
-- 同理它不进 usage_ledger（那张表的行必填 provider_id / model_id，塞一条 provider_id='omp'
-- 等于凭空造一个我们不拥有的 provider）也不进 quota_counters（配额的分母是本系统的 key）。
--
-- 两列都可空：NULL = agent 一次 usage_update 都没报过，与「它报了 0」是两件事。
--
-- **附加式，一个 CHECK 都不碰。** agent_runs.kind 上那条 CHECK (kind IN ('main','sub')) 要改就得
-- 重建整表，而它是 trace 骨架表（03 §4）—— 所以 ACP 行照旧记 kind='sub'，靠 agent_name='acp:<name>'
-- 与 model_alias='external' 认出来。
ALTER TABLE agent_runs ADD COLUMN external_cost_usd REAL;
ALTER TABLE agent_runs ADD COLUMN external_usage_json TEXT;
