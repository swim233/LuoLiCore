import { createWriteStream, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Writable } from 'node:stream';
import {
  openFileStore,
  openRequestLog,
  readConversations,
  type LoggedRequest,
  type RequestResponse,
  type StoredConversation,
} from '../core/index.js';
import { dataPaths, type Env } from '../shared/config.js';
import { parseExportArgs, usage, type ExportOptions } from './args.js';
import { formatLocalTime } from './time.js';

/**
 * 按 --conversation 的文字找会话。每段文字依次按这几种认，先认出的为准：会话 id 完全相同；
 * 平台会话 id（Telegram 群 id）完全相同；会话标题包含这段文字（不分大小写）。一段文字可以
 * 匹配到多个会话，全部算上；有一段一个都匹配不到时报错
 */
export function matchConversations(
  conversations: readonly StoredConversation[],
  texts: readonly string[],
): { ok: true; matched: StoredConversation[] } | { ok: false; error: string } {
  const matched = new Map<string, StoredConversation>();
  for (const text of texts) {
    const lower = text.toLowerCase();
    const rules = [
      (c: StoredConversation) => c.id === text,
      (c: StoredConversation) => c.platformConversationId === text,
      (c: StoredConversation) => c.title?.toLowerCase().includes(lower) ?? false,
    ];
    let found: StoredConversation[] = [];
    for (const rule of rules) {
      found = conversations.filter(rule);
      if (found.length > 0) break;
    }
    if (found.length === 0) {
      return {
        ok: false,
        error: `找不到会话「${text}」：没有 id、Telegram 群 id 与它相同，也没有标题包含它的会话`,
      };
    }
    for (const conversation of found) matched.set(conversation.id, conversation);
  }
  return { ok: true, matched: [...matched.values()] };
}

/** 导出的一项（字段顺序即输出顺序；没有的字段不写） */
export type ExportItem = {
  time: string;
  conversation: { id: string; platform?: string; title?: string };
  purpose: LoggedRequest['purpose'];
  replyId?: string;
  step?: number;
  attempt: number;
  durationMs: number;
  outcome: LoggedRequest['outcome'];
  request: LoggedRequest['body'];
  response: RequestResponse;
  missingImages?: string[];
};

/** 读出的一次请求换成导出的一项。conversations 按会话 id 查；找不到时只写 id */
export function exportItem(
  request: LoggedRequest,
  conversations: ReadonlyMap<string, StoredConversation>,
): ExportItem {
  const found = conversations.get(request.conversationId);
  return {
    time: formatLocalTime(new Date(request.startedAt)),
    conversation: found
      ? {
          id: found.id,
          platform: found.platform,
          ...(found.title === undefined ? {} : { title: found.title }),
        }
      : { id: request.conversationId },
    purpose: request.purpose,
    ...(request.replyId === undefined ? {} : { replyId: request.replyId }),
    ...(request.step === undefined ? {} : { step: request.step }),
    attempt: request.attempt,
    durationMs: request.durationMs,
    outcome: request.outcome,
    request: request.body,
    response: request.response,
    ...(request.missingImages === undefined ? {} : { missingImages: request.missingImages }),
  };
}

/**
 * 把各项写成一个 JSON 数组，内容与 `JSON.stringify(items, null, 2)` 加换行相同。逐项写出，
 * 不拼成一整个字符串；写不进去时等 drain（背压）。流出错时抛出
 */
export async function writeJsonArray(items: Iterable<unknown>, out: Writable): Promise<void> {
  // 流出错时记下（写的间隙里出错也不会成为没人接的 error 事件），下一次写之前抛出
  const state: { failure?: { error: unknown } } = {};
  const onError = (error: unknown) => {
    state.failure ??= { error };
  };
  out.on('error', onError);
  const check = () => {
    if (state.failure) throw state.failure.error;
  };
  const write = async (text: string) => {
    check();
    if (!out.write(text)) {
      await new Promise<void>((resolve, reject) => {
        const done = (error?: unknown) => {
          out.off('drain', onDrain);
          out.off('error', done);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onDrain = () => done();
        out.on('drain', onDrain);
        out.on('error', done);
      });
    }
    check();
  };
  try {
    let first = true;
    for (const item of items) {
      const json = JSON.stringify(item, null, 2).replaceAll('\n', '\n  ');
      await write(`${first ? '[\n' : ',\n'}  ${json}`);
      first = false;
    }
    await write(first ? '[]\n' : '\n]\n');
  } finally {
    out.off('error', onError);
  }
}

/**
 * 跑一次导出，返回退出码（成功 0，参数、打开或写出出错 1）。JSON 写到 stdout 或 -o 的文件；
 * 匹配到的会话、摘要与错误写到 stderr
 */
export async function runExport({
  argv,
  env,
  now,
  stdout,
  stderr,
  openFile = openOutputFile,
}: {
  argv: string[];
  env: Env;
  now: Date;
  stdout: Writable;
  stderr: Writable;
  /** 打开 -o 的文件，默认打开真实文件；测试里换成会出错的流 */
  openFile?: (path: string) => Promise<Writable>;
}): Promise<number> {
  const say = (line: string) => stderr.write(`${line}\n`);
  const fail = (message: string) => {
    say(message);
    return 1;
  };

  const parsed = parseExportArgs(argv, now);
  if (!parsed.ok) return fail(`${parsed.error}\n用 --help 查看用法`);
  if (parsed.help) {
    stdout.write(`${usage}\n`);
    return 0;
  }
  const { options } = parsed;
  const { dbPath, filesDir, requestsDbPath } = dataPaths(env);

  if (!existsSync(requestsDbPath)) {
    return fail(
      `请求记录不存在：${requestsDbPath}（可能设置了 LUOLI_REQUEST_LOG=off，或还没有运行过洛璃服务）`,
    );
  }
  if (!existsSync(dbPath)) return fail(`主库不存在：${dbPath}`);
  if (options.output !== undefined && !isDirectory(dirname(options.output))) {
    return fail(`输出文件所在的目录不存在：${dirname(options.output)}`);
  }

  let conversations: StoredConversation[];
  try {
    conversations = readConversations(dbPath);
  } catch (error) {
    return fail(`打开主库失败（${dbPath}）：${(error as Error).message}`);
  }
  let conversationIds: string[] | undefined;
  if (options.conversations.length > 0) {
    const match = matchConversations(conversations, options.conversations);
    if (!match.ok) return fail(match.error);
    for (const c of match.matched) {
      say(`会话：${c.title ?? '（无标题）'}（${c.platform}，${c.id}）`);
    }
    conversationIds = match.matched.map((c) => c.id);
  }

  let requests: LoggedRequest[];
  try {
    const log = openRequestLog({
      path: requestsDbPath,
      fileStore: openFileStore(filesDir),
      readOnly: true,
    });
    try {
      requests = await log.list(
        {
          conversationIds,
          since: options.since,
          until: options.until,
          replyId: options.replyId,
          failedOnly: options.failedOnly,
        },
        { embedImages: options.embedImages },
      );
    } finally {
      log.close();
    }
  } catch (error) {
    return fail(`读取请求记录失败（${requestsDbPath}）：${(error as Error).message}`);
  }

  const byId = new Map(conversations.map((c) => [c.id, c]));
  const items = requests.map((request) => exportItem(request, byId));
  const destination = options.output ?? '标准输出';
  try {
    if (options.output === undefined) {
      await writeJsonArray(items, stdout);
    } else {
      await writeAndClose(items, await openFile(options.output));
    }
  } catch (error) {
    // 管道的读端先关了（如接 head）：不算出错
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') return 0;
    return fail(`写出失败（${destination}）：${(error as Error).message}`);
  }

  const range = describeRange(options);
  say(
    items.length === 0
      ? `没有符合条件的请求（${range}），输出了 []（${destination}）`
      : `导出 ${items.length} 条请求（${range}），写到${destination}`,
  );
  return 0;
}

/** 打开 -o 的文件：等打开成功（打不开时抛出） */
export async function openOutputFile(path: string): Promise<Writable> {
  const file = createWriteStream(path);
  await new Promise<void>((resolve, reject) => {
    file.once('open', () => resolve());
    file.once('error', reject);
  });
  return file;
}

/**
 * 写进流后关闭它，等写完。写入出错时抛出，包括最后几段：它们进了缓冲区（write 返回 true）、
 * 之后才写失败的，错误比 writeJsonArray 的最后一次检查晚到，要在关闭时才看得到
 */
export async function writeAndClose(items: Iterable<unknown>, stream: Writable): Promise<void> {
  // 从头到尾挂着：任何时候出的错都记下，也不会成为没人接的 error 事件
  let failure: { error: unknown } | undefined;
  const onError = (error: unknown) => {
    failure ??= { error };
  };
  stream.on('error', onError);
  try {
    try {
      await writeJsonArray(items, stream);
    } catch (error) {
      stream.destroy();
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    }).catch((error: unknown) => {
      // end 的回调可能只说流已销毁（ERR_STREAM_DESTROYED），真正的原因是先到的那个错误
      throw failure?.error ?? error;
    });
    if (failure) throw failure.error;
  } finally {
    stream.off('error', onError);
  }
}

/** 摘要里的时间范围（本机时区） */
function describeRange(options: ExportOptions): string {
  const parts: string[] = [];
  if (options.defaultRange) parts.push('最近 24 小时');
  const from = options.since ? formatLocalTime(options.since) : '不限';
  const to = options.until ? formatLocalTime(options.until) : '不限';
  parts.push(`开始时间 ${from} 至 ${to}`);
  if (options.replyId !== undefined) parts.push(`回复 ${options.replyId}`);
  if (options.failedOnly) parts.push('只看失败的');
  return parts.join('，');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
