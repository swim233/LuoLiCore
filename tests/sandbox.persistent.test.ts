import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SandboxContainerRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContainerManager, chatCandidates, containerNameFor, hardExpiryFor, reapReasonFor, resolveChatTarget, sanitizeDockerToken, sanitizeLogName, sandboxLabel, specHashOf, type ChatCandidate, type ContainerRuntimeConfig } from '@luoli/core';

/**
 * 会话级持久容器的**判定层**（docs/05 §5.5）。这一份不碰 docker：TTL 两档、spec 指纹、
 * 名字合法化、按名字定位会话 —— 全是纯函数，能不能正确回收与会不会重置错群的容器都由它们决定。
 * 真起容器的那条路在 `sandbox.containers.docker.test.ts`（docker 不可用时整份 skip）。
 */

const config = (overrides: Partial<ContainerRuntimeConfig> = {}): ContainerRuntimeConfig => ({
  dockerBin: 'docker', image: 'luoli-sandbox:latest', memoryMb: 512, cpus: 1, pidsLimit: 128, readOnlyRoot: true, tmpfsMb: 64,
  maxOutputBytes: 65_536,
  persistent: { enabled: true, idleTtlMs: 86_400_000, maxLifetimeMs: 0, maxContainers: 16, network: 'bridge', reapCron: '*/5 * * * *' },
  ...overrides,
});

describe('持久容器 · TTL 两档', () => {
  const row = (patch: { expiresAt?: number; hardExpiresAt?: number | null; pinned?: number }) =>
    ({ expiresAt: 2000, hardExpiresAt: null, pinned: 0, ...patch });

  it('滑动到期：没到不收，到了就收', () => {
    expect(reapReasonFor(row({ expiresAt: 2000 }), 1999)).toBeNull();
    expect(reapReasonFor(row({ expiresAt: 2000 }), 2000)).toBe('idle');
  });

  it('钉住豁免滑动那一档', () => {
    expect(reapReasonFor(row({ expiresAt: 1000, pinned: 1 }), 9999)).toBeNull();
  });

  /**
   * 这一条是这套 TTL 的核心取舍：**钉住豁免不了绝对上限**。豁免了它就不是上限了，
   * 而「容器最长活 N 天」这个承诺在 WebUI 上是写出来的。
   */
  it('钉住豁免不了绝对上限，而且绝对上限优先于滑动', () => {
    expect(reapReasonFor(row({ expiresAt: 9999, hardExpiresAt: 500, pinned: 1 }), 600)).toBe('hard');
    expect(reapReasonFor(row({ expiresAt: 100, hardExpiresAt: 100 }), 200)).toBe('hard');
  });

  /** `maxLifetimeMs: 0` = 不设上限，不是「立刻过期」（docs/11：本仓库里 0 一律是「不清」）。 */
  it('maxLifetimeMs 为 0 时 hard_expires_at 是 NULL 而不是 createdAt', () => {
    expect(hardExpiryFor(1_000_000, 0)).toBeNull();
    expect(hardExpiryFor(1_000_000, 5_000)).toBe(1_005_000);
    expect(reapReasonFor(row({ expiresAt: 9999, hardExpiresAt: hardExpiryFor(1_000_000, 0) }), 8_000_000)).toBe('idle');
  });
});

describe('持久容器 · 容器名与日志名', () => {
  /**
   * 负数 chatId 是常态（超级群），而 docker 容器名必须以字母数字开头。
   * 顺带钉住那个**既有 bug**：WebUI 试跑的 turnId 是 `dryrun:<ulid>`，冒号不在合法字符集里，
   * docker 模式下那条路的 `bash` 一直以 `invalid name` 收场而不是一个沙箱层的错误。
   */
  it('负数 chatId 与带冒号的 turnId 都合法化成 docker 收得下的名字', () => {
    const valid = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
    expect(containerNameFor('-1001234567')).toBe('luoli-box-n1001234567');
    expect(valid.test(containerNameFor('-1001234567'))).toBe(true);
    expect(valid.test(containerNameFor('8899001'))).toBe(true);
    expect(valid.test(sanitizeDockerToken('dryrun:01M0CKK6W018B5KS9613SNEX5J'))).toBe(true);
    expect(valid.test(sanitizeDockerToken('webui:prompt-preview'))).toBe(true);
    // 不同会话不能撞名，否则一个群的命令会跑进另一个群的容器。
    expect(containerNameFor('-1001')).not.toBe(containerNameFor('1001'));
  });

  /** 后台日志名是拼进 shell 的路径片段：`..` 或 `/` 溜进去就能往工作区之外写。 */
  it('后台日志名挡住路径穿越与空名', () => {
    expect(sanitizeLogName('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeLogName('a/b')).toBe('a-b');
    expect(sanitizeLogName('...')).toBe('task');
    expect(sanitizeLogName('')).toBe('task');
    expect(sanitizeLogName('web-server_1.log')).toBe('web-server_1.log');
  });
});

describe('持久容器 · spec 指纹', () => {
  /**
   * 容器跑起来之后 `--memory` / `--network` / image 都改不动了。没有这条指纹，运维在 WebUI
   * 换了镜像之后所有已存在的容器会一直用旧的，而界面上显示的是新的。
   */
  it('影响容器形态的每一项都进指纹，不影响的不进', () => {
    const base = specHashOf(config());
    expect(specHashOf(config({ image: 'other:latest' }))).not.toBe(base);
    expect(specHashOf(config({ memoryMb: 1024 }))).not.toBe(base);
    expect(specHashOf(config({ cpus: 2 }))).not.toBe(base);
    expect(specHashOf(config({ pidsLimit: 64 }))).not.toBe(base);
    expect(specHashOf(config({ readOnlyRoot: false }))).not.toBe(base);
    expect(specHashOf(config({ tmpfsMb: 128 }))).not.toBe(base);
    expect(specHashOf(config({ persistent: { ...config().persistent, network: 'none' } }))).not.toBe(base);
    // TTL / 上限 / cron 改了不用重建容器 —— 它们不是 `docker run` 的参数。
    expect(specHashOf(config({ persistent: { ...config().persistent, idleTtlMs: 1, maxContainers: 99, reapCron: '0 * * * *' } }))).toBe(base);
    expect(specHashOf(config({ dockerBin: '/usr/bin/docker' }))).toBe(base);
  });
});

describe('持久容器 · 按名字定位会话', () => {
  const candidates: ChatCandidate[] = [
    { chatId: '-1001', label: '隆福饭搭子', type: 'group' },
    { chatId: '-1002', label: '隆福寺开发组 (@lfs_dev)', type: 'group' },
    { chatId: '8899001', label: '阿离 (@ali)', type: 'private' },
  ];

  it('唯一命中就解析，chat id 直接收', () => {
    expect(resolveChatTarget(candidates, '饭搭子')).toEqual({ ok: true, chatId: '-1001', label: '隆福饭搭子' });
    expect(resolveChatTarget(candidates, '-1002')).toEqual({ ok: true, chatId: '-1002', label: '隆福寺开发组 (@lfs_dev)' });
    expect(resolveChatTarget(candidates, '@ali')).toMatchObject({ ok: true, chatId: '8899001' });
  });

  /**
   * **这一条是这套解析的全部意义**：一次模糊匹配错了，`container_reset` 重置的就是另一个群的
   * 容器。歧义时交回候选并拒绝，不挑一个（「摘除比伪造安全」，docs/reviews/16 §5）。
   */
  it('匹配到多个就拒绝，并把候选交回去', () => {
    const result = resolveChatTarget(candidates, '隆福');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('ambiguous_chat');
    expect(result.ok === false && result.candidates.map((entry) => entry.chatId)).toEqual(['-1001', '-1002']);
  });

  it('零命中交回现有列表而不是空成功', () => {
    const result = resolveChatTarget(candidates, '不存在的群');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('chat_not_found');
    expect(result.ok === false && result.candidates).toHaveLength(3);
    expect(resolveChatTarget(candidates, '   ').ok).toBe(false);
  });

  /** 库里还没登记名字的会话（刚加进来的群、定时任务的落点）不该挡住 owner 用 id 直接点名。 */
  it('没登记过的纯数字 id 照收', () => {
    expect(resolveChatTarget(candidates, '-100999')).toEqual({ ok: true, chatId: '-100999', label: '未登记会话 -100999' });
  });
});

describe('持久容器 · 会话名取自 principals', () => {
  /**
   * 群取 `chat:<id>` 的 `display_name`，**私聊要优先取 `user:<id>`** —— `chat:<id>` 对私聊
   * 只存了 `first_name`。与 WebUI 的 `chatIdentity()` 同一套 join；两处漂开的表现是
   * 「界面上叫这个名字，跟模型说这个名字它找不到」。
   */
  it('私聊取 user 那一行的全名，群取 chat 那一行的标题', () => {
    const path = './data/containers-names.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    const insert = db.prepare("INSERT INTO principals(id,kind,tg_id,role,display_name,username,chat_type,first_seen_at,updated_at) VALUES (?,?,?,'trusted',?,?,?,0,0)");
    insert.run('chat:-1001', 'chat', '-1001', '隆福饭搭子', null, 'supergroup');
    insert.run('chat:8899001', 'chat', '8899001', '阿', null, 'private');
    insert.run('user:8899001', 'user', '8899001', '阿离', 'ali', null);
    const candidates = chatCandidates(db);
    expect(candidates.find((entry) => entry.chatId === '-1001')).toEqual({ chatId: '-1001', label: '隆福饭搭子', type: 'group' });
    // 取到的是 `阿离 (@ali)` 而不是 chat 行里那个 first_name「阿」。
    expect(candidates.find((entry) => entry.chatId === '8899001')).toEqual({ chatId: '8899001', label: '阿离 (@ali)', type: 'private' });
    closeDatabase(db);
  });
});

describe('持久容器 · 仓储与容量', () => {
  const open = (name: string) => {
    const path = `./data/${name}.test.db`;
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    return db;
  };

  it('touch 只推进滑动到期，不动绝对上限', () => {
    const db = open('containers-repo');
    const repo = new SandboxContainerRepository(db);
    const created = repo.create({ chatId: '-1001', name: 'luoli-box-n1001', containerId: 'abc', image: 'i', specHash: 'h',
      hasSetsid: true, expiresAt: 1000, hardExpiresAt: 5000 });
    expect(created.hardExpiresAt).toBe(5000);
    repo.touch('-1001', 9999);
    const after = repo.byChat('-1001')!;
    expect(after.expiresAt).toBe(9999);
    expect(after.hardExpiresAt).toBe(5000);
    expect(after.execCount).toBe(1);
    closeDatabase(db);
  });

  /** 撞上限是**直接报错**而不是退回一次性容器（决策 6）—— 那样「为什么这个群没有容器」查不出来。 */
  it('容量按行数算，撞上限时 ensure 报错且不建容器', async () => {
    const db = open('containers-capacity');
    const repo = new SandboxContainerRepository(db);
    const manager = new ContainerManager(db, repo, () => config({ persistent: { ...config().persistent, maxContainers: 1 } }));
    repo.create({ chatId: '-1001', name: 'luoli-box-n1001', containerId: null, image: 'i', specHash: 'h', hasSetsid: true, expiresAt: Date.now() + 1e6, hardExpiresAt: null });
    expect(manager.capacity()).toEqual({ used: 1, max: 1 });
    const result = await manager.ensure('-1002', '/tmp/nowhere');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('sandbox_container_limit');
    expect(repo.count()).toBe(1);
    closeDatabase(db);
  });

  it('keep 的续期被绝对上限钳住', () => {
    const db = open('containers-keep');
    const repo = new SandboxContainerRepository(db);
    const manager = new ContainerManager(db, repo, () => config());
    const hardExpiresAt = Date.now() + 3_600_000;
    repo.create({ chatId: '-1001', name: 'luoli-box-n1001', containerId: null, image: 'i', specHash: 'h', hasSetsid: true, expiresAt: Date.now() + 1000, hardExpiresAt });
    const kept = manager.keep('-1001', { hours: 720 });
    expect(kept.ok).toBe(true);
    // 续到绝对上限就停 —— 钉住与续期都豁免不了它。
    expect(kept.ok === true && kept.row.expiresAt).toBe(hardExpiresAt);
    expect(manager.keep('-9999', { pin: true })).toMatchObject({ ok: false, error: 'container_not_found' });
    closeDatabase(db);
  });

  /** RUNTIME 块那一行要区分「没有容器 / 钉住 / 还剩多久」，压成一个数字就得靠猜（docs/06 §1）。 */
  it('expiryHintFor 三种状态各自分开', () => {
    const db = open('containers-hint');
    const repo = new SandboxContainerRepository(db);
    const manager = new ContainerManager(db, repo, () => config());
    expect(manager.expiryHintFor('-1001')).toEqual({ state: 'none' });
    repo.create({ chatId: '-1001', name: 'a', containerId: null, image: 'i', specHash: 'h', hasSetsid: true, expiresAt: 10_000, hardExpiresAt: null });
    expect(manager.expiryHintFor('-1001', 4_000)).toEqual({ state: 'ttl', remainingMs: 6_000 });
    repo.keep('-1001', { pinned: true });
    expect(manager.expiryHintFor('-1001', 4_000)).toEqual({ state: 'pinned' });
    // 钉住 + 有绝对上限时仍然会到期，剩余时间按上限算。
    repo.create({ chatId: '-1002', name: 'b', containerId: null, image: 'i', specHash: 'h', hasSetsid: true, expiresAt: 10_000, hardExpiresAt: 7_000 });
    repo.keep('-1002', { pinned: true });
    expect(manager.expiryHintFor('-1002', 4_000)).toEqual({ state: 'ttl', remainingMs: 3_000 });
    closeDatabase(db);
  });
});

describe('持久容器 · RUNTIME 块的措辞', () => {
  /** 模型不知道自己能起常驻进程的话，这个功能等于没做（docs/06 §1）。 */
  it('持久化开着时说清常驻 / 剩余 / 出不出网，关着时一个字不变', () => {
    const persistent = config().persistent;
    expect(sandboxLabel('docker', { ...persistent, enabled: false }, { state: 'none' })).toBe('docker');
    expect(sandboxLabel('none', persistent, { state: 'none' })).toBe('none');
    const ttl = sandboxLabel('docker', persistent, { state: 'ttl', remainingMs: 23 * 3_600_000 });
    expect(ttl).toContain('常驻容器');
    expect(ttl).toContain('23 小时后回收');
    expect(ttl).toContain('可出网');
    expect(ttl).toContain('重定向');
    expect(sandboxLabel('docker', persistent, { state: 'pinned' })).toContain('不会被回收');
    expect(sandboxLabel('docker', { ...persistent, network: 'none' }, { state: 'none' })).toContain('无网络');
  });
});
