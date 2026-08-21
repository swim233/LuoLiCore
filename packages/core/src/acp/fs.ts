import { statSync } from 'node:fs';
import { RequestError } from '@agentclientprotocol/sdk';
import type { FileTools } from '../tools/files.js';
import type { ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse } from '@agentclientprotocol/sdk';

/**
 * M13 · `fs/read_text_file` / `fs/write_text_file` 的宿主侧实现（`docs/05 §3.5.2`）。
 *
 * ## 为什么读走 `readText()` 而不是 `read()`
 *
 * `read()` 无条件给正文加 `行号<TAB>` 前缀 —— 那对模型是对的（是 `edit_file` 的对照坐标），但 ACP 的写
 * 是**全量覆盖**：agent 读出来改两行再写回去，就把整个文件换成了一份带行号的垃圾。`readText()` 的正文
 * 逐字节等于磁盘，而且**超预算与非 UTF-8 都 fail-closed**（截断过的、U+FFFD 替换过的正文写回去都是
 * 一次静默毁坏，而 `ReadTextFileResponse` 里只有 `content` 一个字段，没有任何地方说得出「这只是一段」）。
 *
 * ## 写路径顺带买到的三样，与它的一个代价
 *
 * `FileTools.write()` 自带 `maxWriteBytes` 闸、覆盖前备份、tmp + rename 原子落地 —— 后者是这条链上
 * 最实在的一样：agent 写到一半被 `/cancel` 掐断时，目标文件要么是旧的要么是新的，不会是半个。
 *
 * ⚠️ **备份落在目标仓库里**（`<root>/.luoli-bak/<时间>-<ulid>-<文件名>`，目录名跟 `tools.fs.backupDir`
 * 走）。也就是说它会出现在那个仓库的 `git status` 里，运维/用户会看见一个自己没建的目录。这是刻意的
 * 取舍：备份的意义是「上一版还在」，而搬到仓库外就得另建一套「哪个备份属于哪个仓库」的账，一次
 * `.gitignore` 换一整套映射不值得。
 *
 * ⚠️ **ACP 没有 delete / move 方法**，所以 `FileTools` 的回收站（`.luoli-trash`）在这条链上永远不会被
 * 用到 —— agent 删文件走的是它自己的进程（我们看不见），把回收站算进这条路的收益是自欺。
 */

/** `PathJail.resolve` 抛出来的三种拒绝 → 一句 agent 照着能改的话。它抛的是裸 `Error(message)`。 */
const JAIL_HINTS: Record<string, string> = {
  path_outside_workspace: '这个路径不在本次会话的目录边界内。只能读写 spawn_acp 那次调用指定的仓库目录（及其子目录）里的文件。',
  path_denied: '这个路径命中了 `tools.fs.denyGlobs`（运维配的禁读写名单），本次会话碰不到它。换一个路径。',
  path_invalid: '路径里有 NUL 字节。',
};
/**
 * `{ok:false}` 里**没带 hint** 的那几档补一句。`FileTools.write` 交回的是光秃秃一个
 * `write_too_large` —— 那对本项目的模型够用（它看得见 `tools.fs.maxWriteBytes` 这个键名），
 * 但对一台外部 agent 就只是一个不认识的单词，它会原样重试。
 */
const CODE_HINTS: Record<string, string> = {
  write_too_large: '这份内容超过 `tools.fs.maxWriteBytes`，一个字节都没写。把它拆成几个文件，或者让运维调大那一项。',
};

/**
 * 一次 ACP 会话的 fs 面。**作用域与会话同生死** —— `AcpManager` 每次调用建一个，jail 的 root 是
 * `realpathSync(dir)`，与 `session/new` 的 `cwd` 是**同一个字面量**（路径中间有软链时，agent 拿到的
 * 绝对路径与 jail 边界必须是同一套字面量，否则每一次 `fs/*` 都是一次越界拒绝）。
 */
export class AcpFs {
  #reads = 0;
  /**
   * 被写过的**不同**文件。进度卡片终帧的 `files` 就是它的大小 —— 数写入次数的话，同一个文件被改三遍
   * 会报成「改了 3 个文件」，而那个数字是要给人看的。
   */
  readonly #written = new Set<string>();

  constructor(private readonly files: FileTools) {}

  get reads(): number { return this.#reads; }
  get writes(): number { return this.#written.size; }

  readTextFile(request: ReadTextFileRequest): ReadTextFileResponse {
    this.#target(request.path, 'read');
    // `line` / `limit` 在协议里是 `number | null`，而 `readText` 收的是 `number | undefined`
    // 且对非法值**拒收而不纠正**（`{limit: 0}` 纠正成「全读」会把一次分窗读悄悄变成全文读，
    // 而 `NaN` 纠正出来的是空正文 —— 空正文交给全量覆盖的写端就是清空文件）。
    const result = this.#call(() => this.files.readText(request.path, {
      ...(typeof request.line === 'number' ? { line: request.line } : {}),
      ...(typeof request.limit === 'number' ? { limit: request.limit } : {}) }), request.path);
    this.#reads += 1;
    return { content: String(result.content ?? '') };
  }

  writeTextFile(request: WriteTextFileRequest): WriteTextFileResponse {
    const target = this.#target(request.path, 'write');
    this.#call(() => this.files.write(request.path, request.content), request.path);
    // 计数键用**解析后**的绝对路径而不是 agent 给的那个字符串：`<root>/a.txt` 与 `<root>/./a.txt`
    // 是同一个文件，而这个数字要变成一句给人看的「改了 N 个文件」。
    this.#written.add(target);
    return {};
  }

  /**
   * 两件先于 `FileTools` 发生的事，各有一条理由：
   *
   * ① **边界先判。** `FileTools` 两条路现在都是「先 `jail.resolve()` 再量参数」（`readText` 一直如此，
   *    `write()` 在 docs/05 §3.1 那一轮补齐 —— 此前它先量 `maxWriteBytes`，于是一次越界的超大写入报出来
   *    的是 `write_too_large`，安全信号被一句体积抱怨盖住）。**所以这里不再是在补一个不对称**：`#call`
   *    照样会把 `PathJail` 抛的裸 `Error('path_denied')` 收成一句带 `JAIL_HINTS` 的 `invalidParams`。
   *    留着它是两件事 —— `writeTextFile` 无论如何都要拿这一步的返回值当 `#written` 的键；以及防御纵深，
   *    这条链的对面是一台**外部** agent，那句「你出界了」不该取决于 `FileTools` 里两行的先后。
   * ② **目录不是文件。** 读那半边的判据与理由都在 `FileTools.#isDirectory` 上（同一件事两处都判，那边
   *    `read` / `readText` 各自返回 `path_is_directory`），不在这里重推一遍；写那半边 `FileTools` 没有这道
   *    判，它死在备份那步的 `cpSync` 上、报一句不带 `EISDIR` 的 `Recursive option not enabled`，agent 拿它
   *    没法做任何事。两档在这里收成一句能照着改的话，且分读写 —— ACP 这条链上没有列目录的 method。
   */
  #target(path: string, verb: 'read' | 'write'): string {
    let target: string;
    try { target = this.files.resolve(path); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw RequestError.invalidParams({ path, reason: message }, JAIL_HINTS[message] ?? message);
    }
    let directory = false;
    try { directory = statSync(target).isDirectory(); } catch { /* 不存在：读那一路随后如实报 not found，写那一路要新建 */ }
    if (directory) {
      throw RequestError.invalidParams({ path, reason: 'is_a_directory' },
        `${path} 是一个目录，不是文件。${verb === 'read' ? '要看它下面有什么请让用户列一遍，这条链上没有列目录的 method。' : '写不进目录里去。'}`);
    }
    return target;
  }

  /**
   * `FileTools` 的两种失败形态都收成一个**干净的 JSON-RPC error**：jail 拒绝是抛，闸门与格式拒绝是
   * `{ok:false}`。哪一种都不能变成「一个挂住的请求」—— 那时 agent 正握着一个半改完的文件。
   *
   * `ok:false` 的 `hint` 原样转给 agent：那几句本来就是写给「读出来的正文要原样写回去」的调用方看的
   * （`read_too_large` 那句直接给出下一次该带的 `line` + `limit`）。**绝不把被截断的正文一起交出去** ——
   * 产生侧已经置空了，这里只是不去绕过它。
   */
  #call(operation: () => Record<string, unknown>, path: string): Record<string, unknown> {
    let result: Record<string, unknown>;
    try { result = operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = JAIL_HINTS[message];
      if (hint) throw RequestError.invalidParams({ path, reason: message }, hint);
      // ENOENT / EISDIR 那一族。`resourceNotFound` 是协议给的那一档，比 `internalError` 说得清 ——
      // agent 收到它会去列目录而不是原样重试。
      if (message.includes('ENOENT') || message.includes('EISDIR') || message.includes('ENOTDIR')) throw RequestError.resourceNotFound(path);
      throw RequestError.internalError({ path }, message);
    }
    if (result.ok === false) {
      const code = typeof result.error === 'string' ? result.error : '';
      throw RequestError.invalidParams({ path, reason: code || null },
        String(result.hint ?? CODE_HINTS[code] ?? (code || 'fs operation refused')));
    }
    return result;
  }
}
