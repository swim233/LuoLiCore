import { describe, expect, it } from 'vitest';
import { markdownBlocks } from './markdown.js';
import type { InputRichBlock } from './rich.js';
import {
  readRichMessage,
  type ReceivedRichText,
  type RichBlock,
  type RichBlockListItem,
  type RichBlockTableCell,
} from './rich-received.js';

/** 一条富文本消息转成的文字，照片的位置写「[图片]」 */
const md = (...blocks: RichBlock[]) => readRichMessage({ blocks }).text(() => '[图片]');

describe('块', () => {
  it('段落、标题 1 到 6 级（size 越界的限在范围里）、分隔线、页脚块；顶层的块之间隔一个空行', () => {
    expect(
      md(
        { type: 'paragraph', text: '第一段' },
        { type: 'heading', text: '大标题', size: 1 },
        { type: 'heading', text: '小标题', size: 6 },
        { type: 'divider' },
        { type: 'paragraph', text: '第一行\n第二行' },
        { type: 'footer', text: '页脚' },
      ),
    ).toBe('第一段\n\n# 大标题\n\n###### 小标题\n\n---\n\n第一行\n第二行\n\n页脚');
    expect(md({ type: 'heading', text: '二', size: 2 })).toBe('## 二');
    expect(md({ type: 'heading', text: '越界', size: 0 })).toBe('# 越界');
    expect(md({ type: 'heading', text: '越界', size: 9 })).toBe('###### 越界');
  });

  it('代码块：有语言的写在围栏后面；里面有三个反引号时围栏更长；文字只取字', () => {
    expect(md({ type: 'pre', text: 'print(1)\nprint(2)', language: 'python' })).toBe(
      '```python\nprint(1)\nprint(2)\n```',
    );
    expect(md({ type: 'pre', text: 'a **b**' })).toBe('```\na **b**\n```');
    expect(md({ type: 'pre', text: '```js\nx\n```' })).toBe('````\n```js\nx\n```\n````');
    expect(md({ type: 'pre', text: ['a ', { type: 'bold', text: 'b' }] })).toBe('```\na b\n```');
    // 语言里的反引号、换行去掉，免得围栏失效
    expect(md({ type: 'pre', text: 'x', language: 'py`th\non' })).toBe('```python\nx\n```');
  });

  describe('列表', () => {
    const item = (
      text: ReceivedRichText,
      more: Partial<RichBlockListItem> = {},
    ): RichBlockListItem => ({
      label: '•',
      blocks: [{ type: 'paragraph', text }],
      ...more,
    });

    it('无序的写成「- 」，不用收到的 label', () => {
      expect(md({ type: 'list', items: [item('一'), item('二')] })).toBe('- 一\n- 二');
    });

    it('有序的按 value 写编号（不从 1 开始的；编号是字母、罗马数字的也写成数字）', () => {
      expect(
        md({
          type: 'list',
          items: [
            item('三', { label: '3.', value: 3, type: '1' }),
            item('四', { label: 'iv.', value: 4, type: 'i' }),
          ],
        }),
      ).toBe('3. 三\n4. 四');
    });

    it('任务：勾了的 [x]，没勾的 [ ]', () => {
      expect(
        md({
          type: 'list',
          items: [
            item('做了', { has_checkbox: true, is_checked: true }),
            item('没做', { has_checkbox: true }),
          ],
        }),
      ).toBe('- [x] 做了\n- [ ] 没做');
    });

    it('一项里几个块、套着列表：后面的块缩进到这一项的文字那一列；套着的列表紧跟着，别的块之间空一行', () => {
      expect(
        md({
          type: 'list',
          items: [
            {
              label: '1.',
              value: 1,
              blocks: [
                { type: 'paragraph', text: '第一段' },
                { type: 'paragraph', text: '第二段' },
                { type: 'list', items: [item('里面'), item('里面二')] },
              ],
            },
            {
              label: '10.',
              value: 10,
              blocks: [
                { type: 'paragraph', text: '十' },
                { type: 'pre', text: 'x\n\ny' },
              ],
            },
          ],
        }),
      ).toBe(
        [
          '1. 第一段',
          '',
          '   第二段',
          '   - 里面',
          '   - 里面二',
          '10. 十',
          '',
          '    ```',
          '    x',
          '',
          '    y',
          '    ```',
        ].join('\n'),
      );
    });

    it('任务的项里后面的块：缩进到记号的宽度，不算勾选框（多缩进 4 格就成了代码块）', () => {
      expect(
        md({
          type: 'list',
          items: [
            {
              label: '•',
              has_checkbox: true,
              blocks: [
                { type: 'paragraph', text: '任务' },
                { type: 'list', items: [item('子项')] },
              ],
            },
          ],
        }),
      ).toBe('- [ ] 任务\n  - 子项');
      expect(
        md({
          type: 'list',
          items: [
            {
              label: '3.',
              value: 3,
              has_checkbox: true,
              is_checked: true,
              blocks: [
                { type: 'paragraph', text: '做了' },
                { type: 'paragraph', text: '第二段' },
              ],
            },
          ],
        }),
      ).toBe('3. [x] 做了\n\n   第二段');
    });
  });

  describe('引用', () => {
    it('里面的块每行前面加「> 」，块之间的空行是「>」；有出处时最后加一行「> —— 出处」', () => {
      expect(
        md({
          type: 'blockquote',
          blocks: [
            { type: 'paragraph', text: '第一行\n第二行' },
            { type: 'paragraph', text: '第二段' },
          ],
          credit: ['鲁迅', { type: 'italic', text: '《呐喊》' }],
        }),
      ).toBe('> 第一行\n> 第二行\n>\n> 第二段\n> —— 鲁迅*《呐喊》*');
    });

    it('里面套列表、套引用', () => {
      expect(
        md({
          type: 'blockquote',
          blocks: [
            { type: 'paragraph', text: '清单' },
            {
              type: 'list',
              items: [
                { label: '•', blocks: [{ type: 'paragraph', text: '一' }] },
                { label: '•', blocks: [{ type: 'paragraph', text: '二' }] },
              ],
            },
            { type: 'blockquote', blocks: [{ type: 'paragraph', text: '里面' }] },
          ],
        }),
      ).toBe('> 清单\n>\n> - 一\n> - 二\n>\n> > 里面');
    });

    it('可展开的引用、居中的引用：内容是 text 那一段，出处照样', () => {
      expect(md({ type: 'expandable_blockquote', text: '很长的\n引用' })).toBe('> 很长的\n> 引用');
      expect(md({ type: 'pullquote', text: { type: 'bold', text: '金句' }, credit: '某人' })).toBe(
        '> **金句**\n> —— 某人',
      );
    });
  });

  describe('表格', () => {
    const cell = (
      text: ReceivedRichText | undefined,
      align: RichBlockTableCell['align'] = 'left',
    ): RichBlockTableCell => ({ ...(text === undefined ? {} : { text }), align, valign: 'top' });

    it('第一行是表头；对齐那一行按第一行各格的 align；格子里可以有样式', () => {
      expect(
        md({
          type: 'table',
          cells: [
            [cell('左'), cell('中', 'center'), cell('右', 'right')],
            [cell('1'), cell({ type: 'bold', text: '2' }, 'center'), cell('3', 'right')],
          ],
          is_bordered: true,
        }),
      ).toBe('| 左 | 中 | 右 |\n| --- | :-: | --: |\n| 1 | **2** | 3 |');
    });

    it('格子里的竖线加反斜杠、换行换成空格；没有文字的格子是空的；短的行补空格子；有标题时后面另起一段', () => {
      expect(
        md({
          type: 'table',
          cells: [
            [cell('a|b'), cell('第一行\n第二行')],
            [cell(undefined), cell('x')],
            [cell('只有一格')],
          ],
          caption: '表 1',
        }),
      ).toBe('| a\\|b | 第一行 第二行 |\n| --- | --- |\n|  | x |\n| 只有一格 |  |\n\n表 1');
      // 第一行比后面的短：表头补空格子，对齐是 ---
      expect(md({ type: 'table', cells: [[cell('甲')], [cell('1'), cell('2', 'right')]] })).toBe(
        '| 甲 |  |\n| --- | --- |\n| 1 | 2 |',
      );
    });
  });

  describe('媒体、按钮、详情、拼图', () => {
    const video = { file_id: 'v', file_unique_id: 'v', width: 1, height: 1, duration: 12 };

    it('视频、动图、音频、语音、文件、地图记成占位；说明接在后面，带出处时再接「 —— 出处」', () => {
      expect(
        md(
          { type: 'video', video },
          { type: 'video', video, caption: { text: ['看', { type: 'bold', text: '这个' }] } },
          {
            type: 'animation',
            animation: { file_id: 'a', file_unique_id: 'a', width: 1, height: 1, duration: 3 },
            caption: { text: '动图', credit: '网上' },
          },
          {
            type: 'audio',
            audio: {
              file_id: 'u',
              file_unique_id: 'u',
              duration: 200,
              title: '歌名',
              file_name: 'a.mp3',
            },
          },
          {
            type: 'audio',
            audio: { file_id: 'u', file_unique_id: 'u', duration: 200, file_name: 'a.mp3' },
          },
          { type: 'audio', audio: { file_id: 'u', file_unique_id: 'u', duration: 200 } },
          { type: 'voice_note', voice_note: { file_id: 'o', file_unique_id: 'o', duration: 65 } },
          {
            type: 'document',
            document: { file_id: 'd', file_unique_id: 'd', file_name: '报告.pdf' },
          },
          // 文件是图片也只记占位
          {
            type: 'document',
            document: { file_id: 'd', file_unique_id: 'd', mime_type: 'image/png' },
            caption: { text: '', credit: '出处' },
          },
          {
            type: 'map',
            location: { latitude: 1, longitude: 2 },
            zoom: 13,
            width: 100,
            height: 100,
            caption: { text: '这里' },
          },
        ),
      ).toBe(
        [
          '[视频 0:12]',
          '[视频 0:12] 看**这个**',
          '[GIF] 动图 —— 网上',
          '[音频 歌名]',
          '[音频 a.mp3]',
          '[音频]',
          '[语音 1:05]',
          '[文件 报告.pdf]',
          '[文件] —— 出处',
          '[地图] 这里',
        ].join('\n\n'),
      );
    });

    it('一排按钮：每个 [按钮 上面的字]，空格隔开，写在一行', () => {
      expect(
        md({
          type: 'buttons',
          buttons: [
            { text: '确定', callback_data: 'ok' },
            {
              text: [
                '打开 ',
                { type: 'custom_emoji', custom_emoji_id: '1', alternative_text: '🔗' },
              ],
              url: 'https://a.com',
            },
            // 字是空的
            { text: '', callback_data: 'x' },
          ],
        }),
      ).toBe('[按钮 确定] [按钮 打开 🔗] [按钮]');
    });

    it('详情块：summary 一段，然后是里面的块', () => {
      expect(
        md({
          type: 'details',
          summary: '点开看',
          blocks: [
            { type: 'paragraph', text: '里面一' },
            { type: 'paragraph', text: '里面二' },
          ],
        }),
      ).toBe('点开看\n\n里面一\n\n里面二');
    });

    it('拼图、幻灯片：里面的块照顺序；有说明时后面另起一段', () => {
      expect(
        md(
          {
            type: 'collage',
            blocks: [
              { type: 'video', video },
              { type: 'paragraph', text: '中间' },
            ],
            caption: { text: '拼图的说明', credit: '某人' },
          },
          {
            type: 'slideshow',
            blocks: [
              { type: 'video', video },
              { type: 'video', video },
            ],
          },
        ),
      ).toBe('[视频 0:12]\n\n中间\n\n拼图的说明 —— 某人\n\n[视频 0:12]\n\n[视频 0:12]');
    });

    it('锚点、thinking 不记，也不多出空行', () => {
      expect(
        md(
          { type: 'paragraph', text: '前' },
          { type: 'anchor', name: 'a' },
          { type: 'thinking', text: '正在思考' },
          { type: 'paragraph', text: '后' },
        ),
      ).toBe('前\n\n后');
    });
  });

  it('照片：原来的位置留一行占位，说明接在后面；按出现的顺序编号；引用、拼图里的也算；正文里本来就有的「[图片]」不算', () => {
    const sizes = (id: string) => [
      { file_id: `${id}-小`, file_unique_id: `${id}1`, width: 90, height: 60 },
      { file_id: `${id}-大`, file_unique_id: `${id}2`, width: 1280, height: 853 },
    ];
    const read = readRichMessage({
      blocks: [
        { type: 'paragraph', text: '开头' },
        { type: 'photo', photo: sizes('a') },
        {
          type: 'blockquote',
          blocks: [{ type: 'photo', photo: sizes('b'), caption: { text: '引用里的' } }],
        },
        {
          type: 'collage',
          blocks: [
            { type: 'photo', photo: sizes('c') },
            { type: 'photo', photo: sizes('d'), caption: { text: '第二张\n两行', credit: '某人' } },
          ],
        },
        { type: 'paragraph', text: '正文里本来就有[图片]这几个字' },
      ],
    });
    expect(read.text((index) => `<照片${index}>`)).toBe(
      [
        '开头',
        '<照片0>',
        '> <照片1> 引用里的',
        '<照片2>',
        '<照片3> 第二张\n两行 —— 某人',
        '正文里本来就有[图片]这几个字',
      ].join('\n\n'),
    );
    expect(read.photos).toEqual([sizes('a'), sizes('b'), sizes('c'), sizes('d')]);
  });

  it('块公式：$$、公式、$$ 各占一行', () => {
    expect(md({ type: 'mathematical_expression', expression: 'E = mc^2' })).toBe(
      '$$\nE = mc^2\n$$',
    );
  });
});

describe('行内', () => {
  const para = (text: ReceivedRichText) => md({ type: 'paragraph', text });

  it('加粗、斜体、删除线、行内代码、行内公式，互相套着的；里面是空的就不写', () => {
    expect(
      para([
        { type: 'bold', text: '粗' },
        ' ',
        { type: 'italic', text: '斜' },
        ' ',
        { type: 'strikethrough', text: '删' },
        ' ',
        { type: 'code', text: 'a = 1' },
        ' ',
        { type: 'mathematical_expression', expression: 'x^2' },
      ]),
    ).toBe('**粗** *斜* ~~删~~ `a = 1` $x^2$');
    expect(
      para({
        type: 'bold',
        text: ['粗', { type: 'italic', text: '斜' }, { type: 'strikethrough', text: '删' }],
      }),
    ).toBe('**粗*斜*~~删~~**');
    expect(para(['前', { type: 'bold', text: '' }, { type: 'italic', text: [] }, '后'])).toBe(
      '前后',
    );
  });

  it('行内代码：里面有反引号时用更长的一串包；开头、结尾是反引号时加空格隔开', () => {
    expect(para({ type: 'code', text: 'a`b' })).toBe('``a`b``');
    expect(para({ type: 'code', text: 'a``b`' })).toBe('``` a``b` ```');
    // 行内代码里的样式只取字
    expect(para({ type: 'code', text: ['x', { type: 'bold', text: 'y' }] })).toBe('`xy`');
  });

  it('链接：字和网址不一样时写成链接；字就是网址（只差开头的 http(s):// 和末尾的斜杠）时只写字', () => {
    expect(para({ type: 'url', text: '看这里', url: 'https://example.com/a' })).toBe(
      '[看这里](https://example.com/a)',
    );
    expect(
      para({ type: 'url', text: [{ type: 'bold', text: '粗' }, '体'], url: 'https://a.com/' }),
    ).toBe('[**粗**体](https://a.com/)');
    expect(para({ type: 'url', text: 'https://example.com/a', url: 'https://example.com/a' })).toBe(
      'https://example.com/a',
    );
    expect(para({ type: 'url', text: 'example.com/a', url: 'http://example.com/a' })).toBe(
      'example.com/a',
    );
    expect(para({ type: 'url', text: 'example.com', url: 'https://example.com/' })).toBe(
      'example.com',
    );
    // 网址里有空白：用尖括号包着，免得链接断开
    expect(para({ type: 'url', text: '文件', url: 'https://a.com/my file.pdf' })).toBe(
      '[文件](<https://a.com/my file.pdf>)',
    );
  });

  it('自定义 emoji 取替代字；下划线、剧透、上下标、标记、日期、提到人、话题、邮箱等只留字；锚点不记', () => {
    expect(
      para([
        { type: 'custom_emoji', custom_emoji_id: '1', alternative_text: '😀' },
        { type: 'underline', text: '下' },
        { type: 'spoiler', text: '剧' },
        { type: 'subscript', text: '下标' },
        { type: 'superscript', text: '上标' },
        { type: 'marked', text: '标记' },
        { type: 'date_time', text: '明天', unix_time: 1, date_time_format: 'd' },
        { type: 'mention', text: '@someone', username: 'someone' },
        { type: 'text_mention', text: '小明', user: { id: 7, is_bot: false, first_name: '小明' } },
        { type: 'hashtag', text: '#话题', hashtag: '话题' },
        { type: 'email_address', text: 'a@b.com', email_address: 'a@b.com' },
        { type: 'phone_number', text: '123', phone_number: '123' },
        { type: 'bank_card_number', text: '4242', bank_card_number: '4242' },
        { type: 'ton_address', text: 'EQ', address: 'EQ' },
        { type: 'cashtag', text: '$USD', cashtag: 'USD' },
        { type: 'bot_command', text: '/start', bot_command: 'start' },
        { type: 'anchor_link', text: '跳', anchor_name: 'a' },
        { type: 'reference', text: '注', name: 'r' },
        { type: 'reference_link', text: '[1]', reference_name: 'r' },
        { type: 'anchor', name: 'a' },
      ]),
    ).toBe('😀下剧下标上标标记明天@someone小明#话题a@b.com1234242EQ$USD/start跳注[1]');
    // 只留字时里面的样式照旧
    expect(para({ type: 'spoiler', text: { type: 'bold', text: '粗' } })).toBe('**粗**');
  });

  it('text_mention 提到的人给出用户 id', () => {
    const read = readRichMessage({
      blocks: [
        {
          type: 'paragraph',
          text: [
            {
              type: 'text_mention',
              text: '小明',
              user: { id: 7, is_bot: false, first_name: '小明' },
            },
            '和',
            {
              type: 'text_mention',
              text: '洛璃',
              user: { id: 999, is_bot: true, first_name: 'N' },
            },
          ],
        },
      ],
    });
    expect(read.mentions).toEqual(['7', '999']);
  });

  it('行内的按钮：[按钮 上面的字]', () => {
    expect(para(['点', { type: 'button', button: { text: '确定', callback_data: 'ok' } }])).toBe(
      '点[按钮 确定]',
    );
    // 字是空的
    expect(para(['点', { type: 'button', button: { text: [], callback_data: 'ok' } }])).toBe(
      '点[按钮]',
    );
  });

  it('字里的 Markdown 符号原样留着，不加反斜杠', () => {
    expect(para('*不是斜体* _也不是_ # 也不是标题 [x](y)')).toBe(
      '*不是斜体* _也不是_ # 也不是标题 [x](y)',
    );
  });
});

describe('外面来的数据：不抛错，认识的部分照常', () => {
  /** 故意不合类型的块 */
  const bad = (block: unknown) => block as RichBlock;
  const any = (message: unknown) => readRichMessage(message).text(() => '[图片]');

  it('不认识的块、不认识的行内类型：不记，别处照常', () => {
    expect(
      md(bad({ type: 'hologram', text: '看不见' }), {
        type: 'paragraph',
        text: [
          '前',
          { type: 'sparkle' } as unknown as ReceivedRichText,
          { type: 'glow', text: '亮' } as unknown as ReceivedRichText,
          '后',
        ],
      }),
    ).toBe('前亮后');
  });

  it('缺字段、字段的类型不对：当那一处没有，别处照常', () => {
    expect(
      md(
        bad({ type: 'paragraph' }),
        bad({ type: 'paragraph', text: 42 }),
        // 没有 type、带着字的：和不认识的类型一样只留字
        bad({ type: 'paragraph', text: ['一', 42, null, { text: '三' }, '二'] }),
        bad({ type: 'heading', text: '没有级别' }),
        bad({ type: 'heading', text: '级别是字', size: '3' }),
        bad({ type: 'pre', text: 'x', language: 7 }),
        bad({ type: 'mathematical_expression' }),
        bad({ type: 'list', items: 'x' }),
        bad({
          type: 'list',
          items: [
            null,
            { blocks: 'x' },
            { value: 'x', blocks: [{ type: 'paragraph', text: '项' }] },
          ],
        }),
        bad({ type: 'blockquote', blocks: { type: 'paragraph', text: 'x' } }),
        bad({ type: 'table', cells: [['x'], 'y', [{ text: 5 }, { text: '格' }]] }),
        bad({ type: 'video' }),
        bad({ type: 'audio', audio: { title: 5 } }),
        bad({ type: 'document', document: 'x', caption: 'x' }),
        bad({ type: 'photo', photo: 'x' }),
        bad({ type: 'buttons', buttons: [null, { text: '好' }] }),
        bad({ type: 'paragraph', text: { type: 'url', text: '没有网址' } }),
        bad({ type: 'paragraph', text: { type: 'text_mention', text: '某人', user: 'x' } }),
        bad({ type: 'paragraph', text: { type: 'custom_emoji' } }),
        bad({ type: 'paragraph', text: '最后' }),
      ),
    ).toBe(
      [
        '一三二',
        '# 没有级别',
        '# 级别是字',
        '```\nx\n```',
        '-\n- 项',
        '|  |  |\n| --- | --- |\n|  | 格 |',
        '[视频 0:00]',
        '[音频]',
        '[文件]',
        '[图片]',
        '[按钮 好]',
        '没有网址',
        '某人',
        '最后',
      ].join('\n\n'),
    );
  });

  it('rich_message 不是对象、blocks 不是数组：没有字，也没有照片', () => {
    for (const message of [
      undefined,
      null,
      'x',
      5,
      [],
      {},
      { blocks: 'x' },
      { blocks: [null, 5, 'x'] },
    ]) {
      const read = readRichMessage(message);
      expect({ message, text: read.text(() => '[图片]'), photos: read.photos }).toEqual({
        message,
        text: '',
        photos: [],
      });
    }
    expect(any({ blocks: [{ type: 'paragraph', text: '好' }] })).toBe('好');
  });
});

describe('往返', () => {
  /** 发出去的块收回来的样子：列表项多一个 label（「•」「3.」） */
  const asReceived = (block: InputRichBlock): RichBlock => {
    switch (block.type) {
      case 'list':
        return {
          type: 'list',
          items: block.items.map((item) => ({
            label: item.value === undefined ? '•' : `${item.value}.`,
            ...item,
            blocks: item.blocks.map(asReceived),
          })),
        };
      case 'blockquote':
        return { ...block, blocks: block.blocks.map(asReceived) };
      default:
        return block as RichBlock;
    }
  };

  it('Markdown 用第 5 步转成块、收回来转成文字，再用第 5 步转一次：两次的块一样', () => {
    const original = [
      '## 小结 $x$',
      '',
      '**粗**、*斜*、~~删~~、`码`，[链接](https://example.com/a)，公式 \\(a_1\\)。',
      '',
      '普通的一段',
      '第二行',
      '',
      '3. 第三',
      '4. [x] 做了',
      '5. [ ] 没做',
      '',
      '- 一',
      '  - 一点一',
      '- 二',
      '',
      '> 引用',
      '> - 项',
      '',
      '- [ ] 任务',
      '  - 子项',
      '',
      '  第二段',
      '- [x] 完成',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '| 左 | 中 | 右 |',
      '|:--|:-:|--:|',
      '| 1 | **2** | 3 |',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '---',
      '',
      '结尾',
    ].join('\n');
    const sent = markdownBlocks(original).map((part) => part.block);
    const back = readRichMessage({ blocks: sent.map(asReceived) }).text(() => '[图片]');
    expect(markdownBlocks(back).map((part) => part.block)).toEqual(sent);
  });
});
