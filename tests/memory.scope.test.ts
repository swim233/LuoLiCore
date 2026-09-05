import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import {
  LogSink,
  MemoryStore,
  TELEGRAM_SOURCE_ID,
  assertValidSourceId,
  memoryScopeSubjects,
  migrateMemoryLayout,
  splitPrimemorySubject,
} from '@luoli/core';
import { code, source } from './support/source';

/**
 * docs/12-sdk.md T2.3：`MemoryStore.path()` 改为新布局（四 scope 全按 subject 分路径），
 * 新增作用域键计算函数 `memoryScopeSubjects`（唯一实现点）。三条验收：
 * 1. 四个 scope 的路径生成各有用例。
 * 2. 生成的路径不含 `:`。
 * 3. `builtins.ts` 不再把 `initiatorUserId` 直传给 `memory.read`/`queueWrite`（源码断言）。
 */
function harness(name: string) {
  const database = `./data/${name}.test.db`;
  const directory = `./data/${name}-memory`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true });
  const db = openDatabase(database);
  migrateDatabase(db);
  return { db, directory, memory: new MemoryStore(db, directory, 1500, 3000) };
}

describe('memoryScopeSubjects（作用域键，唯一实现点）', () => {
  it('pubmemory 的 subject 即 sourceId 本身', () => {
    expect(memoryScopeSubjects('telegram', '1001').pubmemory).toBe('telegram');
    expect(memoryScopeSubjects('acme-sdk', 'sess-1').pubmemory).toBe('acme-sdk');
  });

  it('primemory 的 subject 是复合键 <sourceId>:<sessionId>', () => {
    expect(memoryScopeSubjects('telegram', '1001').primemory).toBe('telegram:1001');
    expect(memoryScopeSubjects('acme-sdk', 'sess-1').primemory).toBe('acme-sdk:sess-1');
  });

  it('splitPrimemorySubject 反解复合 subject，与 memoryScopeSubjects 互逆', () => {
    const subjects = memoryScopeSubjects('acme-sdk', 'sess-1');
    expect(splitPrimemorySubject(subjects.primemory)).toEqual({ sourceId: 'acme-sdk', sessionId: 'sess-1' });
  });

  it('splitPrimemorySubject 对没有 : 的字符串报错，不静默拆出垃圾目录段', () => {
    expect(() => splitPrimemorySubject('no-colon-here')).toThrow('invalid_primemory_subject');
  });

  it('sourceId 校验：含 : 或路径字符即拒绝（A3）', () => {
    expect(() => assertValidSourceId('telegram')).not.toThrow();
    expect(() => memoryScopeSubjects('has:colon', '1001')).toThrow('invalid_source_id');
    expect(() => memoryScopeSubjects('has/slash', '1001')).toThrow('invalid_source_id');
    expect(() => memoryScopeSubjects('../escape', '1001')).toThrow('invalid_source_id');
  });

  it('sessionId 校验：含 : 、路径分隔符或 .. 即拒绝', () => {
    expect(() => memoryScopeSubjects('telegram', '1001')).not.toThrow();
    expect(() => memoryScopeSubjects('telegram', 'has:colon')).toThrow('invalid_session_id');
    expect(() => memoryScopeSubjects('telegram', 'has/slash')).toThrow('invalid_session_id');
    expect(() => memoryScopeSubjects('telegram', '../escape')).toThrow('invalid_session_id');
    expect(() => memoryScopeSubjects('telegram', '')).toThrow('invalid_session_id');
  });

  it('TELEGRAM_SOURCE_ID 是内建来源的固定 id', () => {
    expect(TELEGRAM_SOURCE_ID).toBe('telegram');
  });
});

describe('MemoryStore 路径生成（四个 scope，按新布局 memory/sources/<sourceId>/…）', () => {
  it('pubmemory → memory/sources/<sourceId>/PUBMEMORY.md', () => {
    const { db, directory, memory } = harness('scope-pubmemory');
    const document = memory.read('pubmemory', 'telegram', 'owner');
    expect(document.path).toBe(join(directory, 'sources', 'telegram', 'PUBMEMORY.md'));
    closeDatabase(db);
  });

  it('character → memory/sources/<sourceId>/CHARACTER.md', () => {
    const { db, directory, memory } = harness('scope-character');
    const document = memory.read('character', 'telegram', 'owner');
    expect(document.path).toBe(join(directory, 'sources', 'telegram', 'CHARACTER.md'));
    closeDatabase(db);
  });

  it('assist → memory/sources/<sourceId>/ASSIST.md', () => {
    const { db, directory, memory } = harness('scope-assist');
    const document = memory.read('assist', 'telegram', 'owner');
    expect(document.path).toBe(join(directory, 'sources', 'telegram', 'ASSIST.md'));
    closeDatabase(db);
  });

  it('primemory → memory/sources/<sourceId>/private/<sessionId>/PRIMEMORY.md', () => {
    const { db, directory, memory } = harness('scope-primemory');
    const subject = memoryScopeSubjects('telegram', 'u1').primemory;
    const document = memory.read('primemory', subject, 'limited', 'u1', true);
    expect(document.path).toBe(join(directory, 'sources', 'telegram', 'private', 'u1', 'PRIMEMORY.md'));
    closeDatabase(db);
  });

  it('非内建来源同样按 sourceId 分路径，不硬编码 telegram', () => {
    const { db, directory, memory } = harness('scope-other-source');
    const pub = memory.read('pubmemory', 'acme-sdk', 'owner');
    expect(pub.path).toBe(join(directory, 'sources', 'acme-sdk', 'PUBMEMORY.md'));
    const primemorySubject = memoryScopeSubjects('acme-sdk', 'sess-1').primemory;
    const pri = memory.read('primemory', primemorySubject, 'limited', 'sess-1', true, 'acme-sdk');
    expect(pri.path).toBe(join(directory, 'sources', 'acme-sdk', 'private', 'sess-1', 'PRIMEMORY.md'));
    closeDatabase(db);
  });

  it('生成的路径中不含 :（复合 subject 只作库键，不直接当目录名）', () => {
    const { db, directory, memory } = harness('scope-no-colon');
    const primemorySubject = memoryScopeSubjects('telegram', 'u1').primemory;
    expect(primemorySubject).toContain(':'); // 库里的键本身含 :，验证的是它不会原样落进路径
    const paths = [
      memory.read('pubmemory', 'telegram', 'owner').path,
      memory.read('character', 'telegram', 'owner').path,
      memory.read('assist', 'telegram', 'owner').path,
      memory.read('primemory', primemorySubject, 'limited', 'u1', true).path,
    ];
    const normalizedDirectory = join(directory); // 与 path() 内部同一套 join() 归一化，两侧才能比
    for (const path of paths) {
      expect(path.startsWith(normalizedDirectory)).toBe(true);
      expect(path).not.toContain(':');
    }
    closeDatabase(db);
  });

  it('flush() 落 .pending 时的文件名同样不含 :（primemory 复合 subject 触发软上限）', () => {
    const { db, directory } = harness('scope-pending-colon');
    // softLimit=1：任何非空内容都会在 flush() 里判定「超软上限」，从而走进 `.pending/` 分支
    // （`store.ts` 里那处曾经拼 `${scope}-${subject}.md` 时会把复合 subject 的 `:` 原样带进文件名）。
    const memory = new MemoryStore(db, directory, 1, 10_000, 12);
    const subject = memoryScopeSubjects('telegram', 'u1').primemory;
    memory.queueWrite(
      { scope: 'primemory', subject, section: 'A', lines: ['一条记忆'], actor: 'test', turnId: 't1', chatId: 'c', userId: 'u1' },
      'limited',
      true,
      'trusted',
    );
    memory.flush('t1');
    const pendingFiles = readdirSync(join(directory, '.pending'));
    expect(pendingFiles.length).toBeGreaterThan(0);
    expect(pendingFiles).toContain('primemory-telegram-u1.md');
    for (const file of pendingFiles) expect(file).not.toContain(':');
    closeDatabase(db);
  });
});

describe('builtins.ts 接入点：memory_read / memory_write 经 memoryScopeSubjects 取 subject', () => {
  const builtinsSource = source('packages/core/src/tools/builtins.ts');

  it('不再把 initiatorUserId 直传给 memory.read / queueWrite 作 subject（唯一实现点判据）', () => {
    // 改造前的确切形态：三元表达式把 initiatorUserId 直接当 primemory 的 subject，
    // pubmemory/character/assist 一侧硬编码 null。两处（memory_read 与 memory_write）都要拦。
    expect(builtinsSource).not.toContain(
      code('input.scope === "primemory" ? context.turn.initiatorUserId : null'),
    );
  });

  it('两个工具都改为调用 memoryScopeSubjects 计算 subject', () => {
    expect(builtinsSource).toContain(code('memoryScopeSubjects('));
    expect(builtinsSource).toContain(code('turnMemorySubjects(context.turn)'));
    // memory_read 与 memory_write 各调用一次 turnMemorySubjects；只出现一次说明有一侧没接入。
    const occurrences = builtinsSource.split(code('turnMemorySubjects(context.turn)')).length - 1;
    expect(occurrences).toBe(2);
  });

  it('memory_write 传给 queueWrite 的 subject 同样来自作用域键，不是裸 userId', () => {
    expect(builtinsSource).not.toContain(
      code('subject: input.scope === "primemory" ? context.turn.initiatorUserId : null'),
    );
    expect(builtinsSource).toContain(
      code('subject: input.scope === "primemory" ? subjects.primemory : subjects.pubmemory'),
    );
  });
});

/**
 * F-1（qa-T2-3 第 1 轮 FAIL）：`/memory` 命令（`packages/telegram/src/bot.ts` 约 `:1097`）
 * 是另一处把 userId 当 primemory subject 的调用点，`builtins.ts` 的源码断言覆盖不到它——
 * 两处各自独立地把裸 userId 传给 `MemoryStore`，只改一处，另一处照样在改造后失效
 * （非 owner 被 `read()` 的自读闸拒绝，owner 越过闸后在 `path()` 的 `splitPrimemorySubject`
 * 上抛错，用户侧无任何回复）。
 */
describe('/memory 命令（packages/telegram/src/bot.ts）：F-1 回归', () => {
  it('经 T2.2 搬迁的旧数据：三档角色自读都拿到搬迁前的原文，owner 自读不落审计', () => {
    // 判据按 qa-T2-3 的第 2 轮探针：不能只断言「不抛错」或读到空字符串——空文档上这两条
    // 恒真，挡不住 T2.2 那一层搬迁（旧路径搬走了、`memory_docs.path` 没跟着改，也照样读到
    // 空字符串）。必须先造一份真实的旧布局内容，走完 0019 迁移 + `migrateMemoryLayout()`，
    // 再按 bot.ts 的实参形态读，断言内容与搬迁前逐字节相等。
    const root = './data/scope-bot-memory-migrated';
    rmSync(root, { recursive: true, force: true });
    const memoryDir = join(root, 'memory');
    const dataDir = join(root, 'state');
    mkdirSync(join(memoryDir, 'private', '1001'), { recursive: true });
    const db = openDatabase(join(root, 'luoli.db'));
    migrateDatabase(db); // 全量跑到最新，含已提交的 0019
    const original = '# 私有记忆（甲）\n\n## 其他\n- 甲的旧内容\n';
    writeFileSync(join(memoryDir, 'private', '1001', 'PRIMEMORY.md'), original);
    db.prepare(
      `INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,?,?,?,1,1,'h',1)`,
    ).run(
      'primemory:telegram:1001',
      'primemory',
      'telegram:1001',
      join(memoryDir, 'private', '1001', 'PRIMEMORY.md'),
    );
    migrateMemoryLayout(db, memoryDir, dataDir);

    const log = new LogSink(new OperationsRepository(db));
    const memory = new MemoryStore(db, memoryDir, 1500, 3000, 12, log);
    const userId = '1001';
    // `/memory` 命令要求 `access.effectiveRole >= limited`（`requireRole` 闸在命令处理器更
    // 前面）；三档角色都应该读到自己搬迁前的那份原文，逐字节相等，不是「不抛错」这么弱。
    for (const role of ['limited', 'trusted', 'owner'] as const) {
      const document = memory.read(
        'primemory',
        memoryScopeSubjects(TELEGRAM_SOURCE_ID, userId).primemory,
        role,
        userId,
        true,
      );
      expect(document.content).toBe(original);
    }
    // owner 自读自己那份不算「查看他人」，不应该落一条审计——未修复的形态下 owner 会先在
    // `subject !== ownSubject` 上判定为真（裸 id 与复合键不相等）落一条审计，再在 `path()`
    // 拆分时抛错；这条断言单独挡住那个副作用，即使前面的角色循环侥幸没抛错也拦得住。
    expect(
      db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='memory.owner_read_private'").pluck().get(),
    ).toBe(0);
    closeDatabase(db);
  });

  it('bot.ts 不再把裸 userId 直传给 read() 的 subject，改经 memoryScopeSubjects', () => {
    const botSource = source('packages/telegram/src/bot.ts');
    // 改造前的确切形态：第二个位置参数（subject）与第四个位置参数（actorUserId）用的是
    // 同一个裸 access.userId——`path()` 改新布局后，前者需要是复合键，后两者仍是裸 id。
    expect(botSource).not.toContain(
      code('"primemory", access.userId, access.effectiveRole, access.userId, true,'),
    );
    expect(botSource).toContain(
      code('memoryScopeSubjects(TELEGRAM_SOURCE_ID, access.userId).primemory'),
    );
    // lastOwnerRead 的键必须保持裸 id 不变——它与 WebUI/`/memory` 两侧的问责查询共用同一个键，
    // 改成复合键会让 `/memory` 命令自己都查不到刚落的那条「被 owner 看过」记录。
    expect(botSource).toContain(code('dependencies.memory.lastOwnerRead(access.userId)'));
  });
});
