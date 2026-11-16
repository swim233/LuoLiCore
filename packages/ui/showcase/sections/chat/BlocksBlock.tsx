import { ChatBubble, ChatMentions } from '../../../src/chat';
import type { ChatBubbleProps, ChatPart } from '../../../src/chat';
import { Button } from '../../../src/controls';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';
import { pic } from './samples';

/* 「各种块」一块：一条消息是按先后排的块——文字、图片（连着的并成一排）、思考、工具调用，加上排队中、中止、出错这几种状态 */
const LONG_THINK = Array.from(
  { length: 14 },
  (_, i) => `第 ${i + 1} 步：先想想周末的天气和路程，再看看大家的时间。`,
).join('\n');

type Item = [string, Partial<ChatBubbleProps> & { parts: ChatPart[] }];

const ITEMS: Item[] = [
  [
    '文字和图片',
    {
      role: 'assistant',
      parts: [
        { kind: 'text', text: '这是上次拍的两张，第三张文件已经不在了：' },
        { kind: 'image', info: pic(200, 280), name: '月亮.jpg' },
        { kind: 'image', info: pic(30, 330, 200, 300), name: '星云.jpg' },
        { kind: 'image', info: null, name: '丢了.jpg' },
      ],
    },
  ],
  [
    '思考（结束，展开能看内容；里面的滚轮缓动）',
    {
      role: 'assistant',
      parts: [
        { kind: 'think', text: LONG_THINK, sec: 3, streaming: false },
        { kind: 'text', text: '想好了，周六去。' },
      ],
    },
  ],
  [
    '思考中（还没有文字）',
    {
      role: 'assistant',
      label: '正在回复',
      parts: [{ kind: 'think', text: '先看看大家什么时候有空……', streaming: true }],
    },
  ],
  [
    '工具：成功（带图）、调用中、出错',
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          name: 'fetch',
          label: 'example.com/m42 · 猎户座大星云 M42',
          state: 'ok',
          input: { url: 'https://example.com/m42', mode: 'article' },
          ms: 1500,
          outText: '# 猎户座大星云\n\n距离地球约 1344 光年，冬天能用肉眼看到。',
          chars: 4210,
          truncated: true,
          images: [pic(320, 40, 240, 160)],
        },
        {
          kind: 'tool',
          name: 'fetch',
          label: 'example.com/slow',
          state: 'running',
          input: { url: 'https://example.com/slow' },
          images: [],
        },
        {
          kind: 'tool',
          name: 'fetch',
          label: 'example.com/404',
          state: 'error',
          input: { url: 'https://example.com/404' },
          ms: 800,
          errorText: '抓取失败：HTTP 404',
          images: [],
        },
        { kind: 'text', text: '前两个能看，第三个页面不存在。' },
      ],
    },
  ],
  [
    '排队中（生成中又发的消息，还没被回复看到）',
    {
      role: 'self',
      side: 'end',
      name: '月亮不睡',
      queued: true,
      parts: [{ kind: 'text', text: '对了，再帮我查一下天气' }],
    },
  ],
  [
    '中止（半截回复，末尾有标记）',
    {
      role: 'assistant',
      aborted: true,
      parts: [{ kind: 'text', text: '好的，周六上午去植物园，下午' }],
    },
  ],
  [
    '出错（中断，气泡下面放重试）',
    {
      role: 'assistant',
      failed: true,
      parts: [
        { kind: 'think', text: '', streaming: true },
        { kind: 'text', text: '我看看哦，周六上午' },
      ],
      below: (
        <Button size="sm" variant="ghost">
          重试
        </Button>
      ),
    },
  ],
];

export function BlocksBlock() {
  return (
    <Group id="chat-blocks" title="各种块" sub="ChatPart · think / tool / image">
      <p className="sc-note">
        块的结构在 <code>@luoli/ui/chat</code> 的 <code>ChatPart</code>
        ：库不认识 AI SDK 的消息，由用的项目把自己的消息变成它们。工具那一行写什么（
        <code>label</code>
        ）由用的项目算好，库不认识参数。折叠展开收起时，气泡的外框跟着内容平滑变大变小。
      </p>
      <ChatMentions value={{ name: '洛璃', wakeWords: ['nori'] }}>
        <Stage kind="sky">
          <div className="sc-chat-list" data-demo="chat-blocks">
            {ITEMS.map(([title, p], i) => (
              <div className="sc-chat-item" key={title}>
                <div className="sc-chat-cap">{title}</div>
                <div className="sc-chat-col">
                  <ChatBubble
                    role="assistant"
                    side="start"
                    name="洛璃"
                    colorKey="u-1001"
                    label="11:20"
                    abortMark="（已中止）"
                    isNew={false}
                    {...p}
                    key={i}
                  />
                </div>
              </div>
            ))}
          </div>
        </Stage>
      </ChatMentions>
    </Group>
  );
}
