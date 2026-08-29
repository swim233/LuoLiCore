-- 私聊今后只占 `user:` 一行（docs/05 §2.2）。旧库里每个私聊都还有一行 `chat:<正数 id>`：
-- `upsertSeen` 的 ON CONFLICT 分支刻意不动 role，于是那一行的角色被首见时的 `defaultUserRole`
-- 冻结，「把 user: 提到 trusted 却不生效、必须再改一次 chat:」这个事故就出在它身上。
-- 两条判据取并集：chat_type 是 Telegram 给的权威值，而 `/grant chat <正数>` 写出的行没有它 ——
-- Telegram 群 / 频道 id 恒负，正数即私聊。
DELETE FROM principals WHERE kind='chat' AND (chat_type='private' OR tg_id NOT LIKE '-%');
-- 群 / 频道内的有效角色封顶 trusted，chat 行的 owner 档在全库零效果；留着它只会让界面说谎。
UPDATE principals SET role='trusted' WHERE kind='chat' AND role='owner';
