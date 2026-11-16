import { createContext } from 'react';
import type { ChatMentionsValue } from './types';

/* 「提到助手」的高亮要认的名字（助手的显示名、唤醒词、bot 的 @用户名）。用的项目在根上放一次：
   <ChatMentions value={{ name, wakeWords, username }}>…</ChatMentions>；值换了（名字、唤醒词变了），里面的正文跟着重新高亮。
   不放就不高亮「提到」，网址、@某人、引号、数字的高亮照常。库不存储：值由用的项目管。 */
export const ChatMentions = createContext<ChatMentionsValue | null>(null);
