import { describe, expect, it } from 'vitest';
import { richMessage, type InputRichBlock } from './rich.js';

describe('一条富文本消息', () => {
  const blocks: InputRichBlock[] = [
    { type: 'heading', text: '标题', size: 2 },
    { type: 'paragraph', text: ['答案是 ', { type: 'bold', text: '4' }] },
  ];

  it('没有尾部：就是这些块', () => {
    expect(richMessage(blocks)).toEqual({ blocks });
  });

  it('带尾部：块的最后加分隔线和下标包着尾部的段落', () => {
    const footer = '输入 5k · 输出 135 · 3.2s';

    expect(richMessage(blocks, footer)).toEqual({
      blocks: [
        ...blocks,
        { type: 'divider' },
        { type: 'paragraph', text: { type: 'subscript', text: footer } },
      ],
    });
  });
});
