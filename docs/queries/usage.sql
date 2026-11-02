-- 模型调用的常用统计（表结构见 docs/adr/0005-sqlite-storage-in-core.md）
-- 用法：sqlite3 -readonly data/luoli.db < docs/queries/usage.sql
-- 时间按本地时区。token 列为空表示服务端没报；缓存命中率只算报了缓存数的调用。
.headers on
.mode column

.print
.print 按天
-- 按天（本地时区）：调用次数、其中失败次数、输入、缓存命中、缓存命中率、输出、推理 token
SELECT
  date(started_at, 'localtime') AS 日期,
  count(*) AS 调用,
  sum(outcome = 'failed') AS 失败,
  sum(input_tokens) AS 输入,
  sum(cache_read_tokens) AS 缓存命中,
  round(100.0 * sum(cache_read_tokens)
    / sum(CASE WHEN cache_read_tokens IS NOT NULL THEN input_tokens END), 1) AS 命中率,
  sum(output_tokens) AS 输出,
  sum(reasoning_tokens) AS 推理
FROM model_calls
GROUP BY 日期
ORDER BY 日期;

.print
.print 按会话
-- 按会话：平台、标题、调用次数、输入、缓存命中率、输出；输入多的在前
SELECT
  c.platform AS 平台,
  c.title AS 标题,
  count(*) AS 调用,
  sum(m.input_tokens) AS 输入,
  round(100.0 * sum(m.cache_read_tokens)
    / sum(CASE WHEN m.cache_read_tokens IS NOT NULL THEN m.input_tokens END), 1) AS 命中率,
  sum(m.output_tokens) AS 输出
FROM model_calls m
JOIN conversations c ON c.id = m.conversation_id
GROUP BY m.conversation_id
ORDER BY 输入 DESC;

.print
.print 按模型
-- 按模型：调用次数、输入、缓存命中率、输出；输入多的在前
SELECT
  model AS 模型,
  count(*) AS 调用,
  sum(input_tokens) AS 输入,
  round(100.0 * sum(cache_read_tokens)
    / sum(CASE WHEN cache_read_tokens IS NOT NULL THEN input_tokens END), 1) AS 命中率,
  sum(output_tokens) AS 输出
FROM model_calls
GROUP BY model
ORDER BY 输入 DESC;

.print
.print 最近的失败
-- 最近 20 次失败（本地时区）：时间、会话标题、用途、错误、请求次数。
-- 错误为「APICallError 200」表示服务端已经开始返回后连接中断
SELECT
  datetime(m.started_at, 'localtime') AS 时间,
  c.title AS 标题,
  m.purpose AS 用途,
  m.error AS 错误,
  m.attempts AS 请求
FROM model_calls m
JOIN conversations c ON c.id = m.conversation_id
WHERE m.outcome = 'failed'
ORDER BY m.started_at DESC
LIMIT 20;
