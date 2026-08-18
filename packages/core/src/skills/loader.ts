import { createHash } from 'node:crypto';
import { watch } from 'chokidar';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import type { Role } from '@luoli/shared';
import { roleRank } from '@luoli/shared';
import type { Sqlite } from '@luoli/db';

const VALID_ROLES: Record<Role, true> = { blocked: true, limited: true, trusted: true, owner: true };

/**
 * 随包提交在 `skills/` 里的四份说明书 —— 模型写 plugin / 定义工具 / 装 MCP 之前要读的那份文档。
 * 它们经 `load_skill` 渐进式取用，所以平时只占目录里四行。`write_skill` 与 `install_skill`
 * 都拒绝覆写它们、WebUI 也只放行启停：模型把自己的说明书改掉之后，下一次它就是照着改坏的那份写的。
 *
 * **住在 loader 里而不是 `tools/authoring.ts`**：`persist()` 要靠它把 `source` 判成 `bundled`，
 * 而 authoring 反过来 import loader —— 放在那边就是一个 import 环。
 */
export const BUNDLED_SKILLS = ['writing-tools', 'writing-skills', 'writing-plugins', 'installing-mcp'] as const;
/** 装包时留下的痕迹（来源、时间、原档 sha256）。它在不在，决定 `source` 是 `package` 还是 `local`。 */
export const SKILL_PACKAGE_MARKER = '.package.json';

export const frontmatterSchema = z.object({
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
  readonly #onChange: (() => void) | undefined;
  /** 上一次扫描的 `name → content_hash`，用来判断这一次是不是真的变了（见 `scan()` 末尾）。 */
  #signature = new Map<string, string>();
  constructor(private readonly db: Sqlite, readonly directory: string, defaultMinRole: Role | (() => Role) = 'trusted', onChange?: () => void) {
    this.#defaultMinRole = typeof defaultMinRole === 'function' ? defaultMinRole : () => defaultMinRole;
    this.#onChange = onChange;
  }
  #watcher: ReturnType<typeof watch> | null = null;

  scan(): SkillDefinition[] {
    this.#skills.clear();
    let entries: Dirent[] = [];
    // ENOENT 与其余错误必须分开：目录不存在是「一个 skill 都没有」，而权限错误 / EIO 是
    // 「读不到」——后者绝不能一路走到下面的清理，那等于把整张表当成「盘上真的空了」删空。
    let readable = true;
    try { entries = readdirSync(this.directory, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      readable = false;
    }
    // **只认真正的子目录，且跳过点号开头的。** `.staging-*` / `.backups/` 靠这一条才能住在
    // `skills/` 里（装包要同分区 `renameSync` 落位，docs/07 §2.5）；顺带也修掉了一个独立的老问题：
    // 在这之前 `skills/` 下随便一个 `.DS_Store` 都会被当成 skill 目录扫出一行 `load_error`。
    // 符号链接同样不认（`Dirent.isDirectory()` 对它为假）：`resolveResource()` 的包含判断走
    // `resolve()` 而不是 `realpath`，一个指向别处的软链接等于给 `skill://` 开了条出口。
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
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
    // **`skills` 是盘上那批文件的读模型，不是真相**（docs/03 §2.10）。`persist()` 只 upsert，
    // 所以在这之前盘上删掉一个 skill 目录，那一行会永远留在表里、永远显示在扩展页 ——
    // 唯一会删行的是 `remove()`，而它只覆盖「从 WebUI/工具删」这一条路。
    if (readable) this.prune([...this.#skills.keys()]);
    const signature = new Map([...this.#skills].map(([name, skill]) => [name, `${skill.enabled}:${skill.loadError ?? ''}:${this.hashOf(name)}`]));
    const changed = signature.size !== this.#signature.size || [...signature].some(([name, value]) => this.#signature.get(name) !== value);
    this.#signature = signature;
    // watcher 的 100ms 去抖之外再挡一层：装一个包要写几十个文件，每一次写盘都广播的话，
    // 一次安装就是几十条 SSE + 几十次「WebUI 重新拉四个端点」。
    if (changed) this.#onChange?.();
    return [...this.#skills.values()];
  }

  private prune(keep: readonly string[]): void {
    const stale = this.db.prepare('SELECT name FROM skills').all() as Array<{ name: string }>;
    const alive = new Set(keep);
    for (const row of stale) if (!alive.has(row.name)) this.db.prepare('DELETE FROM skills WHERE name=?').run(row.name);
  }

  private hashOf(name: string): string {
    return (this.db.prepare('SELECT content_hash FROM skills WHERE name=?').get(name) as { content_hash: string } | undefined)?.content_hash ?? '';
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

  /**
   * `source` 此前是死列：schema 有、这里从不写、WebUI 从不读，于是每一行都是默认值 `local`，
   * 界面上分不出「随包发的说明书」「装进来的包」「手写的」。`plugin` 那个旧取值从来没有过
   * 写入方（plugin 不贡献 skill），一并换掉（docs/03 §2.10）。
   */
  private sourceOf(name: string): string {
    if ((BUNDLED_SKILLS as readonly string[]).includes(name)) return 'bundled';
    return existsSync(join(this.directory, name, SKILL_PACKAGE_MARKER)) ? 'package' : 'local';
  }

  private persist(skill: SkillDefinition, path: string, raw: string, frontmatter: unknown): void {
    const hash = createHash('sha256').update(raw).digest('hex');
    this.db.prepare(`INSERT INTO skills(name,path,description,min_role,allowed_tools_json,model_alias,enabled,source,content_hash,frontmatter_json,load_error,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET path=excluded.path,description=excluded.description,min_role=excluded.min_role,
      allowed_tools_json=excluded.allowed_tools_json,model_alias=excluded.model_alias,enabled=excluded.enabled,source=excluded.source,content_hash=excluded.content_hash,
      frontmatter_json=excluded.frontmatter_json,load_error=excluded.load_error,updated_at=excluded.updated_at`).run(skill.name, path, skill.description, skill.minRole,
      skill.allowedTools ? JSON.stringify(skill.allowedTools) : null, skill.model ?? null, skill.enabled ? 1 : 0, this.sourceOf(skill.name), hash, JSON.stringify(frontmatter), skill.loadError ?? null, Date.now());
  }
}
