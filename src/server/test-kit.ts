import {
  createMemoryFileStore,
  createMemoryStorage,
  createRedactor,
  installTools,
  type FileStore,
  type InstalledTool,
  type Logger,
  type Storage,
} from '../core/index.js';
import { testPrompts } from '../core/test-prompts.js';
import { createApp } from './app.js';
import { createChats, type Chats } from './chat.js';
import { createEvents } from './events.js';
import type { FeedsDb } from './feeds-db.js';
import { createTryMonitorTool } from './monitors/tools.js';
import type { ServiceLayer } from './services/layer.js';
import { createLive } from './live.js';
import { observeStorage } from './observed-storage.js';
import { relayChanges } from './relay.js';
import { createSessions, type SessionOptions, type Sessions } from './sessions.js';
import { createStatus } from './status.js';
import { createTaskService, type Clock, type TaskService } from './tasks/service.js';
import { createTaskTools } from './tasks/tools.js';
import { toolSummaries } from './tool-summary.js';
import type { LiveSnapshot, ServiceStatus } from './types.js';
import { createViews } from './views.js';
import { openWebState } from './web-state.js';

// 测试用：把服务的网页部分（存储包一层、已读、数据、事件、接口）装起来，不起端口

export const testPort = 7310;
export const testHost = `127.0.0.1:${testPort}`;

export type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

export function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) => {
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  };
  return {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    entries,
  };
}

export const testStatus: ServiceStatus = {
  startedAt: '2026-11-08T00:00:00.000Z',
  uptimeSeconds: 42,
  telegram: { enabled: true, connected: false },
  assistant: { name: '洛璃', wakeWords: ['nori'] },
  web: { author: 'Alice' },
};

/** 没有进行中的回复的现场 */
export const emptyLive: LiveSnapshot = { seq: 0, replies: [] };

/** 空的数据（内存存储里没有会话），给只测页面、访问控制、SSE 连接的测试用 */
export function emptyViews() {
  return createViews({
    storage: createMemoryStorage(),
    fileStore: createMemoryFileStore(),
    webState: {
      readSeq: () => 0,
      advanceRead: () => 0,
      title: () => undefined,
      setTitle() {},
      close() {},
    },
  });
}

/**
 * 装一套：storage 是核心的存储（默认内存），observed 是包过一层的（写入经过它才有事件）；
 * 已读位置存在内存里的 web.db，第一次打开时照常用现有会话初始化；「此刻」与服务的状态照服务里的
 * 接法装上（status 给了就用它代替）。给了 model 时再装上会话管理（回复由「此刻」旁听）、网页会话的
 * 对话接口与任务服务（网页会话的到点入口、取消任务的接口），接法与 main.ts 相同；taskTools 时
 * 任务工具接在 tools 后面。给了 monitors（服务层与 feeds.db）时任务服务带上监听的引擎；服务层里有服务时
 * 任务工具还能建、改监听任务，最后多一个试跑监听的工具。定时器不自己开始（测试里调 tasks.start()）。
 * request 默认带上本机的 Host
 */
export async function testService({
  storage = createMemoryStorage(),
  fileStore = createMemoryFileStore(),
  dist = '/nonexistent-luoli-dist',
  heartbeat,
  backlogLimit,
  timeZone = 'Asia/Singapore',
  now,
  status,
  name = '洛璃',
  telegram,
  delayMs,
  model,
  tools = [],
  maxRetries = 0,
  author = 'Alice',
  secrets = [],
  taskTools = false,
  clock,
  monitors,
}: {
  storage?: Storage;
  fileStore?: FileStore;
  dist?: string;
  heartbeat?: number;
  backlogLimit?: number;
  timeZone?: string;
  now?: () => Date;
  status?: () => ServiceStatus;
  /** 助手的显示名 */
  name?: string;
  /** 启动了 Telegram 时它的唤醒词；不给时当作没启动 */
  telegram?: { wakeWords: readonly string[] };
  /** 逐字片段攒多久 */
  delayMs?: number;
  /** 给了才装会话管理与对话接口 */
  model?: SessionOptions['model'];
  tools?: readonly InstalledTool[];
  maxRetries?: number;
  /** 网页会话里发言人的名字 */
  author?: string;
  /** 要从错误文字里抹掉的秘密（服务里是 API key 与 Telegram token） */
  secrets?: string[];
  /** 装上任务工具（接在 tools 后面） */
  taskTools?: boolean;
  /** 任务服务的时钟（测试里用假的） */
  clock?: Clock;
  /** 监听（ADR-0014）：服务层与 feeds.db */
  monitors?: { layer: ServiceLayer; feeds: FeedsDb };
} = {}) {
  const { logger, entries } = recordingLogger();
  const webState = await openWebState(':memory:', async () =>
    (await storage.overviews({ textChars: 0 })).flatMap((overview) =>
      overview.last ? [[overview.id, overview.last.seq] as const] : [],
    ),
  );
  let tasks: TaskService | undefined;
  // 照服务的装配：服务层里有服务时才能建、试跑监听任务
  const serving = monitors && monitors.layer.services.length > 0 ? monitors.layer : undefined;
  const installed = taskTools
    ? [
        ...tools,
        ...installTools(
          [
            ...createTaskTools(
              () => tasks!,
              serving ? { monitors: { services: serving.services } } : {},
            ),
            ...(serving
              ? [
                  createTryMonitorTool({
                    layer: serving,
                    checkConversation: (id) => tasks!.allows(id),
                  }),
                ]
              : []),
          ],
          {},
        ).tools,
      ]
    : tools;
  const summarize = toolSummaries(installed);
  const redact = createRedactor(secrets);
  const views = createViews({
    storage,
    fileStore,
    webState,
    timeZone,
    now,
    summarize,
    monitorView: (task) => tasks?.monitorView(task),
  });
  // events 的 hello 要用 live，live 推事件要用 events：互相在用到时才取
  const lastReply = await storage.lastReply();
  const events = createEvents({
    hello: () => ({ ...statusOf(), live: live.snapshot() }),
    logger,
    heartbeat,
    backlogLimit,
  });
  const live = createLive({
    broadcast: (event) => events.broadcast('live', event),
    logger,
    lastReply,
    delayMs,
    summarize,
    redact,
  });
  const service = createStatus({
    startedAt: new Date('2026-11-08T00:00:00.000Z'),
    name,
    webAuthor: author,
    telegram,
    lastReply: () => live.lastReply,
  });
  const statusOf = status ?? service.status;
  const relay = relayChanges({ views, events, logger });
  const observed = observeStorage(storage, relay.onChange);
  let sessions: Sessions | undefined;
  let chats: Chats | undefined;
  if (model) {
    const opened = (): Sessions => sessions!;
    tasks = createTaskService({
      storage: observed,
      open: (conversationId) => opened().open(conversationId),
      logger,
      clock,
      ...(monitors
        ? {
            monitors: {
              ...monitors,
              notify: (task) =>
                relay.onChange({
                  type: 'task',
                  conversationId: task.conversationId,
                  taskId: task.id,
                }),
            },
          }
        : {}),
    });
    sessions = createSessions({
      model,
      prompts: testPrompts('你是测试助手'),
      tools: installed,
      storage: observed,
      fileStore,
      logger,
      maxRetries,
    });
    sessions.onReply(live.listener);
    chats = createChats({
      sessions,
      storage: observed,
      fileStore,
      webState,
      live,
      webAuthor: author,
      logger,
      notify: relay.onChange,
      summarize,
      redact,
    });
    const webChats = chats;
    tasks.setEntrance('web', { deliver: (due) => webChats.due(due), accepts: () => true });
  }
  const app = createApp({
    port: testPort,
    dist,
    events,
    views,
    status: statusOf,
    logger,
    chats,
    tasks,
    fileStore,
    chatHeartbeat: heartbeat,
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { host: testHost, ...init.headers } });
  return {
    app,
    events,
    views,
    relay,
    storage,
    observed,
    fileStore,
    webState,
    live,
    status: service,
    sessions,
    chats,
    tasks,
    entries,
    request,
  };
}

/**
 * 假时钟：now 只在 advance 时往前走；setTimeout 排的到时候（按到点的先后）在 advance 里执行。
 * 别的计时器（模型的流、「此刻」的合并）照常用真的
 */
export function fakeClock(start: Date | string) {
  let now = new Date(start).getTime();
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => new Date(now),
    setTimeout(run: () => void, ms: number): unknown {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), run });
      return id;
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
    },
    /** 往前走 ms 毫秒，途中到时候的计时器依次执行 */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target);
        if (due.length === 0) break;
        const [id, timer] = due.reduce((a, b) => (b[1].at < a[1].at ? b : a));
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.run();
      }
      now = target;
    },
    /** 排着的计时器还要等多久（毫秒），按先后 */
    pending(): number[] {
      return [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b);
    },
  };
}

// ─── 测试用的图片字节：只有文件头（宽高读得出），不是能解码的图 ─────────────

/** PNG：文件头加 IHDR（宽高），末尾的 tag 让内容各不相同 */
export function pngBytes(width: number, height: number, tag = ''): Uint8Array {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
  bytes.push(...[...'IHDR'].map((c) => c.charCodeAt(0)));
  for (const value of [width, height]) {
    bytes.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
  }
  bytes.push(8, 6, 0, 0, 0, ...new TextEncoder().encode(tag));
  return Uint8Array.from(bytes);
}

/** JPEG 与 WebP：只有文件头 */
export function jpegBytes(tag = ''): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(tag)]);
}
export function webpBytes(tag = ''): Uint8Array {
  const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
  return Uint8Array.from([
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...new TextEncoder().encode(tag),
  ]);
}

/** GIF：frames 帧（每帧一个图像块，前面带一个图形控制扩展块），宽高 width × height */
export function gifBytes(frames: number, width = 4, height = 3): Uint8Array {
  const word = (value: number) => [value & 255, (value >>> 8) & 255];
  const bytes = [...[...'GIF89a'].map((c) => c.charCodeAt(0)), ...word(width), ...word(height)];
  // 没有全局颜色表
  bytes.push(0x00, 0, 0);
  for (let i = 0; i < frames; i++) {
    bytes.push(0x21, 0xf9, 0x04, 0x00, 10, 0, 0, 0x00);
    bytes.push(0x2c, ...word(0), ...word(0), ...word(width), ...word(height), 0x00);
    bytes.push(0x02, 0x02, 0x4c, 0x01, 0x00);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
