import { createHash } from 'node:crypto';
import { watch } from 'chokidar';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import type { Role } from '@luoli/shared';
import { roleRank } from '@luoli/shared';
import type { Sqlite } from '@luoli/db';

const VALID_ROLES: Record<Role, true> = { blocked: true, limited: true, trusted: true, owner: true };
const frontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().max(500),
  'allowed-tools': z.array(z.string()).optional(),
  'min-role': z.enum(['blocked', 'limited', 'trusted', 'owner']).optional(),
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
export interface SkillWriteInput {
  description?: string | undefined;
  body?: string | undefined;
  allowedTools?: string[] | undefined;
  minRole?: Role | undefined;
  model?: string | null | undefined;
  enabled?: boolean | undefined;
}
interface NormalizedSkillWriteInput {
  description: string;
  body: string;
  allowedTools: string[];
  minRole: Role;
  model: string | null;
  enabled: boolean;
}

export class SkillLoader {
  readonly #skills = new Map<string, SkillDefinition>();

  readonly #defaultMinRole: () => Role;
  constructor(private readonly db: Sqlite, readonly directory: string, defaultMinRole: Role | (() => Role) = 'trusted') {
    this.#defaultMinRole = typeof defaultMinRole === 'function' ? defaultMinRole : () => defaultMinRole;
  }
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
        const skill: SkillDefinition = { name: meta.name, description: meta.description, body: parsed.content.trim(), dir: join(this.directory, directory), minRole: meta['min-role'] ?? this.#defaultMinRole(), enabled: meta.enabled, files };
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
  read(name: string): SkillDefinition | null {
    const skill = this.#skills.get(name);
    return skill ? { ...skill, files: [...skill.files], ...(skill.allowedTools ? { allowedTools: [...skill.allowedTools] } : {}) } : null;
  }

  create(name: string, input: SkillWriteInput): SkillDefinition {
    this.validateInput(input);
    this.assertName(name);
    if (this.#skills.has(name) || existsSync(join(this.directory, name))) throw new Error('skill_already_exists');
    if (typeof input.description !== 'string' || typeof input.body !== 'string') throw new Error('skill_description_and_body_required');
    return this.write(name, {
      description: input.description,
      body: input.body,
      allowedTools: input.allowedTools ?? [],
      minRole: input.minRole ?? this.#defaultMinRole(),
      model: input.model ?? null,
      enabled: input.enabled ?? true,
    });
  }

  update(name: string, input: SkillWriteInput): SkillDefinition {
    this.validateInput(input);
    this.assertName(name);
    const current = this.#skills.get(name);
    if (!current || current.loadError) throw new Error('skill_not_found');
    return this.write(name, {
      description: input.description ?? current.description,
      body: input.body ?? current.body,
      allowedTools: input.allowedTools ?? current.allowedTools ?? [],
      minRole: input.minRole ?? current.minRole,
      model: input.model === undefined ? current.model ?? null : input.model,
      enabled: input.enabled ?? current.enabled,
    });
  }

  remove(name: string): boolean {
    this.assertName(name);
    const path = join(this.directory, name);
    if (!existsSync(path) && !this.#skills.has(name)) return false;
    if (existsSync(path)) rmSync(path, { recursive: true });
    this.#skills.delete(name);
    this.db.prepare('DELETE FROM skills WHERE name=?').run(name);
    return true;
  }

  private assertName(name: string): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('invalid_skill_name');
  }

  private validateInput(input: SkillWriteInput): void {
    if (input.description !== undefined && typeof input.description !== 'string') throw new Error('invalid_skill_description');
    if (input.body !== undefined && typeof input.body !== 'string') throw new Error('invalid_skill_body');
    if (input.allowedTools !== undefined && (!Array.isArray(input.allowedTools) || input.allowedTools.some((entry) => typeof entry !== 'string'))) throw new Error('invalid_skill_allowed_tools');
    if (input.minRole !== undefined && !(input.minRole in VALID_ROLES)) throw new Error('invalid_skill_min_role');
    if (input.model !== undefined && input.model !== null && typeof input.model !== 'string') throw new Error('invalid_skill_model');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('invalid_skill_enabled');
  }

  private write(name: string, input: NormalizedSkillWriteInput): SkillDefinition {
    const directory = join(this.directory, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'SKILL.md');
    const data: Record<string, unknown> = {
      name,
      description: input.description,
      'allowed-tools': input.allowedTools,
      'min-role': input.minRole,
      enabled: input.enabled,
    };
    if (input.model) data.model = input.model;
    const raw = matter.stringify(`${input.body.trim()}\n`, data);
    const temporary = join(directory, `.SKILL.md.${process.pid}.tmp`);
    writeFileSync(temporary, raw, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    this.scan();
    const written = this.#skills.get(name);
    if (!written || written.loadError) throw new Error(written?.loadError ?? 'skill_write_failed');
    return this.read(name)!;
  }

  catalog(role: Role): Array<{ name: string; description: string }> {
    return [...this.#skills.values()].filter((skill) => skill.enabled && !skill.loadError && roleRank(role) >= roleRank(skill.minRole)).map(({ name, description }) => ({ name, description }));
  }

  load(name: string, role: Role, roleTools: string[]): Record<string, unknown> {
    const skill = this.#skills.get(name);
    if (!skill || !skill.enabled || skill.loadError) return { ok: false, error: `Skill 不存在或已禁用: ${name}` };
    if (roleRank(role) < roleRank(skill.minRole)) return { ok: false, error: '权限不足' };
    const narrowed = skill.allowedTools ? roleTools.filter((tool) => skill.allowedTools!.includes(tool)) : null;
    // `narrows` 必须单独交出去：未声明 `allowed-tools` 的 skill **不收窄**（docs/07 §4），而
    // `allowedTools` 在这一档等于「当前全部可用工具」。调用方分不清这两件事，就会把它并进
    // 本轮允许集 —— 于是后载入一个不声明的 skill 正好抹掉前一个 skill 的收窄。
    return { ok: true, name, body: skill.body, dir: skill.dir, files: skill.files, allowedTools: narrowed ?? roleTools, narrows: narrowed !== null, modelSuggestion: skill.model ?? null };
  }

  resolveResource(uri: string, role: Role): string {
    const match = /^skill:\/\/([^/]+)\/(.+)$/.exec(uri);
    if (!match) throw new Error('invalid_skill_uri');
    const [, name, relativePath] = match;
    const skill = this.#skills.get(name!);
    if (!skill || !skill.enabled || skill.loadError) throw new Error('skill_unavailable');
    if (roleRank(role) < roleRank(skill.minRole)) throw new Error('skill_forbidden');
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
