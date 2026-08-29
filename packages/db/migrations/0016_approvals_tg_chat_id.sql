-- 审批按钮改发 owner 私聊之后，回执所在的会话不再等于 approvals.chat_id。后者记的是**发起人
-- 会话**（审计要回答「这次调用发生在哪」），而 tg_message_id 记的是那条带按钮的消息 —— 它现在
-- 落在 owner 私聊里。少这一列的话，重启时 staleKeyboards() 会拿发起人会话 id 配私聊的
-- message_id 去 editMessageText：群里那个 id 上没有这条消息，撤键盘全部 400，
-- 上一次进程留下的那排按钮永远点得动（docs/05 §6.1 那条待办队列就此失效）。
--
-- 可空：本次改动之前写下的行没有这一列，staleKeyboards() 用 COALESCE(tg_chat_id, chat_id)
-- 回落 —— 那些行当初的投递目标正是 chat_id。
ALTER TABLE approvals ADD COLUMN tg_chat_id TEXT;
