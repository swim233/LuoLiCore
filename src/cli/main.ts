import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { createClient, ServiceUnreachable, unreachableText } from './client.js';
import { parseConfig, usage } from './config.js';
import { handleLine, runLines } from './lines.js';
import { errorLine, flushed, notice } from './notice.js';
import { createChatSession } from './session.js';
import { runTerminal } from './terminal.js';

// CLI 是洛璃服务的客户端（ADR-0009）：经服务的 HTTP 接口发消息、收流式回复。
// 不带核心，不读数据库、提示词与 key，不写日志与请求记录，这些都由服务做

const parsed = parseConfig(process.argv.slice(2), process.env);
if (!parsed.ok) {
  console.error(parsed.error);
  if (parsed.showUsage) console.error(usage);
  process.exit(1);
}
const { port, resume } = parsed.config;
const name = parsed.config.name ?? systemUserName();

const client = createClient({ port });

/**
 * 结束程序：关掉连接（最多等 1 秒），等 stdout、stderr 把输出都写出去（管道里的要等下游读走），
 * 再明确退出，不让残留的连接或计时器拖住进程（实测服务冻住又恢复之后，偶尔按 Ctrl+D 后进程没有
 * 马上结束）
 */
let exiting: Promise<never> | undefined;
function exit(code: number): Promise<never> {
  exiting ??= (async () => {
    await client.close();
    await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
    process.exit(code);
  })();
  return exiting;
}

// 下游不读了（管道的另一头关掉了：退出了 less、head 读够了）：像收到 SIGPIPE 的程序一样马上结束，
// 退出码 0，不再处理后面的行。不先关连接：进程结束时连接随之断开，服务把断开当作中止，进行中的回复
// 不会接着生成；先关连接的话，还在读的那一句会以为服务断了、打出「无法连接」。stderr 写不出去就算了
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  void flushed(process.stderr).then(() => process.exit(error.code === 'EPIPE' ? 0 : 1));
});
process.stderr.on('error', () => {});

/** 连不上服务：打印提示，退出码 1 */
async function unreachable(): Promise<never> {
  errorLine(unreachableText(client.address));
  return exit(1);
}

// 先确认服务在运行，回的是洛璃服务的状态
if (!(await client.healthy())) await unreachable();

// 默认每次新开会话（发第一句时才建）；--resume 接着最后消息最新的 CLI 会话
let conversationId: string | undefined;
if (resume) {
  let latest;
  try {
    latest = await client.latestCliConversation();
  } catch (error) {
    if (!(error instanceof ServiceUnreachable)) throw error;
    await unreachable();
  }
  if (latest) {
    notice(`接着上次的会话（${latest.messages} 条消息）`);
    conversationId = latest.id;
  } else {
    notice('没有之前的 CLI 会话，已新开一个');
  }
}

const session = createChatSession({ client, author: name, conversationId });

if (process.stdin.isTTY) {
  // 终端里连不上服务时打印提示、不退出，服务起来后接着用。整行是 /compact、/clear 时是指令
  await runTerminal(async (text, signal) => {
    await handleLine(session, text, signal);
  });
} else {
  // 管道输入：逐行按顺序处理，每行（消息或指令）等它结束再处理下一行，读到 EOF 结束；不显示提示符，
  // 不处理 Ctrl+C（按默认退出）。迭代 rl 会缓存读到的行：EOF 时 rl 立即关闭，已读入的行照常处理。
  // 连不上服务（发不出去、流中途断了、超时）时不再处理后面的行，退出码 1；模型出错照常接着下一行
  const rl = createInterface({ input: process.stdin, terminal: false });
  const code = await runLines(rl, session);
  if (code !== 0) process.exitCode = code;
  rl.close();
}
// 用完了：等输出写完再退出（见 exit）
await exit(Number(process.exitCode ?? 0));

/** 系统用户名；取不到时（极少见）叫「CLI」 */
function systemUserName(): string {
  try {
    return userInfo().username || 'CLI';
  } catch {
    return 'CLI';
  }
}
