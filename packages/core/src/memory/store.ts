import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { ulid } from 'ulid';
import type { Role } from '@luoli/shared';
import { estimateTextTokens, roleRank } from '@luoli/shared';
import type { Sqlite } from '@luoli/db';

interface MemoryDocument {
  id: string;
  scope: 'assist' | 'character' | 'pubmemory' | 'primemory';
  subject: string | null;
  path: string;
  content: string;
}

interface PendingWrite {
  scope: 'pubmemory' | 'primemory';
  subject: string | null;
  section: string;
  lines: string[];
  actor: string;
  turnId: string;
  chatId: string;
  userId: string;
}

// 与上下文、提示词共用同一把尺子：记忆的软/硬上限是按 token 写的配置，估算器不一致时
// 「还剩多少额度」在两个页面上会给出两个数（docs/06 §3）。
const estimateTokens = estimateTextTokens;

function normalized(content: string): string {
  return content.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 来源标注不参与相似度：`jaccard` 数的是字符集合，`<!-- src: chat … -->` 里那串
 *  字母数字会把并集撑大，让「同一条」看起来只有六七成像。 */
function stripSource(line: string): string {
  return line.replace(/<!--[^]*?-->/g, '').trim();
}

function jaccard(a: string, b: string): number {
  const left = new Set([...normalized(a)]);
  const right = new Set([...normalized(b)]);
  const intersection = [...left].filter((char) => right.has(char)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 1;
}
function parseSections(content: string): { title: string; sections: Map<string, string[]> } {
  const lines = content.split('\n');
  const title = lines.find((line) => line.startsWith('# ')) ?? '# 记忆';
  const sections = new Map<string, string[]>();
  let current = '其他';
  for (const line of lines) {
    if (line.startsWith('## ')) { current = line.slice(3).trim(); if (!sections.has(current)) sections.set(current, []); continue; }
    if (line.startsWith('- ')) { const values = sections.get(current) ?? []; values.push(line); sections.set(current, values); }
  }
  return { title, sections };
}

function serializeSections(title: string, sections: Map<string, string[]>): string {
  return `${title}\n\n${[...sections].map(([name, lines]) => `## ${name}\n${lines.join('\n')}`).join('\n\n')}\n`;
}

export class MemoryStore {
  readonly #pending = new Map<string, PendingWrite[]>();

  constructor(private readonly db: Sqlite, readonly directory: string, private readonly softLimit: number, private readonly hardLimit: number, private readonly maxSections = 12, private readonly forgetRetentionDays = 30, private readonly log?: { event(input: { level: 'info' | 'warn'; kind: string; summary: string; data?: unknown }): number }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  read(scope: 'assist' | 'character' | 'pubmemory' | 'primemory', subject: string | null, actorRole: Role, actorUserId?: string, isPrivate = false): MemoryDocument {
    if (scope === 'primemory') {
      if (!isPrivate) throw new Error('private_memory_forbidden');
      if (subject !== actorUserId && actorRole !== 'owner') throw new Error('private_memory_forbidden');
      if (subject !== actorUserId) this.log?.event({ level: 'warn', kind: 'memory.owner_read_private', summary: 'Owner read another user private memory', data: { targetUserId: subject } });
    }
    const document = this.readRaw(scope, subject);
    this.log?.event({ level: 'info', kind: 'memory.read', summary: `Read ${scope}`, data: { scope, subject, bytes: Buffer.byteLength(document.content) } });
    return document;
  }

  queueWrite(input: PendingWrite, role: Role, isPrivate: boolean, pubWriteMinRole: Role): Record<string, unknown> {
    if (input.scope === 'primemory' && (!isPrivate || input.subject !== input.userId)) return { ok: false, error: 'primemory_scope_forbidden' };
    if (input.scope === 'pubmemory' && roleRank(role) < roleRank(pubWriteMinRole)) return { ok: false, error: '权限不足' };
    const document = this.read(input.scope, input.subject, role, input.userId, isPrivate);
    const existing = document.content.split('\n').filter((line) => line.startsWith('- ')).map(stripSource);
    const unique = input.lines.filter((line) => !existing.some((candidate) => jaccard(candidate, stripSource(line)) > 0.85));
    if (!unique.length) return { ok: true, skipped: true, reason: '已存在相似条目' };
    const source = `<!-- src: chat ${input.chatId} by ${input.userId} at ${new Date().toISOString()} -->`;
    const annotated = unique.map((line) => `- ${line.replace(/^\s*-\s*/, '')}  ${source}`);
    const projected = `${document.content}\n\n## ${input.section}\n${annotated.join('\n')}\n`;
    if (estimateTokens(projected) > this.hardLimit) return { ok: false, error: 'memory_hard_limit', hint: '请先整理现有记忆' };
    const list = this.#pending.get(input.turnId) ?? [];
    list.push({ ...input, lines: annotated });
    this.#pending.set(input.turnId, list);
    return { ok: true, pending: true, softLimitExceeded: estimateTokens(projected) > this.softLimit };
  }

  /**
   * `queueWrite` 的去重与硬上限判据取的是**工具调用那一刻**的快照，而落盘发生在轮末：这中间
   * 别的轮次完全可能已经把同一条写进同一份文档（PUBMEMORY 是全局单份）。`flush` 本身是同步的
   * ——`readRaw` → 改 → `persist` 之间没有 await，事件循环插不进来，所以**不会丢更新**
   * （`docs/22 · I-05` 说的锁不是这里需要的东西）。真正会漏的是那两条判据：重复条目照样落盘，
   * 硬上限也会被越过。两条都在这里按新读到的内容再走一遍。
   */
  flush(turnId: string): Record<string, unknown> {
    const writes = this.#pending.get(turnId) ?? [];
    const grouped = new Map<string, PendingWrite[]>();
    for (const write of writes) {
      const key = `${write.scope}:${write.subject ?? 'global'}`;
      const list = grouped.get(key) ?? [];
      list.push(write);
      grouped.set(key, list);
    }
    let written = 0; let duplicates = 0; let rejected = 0;
    for (const group of grouped.values()) {
      const first = group[0]!;
      const document = this.readRaw(first.scope, first.subject);
      const parsed = parseSections(document.content || (first.scope === 'pubmemory' ? '# 公开记忆\n' : '# 私有记忆\n'));
      const landed = document.content.split('\n').filter((line) => line.startsWith('- ')).map(stripSource);
      for (const write of group) {
        const fresh = write.lines.filter((line) => {
          if (!landed.some((candidate) => jaccard(candidate, stripSource(line)) > 0.85)) { landed.push(stripSource(line)); return true; }
          duplicates += 1; return false;
        });
        if (!fresh.length) continue;
        const lines = parsed.sections.get(write.section) ?? [];
        lines.push(...fresh);
        parsed.sections.delete(write.section);
        parsed.sections.set(write.section, lines);
      }
      while (parsed.sections.size > this.maxSections) {
        // 「其他」自身不能当合并来源：它与目标是同一个数组，会把整段条目复制一份（docs/19 · R-MEM-01）。
        const oldest = [...parsed.sections.keys()].find((name) => name !== '其他');
        if (!oldest) break;
        const merged = [...(parsed.sections.get('其他') ?? []), ...(parsed.sections.get(oldest) ?? [])];
        parsed.sections.delete(oldest);
        parsed.sections.delete('其他');
        parsed.sections.set('其他', merged);
      }
      const content = serializeSections(parsed.title, parsed.sections);
      if (content === document.content) continue;
      // 硬上限是最后一道闸：`queueWrite` 放行时文档还小，落盘时可能已经被别的轮次写胖了。
      // 越过它去写等于让这份文档从此再也裁不回来。
      if (estimateTokens(content) > this.hardLimit) {
        rejected += 1;
        this.log?.event({ level: 'warn', kind: 'memory.hard_limit', summary: `Skipped ${first.scope} at hard limit`, data: { scope: first.scope, subject: first.subject, tokens: estimateTokens(content), hardLimit: this.hardLimit } });
        continue;
      }
      this.persist(document, content, first);
      written += 1;
      if (estimateTokens(content) > this.softLimit) {
        const pending = resolve(this.directory, '.pending', `${first.scope}-${first.subject ?? 'global'}.md`);
        mkdirSync(dirname(pending), { recursive: true, mode: 0o700 });
        writeFileSync(pending, content, { mode: 0o600 });
      }
    }
    this.#pending.delete(turnId);
    // 只在真有话说时挂字段：`documents: 0` 那条断言（tests/memory.operations.test.ts）问的是
    // 「abort 之后什么都没写」，恒定多两个 0 会让它变成在核对计数器而不是核对这件事。
    return { ok: true, documents: written, ...(duplicates ? { duplicates } : {}), ...(rejected ? { rejected } : {}) };
  }
  discard(turnId: string): number {
    const count = this.#pending.get(turnId)?.length ?? 0;
    this.#pending.delete(turnId);
    return count;
  }


  list(): Array<{ scope: string; subject: string | null; path: string; bytes: number; tokens: number }> {
    return this.db.prepare('SELECT scope,subject,path,bytes,tokens FROM memory_docs ORDER BY updated_at DESC').all() as Array<{ scope: string; subject: string | null; path: string; bytes: number; tokens: number }>;
  }
  forgetPrivate(userId: string, actor = `user:${userId}`): boolean {
    const document = this.readRaw('primemory', userId);
    if (!document.content) return false;
    const write: PendingWrite = { scope: 'primemory', subject: userId, section: 'forgetme', lines: [], actor, turnId: '', chatId: userId, userId };
    this.persist(document, '# 私有记忆\n', write, 'forget');
    if (this.forgetRetentionDays > 0) {
      const backup = resolve(this.directory, '.forgotten', userId, `${Date.now()}.md`);
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      writeFileSync(backup, document.content, { mode: 0o600 });
    }
    this.log?.event({ level: 'info', kind: 'memory.write', summary: 'Private memory forgotten', data: { scope: 'primemory', subject: userId, op: 'forget' } });
    return true;
  }

  private readRaw(scope: MemoryDocument['scope'], subject: string | null): MemoryDocument {
    const path = this.path(scope, subject);
    let content = '';
    try { content = readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { id: `${scope}:${subject ?? 'global'}`, scope, subject, path, content };
  }

  private path(scope: string, subject: string | null): string {
    const paths: Record<string, string> = {
      assist: join(this.directory, 'ASSIST.md'),
      character: join(this.directory, 'CHARACTER.md'),
      pubmemory: join(this.directory, 'PUBMEMORY.md'),
      primemory: join(this.directory, 'private', subject ?? 'invalid', 'PRIMEMORY.md'),
    };
    return paths[scope]!;
  }

  private persist(document: MemoryDocument, content: string, write: PendingWrite, operation = 'append'): void {
    mkdirSync(dirname(document.path), { recursive: true, mode: 0o700 });
    const old = document.content;
    const temporary = `${document.path}.${ulid()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, document.path);
    const now = Date.now();
    const hash = createHash('sha256').update(content).digest('hex');
    this.db.prepare(`INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,tokens=excluded.tokens,content_hash=excluded.content_hash,updated_at=excluded.updated_at`).run(document.id, document.scope, document.subject, document.path, Buffer.byteLength(content), estimateTokens(content), hash, now);
    const diff = createTwoFilesPatch('before', 'after', old, content, '', '', { context: 3 });
    this.db.prepare('INSERT INTO memory_revisions(id,doc_id,ts,actor,turn_id,chat_id,user_id,op,diff,bytes_after) VALUES (?,?,?,?,?,?,?,?,?,?)').run(ulid(), document.id, now, write.actor, write.turnId || null, write.chatId, write.userId, operation, diff, statSync(document.path).size);
    this.log?.event({ level: 'info', kind: 'memory.write', summary: `${operation} ${document.scope}`, data: { scope: document.scope, subject: document.subject, op: operation, bytesAfter: Buffer.byteLength(content) } });
  }
}
