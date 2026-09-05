-- 记忆作用域从「全局单例」改为「按来源」的第一步（docs/03 §2.10）：新增 sources 表与内建
-- telegram 行，并把 memory_docs / memory_revisions 里代表「全局」的旧形态改写成按来源的新形态。
-- 磁盘上的文件搬迁（memory/PUBMEMORY.md 等移到 memory/sources/telegram/ 下）不在这个文件里——
-- 迁移不知道 memory.dir 的实际值，memory_docs.path 列留给启动期的 migrateMemoryLayout() 改写。
--
-- memory_revisions.doc_id 是 memory_docs.id 的外键（连接期 foreign_keys = ON）。四条 UPDATE
-- 中任意一条单独执行都会破坏这条外键：先改 memory_docs.id，旧 doc_id 变成悬空引用；先改
-- memory_revisions.doc_id，新值在 memory_docs 里还不存在。PRAGMA defer_foreign_keys = ON
-- 把校验从「每条语句执行后」推迟到「本迁移事务提交时」，四条 UPDATE 之间不必讲究顺序，
-- 只要求提交那一刻两张表互相对得上。
PRAGMA defer_foreign_keys = ON;

CREATE TABLE sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('telegram','sdk')),
  name TEXT NOT NULL, character_file TEXT, assist_file TEXT,
  created_at INTEGER NOT NULL, disabled_at INTEGER
);
INSERT INTO sources(id,kind,name,created_at) VALUES ('telegram','telegram','Telegram', (strftime('%s','now') * 1000));

-- assist:global / character:global / pubmemory:global 三个来源级文档的历史记录。
-- character 的 per-chat 覆盖行（doc_id 形如 character:<chatId>）不在此列：它们的 doc_id
-- 不以 ':global' 结尾，这条 UPDATE 天然跳过。
UPDATE memory_revisions SET doc_id = replace(doc_id, ':global', ':telegram') WHERE doc_id LIKE '%:global';
-- primemory:<userId> 的历史记录。跟下面 memory_docs 那条 primemory UPDATE 是同一套改写规则，
-- 这里单独写一遍是因为 memory_revisions 没有 subject 列可借，只能从 doc_id 里截出用户段。
-- 这条不加 subject 判断——这张表没有这一列可判。下方 memory_docs 的 primemory UPDATE 加了
-- subject IS NOT NULL 之后，若某个 doc_id 对应的 memory_docs 行 subject 恰好为 NULL
-- （当前写入路径下不可达），两条改写会分别落在不同的字符串上，提交时被 defer_foreign_keys
-- 拦下来，不是静默错位。
UPDATE memory_revisions SET doc_id = 'primemory:telegram:' || substr(doc_id, length('primemory:') + 1) WHERE doc_id LIKE 'primemory:%';

-- 三个来源级 scope：只动 subject 为 NULL 的行（= 迁移前的全局单例）。per-chat 覆盖行的
-- subject 已经是 chatId，不满足 IS NULL，不受影响。
UPDATE memory_docs SET subject = 'telegram', id = scope || ':telegram'
  WHERE scope IN ('assist','character','pubmemory') AND subject IS NULL;
-- primemory：旧 subject 是纯 userId。同一条 UPDATE 里 id 与 subject 两个赋值算的都是这一行
-- 改写前的旧值（SQL UPDATE 的语义），所以改完之后 id 里的用户段与新 subject 仍然对得上。
-- subject IS NOT NULL：拼接遇 NULL 结果整体为 NULL，会把这一行的主键改成 NULL。当前三条
-- 写入 memory_docs 的路径下 primemory 行的 subject 恒非空，这一判断只是防这一列以后出现
-- 意外空值时不去改一行不该改的主键，对现有可达数据的改写结果没有影响。
UPDATE memory_docs SET id = 'primemory:telegram:' || subject, subject = 'telegram:' || subject
  WHERE scope = 'primemory' AND subject IS NOT NULL;
