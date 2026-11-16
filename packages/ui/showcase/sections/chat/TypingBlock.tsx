import { ChatBubble, ChatTyping } from '../../../src/chat';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「打字的三个点」一块，加「写死的中文可以换」：labels 只写要换的几条 */
export function TypingBlock() {
  return (
    <Group id="chat-typing" title="打字的三个点" sub="ChatTyping · labels">
      <p className="sc-note">
        <code>ChatTyping</code>{' '}
        是「正在回复」：助手的气泡里三个点（和有内容的气泡一样是毛玻璃）。库里写死的中文（「思考中…」「复制」「图片已丢失」「排队中」……）都是默认值，用{' '}
        <code>labels</code> 只写要换的几条；右边那条换成了英文。
      </p>
      <Stage kind="sky">
        <div className="sc-chat-list" data-demo="chat-typing">
          <div className="sc-chat-col">
            <ChatTyping side="start" name="洛璃" />
          </div>
          <div className="sc-chat-col">
            <ChatTyping side="end" name="Nori" label="typing" labels={{ typing: 'Replying' }} />
          </div>
          <div className="sc-chat-col">
            <ChatBubble
              role="assistant"
              side="start"
              name="Nori"
              label="11:20"
              abortMark="(stopped)"
              isNew={false}
              labels={{
                thought: (s) => `Thought for ${s}s`,
                params: 'Input',
                result: (n) => `Result · ${n} chars`,
                imageLost: 'Image missing',
                copy: 'Copy',
                copied: 'Copied',
              }}
              parts={[
                { kind: 'think', text: 'Check the weather first.', sec: 2, streaming: false },
                {
                  kind: 'tool',
                  name: 'fetch',
                  label: 'example.com',
                  state: 'ok',
                  input: { url: 'https://example.com' },
                  ms: 900,
                  outText: 'Example Domain',
                  chars: 14,
                  images: [],
                },
                { kind: 'image', info: null },
                { kind: 'text', text: 'Sunny.\n\n```\nnpm run build\n```' },
              ]}
            />
          </div>
        </div>
      </Stage>
    </Group>
  );
}
