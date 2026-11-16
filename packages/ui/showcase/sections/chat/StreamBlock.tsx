import { useEffect, useRef, useState } from 'react';
import { Button, Switch } from '../../../src/controls';
import { ChatBubble, ChatMentions } from '../../../src/chat';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';
import { STREAM_TEXT } from './samples';

/* 「逐字输出」一块：按时间一批批到的假的流。到的字排成一条，每个字各自从上方落下，金色小星光标紧贴最后出现的字；
   结束后先落完剩下的字，光标停一阵再淡出（onRevealed 是最后一个字出现的那一刻，用的项目在那里放特效）。关掉动画时不落下，到了就显示 */
const BATCH_MS = 260;

export function StreamBlock() {
  const [round, setRound] = useState(0);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(true);
  const [linger, setLinger] = useState(0);
  const [paused, setPaused] = useState(false);
  const [fast, setFast] = useState(false);
  const [note, setNote] = useState('');
  const pausedRef = useRef(false);
  const fastRef = useRef(false);
  pausedRef.current = paused;
  fastRef.current = fast;
  // 每次重放：从头来，每批 3 到 12 个字（关掉「慢」时一批多一些，字来得快、落得靠后的追上去）
  useEffect(() => {
    let at = 0;
    setText('');
    setStreaming(true);
    setLinger(0);
    setNote('');
    const id = setInterval(() => {
      if (pausedRef.current) return;
      at = Math.min(
        STREAM_TEXT.length,
        at + (fastRef.current ? 14 + (at % 9) : 3 + ((at * 7) % 10)),
      );
      setText(STREAM_TEXT.slice(0, at));
      if (at >= STREAM_TEXT.length) {
        clearInterval(id);
        setLinger(Date.now() + 2000);
        setStreaming(false);
      }
    }, BATCH_MS);
    return () => clearInterval(id);
  }, [round]);
  const replay = () => {
    setPaused(false);
    setRound((r) => r + 1);
  };
  return (
    <Group id="chat-stream" title="逐字输出" sub="Typed · Cursor · live">
      <p className="sc-note">
        <code>ChatBubble</code> 的 <code>live</code> 给了就逐字：<code>streamId</code>
        、是否还在流、结束后光标停留到哪一刻（<code>lingerUntil</code>
        ）、最后一个字出现时的回调（<code>onRevealed</code>
        ）。没写完的加粗、行内代码、链接一出现就按排好的样子显示，符号不露出来；回复结束后光标停一会儿淡出，前后排版一致。
        下面的流每 {BATCH_MS} 毫秒到一批字，能暂停、能重放。
      </p>
      <div className="sc-pill-row sc-chat-ctl">
        <Button data-demo="stream-replay" onClick={replay}>
          重放
        </Button>
        <Button
          data-demo="stream-pause"
          variant="ghost"
          disabled={!streaming}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? '继续' : '暂停'}
        </Button>
        <Switch checked={fast} onChange={setFast} label="每批多来一些字（下次重放生效）" />
        <span className="sc-note" data-demo="stream-state">
          {streaming ? (paused ? '已暂停' : '正在流') : '已结束'}
          {note && ` · ${note}`}
        </span>
      </div>
      <ChatMentions value={{ name: '洛璃', wakeWords: ['nori'] }}>
        <Stage kind="sky">
          <div className="sc-chat-col sc-chat-wide" data-demo="chat-stream">
            <ChatBubble
              key={round}
              role="assistant"
              side="start"
              name="洛璃"
              label={streaming ? '正在回复' : '11:20'}
              parts={[{ kind: 'text', text }]}
              abortMark="（已中止）"
              isNew={false}
              live={{
                streamId: `sc-stream-${round}`,
                streaming,
                lingerUntil: linger,
                onRevealed: () => setNote('最后一个字出现了（onRevealed）'),
              }}
            />
          </div>
        </Stage>
      </ChatMentions>
    </Group>
  );
}
