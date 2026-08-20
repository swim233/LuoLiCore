import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import matter from 'gray-matter';
import { ulid } from 'ulid';
import yauzl from 'yauzl';
import type { Role } from '@luoli/shared';
import { roleRank } from '@luoli/shared';
import { BUNDLED_SKILLS, SKILL_PACKAGE_MARKER, frontmatterSchema, type SkillDefinition, type SkillLoader } from './loader.js';

/**
 * 装一个多文件 skill 包（docs/07 §2.5）。
 *
 * 这是这条通道的**唯一实现**：模型侧的 `install_skill` 与 WebUI 的
 * `POST /api/skills/package` 都打这里。端点自己抄一遍解包逻辑的话，两条路迟早在校验上分叉
 * —— 而这里的每一条校验都是安全判据，分叉出来的那份就是没有校验的那份。
 */

export interface SkillPackageLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  allowExecutable: boolean;
}
export interface SkillPackageOptions {
  limits: SkillPackageLimits;
  /** `tools.selfExtend.skills.minRole`。包里写的 `min-role` 只能被它抬高，抬不低。 */
  minRoleFloor: Role;
  name?: string | undefined;
  subdir?: string | undefined;
  overwrite?: boolean | undefined;
  /** 记进 `.package.json`，纯留痕：这个包是从哪儿来的。 */
  origin?: string | undefined;
}
export interface InstalledSkillPackage {
  name: string;
  files: string[];
  bytes: number;
  /** 覆盖安装时旧的那棵被留档了。 */
  backedUp: boolean;
}

export class SkillPackageError extends Error {
  constructor(readonly code: string, readonly hint?: string, readonly candidates?: string[]) {
    super(code);
    this.name = 'SkillPackageError';
  }
}
const fail = (code: string, hint?: string, candidates?: string[]): never => { throw new SkillPackageError(code, hint, candidates); };

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 只有这两个目录下的文件能保留执行位。skill 正文里让人 `bash scripts/x.sh` 是常态，让人跑 `references/x.md` 不是。 */
const EXECUTABLE_PREFIXES = ['scripts/', 'bin/'];
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * 条目名 → 安全的相对路径。**两道判据都要**：这一道判形状（名字里就带 `..` / 绝对路径），
 * 调用方随后还要判结果（`resolve()` 之后是不是还在暂存目录里）。只留一道的历史教训是
 * `a/../../b` 这类靠规范化才现形的写法，以及不同平台对 `\` 的不同处理。
 */
function safeRelative(entryName: string): string {
  if (entryName.includes('\0')) fail('skill_package_entry_invalid', '条目名里有 NUL。');
  const normalized = entryName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) fail('skill_package_absolute_entry', `包里有绝对路径条目：${entryName}`);
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) fail('skill_package_path_escape', `包里有指向上级目录的条目：${entryName}`);
  return parts.join('/');
}

/** `resolve()` 之后的包含判断。`path !== root` 那一支是为了让根目录自己不算越界。 */
function contained(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function targetFor(stage: string, relativePath: string): string {
  const target = resolve(stage, relativePath);
  if (!contained(target, resolve(stage))) fail('skill_package_path_escape', `条目落在包目录之外：${relativePath}`);
  return target;
}

/** 解包的产物：每个文件的来源模式，以及这个包到底带没带 Unix 模式位。 */
interface Extracted {
  modes: Map<string, number>;
  /** zip 由 Windows 打的时候外部属性高 16 位恒为 0 —— 那不是「都不可执行」，是「没这个信息」。 */
  hasUnixModes: boolean;
}

/**
 * 执行位在**落位之后**才决定，不在解包时。`scripts/` 与 `bin/` 是相对**包根**说的，而解包时
 * 还不知道包根在哪 —— 包常被套一层顶层目录（那个音乐包就是 `music-download-cli-linux/scripts/`），
 * 按暂存目录的相对路径判的话前缀永远对不上，于是整包一个可执行文件都没有、`invoke.sh` 跑不起来。
 *
 * **包不带 Unix 模式时按目录约定给。** 那个音乐包就是这样：`create_system=0`（Windows 打的），
 * 每个条目的模式位都读成 0。此时照「原本带执行位的才给」办，装完是一个跑不起来的包 ——
 * 而这正是这条通道存在的理由。分发给终端用户的 zip 多半是 Windows 或不保留权限位的工具打的，
 * 所以这是常态而不是例外。硬规则不变：**`scripts/` 与 `bin/` 之外一律不给执行位**，
 * 位置是约定，属性只是这个约定之上的额外收窄。
 */
function applyExecutableBits(stage: string, root: string, extracted: Extracted, limits: SkillPackageLimits): void {
  if (!limits.allowExecutable) return;
  for (const [staged, sourceMode] of extracted.modes) {
    if (extracted.hasUnixModes && (sourceMode & 0o111) === 0) continue;
    const inPackage = relative(root, resolve(stage, staged)).replaceAll('\\', '/');
    if (inPackage.startsWith('..')) continue;
    if (EXECUTABLE_PREFIXES.some((prefix) => inPackage.startsWith(prefix))) chmodSync(resolve(stage, staged), 0o700);
  }
}

interface Budget { entries: number; bytes: number }

function claimEntry(budget: Budget, limits: SkillPackageLimits): void {
  budget.entries += 1;
  if (budget.entries > limits.maxEntries) fail('skill_package_too_many_entries', `包里的条目数超过 ${limits.maxEntries}。`);
}

async function writeStream(stream: Readable, target: string, relativePath: string, budget: Budget, limits: SkillPackageLimits): Promise<void> {
  // 一律先写成 0600，执行位等落位前由 `applyExecutableBits` 按包根重判 —— 解包这一刻还不知道
  // 包根在哪。中间态是「谁都跑不了」而不是「先给上再收回」。
  const handle = await open(target, 'w', 0o600);
  let written = 0;
  // **在开始消费之前就挂上**：超限那一刻我们从循环里抛出去，异步迭代器随即摘掉自己的监听，而
  // yauzl 的 `validateEntrySizes` 还会在这条流上继续吐 error（压缩炸弹谎报大小时必然吐，而且
  // 不止一次）。那时没人在听，**流上未处理的 error 在 Node 里直接抛** —— 一个畸形包足以把进程带崩。
  // 挂在 finally 里太晚：抛出与摘监听之间就已经有一发落空了。
  stream.on('error', () => {});
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      written += buffer.length;
      // **按实际写出的字节数判，不看 zip 头里的 `uncompressedSize`** —— 那个字段是打包方填的，
      // 一个声明 1 字节、实际解出 100 MB 的条目正是压缩炸弹的标准形态。判在写之前，
      // 所以超限的那一刻磁盘上最多多出这一个 chunk。
      if (written > limits.maxFileBytes) fail('skill_package_file_too_large', `${relativePath} 超过单文件上限 ${limits.maxFileBytes} 字节。`);
      if (budget.bytes + written > limits.maxTotalBytes) fail('skill_package_too_large', `解开之后超过总上限 ${limits.maxTotalBytes} 字节。`);
      await handle.write(buffer);
    }
  } finally {
    stream.destroy();
    await handle.close();
  }
  budget.bytes += written;
}

function openZip(source: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(source, { lazyEntries: true, autoClose: false }, (error, file) => (error ? reject(error) : resolvePromise(file)));
  });
}

function readEntries(zip: yauzl.ZipFile, limits: SkillPackageLimits): Promise<yauzl.Entry[]> {
  return new Promise((resolvePromise, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on('entry', (entry: yauzl.Entry) => {
      // 条目数在**读目录时**就挡住，不等到落盘：一个一千万条目的 zip 光是把 Entry 攒进数组
      // 就够把进程撑爆，而那时候一个字节都还没写。
      if (entries.length >= limits.maxEntries) { reject(new SkillPackageError('skill_package_too_many_entries', `包里的条目数超过 ${limits.maxEntries}。`)); return; }
      entries.push(entry);
      zip.readEntry();
    });
    zip.on('end', () => resolvePromise(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

/**
 * yauzl 自己也拒 `..` 与反斜杠（它在 `readEntry` 里就 emit 出来）。**那是第二道，不是唯一一道**
 * —— `safeRelative` 与落位后的包含判断仍然各自独立成立。这里只把它的话翻译成同一套错误码，
 * 免得调用方要同时认两套词汇；认不出来的错误照原样带出去，不吞。
 */
function translateZipError(error: unknown): never {
  if (error instanceof SkillPackageError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/^absolute path:/i.test(message)) fail('skill_package_absolute_entry', message);
  if (/invalid relative path|invalid characters in fileName/i.test(message)) fail('skill_package_path_escape', message);
  return fail('skill_package_unreadable', message);
}

async function extractZip(source: string, stage: string, limits: SkillPackageLimits): Promise<Extracted> {
  const zip = await openZip(source).catch(translateZipError);
  const budget: Budget = { entries: 0, bytes: 0 };
  const modes = new Map<string, number>();
  let hasUnixModes = false;
  try {
    for (const entry of await readEntries(zip, limits).catch(translateZipError)) {
      const relativePath = safeRelative(entry.fileName);
      if (!relativePath) continue;
      claimEntry(budget, limits);
      const target = targetFor(stage, relativePath);
      // 高 16 位是 Unix 模式。Windows 打的包这里恒为 0 —— 那是「没这个信息」而不是
      // 「不可执行」，`applyExecutableBits` 据 `hasUnixModes` 分这两种情况。
      const sourceMode = entry.externalFileAttributes >>> 16;
      if (sourceMode !== 0) hasUnixModes = true;
      if ((sourceMode & S_IFMT) === S_IFLNK) {
        fail('skill_package_symlink', `包里有符号链接：${relativePath}。它能让 skill:// 读到目录之外的东西。`);
      }
      if (entry.fileName.endsWith('/')) { mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      const stream = await new Promise<Readable>((resolvePromise, reject) => {
        zip.openReadStream(entry, (error, value) => (error ? reject(error) : resolvePromise(value as unknown as Readable)));
      });
      await writeStream(stream, target, relativePath, budget, limits);
      modes.set(relativePath, sourceMode);
    }
  } finally { zip.close(); }
  return { modes, hasUnixModes };
}

async function extractDirectory(source: string, stage: string, limits: SkillPackageLimits): Promise<Extracted> {
  const root = resolve(source);
  const budget: Budget = { entries: 0, bytes: 0 };
  const modes = new Map<string, number>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const relativePath = safeRelative(relative(root, absolute));
      claimEntry(budget, limits);
      const target = targetFor(stage, relativePath);
      // `readdirSync` 的 Dirent 已经是 lstat 语义，软链既不是 file 也不是 directory ——
      // 但显式判一次，好让错误码和 zip 那条路一致（「包里有软链」而不是「跳过了一个不认识的条目」）。
      if (entry.isSymbolicLink()) fail('skill_package_symlink', `包里有符号链接：${relativePath}。`);
      if (entry.isDirectory()) { mkdirSync(target, { recursive: true, mode: 0o700 }); await walk(absolute); continue; }
      if (!entry.isFile()) fail('skill_package_entry_invalid', `包里有既不是文件也不是目录的条目：${relativePath}`);
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      await writeStream(createReadStream(absolute), target, relativePath, budget, limits);
      modes.set(relativePath, lstatSync(absolute).mode);
    }
  };
  await walk(root);
  // 从目录装时 `lstat` 的模式永远是真的，不存在「没这个信息」那一档。
  return { modes, hasUnixModes: true };
}

/**
 * 找包根。`SKILL.md` 常被套一层顶层目录，而一个包里可以有好几份 —— 那个音乐包就同时带
 * `music-download-cli/`（Windows）与 `music-download-cli-linux/` 两套。歧义时**必须把候选列出来**，
 * 否则调用方只能靠猜去填 `subdir`。
 */
function findRoot(stage: string, subdir: string | undefined): string {
  if (subdir) {
    const target = targetFor(stage, safeRelative(subdir));
    if (!existsSync(join(target, 'SKILL.md'))) fail('skill_md_not_found', `${subdir} 下没有 SKILL.md。`);
    return target;
  }
  if (existsSync(join(stage, 'SKILL.md'))) return stage;
  const candidates = readdirSync(stage, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(stage, entry.name, 'SKILL.md')))
    .map((entry) => entry.name);
  if (candidates.length === 1) return join(stage, candidates[0]!);
  if (candidates.length === 0) fail('skill_md_not_found', '包的根目录与第一层子目录里都没有 SKILL.md。');
  return fail('skill_ambiguous_root', `这个包里有 ${candidates.length} 份 SKILL.md，用 subdir 指一个：${candidates.join(' / ')}`, candidates);
}

/**
 * 落位前重写 frontmatter。三个字段**不接受包里写的值**：
 *
 * - `name` —— `scan()` 要求 `name === 目录名`，包里那个未必对得上（尤其是重命名安装时）；
 * - `enabled` —— 一个带 `scripts/` 与 `bin/` 的包不适用「skill 是纯文本」那条豁免（docs/07 §6.1）；
 * - `min-role` —— 只能被 `minRoleFloor` 抬高。**没写的一律取下限**，而不是落到
 *   `skills.defaultMinRole`：那个值可以比下限低，于是「不写」就成了绕过下限的办法。
 */
function rewriteFrontmatter(root: string, name: string, minRoleFloor: Role): void {
  const path = join(root, 'SKILL.md');
  const parsed = matter(readFileSync(path, 'utf8'));
  const data: Record<string, unknown> = { ...parsed.data };
  const declared = data['min-role'];
  const minRole = typeof declared === 'string' && declared in { blocked: 1, limited: 1, trusted: 1, owner: 1 }
    && roleRank(declared as Role) > roleRank(minRoleFloor) ? (declared as Role) : minRoleFloor;
  data.name = name;
  data.enabled = false;
  data['min-role'] = minRole;
  const check = frontmatterSchema.safeParse(data);
  // 提前判一次，好让错误说得出「包里的 frontmatter 哪里不对」。落位之后那道复核仍然留着 ——
  // 它挡的是别的东西（写盘本身出了岔子），两道判的不是同一件事。
  if (!check.success) fail('skill_package_invalid_frontmatter', check.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  writeFileSync(path, matter.stringify(`${parsed.content.trim()}\n`, data), { encoding: 'utf8', mode: 0o600 });
}

function backupDir(skillsDir: string): string {
  const path = join(skillsDir, '.backups');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * @param source 已由调用方鉴权过的绝对路径（docs/07 §6.5 限定了模型侧能给哪些），zip 或目录。
 */
export async function installSkillPackage(loader: SkillLoader, source: string, options: SkillPackageOptions): Promise<InstalledSkillPackage> {
  if (options.name !== undefined && !NAME_PATTERN.test(options.name)) fail('invalid_skill_name', '名字要是 kebab-case（小写字母数字，连字符分隔）。');
  if (!existsSync(source)) fail('skill_package_not_found', `找不到 ${source}。`);
  const skillsDir = resolve(loader.directory);
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  // 暂存放在 `skills/` 之内，所以落位是同分区 `renameSync`（跨分区的话就得复制，而复制到一半
  // 失败会在目录里留下半棵）。点号开头 —— `SkillLoader.scan()` 靠这一条不去扫它。
  const stage = join(skillsDir, `.staging-${process.pid}-${ulid()}`);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  let installed: string | null = null;
  let backup: string | null = null;
  try {
    const extracted = statSync(source).isDirectory()
      ? await extractDirectory(source, stage, options.limits)
      : await extractZip(source, stage, options.limits);

    const root = findRoot(stage, options.subdir);
    applyExecutableBits(stage, root, extracted, options.limits);
    const declaredName = (matter(readFileSync(join(root, 'SKILL.md'), 'utf8')).data as { name?: unknown }).name;
    const name = options.name ?? (typeof declaredName === 'string' ? declaredName : basename(root));
    if (!NAME_PATTERN.test(name)) fail('invalid_skill_name', `从包里推出来的名字「${name}」不是 kebab-case，用 name 参数指一个。`);
    if ((BUNDLED_SKILLS as readonly string[]).includes(name)) fail('skill_reserved', `${name} 是随包发的说明书，改不得 —— 换个名字。`);

    rewriteFrontmatter(root, name, options.minRoleFloor);
    writeFileSync(join(root, SKILL_PACKAGE_MARKER), `${JSON.stringify({
      installedAt: Date.now(), origin: options.origin ?? basename(source),
      sha256: statSync(source).isDirectory() ? null : createHash('sha256').update(readFileSync(source)).digest('hex'),
      ...(options.subdir ? { subdir: options.subdir } : {}),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

    const destination = join(skillsDir, name);
    if (existsSync(destination)) {
      if (!options.overwrite) fail('skill_already_exists', `已经有一个叫 ${name} 的了，要覆盖就带 overwrite。`);
      // 留档而不是直接删：被覆盖的可能是运维手写的那一份，而 skill 目录没有 `write_file`
      // 那样的回收站（照 `write_plugin` 的先例）。放 `.backups/` 是因为 `<name>.bak-<ts>`
      // 会被 `scan()` 当成一个名字对不上的坏 skill 扫出来。
      backup = join(backupDir(skillsDir), `${name}-${Date.now()}`);
      renameSync(destination, backup);
    }
    renameSync(root, destination);
    installed = destination;

    loader.scan();
    const written = loader.read(name);
    if (!written || written.loadError) fail('skill_package_invalid', written?.loadError ?? '装完之后重新解析不出来。');
    return { name, files: (written as SkillDefinition).files, bytes: sizeOf(destination), backedUp: backup !== null };
  } catch (error) {
    // **「装了一半」不能留在目录里**：它在扩展页上和一个装好的坏 skill 长得一模一样。
    // 覆盖安装失败时把旧的那棵放回去 —— 装新的失败不该顺带把能用的那份弄没了。
    if (installed && existsSync(installed)) renameSync(installed, join(backupDir(skillsDir), `failed-${basename(installed)}-${Date.now()}`));
    if (backup && installed && !existsSync(installed)) renameSync(backup, installed);
    if (installed) loader.scan();
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function sizeOf(directory: string): number {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((total, entry) => total + statSync(join(entry.parentPath, entry.name)).size, 0);
}
