import { ChatBubble, ChatMentions } from '../../../src/chat';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';
import { MD_SAMPLE } from './samples';

/* 「Markdown 和高亮」一块：助手的回复按 Markdown 画（不用 marked 的 HTML 输出）；别人、自己发的消息不按 Markdown，原样文字，只高亮数字、网址和提到助手 */
export function MarkdownBlock() {
  return (
    <Group id="chat-md" title="Markdown 和高亮" sub="Markdown · Hl">
      <p className="sc-note">
        助手的回复：加粗、斜体、删除线、行内代码、代码块（右上角「复制」）、列表、引用、标题（显示成加粗稍大一号的一行）、表格、分隔线、链接（新标签页打开，悬停显示网址）；
        原始 HTML
        当文字，图片不加载。别人、自己发的消息原样显示，高亮数字、网址，以及「提到助手」（名字、唤醒词、bot
        的用户名，由根上的 <code>&lt;ChatMentions value&gt;</code>{' '}
        给；不放就不高亮「提到」，别的高亮照常）。
      </p>
      <ChatMentions value={{ name: '洛璃', wakeWords: ['nori'], username: 'luoli_bot' }}>
        <Stage kind="sky">
          <div className="sc-chat-list" data-demo="chat-md">
            <div className="sc-chat-col">
              <ChatBubble
                role="assistant"
                side="start"
                name="洛璃"
                label="11:20"
                parts={[{ kind: 'text', text: MD_SAMPLE }]}
                abortMark="（已中止）"
                isNew={false}
              />
            </div>
            <div className="sc-chat-col">
              <ChatBubble
                role="other"
                side="start"
                name="星河"
                colorKey="u-1001"
                label="11:21"
                parts={[
                  {
                    kind: 'text',
                    text: '@洛璃 帮我看看 https://example.com/m42 周六 3 点 2000 元 **不加粗**，nori 你觉得呢 @luoli_bot',
                  },
                ]}
                abortMark="（已中止）"
                isNew={false}
              />
            </div>
          </div>
        </Stage>
      </ChatMentions>
    </Group>
  );
}
