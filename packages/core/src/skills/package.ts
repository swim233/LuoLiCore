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
 * 安装一个多文件 skill 包（docs/07 §2.5）。
 *
 * 这是该通道的唯一实现：模型侧的 `install_skill` 与 WebUI 的
 * `POST /api/skills/package` 都调用此处。端点若自行复制解包逻辑，两条路径迟早在校验上分叉
 * —— 而此处每一条校验都是安全判据，分叉出的那份即缺失校验的那份。
 */

export interface SkillPackageLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  allowExecutable: boolean;
}
export interface SkillPackageOptions {
  limits: SkillPackageLimits;
  /** `tools.selfExtend.skills.minRole`。包内声明的 `min-role` 只能被其抬高，不能降低。 */
  minRoleFloor: Role;
  name?: string | undefined;
  subdir?: string | undefined;
  overwrite?: boolean | undefined;
  /** 记入 `.package.json`，仅用于留痕：记录该包的来源。 */
  origin?: string | undefined;
}
export interface InstalledSkillPackage {
  name: string;
  files: string[];
  bytes: number;
  /** 覆盖安装时旧目录已备份。 */
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
/** 仅这两个目录下的文件保留执行位。skill 正文中引导执行 `bash scripts/x.sh` 属常态，执行 `references/x.md` 不是。 */
const EXECUTABLE_PREFIXES = ['scripts/', 'bin/'];
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * 条目名 → 安全的相对路径。两道判据缺一不可：本道判形状（名字中直接含 `..` 或绝对路径），
 * 调用方随后判结果（`resolve()` 之后是否仍在暂存目录内）。仅保留一道的历史教训是
 * `a/../../b` 这类须经规范化才暴露的写法，以及不同平台对 `\` 的处理差异。
 */
function safeRelative(entryName: string): string {
  if (entryName.includes('\0')) fail('skill_package_entry_invalid', '条目名里有 NUL。');
  const normalized = entryName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) fail('skill_package_absolute_entry', `包里有绝对路径条目：${entryName}`);
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) fail('skill_package_path_escape', `包里有指向上级目录的条目：${entryName}`);
  return parts.join('/');
}

/** `resolve()` 之后的包含判断。`path !== root` 分支使根目录自身不被判为越界。 */
function contained(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function targetFor(stage: string, relativePath: string): string {
  const target = resolve(stage, relativePath);
  if (!contained(target, resolve(stage))) fail('skill_package_path_escape', `条目落在包目录之外：${relativePath}`);
  return target;
}

/** 解包结果：每个文件的来源模式，以及该包是否携带 Unix 模式位。 */
interface Extracted {
  modes: Map<string, number>;
  /** Windows 打包的 zip 其外部属性高 16 位恒为 0 —— 表示该信息缺失，而非全部不可执行。 */
  hasUnixModes: boolean;
}

/**
 * 执行位在落位之后才决定，而非解包时。`scripts/` 与 `bin/` 是相对包根而言的，解包时
 * 尚不知道包根位置 —— 包常被套一层顶层目录（如 `music-download-cli-linux/scripts/`），
 * 按暂存目录的相对路径判定则前缀始终不匹配，结果是整包无可执行文件、`invoke.sh` 无法运行。
 *
 * 包不携带 Unix 模式时按目录约定授予。前述音乐包即属此类：`create_system=0`（Windows 打包），
 * 每个条目的模式位均读为 0。此时若坚持仅对原本带执行位的文件授予，安装结果是不可运行的包 ——
 * 而这正是该通道存在的意义。分发给终端用户的 zip 多数由 Windows 或不保留权限位的工具打包，
 * 属常态而非例外。硬规则不变：`scripts/` 与 `bin/` 之外一律不授予执行位，
 * 位置是约定，属性只是在该约定之上的额外收窄。
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

export interface SkillPackageBudget { entries: number; bytes: number }
type Budget = SkillPackageBudget;

function claimEntry(budget: Budget, limits: SkillPackageLimits): void {
  budget.entries += 1;
  if (budget.entries > limits.maxEntries) fail('skill_package_too_many_entries', `包里的条目数超过 ${limits.maxEntries}。`);
}

/** 导出仅为使「error 监听早于第一个 await」这条不变量有确定性用例，见 `tests/skill.package.test.ts`。 */
export async function writePackageEntry(stream: Readable, target: string, relativePath: string, budget: Budget, limits: SkillPackageLimits): Promise<void> {
  // 必须早于本函数的第一个 await：超限时从循环抛出，异步迭代器随即移除自身监听，
  // 而 yauzl 的 `validateEntrySizes` 仍会在该流上继续发出 error（压缩炸弹谎报大小时必然发出，
  // 且不止一次）。此时无监听者，而流上未处理的 error 在 Node 中直接抛出 —— 一个畸形包足以使进程崩溃。
  // 挂在 finally 中过晚；挂在下方 `await open()` 之后同样过晚 —— 流在返回时已开始流动
  // （`openReadStream` 内部已 pipe 到 inflate），而 `open` 是真实文件系统调用：并行跑全量测试时
  // 该窗口可达 20ms 量级，谎报大小的包恰在其中发出 error，进程随即崩溃于无监听的流上。
  stream.on('error', () => {});
  // 一律先写为 0600，执行位在落位前由 `applyExecutableBits` 按包根重新判定 —— 解包时尚不知道
  // 包根位置。中间态取全部不可执行，而非先授予再回收。
  const handle = await open(target, 'w', 0o600);
  let written = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      written += buffer.length;
      // 按实际写出的字节数判定，不采用 zip 头中的 `uncompressedSize` —— 该字段由打包方填写，
      // 声明 1 字节而实际解出 100 MB 的条目正是压缩炸弹的标准形态。判定在写入之前，
      // 因此超限时磁盘上至多多出当前这一个 chunk。
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
      // 条目数在读取目录时即拦截，不等到落盘：一千万条目的 zip 仅将 Entry 累积进数组
      // 即可耗尽内存，而此时尚未写入任何字节。
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
 * yauzl 自身也拒绝 `..` 与反斜杠（在 `readEntry` 中即发出）。那是第二道校验而非唯一一道
 * —— `safeRelative` 与落位后的包含判断仍各自独立成立。此处只是把它的错误翻译成同一套错误码，
 * 避免调用方需同时识别两套词汇；无法识别的错误原样抛出，不吞掉。
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
      // 高 16 位是 Unix 模式。Windows 打包时该位恒为 0 —— 表示信息缺失而非不可执行，
      // `applyExecutableBits` 依 `hasUnixModes` 区分这两种情形。
      const sourceMode = entry.externalFileAttributes >>> 16;
      if (sourceMode !== 0) hasUnixModes = true;
      if ((sourceMode & S_IFMT) === S_IFLNK) {
        fail('skill_package_symlink', `包里有符号链接：${relativePath}。它会使 skill:// 读取到目录之外的内容。`);
      }
      if (entry.fileName.endsWith('/')) { mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      const stream = await new Promise<Readable>((resolvePromise, reject) => {
        zip.openReadStream(entry, (error, value) => (error ? reject(error) : resolvePromise(value as unknown as Readable)));
      });
      await writePackageEntry(stream, target, relativePath, budget, limits);
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
      // `readdirSync` 的 Dirent 已是 lstat 语义，符号链接既非 file 也非 directory ——
      // 但仍显式判定一次，使错误码与 zip 路径一致（报包内含符号链接，而非跳过未知条目）。
      if (entry.isSymbolicLink()) fail('skill_package_symlink', `包里有符号链接：${relativePath}。`);
      if (entry.isDirectory()) { mkdirSync(target, { recursive: true, mode: 0o700 }); await walk(absolute); continue; }
      if (!entry.isFile()) fail('skill_package_entry_invalid', `包里有既不是文件也不是目录的条目：${relativePath}`);
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      await writePackageEntry(createReadStream(absolute), target, relativePath, budget, limits);
      modes.set(relativePath, lstatSync(absolute).mode);
    }
  };
  await walk(root);
  // 从目录安装时 `lstat` 的模式始终有效，不存在信息缺失的情形。
  return { modes, hasUnixModes: true };
}

/**
 * 定位包根。`SKILL.md` 常被套一层顶层目录，且一个包内可能存在多份 —— 前述音乐包同时含
 * `music-download-cli/`（Windows）与 `music-download-cli-linux/` 两套。存在歧义时必须列出候选，
 * 否则调用方只能猜测 `subdir` 的取值。
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
  return fail('skill_ambiguous_root', `这个包里有 ${candidates.length} 份 SKILL.md，请使用 subdir 指定其一：${candidates.join(' / ')}`, candidates);
}

/**
 * 落位前重写 frontmatter。以下三个字段不采用包内声明的值：
 *
 * - `name` —— `scan()` 要求 `name === 目录名`，包内的值未必匹配（尤其是重命名安装时）；
 * - `enabled` —— 含 `scripts/` 与 `bin/` 的包不适用 skill 为纯文本这一豁免（docs/07 §6.1）；
 * - `min-role` —— 只能被 `minRoleFloor` 抬高。未声明时一律取下限，而非取
 *   `skills.defaultMinRole`：后者可能低于下限，使省略声明成为绕过下限的手段。
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
  // 提前判定一次，使错误能指明包内 frontmatter 的具体问题。落位之后的复核仍保留 ——
  // 它拦截的是另一类问题（写盘过程出错），两道判定的对象不同。
  if (!check.success) fail('skill_package_invalid_frontmatter', check.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  writeFileSync(path, matter.stringify(`${parsed.content.trim()}\n`, data), { encoding: 'utf8', mode: 0o600 });
}

function backupDir(skillsDir: string): string {
  const path = join(skillsDir, '.backups');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * @param source 已由调用方鉴权的绝对路径（docs/07 §6.5 限定了模型侧的可选范围），zip 或目录。
 */
export async function installSkillPackage(loader: SkillLoader, source: string, options: SkillPackageOptions): Promise<InstalledSkillPackage> {
  if (options.name !== undefined && !NAME_PATTERN.test(options.name)) fail('invalid_skill_name', '名字必须是 kebab-case（小写字母数字，连字符分隔）。');
  if (!existsSync(source)) fail('skill_package_not_found', `${source} 不存在。`);
  const skillsDir = resolve(loader.directory);
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  // 暂存目录位于 `skills/` 内，因此落位是同分区 `renameSync`（跨分区需复制，而复制中途
  // 失败会在目录中留下不完整的树）。以点号开头 —— `SkillLoader.scan()` 据此跳过它。
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
    if (!NAME_PATTERN.test(name)) fail('invalid_skill_name', `从包中推断出的名称「${name}」不是 kebab-case，请使用 name 参数指定。`);
    if ((BUNDLED_SKILLS as readonly string[]).includes(name)) fail('skill_reserved', `${name} 是随包发的说明文档，不可修改，请更换名称。`);

    rewriteFrontmatter(root, name, options.minRoleFloor);
    writeFileSync(join(root, SKILL_PACKAGE_MARKER), `${JSON.stringify({
      installedAt: Date.now(), origin: options.origin ?? basename(source),
      sha256: statSync(source).isDirectory() ? null : createHash('sha256').update(readFileSync(source)).digest('hex'),
      ...(options.subdir ? { subdir: options.subdir } : {}),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

    const destination = join(skillsDir, name);
    if (existsSync(destination)) {
      if (!options.overwrite) fail('skill_already_exists', `${name} 已存在，请传入 overwrite 以覆盖。`);
      // 备份而非直接删除：被覆盖的可能是运维手写的版本，而 skill 目录没有 `write_file`
      // 那样的回收站（参照 `write_plugin` 的先例）。放入 `.backups/` 是因为 `<name>.bak-<ts>`
      // 会被 `scan()` 识别为名字不匹配的损坏 skill。
      backup = join(backupDir(skillsDir), `${name}-${Date.now()}`);
      renameSync(destination, backup);
    }
    renameSync(root, destination);
    installed = destination;

    loader.scan();
    const written = loader.read(name);
    if (!written || written.loadError) fail('skill_package_invalid', written?.loadError ?? '安装后无法重新解析。');
    return { name, files: (written as SkillDefinition).files, bytes: sizeOf(destination), backedUp: backup !== null };
  } catch (error) {
    // 安装未完成的目录不能保留：在扩展页上它与一个安装完成但损坏的 skill 无法区分。
    // 覆盖安装失败时恢复旧目录 —— 新版本安装失败不应连带丢失可用的旧版本。
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
