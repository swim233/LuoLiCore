import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_DESCRIPTIONS, HOT_RELOADABLE_CONFIG_KEYS, KNOWN_UNIMPLEMENTED_CONFIG_KEYS, configJsonSchema, configSchemaLeafPaths, configSchema } from '@luoli/core';

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

  // doc 11 开头立的契约是「标 热更新 的项保存后立即生效」。上一轮有十组键标着热更新而实际冻在
  // 启动时，其中 sandbox.mode / approval.enabled / approval.rules 三组是「出事时运维会去点的那个
  // 开关」——点了没用而界面还说成功（docs/20 · W-CFG-02）。这条断言让标注只能跟着白名单走。
  // WebUI 的自动生成表单直接按白名单给每一项打「热更新 / 需重启」徽标（docs/21 §1.1），
  // 文档与白名单一旦对不上，界面就会照着错的那份说话。
  it('only labels genuinely hot-reloadable keys as 热更新 in doc 11', () => {
    // 每一段 yaml 都要查：只查第一段时 logs / skills / plugins 那几块整段漏在断言外，
    // 里面三个键标着热更新而实际冻在启动时。
    const blocks = readFileSync('docs/11-config-reference.md', 'utf8').split('```yaml').slice(1).map((part) => part.split('```')[0]!);
    expect(blocks.length).toBeGreaterThan(1);
    const unimplemented = new Set<string>(KNOWN_UNIMPLEMENTED_CONFIG_KEYS as readonly string[]);
    const labelled: string[] = [];
    for (const block of blocks) {
      const stack: string[] = [];
      for (const line of block.split('\n')) {
        const match = /^(\s*)([a-zA-Z][\w]*):/.exec(line);
        if (!match) continue;
        stack.length = match[1]!.length / 2;
        stack.push(match[2]!);
        if (line.includes('热更新')) labelled.push(stack.join('.'));
      }
    }
    expect(labelled.length).toBeGreaterThan(20);
    const covered = (key: string): boolean => unimplemented.has(key)
      || HOT_RELOADABLE_CONFIG_KEYS.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
    expect(labelled.filter((key) => !covered(key))).toEqual([]);
    // 白名单里的每一项也必须真的是 schema 里的路径，否则改名之后这条断言会静默变松。
    const leaves = new Set(configLeafPaths(configSchema.parse({})));
    for (const prefix of HOT_RELOADABLE_CONFIG_KEYS) {
      expect([...leaves].some((leaf) => leaf === prefix || leaf.startsWith(`${prefix}.`)), `${prefix} 不在 schema 里`).toBe(true);
    }
  });

  // WebUI 的「全部配置」表单逐格渲染 schema 里的 `description`（docs/09 §3.13）。没有说明的格子
  // 只剩一个点分键名，运维得回去翻 doc 11 才知道自己在改什么 —— 而那正是「界面上改得动但不敢改」
  // 的来源。这两条断言让说明与 schema 严格一一对应：加配置项时必须顺手写一句，删配置项时残留的
  // 说明也会被点名（悄悄留着的话，下一个人会以为那个键还在）。
  it('describes every configuration leaf and every top-level section', () => {
    const document_ = configJsonSchema();
    const leaves = configSchemaLeafPaths(document_);
    expect(leaves.length).toBeGreaterThan(200);
    const definitions = document_.definitions as Record<string, { properties?: Record<string, unknown> } | undefined>;
    const sections = Object.keys(definitions.LuoLiConfig?.properties ?? {});
    expect(sections.length).toBeGreaterThan(20);
    const required = new Set([...leaves, ...sections]);
    expect([...required].filter((path) => !CONFIG_DESCRIPTIONS[path]?.trim()), '这些配置项还没有作用说明').toEqual([]);
    expect(Object.keys(CONFIG_DESCRIPTIONS).filter((path) => !required.has(path)), '这些说明对应的配置项已经不存在了').toEqual([]);
  });

  // 说明必须真的进到 `GET /api/config/schema` 的返回里，而不是只躺在那张表里。zodToJsonSchema
  // 对复用的 zod 实例发 $ref（quota 那几个金额键指的是同一个 nullableMoney），说明只能挂成 $ref
  // 的兄弟键 —— 写进被指向的节点会让互指的键共用同一句话。
  it('carries per-path descriptions into the generated JSON schema, including behind $ref', () => {
    const document_ = configJsonSchema() as Record<string, any>;
    const quota = document_.definitions.LuoLiConfig.properties.quota.properties;
    expect(quota.global.properties.daily.description).toBe(CONFIG_DESCRIPTIONS['quota.global.daily']);
    expect(quota.perUser.properties.monthly.$ref).toContain('quota/properties/global');
    expect(quota.perUser.properties.monthly.description).toBe(CONFIG_DESCRIPTIONS['quota.perUser.monthly']);
    expect(quota.global.properties.daily.description).not.toBe(quota.perUser.properties.monthly.description);
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
