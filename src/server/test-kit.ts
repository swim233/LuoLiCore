import {
  createMemoryFileStore,
  createMemoryStorage,
  type FileStore,
  type Logger,
  type Storage,
} from '../core/index.js';
import { createApp } from './app.js';
import { createEvents } from './events.js';
import { observeStorage } from './observed-storage.js';
import { relayChanges } from './relay.js';
import type { ServiceStatus } from './types.js';
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
};

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
 * 已读位置存在内存里的 web.db，第一次打开时照常用现有会话初始化。
 * request 默认带上本机的 Host
 */
export async function testService({
  storage = createMemoryStorage(),
  fileStore = createMemoryFileStore(),
  dist = '/nonexistent-luoli-dist',
  heartbeat,
  timeZone = 'Asia/Singapore',
  now,
  status = () => testStatus,
}: {
  storage?: Storage;
  fileStore?: FileStore;
  dist?: string;
  heartbeat?: number;
  timeZone?: string;
  now?: () => Date;
  status?: () => ServiceStatus;
} = {}) {
  const { logger, entries } = recordingLogger();
  const webState = await openWebState(':memory:', async () =>
    (await storage.overviews({ textChars: 0 })).flatMap((overview) =>
      overview.last ? [[overview.id, overview.last.seq] as const] : [],
    ),
  );
  const views = createViews({ storage, fileStore, webState, timeZone, now });
  const events = createEvents({ status, logger, heartbeat });
  const relay = relayChanges({ views, events, logger });
  const observed = observeStorage(storage, relay.onChange);
  const app = createApp({ port: testPort, dist, events, views, status, logger });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { host: testHost, ...init.headers } });
  return { app, events, views, relay, storage, observed, fileStore, webState, entries, request };
}
