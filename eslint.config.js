import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// 前端（CLI、Telegram）、导出脚本（src/requests/）与前端共用的配置、日志：任何含这些路径段的写法，
// 如 ../cli/x.js、../../src/cli/x.js、./../cli 等（不区分大小写）
const frontends = [
  '(^|[/#])cli(/|$)',
  '(^|[/#])telegram(/|$)',
  '(^|[/#])shared(/|$)',
  '(^|[/#])requests(/|$)',
];

// 洛璃服务（src/server/）与网页面板（src/web/）：core 与工具同样不得引用
const serverAndWeb = ['(^|[/#])server(/|$)', '(^|[/#])web(/|$)'];

// core 不得引用的模块
const forbiddenInCore = [
  ...frontends,
  ...serverAndWeb,
  // 工具清单与工具（src/tools/），同上；core 只认 defineTool 的形状。core 自己的 ./tools.js 不算
  '(^|[/#])tools(/|$)',
  // core 只依赖 Logger 接口，不引用 pino
  '^pino(/|$)',
  '^(node:)?readline(/|$)',
  '^chat(/|$)',
  '^@chat-adapter/',
  '^grammy(/|$)',
];

// 网页面板里没有 Node：node: 模块与不带前缀的内置模块（fs、path……）都不能引用
const nodeBuiltins = `^(node:|(${builtinModules
  .filter((name) => !name.startsWith('_'))
  .join('|')})(/|$))`;

// 网页面板不得引用的目录：服务端、core、各前端与它们共用的代码、工具（src/ 下的同名目录）
const outsideDirs = 'core|server|cli|telegram|shared|requests|tools';

// 网页面板不得引用的模块，按文件所在的深度（d = src/web 到文件之间隔了几层目录）分别写：
// 走出 src/web 到 src/ 要 d+1 个 ../，所以只有 (../){d+1}core 这样的才是 core；
// 网页自己的 ./server/x、../tools/y（d ≥ 1 时是 src/web 里的目录）不拦。
// 另外含 src/core 这样的路径段一律拦（不管写几个 ../ 或绝对路径），子路径导入 #core 也拦。
// d 超过 WEB_DEPTHS 的文件用最宽的写法（任何路径段含这些目录名都拦）
const WEB_DEPTHS = 5;
const webPatterns = (d) => [
  `^(\\.\\./){${d + 1}}(${outsideDirs})(/|$)`,
  `(^|/)src/(${outsideDirs})(/|$)`,
  `^#(${outsideDirs})(/|$)`,
  nodeBuiltins,
];
const webPatternsDeep = [`(^|[/#])(${outsideDirs})(/|$)`, nodeBuiltins];

/**
 * files 里的代码不得引用 patterns 匹配的模块，静态 import 与动态 import() 都查。
 * allowTypeImports 为真时 import type 不查（动态 import() 是值，照查）
 */
function restrictImports(files, patterns, message, { allowTypeImports = false } = {}) {
  // 动态 import() 不受 no-restricted-imports 检查，用选择器补上；模板字符串只看开头一段
  const selector = `/${patterns.join('|').replaceAll('/', '\\/')}/i`;
  return {
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: patterns.map((regex) => ({ regex, message, allowTypeImports })) },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: `ImportExpression > Literal[value=${selector}]`, message },
        {
          selector: `ImportExpression > TemplateLiteral[quasis.0.value.cooked=${selector}]`,
          message,
        },
      ],
    },
  };
}

// CLI 是洛璃服务的客户端（不带核心）：服务端的代码只许 import type；core 只许纯函数的
// tool-content（图片说明、工具结果的文字）与类型；不引用其他前端、共用代码、导出脚本、工具、网页。
// 测试不在此列（连接部分的测试要装一个真的服务）
const cliForbidden = [
  '(^|[/#])server(/|$)',
  '(^|[/#])core(/(?!tool-content(\\.js)?$)|$)',
  '(^|[/#])telegram(/|$)',
  '(^|[/#])shared(/|$)',
  '(^|[/#])requests(/|$)',
  '(^|[/#])tools(/|$)',
  '(^|[/#])web(/|$)',
];

const WEB_MESSAGE =
  '网页面板不得引用服务端、core、前端、工具的代码或 node 模块（import type 可以）';

export default defineConfig(
  globalIgnores(['node_modules', 'dist', '.grill', '.handoff', 'coverage']),
  js.configs.recommended,
  tseslint.configs.recommended,
  restrictImports(
    ['src/core/**'],
    forbiddenInCore,
    'core 不得引用前端、服务、网页、平台代码或工具清单',
  ),
  restrictImports(
    ['src/tools/**'],
    [...frontends, ...serverAndWeb],
    '工具不得引用前端、服务或网页代码',
  ),
  // 网页面板：不得引用服务端、core、前端、工具的代码或 node 模块（import type 可以）
  ...Array.from({ length: WEB_DEPTHS }, (_, d) =>
    restrictImports([`src/web/${'*/'.repeat(d)}*.{ts,tsx}`], webPatterns(d), WEB_MESSAGE, {
      allowTypeImports: true,
    }),
  ),
  restrictImports(
    [`src/web/${'*/'.repeat(WEB_DEPTHS)}**/*.{ts,tsx}`],
    webPatternsDeep,
    WEB_MESSAGE,
    { allowTypeImports: true },
  ),
  {
    // import { type X } from '...' 在 verbatimModuleSyntax 下运行时仍会 import 那个模块，
    // 会把 core 等模块带进浏览器包：只许写 import type { X }
    files: ['src/web/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-import-type-side-effects': 'error' },
  },
  {
    ...restrictImports(
      ['src/cli/**/*.ts'],
      cliForbidden,
      'CLI 是洛璃服务的客户端：服务端只许 import type，core 只许 tool-content 与类型，不引用其他前端、共用代码、工具或网页',
      { allowTypeImports: true },
    ),
    ignores: ['src/cli/**/*.test.ts'],
  },
  {
    // 同上：CLI 引用服务、core 的类型时只许写 import type { X }，不把它们带进运行时
    files: ['src/cli/**/*.ts'],
    rules: { '@typescript-eslint/no-import-type-side-effects': 'error' },
  },
);
