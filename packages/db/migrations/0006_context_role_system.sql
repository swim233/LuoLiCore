-- AI SDK v7 的 standardizePrompt 直接拒收 messages 里的 system 消息，而 context_messages 是持久化的：
-- 一条 role='system' 的旁白（load_skill 正文、群聊省略提示、上下文重置提示）会让该会话此后每一轮
-- 都以 InvalidPromptError 失败，/new 之前无法恢复（docs/20-review-round5.md · W-CTX-01）。
-- 写入侧已改成 role='user' + origin='note'，这里把库里已有的坏数据一起归位。
UPDATE context_messages SET role='user' WHERE role='system';
