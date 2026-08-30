import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ArchiveRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, MaintenanceService, ToolRegistry, WebAssetStore, canSeeImages, captureImage, configSchema,
  contextMessages, isImagePart, normalizeToolOutput, splitToolMedia, toolModelOutput, toolResultPart } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 模型能否看到网页上的图，这条路此前有三处各自独立地阻断（`tools/web.ts` 的注释里已列出）：
 * 抽取层丢掉 `<img>`、工具结果被 `JSON.stringify` 加 64KB 截断并包成不可信文本、以及
 * `isImagePart` 只认顶层 part，导致 vision 切换 / `capImages` / `degradeImages` 都识别不出它。
 *
 * 下面这些用例固定的是修法的形状，而不是逐 bug 的回归：图片跨轮依靠顶层 `webasset://` part，
 * 当步依靠附在工具结果上的 `media`，两条通道都不得把 base64 写进 `parts_json`。
 */
function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const mediaDir = `./data/${name}-media`;
  rmSync(mediaDir, { recursive: true, force: true });
  mkdirSync(mediaDir, { recursive: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  const log = new LogSink(new OperationsRepository(db));
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

/** 一张真实 PNG：sharp 要能解开它，构造假 buffer 只会走到 catch 分支。 */
async function png(width = 40, height = 30): Promise<Buffer> {
  return await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
}

function sink(harnessed: ReturnType<typeof harness>, visionAvailable: boolean,
  subAgent?: { name: string; images: () => number; onInjected: () => void }) {
  return { assets: harnessed.assets, visionAvailable: () => visionAvailable, log: harnessed.log,
    appendDelta: (turn: RuntimeTurnContext, message: unknown) => harnessed.engine.appendDelta(turn, message as never),
    ...(subAgent ? { subAgent } : {}) };
}

describe('web_assets · 抓回来的图存哪、怎么归一化', () => {
  it('落盘 + 落库，并按 media.maxImageEdge 缩进框内转成 jpeg', async () => {
    const bench = harness('web-assets-put');
    try {
      const row = await bench.assets.put('chat:chat', 'https://a.example/big.png', await png(3000, 2000));
      expect(row.mediaType).toBe('image/jpeg');
      // 归一化必须实际发生：一张 3000×2000 的原图按 provider 的分块计价可占掉半个上下文窗口。
      expect(row.width).toBe(bench.config.media.maxImageEdge);
      expect(row.height).toBeLessThan(bench.config.media.maxImageEdge);
      expect(existsSync(row.localPath)).toBe(true);
      const stored = bench.db.prepare('SELECT url,media_type,local_path,bytes FROM web_assets WHERE id=?').get(row.id) as Record<string, unknown>;
      expect(stored.url).toBe('https://a.example/big.png');
      expect(stored.local_path).toBe(row.localPath);
      // 落库的字节数取归一化之后那份，而不是下载下来那份：取错即是在报一个不存在的文件的大小。
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
      // 都依赖它。放进 tool-result 的 `output.value` 里，这四项都不生效。
      const parts = bench.turn.delta.at(-1)!.parts as unknown[];
      expect(parts.some((part) => isImagePart(part))).toBe(true);
      expect(parts.filter((part) => isImagePart(part))).toHaveLength(1);
      // 来源必须标明：不标注时模型看到的是用户发来一张图，而这张图是它自己从公网抓取的。
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
      // 不得留下任何记录：未入库、未落盘、未注入、未置位。
      expect(bench.db.prepare('SELECT COUNT(*) FROM web_assets').pluck().get()).toBe(0);
      expect(bench.turn.delta).toHaveLength(0);
      expect(bench.turn.mediaInjected).toBeUndefined();
    } finally { bench.cleanup(); }
  });

  /**
   * 子 agent 取的图不进入父轮的像素，只留一条文字痕迹：图是它派出的那个 agent 取的，结论在它
   * 交回的摘要里。像素同时给父轮，等于主 agent 为一张自己没请求过的图支付图片额度、并被固定在
   * vision 别名上（`visionScope='window'`）。行与文件照常保存：`gcFiles` 的 referenced 读的是表，
   * 而它当时看到的是哪张图，事后要能查得到。
   */
  it('子 agent 要的那张图：父轮只留文字痕迹，行与文件照存', async () => {
    const bench = harness('capture-subagent');
    try {
      let injected = 0;
      const result = await captureImage(sink(bench, true, { name: 'researcher', images: () => injected, onInjected: () => { injected += 1; } }),
        bench.turn, { url: 'https://a.example/chart.png', mediaType: 'image/png', body: await png() });
      expect(result.ok).toBe(true);
      const parts = bench.turn.delta.at(-1)!.parts as unknown[];
      expect(parts.some((part) => isImagePart(part))).toBe(false);
      // 痕迹要写明由谁取回、以及父轮自身并未看到，否则主 agent 会认为自己看过这张图。
      expect(JSON.stringify(parts)).toContain('researcher');
      expect(JSON.stringify(parts)).toContain('webasset://');
      // 标志落在实际看到图的那个 agent 上：置在父轮上等于多付一次贵别名的费用。
      expect(bench.turn.mediaInjected).toBeUndefined();
      expect(injected).toBe(1);
      expect(bench.db.prepare('SELECT COUNT(*) FROM web_assets').pluck().get()).toBe(1);
      expect(existsSync(bench.assets.path((result as { assetId: string }).assetId)!)).toBe(true);
      // 当步那条通道照旧提供 base64：它正是为了查看这张图才取的。
      expect((result as { data: string }).data.length).toBeGreaterThan(100);
    } finally { bench.cleanup(); }
  });

  it('子 agent 的张数按它这次运行自己数 —— 父轮 delta 里没有它们，数 delta 等于数不到', async () => {
    const bench = harness('capture-subagent-cap');
    try {
      const limit = bench.config.media.maxImagesPerTurn;
      const result = await captureImage(sink(bench, true, { name: 'researcher', images: () => limit, onInjected: () => {} }),
        bench.turn, { url: 'https://a.example/chart.png', mediaType: 'image/png', body: await png() });
      expect(result).toMatchObject({ ok: false, error: 'image_limit_reached' });
      expect(bench.turn.delta).toHaveLength(0);
      expect(bench.db.prepare('SELECT COUNT(*) FROM web_assets').pluck().get()).toBe(0);
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

      // 盘上那份已被删除（保留期清理或手工删除）：parts 是持久化的，此处抛出一次即等于该会话
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
      // base64 保持完整（未被 4096 的上限截断：截断后的 base64 会被 provider 整体拒收）……
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

  /**
   * 落库使用的是注册表交回的那一份，而不是上面那个 `content` 形状。AI SDK 对客户端执行的工具，
   * 把 `execute()` 的返回值原样放进 `step.content[].output`（`asContent`），`toModelOutput` 只作用于
   * 发给 provider 的 messages。于是 `stepToolResults` 拿到的是 `{ok, content, truncated, media}`，
   * `normalizeToolOutput` 为其套上 `{type:'json'}` 后落库。
   *
   * 只认 `content` 形状时，处理的是一份从不落库的形状：实测 `parts_json` 单条 300 KB，且每次
   * 物化都重放一遍（docs/02 §9 红线 21）。因此这条用例从 `registry.execute` 出发，不手工构造形状。
   */
  it('落库那一份是注册表的原始形状 —— 那一支也摘，parts_json 里不留字节', async () => {
    const bench = harness('persist-media');
    try {
      const { z } = await import('zod');
      const registry = new ToolRegistry(bench.log, { request: async () => true },
        { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 5, maxOutputBytes: 65_536 });
      const data = 'A'.repeat(300_000);
      registry.registerExternal({ name: 'shot', description: '', inputSchema: z.record(z.unknown()),
        minRole: 'owner', source: 'plugin', execute: () => ({ ok: true, note: '看这张图', media: [{ mediaType: 'image/jpeg', data }] }) });
      const output = await registry.execute('shot', {}, { turn: bench.turn, workspace: './data', agentKind: 'main' });
      const part = toolResultPart('call-1', 'shot', output);   // stepToolResults 做的就是这一句
      const persisted = JSON.stringify(part);
      expect(persisted).not.toContain('AAAA');
      expect(persisted.length).toBeLessThan(1000);
      // 判别字段一个不碰（红线 14）：形状还是那个 tool-result，只是 `media` 变成一句占位文本。
      expect(part.output.type).toBe('json');
      expect(persisted).toContain('看这张图');
      // 而当步那条通道照旧带完整的 base64：截断后的 base64 会被 provider 整体拒收。
      expect(JSON.stringify(toolModelOutput(output))).toContain(data);
    } finally { bench.cleanup(); }
  });
});

describe('这张图交给谁看，就问谁的能力位', () => {
  const seeing = (aliases: Record<string, boolean>) => ({ supportsVision: (alias: string) => aliases[alias] === true });
  /**
   * 判据取错的表现是图被送给一个不支持视觉的模型：宽容的 provider 静默忽略，严格的直接返回 400
   * （docs/08 §7.2）。子 agent 常跑在 `low` 上，而这里此前查的是主轮别名，与这张图无关。
   */
  it('主 agent 问本轮别名，子 agent 问它自己那个', () => {
    const registry = seeing({ vision: false, main: true, low: false });
    expect(canSeeImages(registry, { agentKind: 'main' }, () => 'main')).toBe(true);
    expect(canSeeImages(registry, { agentKind: 'sub', subAgent: { alias: 'low' } }, () => 'main')).toBe(false);
    expect(canSeeImages(registry, { agentKind: 'sub', subAgent: { alias: 'main' } }, () => 'low')).toBe(true);
  });

  it('有能看图的 vision 别名时两边都算能看 —— 两处切换都会切到它', () => {
    expect(canSeeImages(seeing({ vision: true, low: false }), { agentKind: 'sub', subAgent: { alias: 'low' } }, () => 'low')).toBe(true);
    expect(canSeeImages(seeing({ vision: true, low: false }), { agentKind: 'main' }, () => 'low')).toBe(true);
  });

  it('子 agent 的上下文缺了 subAgent 时按看不了算 —— 存疑的一档 fail-closed', () => {
    expect(canSeeImages(seeing({ vision: false, low: true }), { agentKind: 'sub' }, () => 'low')).toBe(false);
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
      const maintenance = new MaintenanceService(bench.db, './data/gc-web-assets.test.db', 1, 0,
        { files: bench.mediaDir }, 30, {});
      const result = maintenance.gcFiles();
      // 该问题本仓出现过两次（docs/25 §10 / docs/28 · L-OPS-06）：referenced 集合漏一张表，
      // 那张表的文件就会被静默删除。孤儿要删除、被引用的要保留，两条都需断言。
      expect(result.refused).toBeUndefined();
      expect(existsSync(row.localPath)).toBe(true);
      expect(existsSync(orphan)).toBe(false);
      expect(result.files).toBe(1);
    } finally { bench.cleanup(); }
  });

  /**
   * 文件名取内容哈希，因此同一张图取两次是盘上一份、库里两行（`docs/03 §2.4`）。见行即删文件
   * 会把仍在保留期内那行的图一并删除，表现不是报错，而是那张图提前变成
   * 「[图片已不可用：附件文件已丢失]」。因此顺序必须是先删行，再删没有任何行引用的文件。
   */
  it('两行共享一份字节时，过期那行不许把保留期内那行的图删掉', async () => {
    const bench = harness('retention-shared');
    try {
      const image = await png();
      const old = await bench.assets.put('chat:chat', 'https://a.example/a.png', image);
      const fresh = await bench.assets.put('chat:chat', 'https://a.example/again.png', image);
      expect(fresh.localPath).toBe(old.localPath);
      bench.db.prepare('UPDATE web_assets SET created_at=? WHERE id=?').run(Date.now() - 40 * 86_400_000, old.id);
      const maintenance = new MaintenanceService(bench.db, './data/retention-shared.test.db', 1, 0,
        { files: bench.mediaDir }, 30, { media: 30 });
      maintenance.cleanup();
      expect(bench.assets.path(old.id)).toBeNull();
      expect(bench.assets.path(fresh.id)).toBe(fresh.localPath);
      expect(existsSync(fresh.localPath)).toBe(true);
    } finally { bench.cleanup(); }
  });

  it('保留期到了删文件也删行 —— 读出侧照旧交回占位文本', async () => {
    const bench = harness('retention-web-assets');
    try {
      const row = await bench.assets.put('chat:chat', 'https://a.example/a.png', await png());
      bench.db.prepare('UPDATE web_assets SET created_at=? WHERE id=?').run(Date.now() - 40 * 86_400_000, row.id);
      const maintenance = new MaintenanceService(bench.db, './data/retention-web-assets.test.db', 1, 0,
        { files: bench.mediaDir }, 30, { media: 30 });
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
      // `capImages` 只在 openTurn 那一次执行，限制的是用户本轮发了几张：模型自己在一轮里
      // 取十张图它一张都拦不住，而图按 1500 token 估算，十张即占满整个窗口。
      expect(outcomes.slice(0, limit).every((entry) => entry.ok)).toBe(true);
      expect(outcomes.at(-1)).toMatchObject({ ok: false, error: 'image_limit_reached' });
      const images = bench.turn.delta.flatMap((message) => (message.parts as unknown[]).filter((part) => isImagePart(part)));
      expect(images).toHaveLength(limit);
      // 拒新不拒旧：前几张原样留着，模型已经就它们说过的话仍然有依据。
      expect(JSON.stringify(bench.turn.delta)).toContain('a.example/0.png');
    } finally { bench.cleanup(); }
  });
});
