import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sqlite } from '@luoli/db';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import {
  LogSink,
  PromptAssembler,
  PromptDocuments,
  ToolRegistry,
  assembleMainPrompt,
  configSchema,
  migrateMemoryLayout,
} from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * T2.5 验收：`ensure()` 按来源逐行 upsert、`paths()`/`readForPrompt()` 按来源+会话解析、
 * 来源级人格/ASSIST 文件名的非法值退回、新来源从根目录模板复制。
 *
 * fixture 与 `tests/memory.layout.test.ts` 同一惯例：磁盘一份旧布局目录树，库一份经 0019
 * 迁移、`id`/`subject` 已是按来源新形态、`path` 仍指向旧磁盘路径的 `memory_docs` 行——
 * 这正是 `migrateMemoryLayout()` 落地前、产线上真实存量数据会呈现的中间态。
 */
function harness(name: string) {
  const root = `./data/${name}`;
  rmSync(root, { recursive: true, force: true });
  const memoryDir = join(root, 'memory');
  const dataDir = join(root, 'state');
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(root, 'luoli.db'));
  migrateDatabase(db); // 全量跑到最新，含已提交的 0019（种子 telegram 来源行）
  return { memoryDir, dataDir, db };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 造一份完整的旧布局：PUBMEMORY、CHARACTER、ASSIST 三份来源级文件，一个用户的 PRIMEMORY。 */
function seedLegacyLayout(memoryDir: string, db: Sqlite) {
  const insertDoc = db.prepare(`INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at)
    VALUES (?,?,?,?,1,1,'h',1)`);
  const content = {
    pub: '# 公开记忆\n\n## 其他\n- 迁移前的公开记忆\n',
    character: '# 人设\n\n迁移前的人设\n',
    assist: '# 工作指导\n\n迁移前的指导\n',
    prime: '# 私有记忆（甲）\n\n## 其他\n- 迁移前的私有记忆\n',
  };
  writeFileSync(join(memoryDir, 'PUBMEMORY.md'), content.pub);
  writeFileSync(join(memoryDir, 'CHARACTER.md'), content.character);
  writeFileSync(join(memoryDir, 'ASSIST.md'), content.assist);
  mkdirSync(join(memoryDir, 'private', '1001'), { recursive: true });
  writeFileSync(join(memoryDir, 'private', '1001', 'PRIMEMORY.md'), content.prime);
  insertDoc.run('pubmemory:telegram', 'pubmemory', 'telegram', join(memoryDir, 'PUBMEMORY.md'));
  insertDoc.run('character:telegram', 'character', 'telegram', join(memoryDir, 'CHARACTER.md'));
  insertDoc.run('assist:telegram', 'assist', 'telegram', join(memoryDir, 'ASSIST.md'));
  insertDoc.run('primemory:telegram:1001', 'primemory', 'telegram:1001', join(memoryDir, 'private', '1001', 'PRIMEMORY.md'));
  return content;
}

function buildDependencies(db: Sqlite, memoryDir: string) {
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, memory: { dir: memoryDir } });
  const log = new LogSink(new OperationsRepository(db));
  const tools = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 80, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
  const documents = new PromptDocuments(db, memoryDir);
  documents.ensure();
  return { config, tools, prompts: new PromptAssembler(), documents };
}

function turnFor(input: {
  chatId: string;
  isPrivate: boolean;
  config: RuntimeTurnContext['config'];
}): RuntimeTurnContext {
  return {
    turnId: 't', key: `chat:${input.chatId}`, chatId: input.chatId, threadId: null,
    initiatorUserId: '1001', effectiveRole: 'trusted', isPrivate: input.isPrivate,
    baseCommitId: null,
    snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [], abortSignal: new AbortController().signal, config: input.config,
  } satisfies RuntimeTurnContext;
}

describe('PromptDocuments 按来源', () => {
  it('验收 1：私聊一轮的 PRIMEMORY/PUBMEMORY 内容与迁移前逐字节一致', () => {
    const { memoryDir, dataDir, db } = harness('prompt-documents-sources-private');
    const content = seedLegacyLayout(memoryDir, db);
    migrateMemoryLayout(db, memoryDir, dataDir);
    const { config, tools, prompts, documents } = buildDependencies(db, memoryDir);
    const turn = turnFor({ chatId: '1001', isPrivate: true, config });
    const assembled = assembleMainPrompt(turn, { config, tools, prompts, documents, workspace: './data' });
    expect(sha256(assembled.contents.pubmemory!)).toBe(sha256(content.pub));
    expect(sha256(assembled.contents.primemory!)).toBe(sha256(content.prime));
    expect(assembled.contents.pubmemory).toBe(content.pub);
    expect(assembled.contents.primemory).toBe(content.prime);
    closeDatabase(db);
  });

  it('验收 2：群聊一轮不含 PRIMEMORY 块', () => {
    const { memoryDir, dataDir, db } = harness('prompt-documents-sources-group');
    seedLegacyLayout(memoryDir, db);
    migrateMemoryLayout(db, memoryDir, dataDir);
    const { config, tools, prompts, documents } = buildDependencies(db, memoryDir);
    const turn = turnFor({ chatId: '-100', isPrivate: false, config });
    const assembled = assembleMainPrompt(turn, { config, tools, prompts, documents, workspace: './data' });
    expect(assembled.instructions).not.toContain('PRIMEMORY');
    closeDatabase(db);
  });

  it('验收 3：sources.character_file 非法值静默退回该来源的 CHARACTER.md，不抛错', () => {
    const { memoryDir, db } = harness('prompt-documents-sources-invalid-character-file');
    writeFileSync(join(memoryDir, 'CHARACTER.md'), '根目录人设模板');
    db.prepare("UPDATE sources SET character_file=? WHERE id='telegram'").run('../../etc/passwd');
    const documents = new PromptDocuments(db, memoryDir);
    expect(() => documents.ensure()).not.toThrow();
    const characterPath = join(memoryDir, 'sources', 'telegram', 'CHARACTER.md');
    expect(existsSync(characterPath)).toBe(true);
    expect(readFileSync(characterPath, 'utf8')).toBe('根目录人设模板');
    // 退回的是该来源目录下的默认文件，不是把非法字符串当路径段拼进去。`paths()` 返回 `resolve()`
    // 后的绝对路径，与 fixture 侧的相对路径比较前先归一化。
    expect(documents.paths('1001').character).toBe(resolve(characterPath));
    const row = db.prepare("SELECT path FROM memory_docs WHERE id='character:telegram'").get() as { path: string };
    expect(row.path).toBe(resolve(characterPath));
    expect(() => documents.readForPrompt({ userId: '1001', isPrivate: false })).not.toThrow();
    closeDatabase(db);
  });

  it('验收 4：新建来源后 ensure()，memory_docs 出现该来源三行，目录下有从模板复制的两个文件', () => {
    const { memoryDir, db } = harness('prompt-documents-sources-new-source');
    writeFileSync(join(memoryDir, 'CHARACTER.md'), '根目录人设模板');
    writeFileSync(join(memoryDir, 'ASSIST.md'), '根目录工作指导模板');
    db.prepare(
      "INSERT INTO sources(id,kind,name,created_at) VALUES ('sdk-demo','sdk','SDK Demo',?)",
    ).run(Date.now());
    const documents = new PromptDocuments(db, memoryDir);
    documents.ensure();
    const rows = db
      .prepare("SELECT id,scope,subject FROM memory_docs WHERE subject='sdk-demo' ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: 'assist:sdk-demo', scope: 'assist', subject: 'sdk-demo' },
      { id: 'character:sdk-demo', scope: 'character', subject: 'sdk-demo' },
      { id: 'pubmemory:sdk-demo', scope: 'pubmemory', subject: 'sdk-demo' },
    ]);
    const sourceDir = join(memoryDir, 'sources', 'sdk-demo');
    expect(readFileSync(join(sourceDir, 'CHARACTER.md'), 'utf8')).toBe('根目录人设模板');
    expect(readFileSync(join(sourceDir, 'ASSIST.md'), 'utf8')).toBe('根目录工作指导模板');
    closeDatabase(db);
  });

  it('perChat 覆盖优先于 sources.character_file', () => {
    const { memoryDir, db } = harness('prompt-documents-sources-perchat-priority');
    writeFileSync(join(memoryDir, 'CHARACTER.md'), '根目录人设模板');
    writeFileSync(join(memoryDir, 'CHARACTER.-100.md'), '本群覆盖人设');
    db.prepare("UPDATE sources SET character_file='CUSTOM.md' WHERE id='telegram'").run();
    const documents = new PromptDocuments(db, memoryDir);
    const withOverride = documents.readForPrompt({
      userId: '1001', isPrivate: false, characterOverride: 'CHARACTER.-100.md',
    });
    expect(withOverride.character).toBe('本群覆盖人设');
    // 无覆盖时才落到 sources.character_file 指定的文件（该来源目录下，非法值以外的正常分支）。
    const path = documents.paths('1001').character;
    expect(path).toBe(resolve(memoryDir, 'sources', 'telegram', 'CUSTOM.md'));
    closeDatabase(db);
  });

  it('save()/rollback() 的 id 与路径推导与 ensure() 一致', () => {
    const { memoryDir, db } = harness('prompt-documents-sources-save-rollback');
    const documents = new PromptDocuments(db, memoryDir);
    documents.ensure();
    documents.save('assist', 'telegram', '# 工作指导\n\n第一版\n', 'webui');
    // 此时只有一条修订，SELECT 结果就是它，不依赖排序。
    const revisionId = db
      .prepare("SELECT id FROM memory_revisions WHERE doc_id='assist:telegram'")
      .pluck()
      .get() as string;
    documents.save('assist', 'telegram', '# 工作指导\n\n第二版\n', 'webui');
    const rolledBack = documents.rollback('assist:telegram', revisionId, 'webui');
    expect(rolledBack.id).toBe('assist:telegram');
    const path = join(memoryDir, 'sources', 'telegram', 'ASSIST.md');
    expect(readFileSync(path, 'utf8')).toBe('# 工作指导\n\n第一版\n');
    closeDatabase(db);
  });
});
