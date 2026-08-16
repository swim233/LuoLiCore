import { describe, expect, it } from 'vitest';
import { contextMessages } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

const turn = { turnId: 't', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '1', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null,
  snapshot: { messages: [
    { id: 'u', role: 'user', origin: 'trigger', parts: [{ type: 'text', text: 'look' }, { type: 'image', image: 'data:image/jpeg;base64,AA', mediaType: 'image/jpeg' }], ordinal: 1 },
    { id: 'a', role: 'assistant', origin: 'tool_call', parts: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'x' } }], ordinal: 2 },
    { id: 'r', role: 'tool', origin: 'tool_result', parts: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'read_file', output: { type: 'text', value: 'ok' } }], ordinal: 3 },
  ], ordinals: [1, 2, 3], tokens: 10, windowStart: 1, headOrdinal: 3 }, delta: [], abortSignal: new AbortController().signal, config: {} } satisfies RuntimeTurnContext;

describe('provider messages', () => {
  // 库里的 `image` part 是持久化的：读出侧不转，老会话就得一路刷 DeprecationWarning 到图片滚出窗口。
  it('preserves image, tool-call and tool-result parts with their real roles', () => {
    const messages = contextMessages(turn);
    expect(messages[0]).toMatchObject({ role: 'user', content: expect.arrayContaining([
      expect.objectContaining({ type: 'file', data: 'data:image/jpeg;base64,AA', mediaType: 'image/jpeg' })]) });
    expect(JSON.stringify(messages[0])).not.toContain('"type":"image"');
    expect(messages[1]).toMatchObject({ role: 'assistant', content: [expect.objectContaining({ type: 'tool-call', toolCallId: 'call-1' })] });
    expect(messages[2]).toMatchObject({ role: 'tool', content: [expect.objectContaining({ type: 'tool-result', toolCallId: 'call-1' })] });
  });

  it('keeps model aliases scoped to the current turn object', () => {
    const first = structuredClone({ ...turn, abortSignal: undefined }) as unknown as RuntimeTurnContext;
    const second = structuredClone({ ...turn, abortSignal: undefined }) as unknown as RuntimeTurnContext;
    first.abortSignal = new AbortController().signal;
    second.abortSignal = new AbortController().signal;
    Object.assign(first, { modelAliasOverride: 'high' });
    expect(first.modelAliasOverride).toBe('high');
    expect(second.modelAliasOverride).toBeUndefined();
  });
});
