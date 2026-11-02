import { describe, expect, it } from 'vitest';
import {
  createConversation,
  createMemoryFileStore,
  createMemoryStorage,
  editMessage,
  isSupportedMediaType,
} from './index.js';
import { MockLanguageModelV4 } from 'ai/test';
import { testPrompts } from './test-prompts.js';

const alice = { id: 'u-alice', name: 'Alice' };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function setup() {
  const storage = createMemoryStorage();
  const store = await storage.openConversation(
    await storage.createConversation({ platform: 'telegram' }),
  );
  const conversation = createConversation({
    model: new MockLanguageModelV4(),
    prompts: testPrompts('你是测试助手'),
    store,
    fileStore: createMemoryFileStore(),
  });
  return { store, conversation };
}

describe('编辑消息', () => {
  it('按平台消息 id 找到消息：正文换掉，图片不变，记 editedAt，其他 metadata 不变', async () => {
    const { store, conversation } = await setup();
    await conversation.append({
      author: alice,
      text: '原来的说明',
      files: [{ data: png, mediaType: 'image/png' }],
      createdAt: '2026-10-30T12:00:00.000Z',
      platformMessageId: '42',
    });
    const [before] = await store.list();

    const edited = await editMessage(store, {
      platformMessageId: '42',
      text: '改过的说明',
      editedAt: '2026-10-30T12:05:00.000Z',
    });

    const [after] = await store.list();
    expect(after).toEqual(edited);
    expect(after).toEqual({
      ...before,
      metadata: { ...before!.metadata, editedAt: '2026-10-30T12:05:00.000Z' },
      parts: [{ type: 'text', text: '改过的说明' }, before!.parts[1]],
    });
  });

  it('有图片时新正文为空就去掉文字；没有图片时保留一个空的文字部分（与 append 一致）', async () => {
    const { store, conversation } = await setup();
    await conversation.append({
      author: alice,
      text: '图片说明',
      files: [{ data: png, mediaType: 'image/png' }],
      platformMessageId: '1',
    });
    await conversation.append({ author: alice, text: '文字', platformMessageId: '2' });

    await editMessage(store, { platformMessageId: '1', text: '', editedAt: 'x' });
    await editMessage(store, { platformMessageId: '2', text: '', editedAt: 'x' });

    expect((await store.list()).map((m) => m.parts.map((part) => part.type))).toEqual([
      ['file'],
      ['text'],
    ]);
  });

  it('找不到这条消息：返回 undefined，历史不变', async () => {
    const { store, conversation } = await setup();
    await conversation.append({ author: alice, text: '你好', platformMessageId: '1' });
    const before = await store.list();

    expect(
      await editMessage(store, { platformMessageId: '404', text: '改', editedAt: 'x' }),
    ).toBeUndefined();
    expect(await store.list()).toEqual(before);
  });
});

describe('支持的图片类型', () => {
  it('jpeg/png/webp/gif；其他类型与原型链上的名字都不算', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(isSupportedMediaType(type)).toBe(true);
    }
    for (const type of ['image/bmp', 'application/pdf', 'constructor', 'toString', '']) {
      expect(isSupportedMediaType(type)).toBe(false);
    }
  });
});
