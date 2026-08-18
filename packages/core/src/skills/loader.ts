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
  'requires-tools': z.array(z.string()).optional(),
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
  /**
   * 这份 skill 讲的是怎么用哪几个工具。**它们不在本轮可用集里时，这份 skill 整个不出现在目录里。**
   *
   * `allowed-tools` 是「载入后收窄到这些」，方向相反。少了这一条的实测代价：四份自撰写说明书
   * 只被 `min-role: owner` 挡着，而它们讲的 `install_mcp` / `define_tool` 受
   * `tools.selfExtend.*` 控制、出厂是关的 —— 模型读到说明书、找不到工具，然后花了八分钟
   * 用 `bash` 逆向代码库、自己拿 sessions 表里的 owner 会话去打 WebUI API 把事办了。
   * 目录里出现一份「教你用一个你没有的工具」的说明书，比没有这份说明书糟。
   */
  requiresTools?: string[];
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
  /** 写入端不暴露它（没有入口能设），但改一份已有 skill 时必须原样带回去，否则一次编辑就把它抹了。 */
  requiresTools: string[];
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
        if (meta['requires-tools']) skill.requiresTools = meta['requires-tools'];
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
    return skill ? { ...skill, files: [...skill.files], ...(skill.allowedTools ? { allowedTools: [...skill.allowedTools] } : {}),
      ...(skill.requiresTools ? { requiresTools: [...skill.requiresTools] } : {}) } : null;
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
      requiresTools: [],
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
      requiresTools: current.requiresTools ?? [],
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
    if (input.requiresTools.length) data['requires-tools'] = input.requiresTools;
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

  /**
   * @param availableTools 本轮真正可用的工具名。给了就按 `requires-tools` 过滤；不给（WebUI 预览
   *   之外没有这种调用点）则不过滤 —— 少一个参数不该让整份目录消失。
   */
  catalog(role: Role, availableTools?: readonly string[]): Array<{ name: string; description: string }> {
    const available = availableTools ? new Set(availableTools) : null;
    return [...this.#skills.values()]
      .filter((skill) => skill.enabled && !skill.loadError && roleRank(role) >= roleRank(skill.minRole))
      .filter((skill) => !available || !skill.requiresTools || skill.requiresTools.every((tool) => available.has(tool)))
      .map(({ name, description }) => ({ name, description }));
  }

  load(name: string, role: Role, roleTools: string[]): Record<string, unknown> {
    const skill = this.#skills.get(name);
    if (!skill || !skill.enabled || skill.loadError) return { ok: false, error: `Skill 不存在或已禁用: ${name}` };
    if (roleRank(role) < roleRank(skill.minRole)) return { ok: false, error: '权限不足' };
    // 目录里已经按 `requires-tools` 滤过一遍，这里再挡一次：模型完全可以凭上一轮记住的名字
    // 直接 `load_skill` 过来（`admit()` 那套「目录过滤不是边界」的同一个道理）。
    const missing = (skill.requiresTools ?? []).filter((tool) => !roleTools.includes(tool));
    if (missing.length) return { ok: false, error: 'skill_requires_unavailable_tools', hint: `${name} 讲的是怎么用 ${missing.join(' / ')}，而这一轮它们不可用（多半是对应的功能开关没打开），先别照它做。` };
    const narrowed = skill.allowedTools ? roleTools.filter((tool) => skill.allowedTools!.includes(tool)) : null;
    // 交集为空 = 这个 skill 声明的工具在本轮一个都用不了，此时**必须让载入失败**而不是交出一个空集：
    // 下游把空集并进 `turn.skillAllowedTools` 之后，`admit()` 判的是 `skillAllowedTools?.size &&`
    // —— size 0 是 falsy，整条收窄被跳过，于是「收窄到零个工具」在运行时等于「完全不收窄」，
    // 一个 `allowed-tools: [nonexistent]` 的 skill 反而拿到该角色的全部工具。
    if (narrowed !== null && narrowed.length === 0) return { ok: false, error: 'skill_tools_unavailable', hint: `${name} 声明的 allowed-tools 在本轮一个都不可用（${skill.allowedTools!.join(' / ')}），换个办法或先让运维打开这些工具。` };
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
