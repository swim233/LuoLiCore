import { createHash } from 'node:crypto';
import { watch } from 'chokidar';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import type { Role } from '@luoli/shared';
import { roleRank } from '@luoli/shared';
import type { Sqlite } from '@luoli/db';

const frontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().max(500),
  'allowed-tools': z.array(z.string()).optional(),
  'min-role': z.enum(['blocked', 'limited', 'trusted', 'owner']).default('trusted'),
  model: z.string().optional(),
  version: z.union([z.string(), z.number()]).optional(),
  enabled: z.boolean().default(true),
});

export interface SkillDefinition {
  name: string;
  description: string;
  body: string;
  dir: string;
  allowedTools?: string[];
  minRole: Role;
  model?: string;
  enabled: boolean;
  files: string[];
  loadError?: string;
}

export class SkillLoader {
  readonly #skills = new Map<string, SkillDefinition>();

  constructor(private readonly db: Sqlite, readonly directory: string) {}
  #watcher: ReturnType<typeof watch> | null = null;

  scan(): SkillDefinition[] {
    this.#skills.clear();
    let directories: string[] = [];
    try { directories = readdirSync(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const directory of directories) {
      const path = join(this.directory, directory, 'SKILL.md');
      try {
        const raw = readFileSync(path, 'utf8');
        const parsed = matter(raw);
        const meta = frontmatterSchema.parse(parsed.data);
        if (meta.name !== directory) throw new Error('skill name must equal directory name');
        const files = readdirSync(join(this.directory, directory), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile()).map((entry) => relative(join(this.directory, directory), join(entry.parentPath, entry.name)));
        const skill: SkillDefinition = { name: meta.name, description: meta.description, body: parsed.content.trim(), dir: join(this.directory, directory), minRole: meta['min-role'], enabled: meta.enabled, files };
        if (meta['allowed-tools']) skill.allowedTools = meta['allowed-tools'];
        if (meta.model) skill.model = meta.model;
        this.#skills.set(skill.name, skill);
        this.persist(skill, path, raw, meta);
      } catch (error) {
        const skill: SkillDefinition = { name: directory, description: '', body: '', dir: dirname(path), minRole: 'owner', enabled: false, files: [], loadError: error instanceof Error ? error.message : String(error) };
        this.#skills.set(directory, skill);
        this.persist(skill, path, '', {});
      }
    }
    return [...this.#skills.values()];
  }
  startWatching(): void {
    if (this.#watcher) return;
    this.#watcher = watch(this.directory, { ignoreInitial: true });
    let pending: ReturnType<typeof setTimeout> | null = null;
    this.#watcher.on('all', () => { if (pending) clearTimeout(pending); pending = setTimeout(() => { this.scan(); }, 100); });
  }

  async close(): Promise<void> {
    await this.#watcher?.close();
    this.#watcher = null;
  }

  catalog(role: Role): Array<{ name: string; description: string }> {
    return [...this.#skills.values()].filter((skill) => skill.enabled && !skill.loadError && roleRank(role) >= roleRank(skill.minRole)).map(({ name, description }) => ({ name, description }));
  }

  load(name: string, role: Role, roleTools: string[]): Record<string, unknown> {
    const skill = this.#skills.get(name);
    if (!skill || !skill.enabled || skill.loadError) return { ok: false, error: `Skill 不存在或已禁用: ${name}` };
    if (roleRank(role) < roleRank(skill.minRole)) return { ok: false, error: '权限不足' };
    const allowedTools = skill.allowedTools ? roleTools.filter((tool) => skill.allowedTools!.includes(tool)) : roleTools;
    return { ok: true, name, body: skill.body, dir: skill.dir, files: skill.files, allowedTools, modelSuggestion: skill.model ?? null };
  }

  resolveResource(uri: string): string {
    const match = /^skill:\/\/([^/]+)\/(.+)$/.exec(uri);
    if (!match) throw new Error('invalid_skill_uri');
    const [, name, relativePath] = match;
    const skill = this.#skills.get(name!);
    if (!skill || !skill.enabled) throw new Error('skill_unavailable');
    const path = resolve(skill.dir, relativePath!);
    const root = resolve(skill.dir);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('path_outside_skill');
    return path;
  }

  private persist(skill: SkillDefinition, path: string, raw: string, frontmatter: unknown): void {
    const hash = createHash('sha256').update(raw).digest('hex');
    this.db.prepare(`INSERT INTO skills(name,path,description,min_role,allowed_tools_json,model_alias,enabled,content_hash,frontmatter_json,load_error,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET path=excluded.path,description=excluded.description,min_role=excluded.min_role,
      allowed_tools_json=excluded.allowed_tools_json,model_alias=excluded.model_alias,enabled=excluded.enabled,content_hash=excluded.content_hash,
      frontmatter_json=excluded.frontmatter_json,load_error=excluded.load_error,updated_at=excluded.updated_at`).run(skill.name, path, skill.description, skill.minRole,
      skill.allowedTools ? JSON.stringify(skill.allowedTools) : null, skill.model ?? null, skill.enabled ? 1 : 0, hash, JSON.stringify(frontmatter), skill.loadError ?? null, Date.now());
  }
}
