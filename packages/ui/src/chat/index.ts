/* @luoli/ui/chat：聊天内容——Markdown、逐字输出和光标、气泡（含思考与工具的折叠）、正文高亮、图片、打字的三个点。
   样式是单独的一份 @luoli/ui/chat.css（不在总样式 styles.css 里，用的项目在入口另引一次，排在 styles.css 后面）。
   库不认识 AI SDK 的消息：气泡只收这里定义的简单结构（types.ts 的 ChatPart……），由用的项目自己把消息变成它们。
   项目要接上的几处：
   - installBubbleFrame({ busy })：气泡外框的补间在大动画（形变、让位……）进行时不补，启动时调一次（和 installWheel({ busy }) 同一个做法）；
   - <ChatMentions value={{ name, wakeWords, username }}>：正文里「提到助手」的高亮要认的名字，在根上放一次，不放就不高亮「提到」；
   - ChatBubble 的 glass：要换毛玻璃的做法时传进来；live.onRevealed：回复正常完成、最后一个字出现时拿到光标（放特效用）。
   入口加载时不碰 DOM（node 里能 import）。纯逻辑的另有一个不带组件的入口 @luoli/ui/md。 */
export { ChatBubble, ChatTyping } from './Bubble';
export type { ChatBubbleProps } from './Bubble';
export { installBubbleFrame } from './bubble-frame';
export type { InstallBubbleFrameOptions } from './bubble-frame';
export { colorOf } from './colors';
export { Hl, hlTokens } from './Hl';
export type { Tok } from './Hl';
export { DEFAULT_LABELS, resolveLabels } from './labels';
export type { ChatLabels } from './labels';
export { Markdown } from './Markdown';
export { plainPreview } from './markdown';
export { ChatMentions } from './mentions';
export { Pic } from './Pic';
export { Cursor, Typed } from './Typed';
export type { CursorRef } from './Typed';
export type {
  ChatEnded,
  ChatGlass,
  ChatImage,
  ChatLive,
  ChatMentionsValue,
  ChatPart,
  ChatRole,
  ChatSide,
} from './types';
