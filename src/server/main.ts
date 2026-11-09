import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createModel,
  createPromptFiles,
  createRedactor,
  openFileStore,
  openSqliteStorage,
  type RecentReply,
  type Storage,
} from '../core/index.js';
import { createLogger } from '../shared/logger.js';
import { openRequestLogging, type RequestLogging } from '../shared/request-log.js';
import { setupTools } from '../shared/tools.js';
import type { startTelegram } from '../telegram/app.js';
import { tools as toolList } from '../tools/index.js';
import { createApp } from './app.js';
import { createChats, type Chats } from './chat.js';
import { parseServerConfig } from './config.js';
import { createEvents, type Events } from './events.js';
import { hostname, listen, type Listener } from './listen.js';
import { createLive } from './live.js';
import { observeStorage } from './observed-storage.js';
import { isBuilt, notBuiltText, webDist } from './pages.js';
import { relayChanges } from './relay.js';
import { createSessions } from './sessions.js';
import { createStatus } from './status.js';
import { createTaskService } from './tasks/service.js';
import { createTaskTools } from './tasks/tools.js';
import { startTelegramFrontend } from './telegram.js';
import { toolSummaries } from './tool-summary.js';
import { createViews } from './views.js';
import { openWebState, type WebState } from './web-state.js';

// 洛璃服务（ADR-0009）：一个进程里有核心的各个会话、Telegram 前端（设了 token 时）与网页服务

const parsed = parseServerConfig(process.env);
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}
const { config } = parsed;
const startedAt = new Date();
// token 与 API key 写进日志前都会被抹掉；打到终端的错误同样先抹一遍
const logger = createLogger(config.model, config.telegram ? [config.telegram.token] : []);
const redact = createRedactor([config.telegram?.token, config.model.apiKey]);

if (!config.telegram) console.error('没有设置 LUOLI_TELEGRAM_TOKEN，不启动 Telegram');

// 人设与内置提示文件：启动时读一遍并检查，有错就退出；之后每次回复、每次摘要开始时重读。
// 所有会话共用这一个来源
const prompts = createPromptFiles({ personaPath: config.promptPath, logger });
try {
  await prompts.load();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// 工具清单：通用工具，后面接上任务工具（ADR-0010）。有误时退出；缺环境变量的不装，各提示一行。
// 所有会话共用装上的这一份。任务服务要等包过一层的存储建好才有（见下文），任务工具执行时才取它
const installed = setupTools([...toolList, ...createTaskTools(() => taskService)], process.env, {
  logger,
  report: (line) => console.error(line),
});
if (!installed.ok) {
  console.error(installed.error);
  process.exit(1);
}

let storage: Storage;
try {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  storage = openSqliteStorage(config.dbPath);
} catch (error) {
  console.error(`打开数据库失败（${config.dbPath}）：${(error as Error).message}`);
  process.exit(1);
}

const fileStore = openFileStore(config.filesDir);

// 请求记录：每次发给模型的请求原样记下（ADR-0008）；打不开时退出
let requestLogging: RequestLogging;
try {
  requestLogging = openRequestLogging({
    config: config.requestLog,
    fileStore,
    logger,
    secrets: [config.model.apiKey, config.telegram?.token],
  });
} catch (error) {
  console.error(redact((error as Error).message));
  storage.close();
  process.exit(1);
}

// 网页面板自己的状态（已读位置），只在开网页服务时打开。第一次建立时，现有会话以当时最后一条
// 消息为已读；打不开时退出
let webState: WebState | undefined;
if (config.web) {
  const { dbPath } = config.web;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    webState = await openWebState(dbPath, async () =>
      (await storage.overviews({ textChars: 0 })).flatMap((overview) =>
        overview.last ? [[overview.id, overview.last.seq] as const] : [],
      ),
    );
  } catch (error) {
    console.error(`打开网页状态库失败（${dbPath}）：${(error as Error).message}`);
    await requestLogging.close();
    storage.close();
    process.exit(1);
  }
}

let telegram: Awaited<ReturnType<typeof startTelegram>> | undefined;

// 上次回复：启动时从数据库取，之后每次回复正常完成时更新
let lastReply: RecentReply | undefined;
try {
  lastReply = await storage.lastReply();
} catch (error) {
  logger.error({ error: (error as Error).message }, 'service.last_reply_failed');
}

// 「此刻」：旁听会话管理里的每次回复，转成 live 事件；记着进行中回复的现场
// 工具调用给界面看的一句话（工具定义里的摘要），整理消息与推实时事件时用
const summarize = toolSummaries(installed.tools);

const live = createLive({
  broadcast: (event) => events?.broadcast('live', event),
  logger,
  lastReply,
  redact,
  summarize,
});

// 服务的状态：GET /api/health、SSE 的 hello 与 status 事件
const status = createStatus({
  startedAt,
  name: config.name,
  webAuthor: config.web?.author ?? '',
  telegram: config.telegram && { wakeWords: config.telegram.wakeWords },
  lastReply: () => live.lastReply,
});

// 网页服务的数据与实时事件。写入经过包了一层的存储时，变化转成 SSE 事件推给面板；
// 连上时先发状态与现场
const events = config.web
  ? createEvents({ hello: () => ({ ...status.status(), live: live.snapshot() }), logger })
  : undefined;
const views = webState && createViews({ storage, fileStore, webState, summarize });
const relay = views && events && relayChanges({ views, events, logger });
const observed = relay ? observeStorage(storage, relay.onChange) : storage;

// 任务（ADR-0010）：建、列出、取消，定时器。事件写进会话管理里的会话，任务的写入经包过的存储推给面板。
// 到点交给会话所在平台的前端（网页会话在下面登记，Telegram 在它启动时登记）；定时器在所有前端都起来
// 之后才开始
const taskService = createTaskService({
  storage: observed,
  open: (conversationId) => sessions.open(conversationId),
  logger,
});

// 会话管理：所有会话对象都从这里取，同一个会话只有一个
const sessions = createSessions({
  model: createModel({ ...config.model, fetch: requestLogging.fetch }),
  prompts,
  tools: installed.tools,
  storage: observed,
  fileStore,
  logger,
  maxRetries: config.maxRetries,
  timeouts: config.timeouts,
  maxSteps: config.maxSteps,
  toolHistoryChars: config.toolHistoryChars,
  segments: config.segments,
});
sessions.onReply(live.listener);

// 网页会话与 CLI 会话的对话：发消息、排队与补回复、重试（只有网页）、中止。只在开网页服务时有
const chats: Chats | undefined =
  config.web && webState && relay
    ? createChats({
        sessions,
        storage: observed,
        fileStore,
        webState,
        live,
        webAuthor: config.web.author,
        logger,
        notify: relay.onChange,
        summarize,
        redact,
      })
    : undefined;
if (chats) {
  const webChats = chats;
  taskService.setEntrance('web', (due) => webChats.due(due));
}

/** 启动失败时：关掉已经打开的，退出 */
async function fail(message: string, web?: { events: Events; listener: Listener }): Promise<never> {
  console.error(redact(message));
  await web?.events.close();
  await web?.listener.close();
  await sessions.close(0);
  webState?.close();
  await requestLogging.close();
  storage.close();
  process.exit(1);
}

// 先开网页服务：端口被占用时，在连 Telegram 之前就退出
let web: { events: Events; listener: Listener; port: number } | undefined;
if (config.web && events && views) {
  const { port } = config.web;
  if (!isBuilt(webDist)) {
    console.error(notBuiltText);
    logger.warn({ dist: webDist }, 'web.not_built');
  }
  const app = createApp({
    port,
    dist: webDist,
    events,
    views,
    status: status.status,
    logger,
    chats,
    tasks: taskService,
    fileStore,
  });
  try {
    web = { events, listener: await listen(app, port), port };
  } catch (error) {
    await fail((error as Error).message);
  }
  logger.info({ port }, 'web.start');
}

if (config.telegram) {
  try {
    telegram = await startTelegramFrontend({
      config: config.telegram,
      sessions,
      storage: observed,
      logger,
      live,
      status,
      events,
      tasks: taskService,
    });
  } catch (error) {
    await fail(`Telegram 启动失败：${(error as Error).message}`, web);
  }
}

// 前端都起来了：先处理停机期间错过的、正好到点的任务，再盯着最近的下次到点
taskService.start();

logger.info(
  { web: web ? { port: web.port } : false, telegram: telegram !== undefined },
  'service.start',
);
if (web) console.log(`网页面板：http://${hostname}:${web.port}/`);
if (telegram) console.log('Telegram bot 已启动');
console.log('按 Ctrl+C 退出');

let stopping = false;
const stop = async () => {
  // 第二次按 Ctrl+C 时直接退出
  if (stopping) process.exit(1);
  stopping = true;
  console.log('正在退出……');
  // 先停掉定时器：不再有新的到点（正在处理的那次做完）
  await taskService.stop();
  // 不再接新连接；开着的连接留到最后，期间面板还连着
  web?.listener.stopListening();
  // 网页会话不再接新消息，排队的补回复取消
  chats?.close();
  // Telegram 收尾（不再开始新的一轮，进行中的回复照它的做法等完或中止），同时其余进行中的回复
  // 也等完或中止，再关闭各会话：两段宽限期一起等，最多 10 秒
  await Promise.all([telegram?.stop(), sessions.close()]);
  // 网页里中止的回复：abort 段写进响应再断开，网页显示「已中止」
  await chats?.settled();
  // 已经发生的写入，事件推完再断开面板
  await relay?.settled();
  await web?.events.close();
  await web?.listener.close();
  webState?.close();
  // 等已经开始的请求记录写完再关
  await requestLogging.close();
  storage.close();
  logger.info({}, 'service.stop');
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
