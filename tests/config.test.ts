import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_UNIMPLEMENTED_CONFIG_KEYS, configSchema } from '@luoli/core';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

function configLeafPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [prefix];
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length
      ? entries.flatMap(([key, child]) => configLeafPaths(child, prefix ? `${prefix}.${key}` : key))
      : [prefix];
  }
  return [prefix];
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `config.a.b.c` / `config?.a?.b?.c` 这样的完整访问链。 */
const chainPattern = (path: string[]): RegExp => new RegExp(path.map((part) => `(?:\\?)?\\.${escape(part)}`).join('') + '\\b');
/** 对象被整体传下去（`new Foo(config.a.b)`、`{ ...config.a }`），此时叶子只能在别处按名字读到。 */
const valuePattern = (path: string[]): RegExp => new RegExp(`(?:\\?)?\\.${path.map(escape).join('(?:\\?)?\\.')}\\b`);
const leafPattern = (leaf: string): RegExp => new RegExp(`(?:\\.|\\?\\.)${escape(leaf)}\\b|["']${escape(leaf)}["']\\s*:`);

describe('config schema', () => {
  it('rejects documented unsafe boundaries', () => {
    expect(() => configSchema.parse({ context: { limit: { tokens: 1000 } } })).toThrow();
    expect(() => configSchema.parse({ concurrency: { perKey: 20, global: 8 } })).toThrow(/perKey/);
    expect(() => configSchema.parse({ webui: { host: '0.0.0.0', passwordHash: '' } })).toThrow(/password/);
    expect(() => configSchema.parse({ perChat: { chat: { access: { defaultUserRole: 'owner' } } } })).toThrow(/allowlist/);
    expect(() => configSchema.parse({ general: { timezone: 'Asia/Shangahi' } })).toThrow(/IANA/);
  });

  it('applies documented defaults', () => {
    const config = configSchema.parse({});
    expect(config.context.limit.tokens).toBe(32_000);
    expect(config.sandbox.mode).toBe('docker');
    expect(config.webui.host).toBe('127.0.0.1');
  });

  it('explicitly classifies every known unimplemented configuration leaf', () => {
    expect(new Set(KNOWN_UNIMPLEMENTED_CONFIG_KEYS).size).toBe(KNOWN_UNIMPLEMENTED_CONFIG_KEYS.length);
    const schema = readFileSync('packages/core/src/config/schema.ts', 'utf8');
    const docLines = readFileSync('docs/11-config-reference.md', 'utf8').split('\n');
    for (const key of KNOWN_UNIMPLEMENTED_CONFIG_KEYS) {
      expect(schema, key).toContain(`'${key}'`);
      // 光"文档里出现过这个键"是空断言——doc 11 是配置手册，每个键本来就都在。必须真的标了 🚧。
      expect(docLines.filter((line) => line.includes(`\`${key}\``) && line.includes('🚧')), `${key} 需要在 docs/11 标注 🚧`).not.toHaveLength(0);
    }
  });

  it('requires every config leaf to be referenced by full path or explicitly classified', () => {
    const source = [...sourceFiles('packages'), ...sourceFiles('apps')]
      .filter((path) => path !== 'packages/core/src/config/schema.ts')
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    const known = new Set<string>(KNOWN_UNIMPLEMENTED_CONFIG_KEYS as readonly string[]);
    const unclassified = configLeafPaths(configSchema.parse({})).filter((key) => {
      if (!key || known.has(key)) return false;
      const parts = key.split('.');
      // 顶层键（如 perChat）的名字本身已经足够特异。
      if (parts.length === 1) return !chainPattern(parts).test(source);
      // 一档：路径的任意一段连续后缀（长度 ≥ 2）以访问链形式出现。覆盖 `config.media` 传下去后
      // 内部写 `this.config.extract.maxChars` 这类情况，同时仍要求父段与叶子相邻。
      for (let start = 0; start <= parts.length - 2; start += 1) if (chainPattern(parts.slice(start)).test(source)) return false;
      // 二档：某级祖先被整体传下去 + 叶子名在别处出现（如 `{...config.trigger}` → `options.mention`）。
      // 比只按叶子名匹配严格得多——单靠 `.mode`、`.enabled` 撞名不再能蒙混过关（docs/19 · R-CFG-03）。
      for (let end = parts.length - 1; end >= 1; end -= 1) {
        if (valuePattern(parts.slice(0, end)).test(source) && leafPattern(parts.at(-1)!).test(source)) return false;
      }
      return true;
    });
    expect(unclassified).toEqual([]);
  });
});
