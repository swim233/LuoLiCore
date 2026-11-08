import {
  createMemoryFileStore,
  createMemoryStorage,
  type FileStore,
  type Logger,
  type Storage,
} from '../core/index.js';
import { createApp } from './app.js';
import { createEvents } from './events.js';
import { createLive } from './live.js';
import { observeStorage } from './observed-storage.js';
import { relayChanges } from './relay.js';
import { createStatus } from './status.js';
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
};

/** 没有进行中的回复的现场 */
export const emptyLive: LiveSnapshot = { seq: 0, replies: [] };

/** 空的数据（内存存储里没有会话），给只测页面、访问控制、SSE 连接的测试用 */
export function emptyViews() {
  return createViews({
    storage: createMemoryStorage(),
    fileStore: createMemoryFileStore(),
    webState: { readSeq: () => 0, advanceRead: () => 0, close() {} },
  });
}

/**
 * 装一套：storage 是核心的存储（默认内存），observed 是包过一层的（写入经过它才有事件）；
 * 已读位置存在内存里的 web.db，第一次打开时照常用现有会话初始化；「此刻」与服务的状态照服务里的
 * 接法装上（status 给了就用它代替）。request 默认带上本机的 Host
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
} = {}) {
  const { logger, entries } = recordingLogger();
  const webState = await openWebState(':memory:', async () =>
    (await storage.overviews({ textChars: 0 })).flatMap((overview) =>
      overview.last ? [[overview.id, overview.last.seq] as const] : [],
    ),
  );
  const views = createViews({ storage, fileStore, webState, timeZone, now });
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
  });
  const service = createStatus({
    startedAt: new Date('2026-11-08T00:00:00.000Z'),
    name,
    telegram,
    lastReply: () => live.lastReply,
  });
  const statusOf = status ?? service.status;
  const relay = relayChanges({ views, events, logger });
  const observed = observeStorage(storage, relay.onChange);
  const app = createApp({ port: testPort, dist, events, views, status: statusOf, logger });
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
    entries,
    request,
  };
}
