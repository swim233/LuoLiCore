import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import type { ArchivedMessage } from '@luoli/db';
import { ContextEngine, KNOWN_UNIMPLEMENTED_CONFIG_KEYS, PromptAssembler, configSchema, runtimeBlock } from '@luoli/core';
import type { Config } from '@luoli/core';

/**
 * 第五轮从 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 摘下来的键，逐个钉住「它真的被读了」。
 * `config.test.ts` 那条路径级引用断言只能证明**代码里提到过**这个键；一个键从白名单里
 * 消失之后，运行时到底按不按它走，得由行为断言来说。
 */

function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  return { db, archive, engine: new ContextEngine(db, archive) };
}

const baseConfig = (patch: Record<string, unknown> = {}): Config => configSchema.parse({
  general: { timezone: 'UTC' },
  context: { scope: 'chat', background: { enabled: true, maxPerTurn: 20 }, rebase: { injectNotice: false }, limit: { tokens: 32_000, maxMessages: 200, minKeepTurns: 1 } },
  ...patch,
});

function append(archive: ArchiveRepository, id: number, text: string | null, triggered: boolean, mediaParts?: unknown[]): ArchivedMessage {
  const row = archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: id, direction: 'in', fromKind: 'user',
    fromUserId: 'u', fromName: '张三', fromUsername: null, kind: text === null ? 'photo' : 'text', text, tgDate: Date.UTC(2026, 7, 17, 10, 2),
    raw: {}, triggered, triggerReason: triggered ? 'mention' : null });
  if (mediaParts) { archive.scope('chat', null).attachMedia(row.id, mediaParts); row.mediaParts = mediaParts; }
  return row;
}

const textOf = (message: { parts: unknown[] }): string => (message.parts as Array<{ type: string; text?: string }>)
  .filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');

describe('context.background.showTime', () => {
  it('关掉后群聊前缀里没有 HH:mm，也不留空位', async () => {
    const { db, archive, engine } = harness('wiring-showtime');
    const trigger = append(archive, 1, '你好', true);
    const open = (config: Config) => engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'u',
      effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config });
    const withTime = await open(baseConfig());
    expect(textOf(withTime.delta.at(-1)!)).toMatch(/^\[张三[^\]]* \d{2}:\d{2}\]/);
    await engine.abortTurn(withTime, 'cancelled');
    const withoutTime = await open(baseConfig({ context: { scope: 'chat', background: { enabled: true, maxPerTurn: 20, showTime: false }, rebase: { injectNotice: false }, limit: { tokens: 32_000, maxMessages: 200, minKeepTurns: 1 } } }));
    const rendered = textOf(withoutTime.delta.at(-1)!);
    // 前缀里只剩发言人，且不留 `[张三 ]` 那种空位。
    expect(rendered).toMatch(/^\[张三[^\]\s]*\]/);
    expect(rendered.slice(0, rendered.indexOf(']'))).not.toMatch(/\d{1,2}:\d{2}/);
    await engine.abortTurn(withoutTime, 'cancelled');
    closeDatabase(db);
  });
});

describe('context.background.includeNonText', () => {
  it('关掉后纯图片的背景发言不进 delta，但条数并进省略提示', async () => {
    const { db, archive, engine } = harness('wiring-nontext');
    append(archive, 1, '这是一句话', false);
    append(archive, 2, null, false, [{ type: 'file', ref: 'attachment://a', mediaType: 'image/jpeg' }]);
    const trigger = append(archive, 3, '看看上面', true);
    const config = baseConfig({ context: { scope: 'chat', background: { enabled: true, maxPerTurn: 20, includeNonText: false }, rebase: { injectNotice: false }, limit: { tokens: 32_000, maxMessages: 200, minKeepTurns: 1 } } });
    const turn = await engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'u',
      effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config });
    const all = turn.delta.map((message) => textOf(message)).join('\n');
    expect(all).toContain('这是一句话');
    expect(turn.delta.flatMap((message) => message.parts as Array<{ type: string }>).some((part) => part.type === 'file')).toBe(false);
    // 认领水位已经推过去了：不说的话那条图片等于凭空消失。
    expect(all).toContain('省略了 1 条');
    await engine.abortTurn(turn, 'cancelled');
    closeDatabase(db);
  });
});

describe('media.maxImagesPerTurn', () => {
  it('超出的图片换成占位文本，保留最近的几张', async () => {
    const { db, archive, engine } = harness('wiring-maximages');
    const image = () => [{ type: 'file', ref: `attachment://${Math.random()}`, mediaType: 'image/jpeg' }];
    for (const id of [1, 2, 3, 4]) append(archive, id, null, false, image());
    const trigger = append(archive, 5, '这些图讲了什么', true);
    const config = baseConfig({ media: { maxImagesPerTurn: 2 } });
    const turn = await engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'u',
      effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config });
    const parts = turn.delta.flatMap((message) => message.parts as Array<{ type: string; text?: string }>);
    expect(parts.filter((part) => part.type === 'file')).toHaveLength(2);
    // 换成占位文本而不是删掉整条：不透明 part「要么原样保留，要么整体换成占位文本」（docs/02）。
    expect(parts.filter((part) => part.text?.includes('图片已省略'))).toHaveLength(2);
    await engine.abortTurn(turn, 'cancelled');
    closeDatabase(db);
  });
});

describe('prompt.includeToolCatalog / prompt.runtimeBlock.*', () => {
  it('关掉目录时整块不出现，而工具名仍在 RUNTIME 里', () => {
    const assembler = new PromptAssembler();
    const input = { character: 'C', assist: 'A', catalog: '- read_file: 读文件', publicMemory: 'P', runtime: 'R', maxTokens: 12_000 };
    expect(assembler.build(input).instructions).toContain('=== TOOL CATALOG ===');
    expect(assembler.build({ ...input, includeCatalog: false }).instructions).not.toContain('TOOL CATALOG');
    // 一个工具都没有 ≠ 目录被关掉：前者那块空标题是有信息的，模型该知道自己没工具可用。
    expect(assembler.build({ ...input, catalog: '' }).instructions).toContain('=== TOOL CATALOG ===');
  });

  it('三个 runtimeBlock 开关各自控制自己那一行', () => {
    const input = { now: new Date(0), timezone: 'UTC', chatDescription: 'c', triggerDescription: 't', role: 'trusted',
      tools: ['read_file'], agents: [], contextMessages: 3, contextTokens: 100, maxMessages: 200, maxTokens: 32_000,
      quota: '本轮已用 $0.0100', workspace: '/w', sandbox: 'docker' };
    const full = runtimeBlock(input);
    expect(full).toContain('上下文水位：');
    expect(full).toContain('额度：');
    expect(full).toContain('工作目录：');
    const bare = runtimeBlock({ ...input, show: { quota: false, contextWatermark: false, workspace: false } });
    for (const line of ['上下文水位：', '额度：', '工作目录：']) expect(bare).not.toContain(line);
    // 关掉的行整行消失，而不是留一个空值。
    expect(bare.split('\n').every((line) => line.trim() !== '' && !line.endsWith('：'))).toBe(true);
    // 给不出额度时那一行本来就不该有（WebUI 的提示词预览没有本轮预留）。
    const { quota: _quota, ...withoutQuota } = input;
    expect(runtimeBlock(withoutQuota)).not.toContain('额度：');
  });
});

describe('media.extract.codeExtensions', () => {
  it('配置里的扩展名是往内置集合上加，不是替换', async () => {
    const directory = resolve('./data/wiring-extract');
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'a.rs'), 'fn main() {}');
    writeFileSync(resolve(directory, 'b.md'), '# 标题');
    const { TelegramMedia } = await import('@luoli/telegram');
    const config = configSchema.parse({ media: { extract: { codeExtensions: ['rs'] } } }).media;
    const media = new TelegramMedia(null as never, 'token', null as never, config);
    const extract = (media as unknown as { extract(path: string, file: { mime?: string }): Promise<string | null> }).extract.bind(media);
    // 前缀点可加可不加：`['rs']` 与 `['.rs']` 都该认。
    expect(await extract(resolve(directory, 'a.rs'), {})).toContain('fn main');
    // 内置的 .md 不能因为配了 codeExtensions 就失效 —— 那种失败运维要很久才会发现。
    expect(await extract(resolve(directory, 'b.md'), {})).toContain('标题');
  });
});

describe('白名单', () => {
  it('已接线的键不再挂在 KNOWN_UNIMPLEMENTED_CONFIG_KEYS 上', () => {
    const wired = ['general.name', 'telegram.dropPendingOnStart', 'trigger.cooldownMsPerUser', 'concurrency.coalesceSameUserMs',
      'context.background.showTime', 'context.background.includeNonText', 'prompt.includeToolCatalog',
      'prompt.runtimeBlock.showQuota', 'prompt.runtimeBlock.showContextWatermark', 'prompt.runtimeBlock.showWorkspace',
      'agent.maxConcurrentSubagents', 'agent.progressThrottleMs', 'provider.healthDownCooldownMinutes',
      'tools.archive.defaultSearchLimit', 'tools.archive.maxSearchLimit', 'tools.archive.defaultReadLimit', 'tools.archive.maxReadLimit',
      'media.maxImagesPerTurn', 'media.stickerAsImage', 'media.downloadVoice', 'media.extract.codeExtensions',
      'skills.enabled', 'plugins.enabled', 'plugins.watch', 'mcp.connectTimeoutMs'];
    const still = wired.filter((key) => (KNOWN_UNIMPLEMENTED_CONFIG_KEYS as readonly string[]).includes(key));
    expect(still).toEqual([]);
  });

  it('已摘除的键不在 schema 里，写进 config.yaml 也只会被静默剥掉而不是拒绝启动', () => {
    const removed = ['general.locale', 'approval.allowInitiator', 'quota.perTurn.maxToolCalls', 'quota.perTurn.maxSubagents', 'quota.perTurn.maxDurationMs'];
    const parsed = configSchema.parse({ general: { locale: 'en-US' }, approval: { allowInitiator: true }, quota: { perTurn: { maxToolCalls: 1, maxSubagents: 1, maxDurationMs: 1 } } }) as unknown as Record<string, Record<string, unknown>>;
    expect(parsed.general!.locale).toBeUndefined();
    expect(parsed.approval!.allowInitiator).toBeUndefined();
    expect(Object.keys(parsed.quota!.perTurn as Record<string, unknown>).sort()).toEqual(['maxCostUsd', 'maxSteps']);
    for (const key of removed) expect((KNOWN_UNIMPLEMENTED_CONFIG_KEYS as readonly string[]).includes(key)).toBe(false);
  });
});
