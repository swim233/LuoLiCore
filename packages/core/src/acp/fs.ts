import { statSync } from 'node:fs';
import { RequestError } from '@agentclientprotocol/sdk';
import type { FileTools } from '../tools/files.js';
import type { ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse } from '@agentclientprotocol/sdk';

/**
 * M13 · `fs/read_text_file` / `fs/write_text_file` 的宿主侧实现（`docs/05 §3.5.2`）。
 *
 * ## 读为何走 `readText()` 而非 `read()`
 *
 * `read()` 无条件为正文添加 `行号<TAB>` 前缀 —— 这对模型是正确的（作为 `edit_file` 的对照坐标），但 ACP 的写
 * 是全量覆盖：agent 读出后修改两行再写回，会把整个文件替换为带行号的内容。`readText()` 的正文
 * 逐字节等同于磁盘内容，且超预算与非 UTF-8 均 fail-closed（截断过或经 U+FFFD 替换的正文写回都构成
 * 静默损坏，而 `ReadTextFileResponse` 只有 `content` 一个字段，无法表达内容不完整）。
 *
 * ## 写路径附带获得的三项能力及其代价
 *
 * `FileTools.write()` 自带 `maxWriteBytes` 闸、覆盖前备份、tmp + rename 原子落地 —— 最后一项在本链路上
 * 价值最高：agent 写入中途被 `/cancel` 中断时，目标文件要么是旧版本要么是新版本，不会是半个。
 *
 * ⚠️ 备份落在目标仓库内（`<root>/.luoli-bak/<时间>-<ulid>-<文件名>`，目录名跟随 `tools.fs.backupDir`）。
 * 它会出现在该仓库的 `git status` 中，运维或用户会看到一个非自建的目录。这是刻意取舍：
 * 备份的意义是保留上一版本，而移出仓库外需另建一套备份与仓库的映射关系，为一次
 * `.gitignore` 调整而引入整套映射不划算。
 *
 * ⚠️ ACP 没有 delete / move 方法，因此 `FileTools` 的回收站（`.luoli-trash`）在本链路上不会被
 * 使用 —— agent 删除文件走其自身进程（本系统不可见），将回收站计入本路径的收益不成立。
 */

/** `PathJail.resolve` 抛出的三种拒绝 → 转换为 agent 可据以修正的提示。它抛出的是裸 `Error(message)`。 */
const JAIL_HINTS: Record<string, string> = {
  path_outside_workspace: '该路径不在本次会话的目录边界内。只能读写 spawn_acp 调用指定的仓库目录及其子目录中的文件。',
  path_denied: '该路径命中 `tools.fs.denyGlobs`（管理员配置的禁止读写名单），本次会话无法访问。请更换路径。',
  path_invalid: '路径包含 NUL 字节。',
};
/**
 * 为 `{ok:false}` 中未携带 hint 的档位补充说明。`FileTools.write` 返回的仅是
 * `write_too_large` —— 对本项目的模型足够（它可见 `tools.fs.maxWriteBytes` 这一键名），
 * 但对外部 agent 只是一个无法解释的错误码，会导致其原样重试。
 */
const CODE_HINTS: Record<string, string> = {
  write_too_large: '内容超过 `tools.fs.maxWriteBytes`，一个字节都没写。请拆分为多个文件，或由管理员调大该项。',
};

/**
 * 一次 ACP 会话的 fs 面，作用域与会话一致 —— `AcpManager` 每次调用创建一个，jail 的 root 为
 * `realpathSync(dir)`，与 `session/new` 的 `cwd` 是同一字面量（路径中存在符号链接时，agent 获得的
 * 绝对路径与 jail 边界必须使用同一套字面量，否则每一次 `fs/*` 都会被判越界）。
 */
export class AcpFs {
  #reads = 0;
  /**
   * 被写入过的不同文件集合。进度卡片终帧的 `files` 即其大小 —— 若统计写入次数，同一文件修改三次
   * 会显示为修改了 3 个文件，而该数字面向用户展示。
   */
  readonly #written = new Set<string>();

  constructor(private readonly files: FileTools) {}

  get reads(): number { return this.#reads; }
  get writes(): number { return this.#written.size; }

  readTextFile(request: ReadTextFileRequest): ReadTextFileResponse {
    this.#target(request.path, 'read');
    // `line` / `limit` 在协议中为 `number | null`，而 `readText` 接收 `number | undefined`
    // 且对非法值拒收而不纠正（把 `{limit: 0}` 纠正为全量读取会将分窗读静默变为全文读，
    // 而 `NaN` 纠正后得到空正文 —— 空正文交给全量覆盖的写端等于清空文件）。
    const result = this.#call(() => this.files.readText(request.path, {
      ...(typeof request.line === 'number' ? { line: request.line } : {}),
      ...(typeof request.limit === 'number' ? { limit: request.limit } : {}) }), request.path);
    this.#reads += 1;
    return { content: String(result.content ?? '') };
  }

  writeTextFile(request: WriteTextFileRequest): WriteTextFileResponse {
    const target = this.#target(request.path, 'write');
    this.#call(() => this.files.write(request.path, request.content), request.path);
    // 计数键取解析后的绝对路径而非 agent 提供的字符串：`<root>/a.txt` 与 `<root>/./a.txt`
    // 是同一个文件，而该计数会呈现为面向用户的修改文件数。
    this.#written.add(target);
    return {};
  }

  /**
   * 两件先于 `FileTools` 执行的事，各有其理由：
   *
   * ① 边界先判。`FileTools` 两条路径现在都是先 `jail.resolve()` 再校验参数（`readText` 一直如此，
   *    `write()` 在 docs/05 §3.1 那一轮补齐 —— 此前它先校验 `maxWriteBytes`，导致越界的超大写入报出的
   *    是 `write_too_large`，安全信号被体积错误掩盖）。因此此处不再是修补不对称：`#call`
   *    仍会把 `PathJail` 抛出的裸 `Error('path_denied')` 转换为带 `JAIL_HINTS` 的 `invalidParams`。
   *    保留它的原因有两点 —— `writeTextFile` 无论如何都需要该步的返回值作为 `#written` 的键；以及防御纵深，
   *    本链路的对端是外部 agent，越界提示不应取决于 `FileTools` 内两行代码的先后顺序。
   * ② 目录不是文件。读侧的判据与理由位于 `FileTools.#isDirectory`（同一件事两处判定，该处
   *    `read` / `readText` 各自返回 `path_is_directory`），此处不重复推导；写侧 `FileTools` 没有该判定，
   *    会在备份步骤的 `cpSync` 上失败并返回不含 `EISDIR` 的 `Recursive option not enabled`，agent 无法据此
   *    采取任何行动。两档在此收敛为可据以修正的提示，且区分读写 —— ACP 链路上没有列目录的 method。
   */
  #target(path: string, verb: 'read' | 'write'): string {
    let target: string;
    try { target = this.files.resolve(path); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw RequestError.invalidParams({ path, reason: message }, JAIL_HINTS[message] ?? message);
    }
    let directory = false;
    try { directory = statSync(target).isDirectory(); } catch { /* 不存在：读路径随后如实返回 not found，写路径需新建 */ }
    if (directory) {
      throw RequestError.invalidParams({ path, reason: 'is_a_directory' },
        `${path} 是目录，不是文件。${verb === 'read' ? '本链路没有列目录的 method，需要目录内容请让用户提供。' : '无法写入目录。'}`);
    }
    return target;
  }

  /**
   * `FileTools` 的两种失败形态都收敛为规范的 JSON-RPC error：jail 拒绝以抛出表达，闸门与格式拒绝以
   * `{ok:false}` 表达。两者都不能变成挂起的请求 —— 此时 agent 正持有一个修改到一半的文件。
   *
   * `ok:false` 的 `hint` 原样转给 agent：这些提示本就面向需要将读出正文原样写回的调用方
   * （`read_too_large` 直接给出下次应携带的 `line` + `limit`）。绝不将被截断的正文一并返回 ——
   * 产生侧已将其置空，此处只是不绕过该处理。
   */
  #call(operation: () => Record<string, unknown>, path: string): Record<string, unknown> {
    let result: Record<string, unknown>;
    try { result = operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = JAIL_HINTS[message];
      if (hint) throw RequestError.invalidParams({ path, reason: message }, hint);
      // ENOENT / EISDIR 一族。`resourceNotFound` 是协议提供的档位，语义比 `internalError` 明确 ——
      // agent 收到后会去列目录而非原样重试。
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
