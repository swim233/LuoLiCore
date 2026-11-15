import { describe, expect, it } from 'vitest';
import type { TelegramChat, TelegramUser } from '@chat-adapter/telegram';
import {
  duration,
  editedText,
  maxImageDocumentBytes,
  selectPhoto,
  toAppendInput,
  type ImageRef,
} from './content.js';
import { imageBytes, tagOf } from './fake-api.js';
import type { TelegramRaw } from './message.js';
import type { ReceivedRichText, RichBlock } from './rich-received.js';

const group: TelegramChat = { id: -1001, type: 'supergroup', title: '读书会' };
const alice: TelegramUser = { id: 11, is_bot: false, first_name: 'Alice', last_name: 'Liddell' };

function message(fields: Partial<TelegramRaw>): TelegramRaw {
  return { message_id: 7, date: 1793340120, chat: group, from: alice, ...fields };
}

const photo = (id: string, width: number, height: number) => ({
  file_id: id,
  width,
  height,
  file_size: width * height,
});

/**
 * 假下载：内容是 types 里这个 file_id 的类型（默认 jpeg）的图片，带着 file_id；
 * failing 里的下载失败
 */
function downloader({
  failing = [],
  types = {},
}: { failing?: string[]; types?: Record<string, string | Uint8Array> } = {}) {
  const downloads: string[] = [];
  const failures: ImageRef[] = [];
  const rejected: Array<{ image: ImageRef; bytes: number }> = [];
  return {
    downloads,
    failures,
    rejected,
    options: {
      download: async (fileId: string) => {
        downloads.push(fileId);
        if (failing.includes(fileId)) throw new Error('下载失败');
        const type = types[fileId] ?? 'image/jpeg';
        return typeof type === 'string' ? imageBytes(type, fileId) : type;
      },
      onDownloadFailed: (image: ImageRef) => failures.push(image),
      onImageRejected: (image: ImageRef, bytes: number) => rejected.push({ image, bytes }),
    },
  };
}

async function convert(
  raws: TelegramRaw | TelegramRaw[],
  options?: Parameters<typeof downloader>[0],
) {
  const input = await toAppendInput([raws].flat(), downloader(options).options);
  return (
    input && {
      text: input.text,
      files: input.files?.map((file) => ({ mediaType: file.mediaType, fileId: tagOf(file.data) })),
    }
  );
}

describe('Telegram 消息转成核心的输入', () => {
  it('文字消息：发言人 id 与显示名、Telegram 的发送时间、消息 id', async () => {
    const { options } = downloader();
    expect(
      await toAppendInput([message({ text: '你好', date: 1793404920, message_id: 42 })], options),
    ).toEqual({
      author: { id: '11', name: 'Alice Liddell' },
      text: '你好',
      files: [],
      createdAt: '2026-10-31T00:02:00.000Z',
      platformMessageId: '42',
    });
  });

  it('照片：取长边不超过 1280 的最大一档，作为 image/jpeg 附件；说明文字作为正文', async () => {
    const sizes = [
      photo('s', 90, 51),
      photo('m', 320, 180),
      photo('x', 1280, 720),
      photo('y', 2560, 1440),
      photo('l', 800, 450),
    ];
    expect(await convert(message({ photo: sizes, caption: '看这张' }))).toEqual({
      text: '看这张',
      files: [{ mediaType: 'image/jpeg', fileId: 'x' }],
    });
    // 竖图按长边算
    expect(selectPhoto([photo('a', 720, 1280), photo('b', 1080, 1920)]).file_id).toBe('a');
    // 都超过时取最小的一档
    expect(selectPhoto([photo('b', 1600, 1600), photo('a', 1300, 900)]).file_id).toBe('a');
  });

  it('贴纸：静态的作为 webp 图片；动画、视频贴纸记占位，有 emoji 时带上', async () => {
    const sticker = { file_id: 'st', emoji: '😀' };
    expect(await convert(message({ sticker }), { types: { st: 'image/webp' } })).toEqual({
      text: '',
      files: [{ mediaType: 'image/webp', fileId: 'st' }],
    });
    expect(await convert(message({ sticker: { ...sticker, is_animated: true } }))).toEqual({
      text: '[贴纸 😀]',
      files: [],
    });
    expect(await convert(message({ sticker: { file_id: 'st', is_video: true } }))).toEqual({
      text: '[贴纸]',
      files: [],
    });
  });

  it('图片文件：jpeg/png/webp/gif 且不超过 10 MB 的作为图片；其他文件记文件名', async () => {
    const document = (mime_type: string | undefined, file_size?: number, file_name?: string) =>
      message({ document: { file_id: 'doc', mime_type, file_size, file_name } });

    for (const mediaType of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(
        await convert(document(mediaType, maxImageDocumentBytes), { types: { doc: mediaType } }),
      ).toEqual({
        text: '',
        files: [{ mediaType, fileId: 'doc' }],
      });
    }
    expect(await convert(document('image/png', maxImageDocumentBytes + 1, '大图.png'))).toEqual({
      text: '[文件 大图.png]',
      files: [],
    });
    // 核心不支持的图片类型、原型链上的名字都按普通文件
    expect((await convert(document('image/bmp', 10, 'a.bmp')))?.text).toBe('[文件 a.bmp]');
    expect((await convert(document('constructor', 10, 'b')))?.text).toBe('[文件 b]');
    expect((await convert(document('application/pdf', 10, '报告.pdf')))?.text).toBe(
      '[文件 报告.pdf]',
    );
    expect((await convert(document(undefined)))?.text).toBe('[文件]');
  });

  it.each([
    [
      '动图（同时带着 document）',
      {
        animation: { file_id: 'a', duration: 3 },
        document: { file_id: 'a', mime_type: 'image/gif' },
      },
      '[GIF]',
    ],
    ['视频', { video: { file_id: 'v', duration: 65, width: 1, height: 1 } }, '[视频 1:05]'],
    ['视频消息', { video_note: { file_id: 'n', duration: 7 } }, '[视频消息 0:07]'],
    ['语音', { voice: { file_id: 'o', duration: 600 } }, '[语音 10:00]'],
    ['音频（标题）', { audio: { file_id: 'u', title: '晴天', file_name: 'x.mp3' } }, '[音频 晴天]'],
    ['音频（文件名）', { audio: { file_id: 'u', file_name: 'x.mp3' } }, '[音频 x.mp3]'],
    ['音频（都没有）', { audio: { file_id: 'u' } }, '[音频]'],
    ['位置', { location: { latitude: 1, longitude: 2 } }, '[位置]'],
    [
      '地点',
      { venue: { title: '图书馆', address: '某路', location: { latitude: 1, longitude: 2 } } },
      '[位置]',
    ],
    [
      '联系人',
      { contact: { first_name: '小', last_name: '明', phone_number: '123' } },
      '[联系人 小 明]',
    ],
    ['投票', { poll: { id: 'p', question: '周末去哪？' } }, '[投票 周末去哪？]'],
    ['骰子等其他类型', { dice: { emoji: '🎲', value: 3 } }, '[不支持的消息]'],
  ] as Array<[string, Partial<TelegramRaw>, string]>)(
    '%s 记成占位，不下载',
    async (_name, fields, text) => {
      const { options, downloads } = downloader();
      expect((await toAppendInput([message(fields)], options))?.text).toBe(text);
      expect(downloads).toEqual([]);
    },
  );

  it('占位与说明文字各占一行，占位在前', async () => {
    expect(
      await convert(message({ voice: { file_id: 'o', duration: 3 }, caption: '听听这个' })),
    ).toEqual({ text: '[语音 0:03]\n听听这个', files: [] });
  });

  it('服务消息（入群、改群名等）或没有发送者时不记录', async () => {
    expect(await convert(message({ new_chat_title: '新名' }))).toBeUndefined();
    expect(await convert(message({ new_chat_members: [alice] } as never))).toBeUndefined();
    expect(await convert(message({ pinned_message: message({}) } as never))).toBeUndefined();
    expect(await convert(message({ text: '匿名', from: undefined }))).toBeUndefined();
  });

  it('下载失败：记「[图片下载失败]」并报告文件种类与大小；其他图片照常', async () => {
    const { options, failures } = downloader({ failing: ['bad'] });
    const input = await toAppendInput(
      [
        message({ message_id: 1, photo: [photo('bad', 800, 600)], media_group_id: 'g' }),
        message({ message_id: 2, photo: [photo('good', 800, 600)], media_group_id: 'g' }),
      ],
      options,
    );

    expect(input?.text).toBe('[图片下载失败]');
    expect(input?.files?.map((file) => tagOf(file.data))).toEqual(['good']);
    expect(failures).toEqual([
      {
        kind: 'photo',
        fileId: 'bad',
        mediaType: 'image/jpeg',
        size: 800 * 600,
        fallback: '[图片无法读取]',
      },
    ]);
  });

  it('下载到的内容与声明的类型不符（伪造或损坏）：不作为图片；文件记「[文件 名字]」，照片、贴纸记「[图片无法读取]」', async () => {
    const text = new TextEncoder().encode('其实是一段文字');
    const { options, rejected } = downloader({
      types: {
        fake: text,
        'png-as-jpeg': imageBytes('image/png', 'x'),
        sticker: text,
        good: 'image/jpeg',
      },
    });
    const document = (file_id: string, mime_type: string, file_name?: string) =>
      message({ document: { file_id, mime_type, file_name }, caption: 'nori 这是什么' });

    const convertOne = (raw: TelegramRaw) => toAppendInput([raw], options);
    expect(await convertOne(document('fake', 'image/png', 'fake.png'))).toMatchObject({
      text: '[文件 fake.png]\nnori 这是什么',
      files: [],
    });
    expect((await convertOne(document('fake', 'image/gif')))?.text).toBe('[文件]\nnori 这是什么');
    expect(
      (await convertOne(message({ photo: [photo('png-as-jpeg', 8, 8)], caption: '看图' })))?.text,
    ).toBe('[图片无法读取]\n看图');
    expect(
      (await convertOne(message({ sticker: { file_id: 'sticker', emoji: '😀' } })))?.text,
    ).toBe('[图片无法读取]');
    // 相册里只换掉坏的那一张
    const album = await toAppendInput(
      [
        message({ message_id: 1, photo: [photo('good', 8, 8)], caption: '两张' }),
        document('fake', 'image/png', 'b.png'),
      ],
      options,
    );
    expect(album?.text).toBe('[文件 b.png]\n两张');
    expect(album?.files?.map((file) => tagOf(file.data))).toEqual(['good']);

    expect(rejected.map(({ image, bytes }) => [image.kind, bytes])).toEqual([
      ['document', text.length],
      ['document', text.length],
      ['photo', imageBytes('image/png', 'x').length],
      ['sticker', text.length],
      ['document', text.length],
    ]);
  });

  it('相册合成一条：附件按原顺序，说明文字取有说明的那一条，发言人、时间与消息 id 取第一条', async () => {
    const { options } = downloader({ types: { p2: 'image/png' } });
    const album = [
      message({ message_id: 31, date: 1793340120, photo: [photo('p1', 800, 600)] }),
      message({
        message_id: 32,
        date: 1793340121,
        document: { file_id: 'p2', mime_type: 'image/png' },
        caption: '旅行照片',
      }),
      message({ message_id: 33, date: 1793340122, video: { file_id: 'v', duration: 12 } as never }),
      message({ message_id: 34, date: 1793340122, photo: [photo('p3', 800, 600)] }),
    ];

    const input = await toAppendInput(album, options);

    expect(input).toMatchObject({
      author: { id: '11', name: 'Alice Liddell' },
      text: '[视频 0:12]\n旅行照片',
      createdAt: new Date(1793340120 * 1000).toISOString(),
      platformMessageId: '31',
    });
    expect(input?.files?.map((file) => [file.mediaType, tagOf(file.data)])).toEqual([
      ['image/jpeg', 'p1'],
      ['image/png', 'p2'],
      ['image/jpeg', 'p3'],
    ]);
  });

  it('编辑后的正文：占位加新的文字或说明文字，不下载', () => {
    expect(editedText(message({ text: '改过的' }))).toBe('改过的');
    expect(editedText(message({ photo: [photo('p', 800, 600)], caption: '新说明' }))).toBe(
      '新说明',
    );
    expect(editedText(message({ voice: { file_id: 'o', duration: 3 }, caption: '新说明' }))).toBe(
      '[语音 0:03]\n新说明',
    );
    expect(editedText(message({ photo: [photo('p', 800, 600)] }))).toBe('');
  });

  it('时长写成 m:ss', () => {
    expect([duration(0), duration(9), duration(65), duration(3600), duration()]).toEqual([
      '0:00',
      '0:09',
      '1:05',
      '60:00',
      '0:00',
    ]);
  });
});

describe('富文本消息转成核心的输入', () => {
  /** 一条富文本消息（适配器的类型比文档旧，这里照文档写） */
  const rich = (...blocks: RichBlock[]) =>
    message({ rich_message: { blocks } as unknown as TelegramRaw['rich_message'] });
  const photoBlock = (id: string, caption?: string): RichBlock => ({
    type: 'photo',
    photo: [photo(`${id}-小`, 90, 60), photo(id, 1280, 853), photo(`${id}-大`, 2560, 1706)],
    ...(caption ? { caption: { text: caption } } : {}),
  });

  it('记成转出来的文字；发言人、Telegram 的发送时间、消息 id 照常', async () => {
    const { options } = downloader();
    expect(
      await toAppendInput(
        [
          {
            ...rich(
              { type: 'heading', text: '标题', size: 2 },
              { type: 'paragraph', text: ['nori ', { type: 'bold', text: '看看' }] },
            ),
            date: 1793404920,
            message_id: 42,
          },
        ],
        options,
      ),
    ).toEqual({
      author: { id: '11', name: 'Alice Liddell' },
      text: '## 标题\n\nnori **看看**',
      files: [],
      createdAt: '2026-10-31T00:02:00.000Z',
      platformMessageId: '42',
    });
  });

  it('照片：下载长边不超过 1280 的那一档作为附件，顺序和文字里的占位一致；说明接在占位后面', async () => {
    expect(
      await convert(
        rich(
          { type: 'paragraph', text: '前' },
          photoBlock('p1', '第一张'),
          { type: 'blockquote', blocks: [photoBlock('p2')] },
          { type: 'collage', blocks: [photoBlock('p3'), photoBlock('p4', '最后')] },
        ),
      ),
    ).toEqual({
      text: '前\n\n[图片] 第一张\n\n> [图片]\n\n[图片]\n\n[图片] 最后',
      files: ['p1', 'p2', 'p3', 'p4'].map((fileId) => ({ mediaType: 'image/jpeg', fileId })),
    });
  });

  it('12 张照片：只下载前 10 张，后两张只有占位', async () => {
    const { options, downloads } = downloader();
    const ids = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
    const input = await toAppendInput([rich(...ids.map((id) => photoBlock(id, id)))], options);
    expect(downloads).toEqual(ids.slice(0, 10));
    expect(input?.files.map((file) => tagOf(file.data))).toEqual(ids.slice(0, 10));
    expect(input?.text).toBe(ids.map((id) => `[图片] ${id}`).join('\n\n'));
  });

  it('下载失败、不是图片的：那个位置是对应的占位，说明照样带着，报告种类与大小；别的照常；正文里本来就有的「[图片]」不被改', async () => {
    const { options, failures, rejected } = downloader({
      failing: ['bad'],
      types: { fake: new TextEncoder().encode('其实是文字') },
    });
    const input = await toAppendInput(
      [
        rich(
          { type: 'paragraph', text: '[图片]是正文里的字' },
          photoBlock('bad', '坏的'),
          photoBlock('good'),
          photoBlock('fake', '假的'),
          { type: 'paragraph', text: '[图片下载失败]也是字' },
        ),
      ],
      options,
    );
    expect(input?.text).toBe(
      [
        '[图片]是正文里的字',
        '[图片下载失败] 坏的',
        '[图片]',
        '[图片无法读取] 假的',
        '[图片下载失败]也是字',
      ].join('\n\n'),
    );
    expect(input?.files.map((file) => tagOf(file.data))).toEqual(['good']);
    expect(failures.map((image) => [image.kind, image.fileId, image.size])).toEqual([
      ['photo', 'bad', 1280 * 853],
    ]);
    expect(rejected.map(({ image, bytes }) => [image.kind, image.fileId, bytes])).toEqual([
      ['photo', 'fake', new TextEncoder().encode('其实是文字').length],
    ]);
  });

  it('没有字也没有照片（比如只有锚点）：「[不支持的消息]」', async () => {
    expect(await convert(rich({ type: 'anchor', name: 'a' }))).toEqual({
      text: '[不支持的消息]',
      files: [],
    });
    expect(await convert(rich({ type: 'paragraph', text: '  \n ' }))).toEqual({
      text: '[不支持的消息]',
      files: [],
    });
  });

  it('转换出错（套了十万层）：「[不支持的消息]」，报告一次', async () => {
    let deep: unknown = '最里面';
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const errors: unknown[] = [];
    const { options } = downloader();
    const input = await toAppendInput(
      [rich({ type: 'paragraph', text: deep as ReceivedRichText })],
      { ...options, onRichUnreadable: (error) => errors.push(error) },
    );
    expect(input?.text).toBe('[不支持的消息]');
    expect(errors).toHaveLength(1);
  });

  it('编辑后的正文：新转出来的文字，照片的位置一律写「[图片]」，不下载', () => {
    expect(editedText(rich({ type: 'paragraph', text: '改过的' }, photoBlock('p', '说明')))).toBe(
      '改过的\n\n[图片] 说明',
    );
  });
});
