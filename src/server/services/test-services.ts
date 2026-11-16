import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../../core/index.js';
import { onClose } from '../../net/test-server.js';
import { defineService, type ServiceDefinition } from '../../plugin-api.js';

// 服务的测试用的东西：临时目录里的假文档、假服务的声明、记下日志的 logger。
// 临时目录在 closeAll（src/net/test-server.ts）时删掉

/** 新建一个临时目录，closeAll 时删掉 */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'luoli-services-'));
  onClose(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 临时目录里写一份假文档：overview.md 加上每个接口的 <id>.md，内容是「<服务> 的总说明」「<服务> 的 <id> 一节」。
 * skip 里的文件不写
 */
export function fakeDocs(service: string, ids: readonly string[], skip: string[] = []): URL {
  const dir = tempDir();
  const files: Record<string, string> = {
    'overview.md': `# ${service} 的总说明\n\n这是假的文档。\n`,
    ...Object.fromEntries(ids.map((id) => [`${id}.md`, `# ${service} 的 ${id} 一节\n`])),
  };
  for (const [file, text] of Object.entries(files)) {
    if (!skip.includes(file)) writeFileSync(join(dir, file), text);
  }
  return pathToFileURL(`${dir}/`);
}

/**
 * 假服务的声明：默认叫 demo，两个接口 item（/items/{id}，查询参数 lang、q）、search（/search，查询参数 q），
 * 不要环境变量、不带认证，每天最多 100 次，文档在临时目录里。overrides 里的覆盖默认的
 */
export function fakeService(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  const name = overrides.name ?? 'demo';
  const endpoints = overrides.endpoints ?? [
    { id: 'item', title: '条目', path: '/items/{id}', query: ['lang', 'q'] },
    { id: 'search', title: '搜索', path: '/search', query: ['q'] },
  ];
  return defineService({
    name,
    title: '示例服务',
    summary: '测试用的假服务',
    env: [],
    baseUrl: 'http://127.0.0.1:9',
    endpoints,
    limits: { minIntervalSeconds: 60, maxRequestsPerDay: 100 },
    docs:
      overrides.docs ??
      fakeDocs(
        name,
        endpoints.map(({ id }) => id),
      ),
    ...overrides,
  });
}

export type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

/** 记下日志和提示行的 logger */
export function recording() {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) =>
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  const logger: Logger = { info: record('info'), warn: record('warn'), error: record('error') };
  const lines: string[] = [];
  return { logger, entries, lines, report: (line: string) => lines.push(line) };
}
