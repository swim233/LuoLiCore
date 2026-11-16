import { SectionHead } from '../components/SectionHead';
import { BlocksBlock } from './chat/BlocksBlock';
import { MarkdownBlock } from './chat/MarkdownBlock';
import { RoleBlock } from './chat/RoleBlock';
import { StreamBlock } from './chat/StreamBlock';
import { TypingBlock } from './chat/TypingBlock';

/* 「聊天内容」一节：气泡（角色、靠哪边、各种块、折叠、状态）、Markdown 和正文高亮、打字的三个点、逐字输出和光标（@luoli/ui/chat）。
   样式在单独的一份 @luoli/ui/chat.css，展示页入口另引一次 */
const INDEX: readonly (readonly [string, string])[] = [
  ['chat-role', '角色和靠哪边'],
  ['chat-blocks', '各种块'],
  ['chat-md', 'Markdown 和高亮'],
  ['chat-typing', '打字的三个点'],
  ['chat-stream', '逐字输出'],
];

export function Chat() {
  return (
    <>
      <SectionHead title="聊天内容">
        画聊天内容的几样：气泡（毛玻璃，三种角色、两边）、思考与工具的折叠、图片、Markdown、正文高亮、打字的三个点、逐字输出和光标。入口是{' '}
        <code>@luoli/ui/chat</code>，样式是单独的 <code>@luoli/ui/chat.css</code>
        （放在总样式后面）；纯逻辑的另有不带组件的 <code>@luoli/ui/md</code>
        。库不认识 AI SDK
        的消息，也不认识外壳：补间忙不忙、毛玻璃的另一种做法、助手的名字，都由用的项目传进来。
      </SectionHead>
      <div className="sc-ctl-bar">
        <nav className="sc-ctl-index" aria-label="这一节里的块" data-index="">
          {INDEX.map(([id, name]) => (
            <button
              key={id}
              type="button"
              onClick={() =>
                document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              {name}
            </button>
          ))}
        </nav>
      </div>
      <RoleBlock />
      <BlocksBlock />
      <MarkdownBlock />
      <TypingBlock />
      <StreamBlock />
    </>
  );
}
