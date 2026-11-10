import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { StreamText } from './stream';

/* 对话气泡里正在逐字出的正文：命令式的小岛（每个字各自落下），出完后光标再停一会儿（lingerUntil 之前），淡出，换成静态的 Markdown（洛璃的回复） */
export function LiveText({
  convId,
  text,
  streaming,
  lingerUntil,
}: {
  convId: string;
  text: string;
  streaming: boolean;
  lingerUntil: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const st = useRef<StreamText | null>(null);
  const [done, setDone] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    st.current = new StreamText(el, text, convId);
    return () => {
      st.current = null;
      el.textContent = '';
    };
  }, []);
  /* 新的字：落下 */
  const len = useRef(Array.from(text).length);
  useEffect(() => {
    const cs = Array.from(text);
    if (st.current && cs.length > len.current) {
      st.current.delta(cs.slice(len.current).join(''), text);
      len.current = cs.length;
    }
  }, [text]);
  /* 流结束：光标停一会儿（中止、出错 .3 秒，正常 2 秒），淡出，换成静态 */
  useEffect(() => {
    if (streaming || !st.current) return;
    const wait = Math.max(0, lingerUntil - Date.now());
    const c = st.current.finish(wait, 520, () => setDone(true));
    return c;
  }, [streaming, lingerUntil]);
  /* 两个分支要有不同的 key：React 看两个都是同一位置的 span 会复用同一个节点，StreamText 命令式插进去的逐字节点（.ch）还留在里面，
     换成静态文字时就追加在后面，正文出现两份。有了 key 就整个换掉 */
  if (done) return <Markdown key="static" text={text} hits={false} />;
  return <span key="stream" ref={ref} style={{ whiteSpace: 'pre-wrap' }} />;
}
