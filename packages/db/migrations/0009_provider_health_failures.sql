-- provider 连续探测失败次数（docs/04 §5.3 最后一条）。
--
-- 为什么要落库而不是在进程里计数：判据是「连续失败 3 次」，而周期探测与真实调用的超时是两个
-- 不同的写入方（前者每 provider.healthCheckCron 一次，后者在轮次里随时），进程内计数器会让
-- 「重启一次就清零」变成一个隐形的自愈通道 —— 上游还黑着，重启后又要重新熬三次。
-- health_state / health_checked_at / health_error 本来就在这张表上，计数跟着它们走。
--
-- 默认 0：既有行相当于「还没失败过」，第一次探测成功就写回 up 并保持 0。
ALTER TABLE providers ADD COLUMN health_fail_count INTEGER NOT NULL DEFAULT 0;
