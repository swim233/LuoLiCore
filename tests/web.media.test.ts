import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ArchiveRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, MaintenanceService, ToolRegistry, WebAssetStore, captureImage, configSchema,
  contextMessages, isImagePart, normalizeToolOutput, splitToolMedia, toolModelOutput } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 「模型能不能看到网页上的图」这条路，此前有**三处各自独立**地挡着（`tools/web.ts` 的注释里列了）：
 * 抽取层丢掉 `<img>`、工具结果被 `JSON.stringify` + 64KB 截断 + 包成不可信文本、而
 * `isImagePart` 只认顶层 part 所以 vision 切换 / `capImages` / `degradeImages` 一个都认不出它。
 *
 * 下面这些用例钉的是修法的形状，而不是逐 bug 的回归：**图片跨轮靠顶层 `webasset://` part，
 * 当步靠骑在工具结果上的 `media`，两条通道都不许把 base64 写进 `parts_json`。**
 */
function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const mediaDir = `./data/${name}-media`;
  rmSync(mediaDir, { recursive: true, force: true });
  mkdirSync(mediaDir, { recursive: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  const log = new LogSink(new OperationsRepository(db), `./data/${name}-logs`);
  const engine = new ContextEngine(db, archive, log);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' } });
  const assets = new WebAssetStore(db, mediaDir, config.media.maxImageEdge);
  const turn = { turnId: 'probe', key: 'chat:chat', chatId: 'chat', threadId: null, initiatorUserId: 'user',
    effectiveRole: 'owner', isPrivate: true, baseCommitId: null, config,
    snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [], abortSignal: new AbortController().signal } as unknown as RuntimeTurnContext;
  return { db, engine, assets, config, mediaDir, log, turn,
    cleanup: () => { closeDatabase(db); rmSync(mediaDir, { recursive: true, force: true }); } };
}

/** 一张真 PNG。sharp 要真能解开它 —— 造个假 buffer 只会测到 catch 分支。 */
async function png(width = 40, height = 30): Promise<Buffer> {
  return await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
}

function sink(harnessed: ReturnType<typeof harness>, visionAvailable: boolean) {
  return { assets: harnessed.assets, visionAvailable: () => visionAvailable, log: harnessed.log,
    appendDelta: (turn: RuntimeTurnContext, message: unknown) => harnessed.engine.appendDelta(turn, message as never) };
}

describe('web_assets · 抓回来的图存哪、怎么归一化', () => {
  it('落盘 + 落库，并按 media.maxImageEdge 缩进框内转成 jpeg', async () => {
    const bench = harness('web-assets-put');
    try {
      const row = await bench.assets.put('chat:chat', 'https://a.example/big.png', await png(3000, 2000));
      expect(row.mediaType).toBe('image/jpeg');
      // 归一化必须真的发生：一张 3000×2000 的原图按 provider 的分块计价能顶掉半个上下文窗口。
      expect(row.width).toBe(bench.config.media.maxImageEdge);
      expect(row.height).toBeLessThan(bench.config.media.maxImageEdge);
      expect(existsSync(row.localPath)).toBe(true);
      const stored = bench.db.prepare('SELECT url,media_type,local_path,bytes FROM web_assets WHERE id=?').get(row.id) as Record<string, unknown>;
      expect(stored.url).toBe('https://a.example/big.png');
      expect(stored.local_path).toBe(row.localPath);
      // 落库的字节数是**归一化之后**那份的，不是下载下来那份 —— 报错了就是在报一个不存在的文件的大小。
      expect(stored.bytes).toBe(row.bytes);
      expect(readFileSync(row.localPath).length).toBe(row.bytes);
    } finally { bench.cleanup(); }
  });

  it('同一张图取两次只在盘上留一份，但库里是两行（一行一次注入）', async () => {
    const bench = harness('web-assets-dedupe');
    try {
      const body = await png();
      const first = await bench.assets.put('chat:chat', 'https://a.example/a.png', body);
      const second = await bench.assets.put('chat:chat', 'https://a.example/again.png', body);
      expect(second.localPath).toBe(first.localPath);
      expect(second.id).not.toBe(first.id);
      expect(bench.db.prepare('SELECT COUNT(*) FROM web_assets').pluck().get()).toBe(2);
    } finally { bench.cleanup(); }
  });
});

describe('captureImage · 注入的是顶层 part，而且看不了图时不许注入', () => {
  it('成功时注入顶层 file part，isImagePart 认得它，并置位 mediaInjected', async () => {
    const bench = harness('capture-inject');
    try {
      const result = await captureImage(sink(bench, true), bench.turn, { url: 'https://a.example/cat.png', mediaType: 'image/png', body: await png() });
      expect(result.ok).toBe(true);
      // 顶层是关键：`isImagePart` 只认顶层 part，vision 别名自动切换 / capImages / degradeImages
      // 全靠它。塞进 tool-result 的 `output.value` 里这四样一个都不适用。
      const parts = bench.turn.delta.at(-1)!.parts as unknown[];
      expect(parts.some((part) => isImagePart(part))).toBe(true);
      expect(parts.filter((part) => isImagePart(part))).toHaveLength(1);
      // 来源要标明：不标的话模型看到的是「用户发来一张图」，而这张图是它自己抓的、来自公网。
      expect(JSON.stringify(parts)).toContain('a.example/cat.png');
      expect(bench.turn.mediaInjected).toBe(true);
      // 引用而不是字节：base64 落进 parts_json 会被硬截断切半，而截断结果是持久化的。
      expect(JSON.stringify(parts)).toContain('webasset://');
      expect(JSON.stringify(parts).length).toBeLessThan(2000);
    } finally { bench.cleanup(); }
  });

  it('没有能看图的模型时整条路不走 —— 如实说，不伪造一次「已放进上下文」', async () => {
    const bench = harness('capture-no-vision');
    try {
      const result = await captureImage(sink(bench, false), bench.turn, { url: 'https://a.example/cat.png', mediaType: 'image/png', body: await png() });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ error: 'vision_unavailable' });
      // 一个字都不许落：没入库、没落盘、没注入、没置位。
      expect(bench.db.prepare('SELECT COUNT(*) FROM web_assets').pluck().get()).toBe(0);
      expect(bench.turn.delta).toHaveLength(0);
      expect(bench.turn.mediaInjected).toBeUndefined();
    } finally { bench.cleanup(); }
  });

  it('解不成图片时交回失败而不是抛，也不留半行', async () => {
    const bench = harness('capture-broken');
    try {
      const result = await captureImage(sink(bench, true), bench.turn, { url: 'https://a.example/x.png', mediaType: 'image/png', body: Buffer.from('这不是图片') });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ error: 'image_unreadable' });
      expect(bench.turn.delta).toHaveLength(0);
    } finally { bench.cleanup(); }
  });
});

describe('读出侧 · webasset:// 水化，文件丢了也不许抛', () => {
  it('取得到就换成 base64，取不到就整体换成占位文本', async () => {
    const bench = harness('hydrate-webasset');
    try {
      const row = await bench.assets.put('chat:chat', 'https://a.example/a.png', await png());
      bench.turn.delta.push({ id: 'm1', role: 'user', origin: 'note',
        parts: [{ type: 'file', ref: `webasset://${row.id}`, mediaType: 'image/jpeg' }], textPreview: '图' } as never);
      const hydrated = contextMessages(bench.turn, bench.db);
      const part = (hydrated.at(-1)!.content as Array<Record<string, unknown>>)[0]!;
      expect(part.type).toBe('file');
      expect(typeof part.data).toBe('string');
      expect(part.ref).toBeUndefined();

      // 盘上那份被删掉（保留期清过、手工删过）：parts 是持久化的，这里抛一次等于该会话
      // 在 `/new` 之前每轮都失败（docs/24 · R-MEDIA-01）。
      rmSync(row.localPath, { force: true });
      const missing = contextMessages(bench.turn, bench.db);
      const placeholder = (missing.at(-1)!.content as Array<Record<string, unknown>>)[0]!;
      expect(placeholder.type).toBe('text');
      expect(String(placeholder.text)).toContain('已不可用');
    } finally { bench.cleanup(); }
  });

  it('库里根本没有这一行时同样是占位文本', () => {
    const bench = harness('hydrate-webasset-missing');
    try {
      bench.turn.delta.push({ id: 'm1', role: 'user', origin: 'note',
        parts: [{ type: 'file', ref: 'webasset://01NOPE', mediaType: 'image/jpeg' }], textPreview: '图' } as never);
      const part = (contextMessages(bench.turn, bench.db).at(-1)!.content as Array<Record<string, unknown>>)[0]!;
      expect(part.type).toBe('text');
    } finally { bench.cleanup(); }
  });
});

describe('工具结果里的图片：摘出去交给 provider，不写进上下文', () => {
  it('splitToolMedia 把 media 从序列化对象里摘走', () => {
    const media = [{ mediaType: 'image/jpeg', data: 'AAAA' }];
    expect(splitToolMedia({ ok: true, assetId: 'x', media })).toEqual({ media, rest: { ok: true, assetId: 'x' } });
    // 不合形状的 `media` 原样留着：它可能只是某个工具自己的普通字段。
    expect(splitToolMedia({ ok: true, media: 'not-media' })).toEqual({ media: [], rest: { ok: true, media: 'not-media' } });
    expect(splitToolMedia({ ok: true })).toEqual({ media: [], rest: { ok: true } });
  });

  it('#normalizeOutput 摘掉 media 之后，几百 KB 的 base64 不再挤掉正文也不被截半', async () => {
    const bench = harness('normalize-media');
    try {
      const registry = new ToolRegistry(bench.log, { request: async () => true },
        { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 5, maxOutputBytes: 4096 });
      const data = 'A'.repeat(300_000);
      registry.registerExternal({ name: 'shot', description: '', inputSchema: (await import('zod')).z.record((await import('zod')).z.unknown()),
        minRole: 'owner', source: 'plugin', execute: () => ({ ok: true, note: '看这张图', media: [{ mediaType: 'image/jpeg', data }] }) });
      const output = await registry.execute('shot', {}, { turn: bench.turn, workspace: './data', agentKind: 'main' }) as Record<string, unknown>;
      // base64 完整地活着（没被 4096 的上限截半 —— 截半的 base64 会被 provider 整个拒收）……
      expect((output.media as Array<{ data: string }>)[0]!.data).toHaveLength(300_000);
      // ……而模型要读的那句话也没被 base64 挤出预算。
      expect(String(output.content)).toContain('看这张图');
      expect(output.truncated).toBe(false);
    } finally { bench.cleanup(); }
  });

  it('toolModelOutput：带 media 走多模态 content，不带就照 SDK 默认', () => {
    expect(toolModelOutput({ ok: true })).toEqual({ type: 'json', value: { ok: true } });
    expect(toolModelOutput('文本')).toEqual({ type: 'text', value: '文本' });
    const multimodal = toolModelOutput({ ok: true, media: [{ mediaType: 'image/jpeg', data: 'QUFB' }] });
    expect(multimodal.type).toBe('content');
    expect((multimodal as { value: unknown[] }).value).toEqual([
      { type: 'text', text: '{"ok":true}' },
      { type: 'file', data: { type: 'data', data: 'QUFB' }, mediaType: 'image/jpeg' }]);
  });

  it('持久化之前把 tool-result 里的图片摘成占位文本 —— parts_json 里不留字节', () => {
    const withImage = { type: 'content', value: [{ type: 'text', text: '看这张图' },
      { type: 'file', data: { type: 'data', data: 'A'.repeat(50_000) }, mediaType: 'image/jpeg' }] };
    const stripped = normalizeToolOutput(withImage);
    expect(JSON.stringify(stripped)).not.toContain('AAAA');
    expect(JSON.stringify(stripped).length).toBeLessThan(500);
    // 判别字段一个不碰（docs/02 红线 14）：只换 value 里那几项。
    expect(stripped.type).toBe('content');
    expect((stripped.value as unknown[])[0]).toEqual({ type: 'text', text: '看这张图' });
    // 没有图的结果原样返回同一个对象，不做无谓的浅拷贝。
    const plain = { type: 'json', value: { ok: true } };
    expect(normalizeToolOutput(plain)).toBe(plain);
  });
});

describe('gcFiles / 保留期 · 网页图不许被当孤儿删掉', () => {
  it('web_assets 引用的文件在 gc 之后还在', async () => {
    const bench = harness('gc-web-assets');
    try {
      const row = await bench.assets.put('chat:chat', 'https://a.example/a.png', await png());
      const orphan = join(bench.mediaDir, 'orphan.jpg');
      rmSync(orphan, { force: true });
      (await import('node:fs')).writeFileSync(orphan, 'not referenced');
      const maintenance = new MaintenanceService(bench.db, './data/gc-web-assets.test.db', 1, 0, './data/gc-web-assets-logs',
        { files: bench.mediaDir }, 0, 30, {});
      const result = maintenance.gcFiles();
      // 这个坑本仓踩过两次（docs/25 §10 / docs/28 · L-OPS-06）：referenced 集合漏一张表，
      // 那张表的文件就被静静删掉。孤儿要删掉、被引用的要留下，两条都得断言。
      expect(result.refused).toBeUndefined();
      expect(existsSync(row.localPath)).toBe(true);
      expect(existsSync(orphan)).toBe(false);
      expect(result.files).toBe(1);
    } finally { bench.cleanup(); }
  });

  it('保留期到了删文件也删行 —— 读出侧照旧交回占位文本', async () => {
    const bench = harness('retention-web-assets');
    try {
      const row = await bench.assets.put('chat:chat', 'https://a.example/a.png', await png());
      bench.db.prepare('UPDATE web_assets SET created_at=? WHERE id=?').run(Date.now() - 40 * 86_400_000, row.id);
      const maintenance = new MaintenanceService(bench.db, './data/retention-web-assets.test.db', 1, 0, './data/retention-web-assets-logs',
        { files: bench.mediaDir }, 0, 30, { media: 30 });
      maintenance.cleanup();
      expect(existsSync(row.localPath)).toBe(false);
      expect(bench.db.prepare('SELECT COUNT(*) FROM web_assets').pluck().get()).toBe(0);
      expect(bench.assets.path(row.id)).toBeNull();
    } finally { bench.cleanup(); }
  });
});

describe('media.maxImagesPerTurn 对轮内注入的图同样生效', () => {
  it('到上限之后拒绝新的，而不是把模型已经看过的那几张抽走', async () => {
    const bench = harness('cap-web-images');
    try {
      const limit = bench.config.media.maxImagesPerTurn;
      const outcomes = [];
      for (let index = 0; index <= limit; index += 1) {
        outcomes.push(await captureImage(sink(bench, true), bench.turn, { url: `https://a.example/${index}.png`, mediaType: 'image/png', body: await png(20 + index, 20) }));
      }
      // `capImages` 只在 openTurn 那一次跑，管的是「用户这一轮发了几张」—— 模型自己在一轮里
      // 取十张图它一张都拦不住，而图按 1500 token 估，十张就顶掉整个窗口。
      expect(outcomes.slice(0, limit).every((entry) => entry.ok)).toBe(true);
      expect(outcomes.at(-1)).toMatchObject({ ok: false, error: 'image_limit_reached' });
      const images = bench.turn.delta.flatMap((message) => (message.parts as unknown[]).filter((part) => isImagePart(part)));
      expect(images).toHaveLength(limit);
      // 拒新不拒旧：前几张原样留着，模型已经就它们说过的话仍然有依据。
      expect(JSON.stringify(bench.turn.delta)).toContain('a.example/0.png');
    } finally { bench.cleanup(); }
  });
});
