import { describe, expect, it } from 'vitest';
import { plainRichMessage } from './rich.js';

describe('原样文字做成的富文本消息', () => {
  it('只有一个段落块，文字一字不差：换行留在文字里，Markdown、HTML、公式的符号都不解析', () => {
    const text = [
      '第一行',
      '',
      '**加粗？** _斜体？_ `代码？` ~~删除？~~',
      '<b>标签</b> &amp; 1 < 2',
      '$E = mc^2$ 和 $$x^2$$',
      '- 列表？',
      '# 标题？',
      '  行首的空格与行尾的空格  ',
    ].join('\n');

    expect(plainRichMessage(text)).toEqual({ blocks: [{ type: 'paragraph', text }] });
  });
});
