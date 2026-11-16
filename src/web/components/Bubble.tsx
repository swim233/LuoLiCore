import { createContext, memo, useContext, useLayoutEffect, useRef } from 'react';
import { ChatBubble } from '@luoli/ui/chat';
import type { ChatBubbleProps } from '@luoli/ui/chat';
import { attachBubbleSky } from './bubble-sky';
import { useGlassMode } from '../lib/glass';

/* 聊天气泡本身在库里（@luoli/ui/chat 的 ChatBubble）；这里是面板的一层：把「毛玻璃的做法」接上去。
   毛玻璃有两种做法（lib/glass.ts 里说了选哪种；样式在库的 chat/bubble.css 和 app.css 的「预先糊好的气泡星空」）：
   - 实时模糊（默认，正式页面里一律用它）：气泡自己 backdrop-filter（库的 .ll-bubble[data-blur]），不垫那一层、不渲染那个元素，也没有对位的脚本在跑；
   - 预先糊好：气泡里垫一层星空（.bubble-sky，经库的 glass.layer 放进气泡里第一个子元素的位置），位置的对齐见 bubble-sky.ts。
     正式页面里只有下面 BakedGlass 的那一处用到它，另外开发模式的演示控制面板里能整个切过去（用来对比和验收）。
   每个气泡自己订阅这个选择，切换时当场换（同一次提交里换掉那个元素、挂上或摘掉对位）。
   「正在回复」的气泡（sessions/Timeline.tsx 的 TypingView）也用它，和有内容的气泡一样糊。
   实时模糊有个限制：气泡的祖先（窗口那层星空以内、气泡以外）带 opacity < 1 时，气泡拿不到窗口的星空，模糊没有了，那层淡完的一瞬又突然糊上。
   气泡自己的出现动画已经放在气泡自己身上（库的 ll-msg-in-*），会话窗口里列表和时间线两层的切换动画（sessions/Sessions.tsx）是整层在淡入淡出，
   没法放到气泡上：那一层在动的时候给里面的气泡一个 BakedGlass 的 context，它们暂时按「预先糊好」画（淡入淡出和整层一起，没有这个限制），
   动画放完换回实时模糊（两种做法逐像素比过，换的这一下平均色差不到 1） */
export const BakedGlass = createContext(false);
export function useGlass() {
  const wantsBlur = useGlassMode() === 'live';
  const forcedBaked = useContext(BakedGlass);
  const blur = wantsBlur && !forcedBaked;
  const sky = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!blur && sky.current) return attachBubbleSky(sky.current);
  }, [blur]);
  return {
    /** 实时模糊：库的气泡带 data-blur，自己糊 */
    blur,
    /** 气泡里的第一个子元素：预先糊好时是那层星空，实时模糊时没有 */
    layer: blur ? null : <span className="bubble-sky" ref={sky} aria-hidden="true" />,
  };
}

/** 一条消息：库的气泡加上面板的毛玻璃做法（四处调用各自传角色 role 和靠哪边 side） */
export const MsgBubble = memo(function MsgBubble(props: Omit<ChatBubbleProps, 'glass'>) {
  const glass = useGlass();
  return <ChatBubble {...props} glass={glass} />;
});
