import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ulid } from 'ulid';
import { applyPatch, createTwoFilesPatch, parsePatch, reversePatch } from 'diff';
import type { Sqlite } from '@luoli/db';

interface PromptPaths {
  character: string;
  assist: string;
  publicMemory: string;
  privateMemory: string;
}

export class PromptDocuments {
  constructor(private readonly db: Sqlite, private readonly directory: string) {}
  ensure(): void {
    for (const scope of ['character', 'assist', 'pubmemory'] as const) {
      const paths = this.paths('');
      const path = scope === 'character' ? paths.character : scope === 'assist' ? paths.assist : paths.publicMemory;
      const content = this.read(path);
      const id = `${scope}:global`;
      const now = Date.now();
      this.db.prepare(`INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path,bytes=excluded.bytes,tokens=excluded.tokens,content_hash=excluded.content_hash,updated_at=excluded.updated_at`).run(
        id, scope, null, path, Buffer.byteLength(content), Math.ceil([...content].length * 0.6) + 4, createHash('sha256').update(content).digest('hex'), now);
    }
  }

  paths(userId: string, characterOverride?: string): PromptPaths {
    return {
      character: resolve(this.directory, characterOverride ?? 'CHARACTER.md'),
      assist: resolve(this.directory, 'ASSIST.md'),
      publicMemory: resolve(this.directory, 'PUBMEMORY.md'),
      privateMemory: resolve(this.directory, 'private', userId, 'PRIMEMORY.md'),
    };
  }

  readForPrompt(input: { userId: string; isPrivate: boolean; characterOverride?: string }): { character: string; assist: string; publicMemory: string; privateMemory?: string } {
    const paths = this.paths(input.userId, input.characterOverride);
    const output: { character: string; assist: string; publicMemory: string; privateMemory?: string } = {
      character: this.read(paths.character), assist: this.read(paths.assist), publicMemory: this.read(paths.publicMemory),
    };
    if (input.isPrivate) output.privateMemory = this.read(paths.privateMemory);
    return output;
  }

  save(scope: 'character' | 'assist' | 'pubmemory' | 'primemory', userId: string | null, content: string, actor: string): void {
    const paths = this.paths(userId ?? '');
    const pathByScope: Record<string, string> = { character: paths.character, assist: paths.assist, pubmemory: paths.publicMemory, primemory: paths.privateMemory };
    const path = pathByScope[scope]!;
    const old = this.read(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${ulid()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    const id = `${scope}:${userId ?? 'global'}`;
    const now = Date.now();
    const tokens = Math.ceil([...content].length * 0.6) + 4;
    const hash = createHash('sha256').update(content).digest('hex');
    this.db.prepare(`INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,tokens=excluded.tokens,content_hash=excluded.content_hash,updated_at=excluded.updated_at`).run(id, scope, userId, path, Buffer.byteLength(content), tokens, hash, now);
    const diff = createTwoFilesPatch('before', 'after', old, content, '', '', { context: 3 });
    this.db.prepare('INSERT INTO memory_revisions(id,doc_id,ts,actor,op,diff,bytes_after) VALUES (?,?,?,?,?,?,?)').run(ulid(), id, now, actor, 'manual', diff, Buffer.byteLength(content));
  }
  rollback(id: string, revisionId: string, actor: string): { id: string; bytes: number } {
    const row = this.db.prepare('SELECT scope,subject,path FROM memory_docs WHERE id=?').get(id) as { scope: 'character' | 'assist' | 'pubmemory' | 'primemory'; subject: string | null; path: string } | undefined;
    const revisions = this.db.prepare('SELECT id,diff FROM memory_revisions WHERE doc_id=? ORDER BY ts DESC,id DESC').all(id) as Array<{ id: string; diff: string }>;
    const targetIndex = revisions.findIndex((entry) => entry.id === revisionId);
    if (!row || targetIndex < 0) throw new Error('prompt_revision_not_found');
    let content = this.read(row.path);
    for (const revision of revisions.slice(0, targetIndex)) {
      const patch = parsePatch(revision.diff)[0];
      if (!patch) throw new Error('prompt_revision_invalid');
      const restored = applyPatch(content, reversePatch(patch));
      if (restored === false) throw new Error('prompt_revision_conflict');
      content = restored;
    }
    this.save(row.scope, row.subject, content, actor);
    return { id, bytes: Buffer.byteLength(content) };
  }

  private read(path: string): string {
    try { return readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }
}

export class AgentResultStore {
  constructor(private readonly directory: string) {}

  put(runId: string, value: string): string {
    const path = join(this.directory, `${runId}.txt`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { mode: 0o600 });
    return path;
  }

  read(path: string, offset: number, limit: number): { content: string; nextOffset: number | null } {
    const buffer = readFileSync(path);
    const content = buffer.subarray(offset, offset + limit).toString('utf8');
    return { content, nextOffset: offset + limit < buffer.length ? offset + limit : null };
  }
}
