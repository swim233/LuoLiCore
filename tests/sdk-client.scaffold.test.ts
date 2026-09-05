import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { code, codeIndex, source } from './support/source.js';
// 走别名而非相对路径导入：这个 import 本身就是 vitest.config.ts 别名同步（同步点②）的行为级证明 ——
// 别名配错（比如子路径条目排在裸包名之后）会让这一行直接解析失败，而不是等到某条断言变红。
import {
  sdkCommitKindSchema,
  sdkCreateSessionInputSchema,
  sdkErrorCodeSchema,
  sdkErrorResponseSchema,
  sdkPageQuerySchema,
  sdkSendMessageInputSchema,
  sdkSessionSchema,
  sdkStreamEventSchema,
} from '@luoli/sdk-client/schema';

describe('T3.6a sdk-client 脚手架：四处同步', () => {
  it('tsconfig.json paths 含裸包名与子路径两条', () => {
    const tsconfig = source('tsconfig.json');
    expect(tsconfig).toContain(code('"@luoli/sdk-client": ["packages/sdk-client/src/index.ts"]'));
    expect(tsconfig).toContain(code('"@luoli/sdk-client/schema": ["packages/sdk-client/src/schema.ts"]'));
  });

  it('vitest.config.ts resolve.alias 含两条，且子路径排在裸包名之前', () => {
    const vitestConfig = source('vitest.config.ts');
    expect(vitestConfig).toContain(code("'@luoli/sdk-client/schema': `${root}packages/sdk-client/src/schema.ts`,"));
    expect(vitestConfig).toContain(code("'@luoli/sdk-client': `${root}packages/sdk-client/src/index.ts`,"));
    // vite 的字符串别名匹配按插入顺序取第一个 `importee === find || importee.startsWith(find + '/')`：
    // 裸包名排在子路径前面会让 `@luoli/sdk-client/schema` 被裸名条目命中，拼出不存在的
    // `.../src/index.ts/schema`。次序颠倒时上面那条 import 会先炸，这里再钉一次顺序本身。
    const schemaAt = codeIndex(vitestConfig, "'@luoli/sdk-client/schema':");
    const bareAt = codeIndex(vitestConfig, "'@luoli/sdk-client':");
    expect(schemaAt).toBeGreaterThanOrEqual(0);
    expect(bareAt).toBeGreaterThanOrEqual(0);
    expect(schemaAt).toBeLessThan(bareAt);
  });

  it('packages/server/package.json 依赖 @luoli/sdk-client（workspace:*）', () => {
    const serverPkg = source('packages/server/package.json');
    expect(serverPkg).toContain(code('"@luoli/sdk-client": "workspace:*"'));
  });

  it('scripts/postbuild.ts 的 PACKAGES 收了 sdk-client', () => {
    const postbuild = source('scripts/postbuild.ts');
    expect(postbuild).toContain(
      code('const PACKAGES = ["shared", "db", "core", "server", "telegram", "plugin-sdk", "sdk-client"];'),
    );
  });
});

describe('T3.6a sdk-client 脚手架：包声明', () => {
  it('package.json 不依赖任何 @luoli/*（结构校验，不是文本匹配，故直接读 JSON）', () => {
    const pkg = JSON.parse(readFileSync('packages/sdk-client/package.json', 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      exports?: Record<string, string>;
    };
    expect(pkg.name).toBe('@luoli/sdk-client');
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.some((name) => name.startsWith('@luoli/'))).toBe(false);
    expect(pkg.dependencies?.zod).toBeTruthy();
    // 两个子路径导出都要指向既有包一致的 dist 布局。
    expect(pkg.exports?.['.']).toBe('./dist/index.js');
    expect(pkg.exports?.['./schema']).toBe('./dist/schema.js');
  });
});

describe('T3.6a sdk-client 脚手架：schema.ts 校验', () => {
  it('会话对象与创建/修改入参：合法样例通过', () => {
    expect(
      sdkSessionSchema.safeParse({
        id: 'sess_1',
        sourceId: 'telegram',
        label: null,
        modelAlias: null,
        outputFormat: 'markdown',
        createdAt: Date.now(),
        deletedAt: null,
      }).success,
    ).toBe(true);
    expect(sdkCreateSessionInputSchema.safeParse({}).success).toBe(true);
    expect(sdkCreateSessionInputSchema.safeParse({ modelAlias: 'main', outputFormat: 'plain', label: 'demo' }).success).toBe(true);
  });

  it('outputFormat 非法值被拒', () => {
    expect(sdkCreateSessionInputSchema.safeParse({ outputFormat: 'html' }).success).toBe(false);
    expect(sdkCreateSessionInputSchema.safeParse({ outputFormat: 'MARKDOWN' }).success).toBe(false);
  });

  it('messages 入参：endUserId 必填，缺失被拒', () => {
    expect(sdkSendMessageInputSchema.safeParse({ endUserId: 'end-user-1', text: '你好' }).success).toBe(true);
    expect(sdkSendMessageInputSchema.safeParse({ text: '缺 endUserId' }).success).toBe(false);
    expect(sdkSendMessageInputSchema.safeParse({ endUserId: '', text: '空串也不行' }).success).toBe(false);
  });

  it('endUserId 超长或含控制字符被拒，取值本身无形态限制', () => {
    expect(sdkSendMessageInputSchema.safeParse({ endUserId: 'a'.repeat(256), text: 'ok' }).success).toBe(true);
    expect(sdkSendMessageInputSchema.safeParse({ endUserId: 'a'.repeat(257), text: '超长' }).success).toBe(false);
    expect(sdkSendMessageInputSchema.safeParse({ endUserId: 'user\x00id', text: '控制字符' }).success).toBe(false);
    // 整数用户 id 在第三方后端常见：数字字符串本身合法，无需额外形态白名单。
    expect(sdkSendMessageInputSchema.safeParse({ endUserId: '918273645', text: '数字 id' }).success).toBe(true);
  });

  it('分页入参：limit 经查询字符串传入时可 coerce', () => {
    expect(sdkPageQuerySchema.safeParse({ limit: '20' }).success).toBe(true);
    expect(sdkPageQuerySchema.safeParse({ limit: 20 }).success).toBe(true);
    expect(sdkPageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(sdkPageQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('错误契约：code 进契约、message 不进契约', () => {
    expect(
      sdkErrorResponseSchema.safeParse({ ok: false, error: { code: 'not_found', message: '随便什么字符串', retryable: false } })
        .success,
    ).toBe(true);
    expect(sdkErrorCodeSchema.safeParse('not_a_real_code').success).toBe(false);
    // 遍历 `.options` 而不是重复一份字面量清单：T3.6 补了 `not_implemented`/`internal` 两个值
    // （依赖缺失、未预期的内部异常），硬编码清单会在下一次扩枚举时悄悄漏测新值而不报错。
    for (const c of sdkErrorCodeSchema.options) {
      expect(sdkErrorCodeSchema.safeParse(c).success).toBe(true);
    }
    expect(sdkErrorCodeSchema.options).toEqual([
      'unauthorized', 'not_found', 'invalid_request', 'turn_queue_full',
      'upstream_error', 'session_deleted', 'not_implemented', 'internal', 'quota_exceeded',
      'cancelled',
    ]);
  });

  it('SSE 四事件：delta / done / error / queued', () => {
    expect(sdkStreamEventSchema.safeParse({ event: 'delta', data: { text: '增量文本' } }).success).toBe(true);
    expect(
      sdkStreamEventSchema.safeParse({
        event: 'done',
        data: {
          text: '最终文本',
          usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 },
        },
      }).success,
    ).toBe(true);
    expect(
      sdkStreamEventSchema.safeParse({
        event: 'error',
        data: { code: 'upstream_error', message: '上游模型服务出错', retryable: true },
      }).success,
    ).toBe(true);
    // message 缺失即拒收：与 HTTP 错误体 `{code,message,retryable}` 同形（T3.8）。
    expect(
      sdkStreamEventSchema.safeParse({ event: 'error', data: { code: 'upstream_error', retryable: true } }).success,
    ).toBe(false);
    expect(sdkStreamEventSchema.safeParse({ event: 'queued', data: {} }).success).toBe(true);
    expect(sdkStreamEventSchema.safeParse({ event: 'queued', data: { position: 3 } }).success).toBe(true);
    expect(sdkStreamEventSchema.safeParse({ event: 'unknown', data: {} }).success).toBe(false);
  });

  it('commits 列表项：kind 枚举与 context_commits 一致', () => {
    for (const kind of ['turn', 'prune', 'reset', 'manual', 'revert']) {
      expect(sdkCommitKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(sdkCommitKindSchema.safeParse('rebase').success).toBe(false);
  });
});
