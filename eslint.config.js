import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import markdownManifest from './packages/markdown/package.json' with { type: 'json' };
import uiManifest from './packages/ui/package.json' with { type: 'json' };

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
 * 一组引用规则：patterns 里任一个匹配就报 message。
 * allowTypeImports 为真时 import type 不查（动态 import() 是值，照查）
 */
const rule = (patterns, message, { allowTypeImports = false } = {}) => ({
  patterns,
  message,
  allowTypeImports,
});

/**
 * files 里的代码不得引用 groups 里各组规则匹配的模块，静态 import 与动态 import() 都查。
 * 一个文件只认最后一份匹配到它的 no-restricted-imports、no-restricted-syntax 设置（后面的整份覆盖前面的，
 * 不合并），所以一个文件要守的几组规则要写在同一次调用里
 */
function restrictImports(files, ...groups) {
  // 动态 import() 不受 no-restricted-imports 检查，用选择器补上；模板字符串只看开头一段
  const re = (patterns) => `/${patterns.join('|').replaceAll('/', '\\/')}/i`;
  return {
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: groups.flatMap(({ patterns, message, allowTypeImports }) =>
            patterns.map((regex) => ({ regex, message, allowTypeImports })),
          ),
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...groups.flatMap(({ patterns, message }) => [
          { selector: `ImportExpression > Literal[value=${re(patterns)}]`, message },
          {
            selector: `ImportExpression > TemplateLiteral[quasis.0.value.cooked=${re(patterns)}]`,
            message,
          },
        ]),
      ],
    },
  };
}

// 组件库（packages/ui，包名 @luoli/ui）是浏览器里的代码：src/ 下只有网页面板能引用。
// core、工具、服务、CLI、Telegram、导出脚本、共用代码都不能（测试也不例外，import type 也不行）
const noUi = rule(
  ['^@luoli/ui(/|$)'],
  '组件库 @luoli/ui 是浏览器里的代码，src/ 下只有网页面板（src/web/）能引用',
);
// src/ 下的代码（含网页面板）只能按包名引工作区的包（组件库 @luoli/ui/…、Markdown 解析 @luoli/markdown）：
// 任何含 packages 路径段的写法（相对路径、绝对路径）都拦，经 node_modules/@luoli/ 的路径也拦
const viaPackageName = rule(
  ['(^|[/#])packages(/|$)', '(^|/)node_modules/@luoli/'],
  '工作区的包（组件库 @luoli/ui/…、@luoli/markdown）只能按包名引用，不能用相对路径或含 packages/、node_modules/@luoli/ 的路径绕进去',
);

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

// 组件库（packages/ui）：只许引用包里自己的文件，和它自己 package.json 里声明的依赖。
// 根目录的 node_modules 里解析得到的别的包（hono、ai、marked……）不能靠这个引到；import type 也不行。
const uiDeps = Object.keys({
  ...uiManifest.dependencies,
  ...uiManifest.peerDependencies,
  ...uiManifest.optionalDependencies,
});
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 测试由根目录的 vitest 跑，测试文件另外可以引 vitest；控件的测试用 react-dom/server 渲染（不需要 DOM），react-dom 在包的 devDependencies 里
const uiTestDeps = [...uiDeps, 'vitest', 'react-dom'];
// 按文件所在的深度（d = packages/ui 到文件之间隔了几层目录）分别写：走出 packages/ui 要 d+1 个 ../
// （中间夹着 ./ 也算）；任何含 src/ 路径段的写法一律拦（面板、core、服务都在根目录的 src/ 下）；
// 不以 . 开头的（裸模块名、绝对路径、node: 与内置模块、#子路径）只放过声明了的依赖。
// d 达到 UI_DEPTHS 的文件用最宽的写法：开头有 UI_DEPTHS+1 个以上 ../ 的都拦
const UI_DEPTHS = 5;
const uiPatterns = (ups, deps) => [
  `^(\\./)*(\\.\\.(/|$)(\\./)*){${ups}}`,
  '(^|[/#])src(/|$)',
  // 展示页（packages/ui/showcase/）是开发时用的，库的代码不能反过来引用它
  '(^|[/#])showcase(/|$)',
  `^(?!\\.|(${deps.map(escapeRe).join('|')})(/|$))`,
  nodeBuiltins,
];
const UI_MESSAGE = `组件库只许引用包里自己的文件和 packages/ui/package.json 里声明的依赖（${uiDeps.join('、')}），不得引用面板、core、服务的代码或 node 模块`;
const uiRules = (ext, deps, message) =>
  [
    ...Array.from({ length: UI_DEPTHS }, (_, d) =>
      restrictImports(
        [`packages/ui/${'*/'.repeat(d)}*.${ext}`],
        rule(uiPatterns(d + 1, deps), message),
      ),
    ),
    restrictImports(
      [`packages/ui/${'*/'.repeat(UI_DEPTHS)}**/*.${ext}`],
      rule(uiPatterns(UI_DEPTHS + 1, deps), message),
    ),
    // 展示页有自己的一套规则（见下），不走库的这套
  ].map((config) => ({ ...config, ignores: ['packages/ui/showcase/**'] }));

// 组件库的展示页（packages/ui/showcase/，开发时用，不进任何构建）：只许引用库自己的文件（按相对路径 ../src/…）、
// 展示页自己的文件，和 packages/ui/package.json 里声明的包（含 devDependencies）；不得引用仓库 src/ 下的任何东西（面板、core、服务）。
// 按文件所在的深度（d = showcase 到文件之间隔了几层目录）分别写：走出 packages/ui 要 d+2 个 ../（d+1 个到 packages/ui，库的 src 在那里）；
// 先进目录再往上退的写法（a/../../x）一律拦；不以 . 开头的（裸模块名、绝对路径、node: 与内置模块、#子路径）只放过声明了的包
const showcaseDeps = Object.keys({
  ...uiManifest.dependencies,
  ...uiManifest.peerDependencies,
  ...uiManifest.optionalDependencies,
  ...uiManifest.devDependencies,
});
const SHOWCASE_EXT = '{ts,tsx,js,mjs,mts,cts,cjs,jsx}';
const showcasePatterns = (d, deps) => [
  `^(\\./)*(\\.\\.(/|$)(\\./)*){${d + 2}}`,
  '(^|/)[^/.][^/]*/\\.\\.(/|$)',
  '(^|[/#])packages(/|$)',
  `^(?!\\.|(${deps.map(escapeRe).join('|')})(/|$))`,
  nodeBuiltins,
];
const SHOWCASE_MESSAGE = `组件库的展示页只许引用库自己的文件（../src/…）、展示页自己的文件和 packages/ui/package.json 里声明的包，不得引用仓库 src/ 下的面板、core、服务的代码或 node 模块`;
const showcaseRules = (ext, deps, message) => [
  ...Array.from({ length: UI_DEPTHS }, (_, d) =>
    restrictImports(
      [`packages/ui/showcase/${'*/'.repeat(d)}*.${ext}`],
      rule(showcasePatterns(d, deps), message),
    ),
  ),
  restrictImports(
    [`packages/ui/showcase/${'*/'.repeat(UI_DEPTHS)}**/*.${ext}`],
    rule(showcasePatterns(UI_DEPTHS, deps), message),
  ),
];

// Markdown 解析（packages/markdown，包名 @luoli/markdown）：面板和 Telegram 前端共用，浏览器和 Node 里都要能跑。
// 只许引用包里自己的文件和它 package.json 里声明的依赖（marked）；不得引用面板、core、服务、前端的代码，
// node 模块和没声明的包；import type 也不行。测试文件另外可以引 vitest。
// 按文件所在的深度（d = packages/markdown 到文件之间隔了几层目录）分别写：走出 packages/markdown 要 d+1 个 ../
// （中间夹着 ./ 也算）；先进目录再往上退的写法（a/../../x）一律拦；任何含 src/ 路径段的写法也拦
// （包里的文件之间按 ./x.js、../x.js 引，用不到）；不以 . 开头的（裸模块名、绝对路径、node: 与内置模块、
// #子路径）只放过声明了的依赖。d 达到 MARKDOWN_DEPTHS 的文件用最宽的写法
const markdownDeps = Object.keys({
  ...markdownManifest.dependencies,
  ...markdownManifest.peerDependencies,
  ...markdownManifest.optionalDependencies,
});
const MARKDOWN_DEPTHS = 5;
const MARKDOWN_EXT = '{ts,tsx,js,mjs,mts,cts,cjs,jsx}';
const markdownPatterns = (ups, deps) => [
  `^(\\./)*(\\.\\.(/|$)(\\./)*){${ups}}`,
  '(^|/)[^/.][^/]*/\\.\\.(/|$)',
  '(^|[/#])src(/|$)',
  `^(?!\\.|(${deps.map(escapeRe).join('|')})(/|$))`,
  nodeBuiltins,
];
const MARKDOWN_MESSAGE = `Markdown 解析的包只许引用包里自己的文件和 packages/markdown/package.json 里声明的依赖（${markdownDeps.join('、')}），不得引用面板、core、服务、前端的代码或 node 模块`;
const markdownRules = (ext, deps, message) => [
  ...Array.from({ length: MARKDOWN_DEPTHS }, (_, d) =>
    restrictImports(
      [`packages/markdown/${'*/'.repeat(d)}*.${ext}`],
      rule(markdownPatterns(d + 1, deps), message),
    ),
  ),
  restrictImports(
    [`packages/markdown/${'*/'.repeat(MARKDOWN_DEPTHS)}**/*.${ext}`],
    rule(markdownPatterns(MARKDOWN_DEPTHS + 1, deps), message),
  ),
];

export default defineConfig(
  globalIgnores(['node_modules', 'dist', '.grill', '.handoff', 'coverage']),
  js.configs.recommended,
  tseslint.configs.recommended,
  // src/ 下除了网页面板的全部代码（含测试）：不得引用组件库，也不得绕路径进 packages/。
  // 写在最前面：后面 core、工具、CLI 各自的规则对它们的文件整份覆盖这一份，所以那几处也带上这两组
  { ...restrictImports(['src/**'], noUi, viaPackageName), ignores: ['src/web/**'] },
  restrictImports(
    ['src/core/**'],
    rule(forbiddenInCore, 'core 不得引用前端、服务、网页、平台代码或工具清单'),
    noUi,
    viaPackageName,
  ),
  restrictImports(
    ['src/tools/**'],
    rule([...frontends, ...serverAndWeb], '工具不得引用前端、服务或网页代码'),
    noUi,
    viaPackageName,
  ),
  // 组件库：不得引用包外面的文件、node 模块和没声明的依赖
  ...uiRules('{ts,tsx,js,mjs,mts,cts,cjs,jsx}', uiDeps, UI_MESSAGE),
  // 测试文件另外可以引 vitest（写在后面，对测试文件覆盖上面那一组）
  ...uiRules(
    'test.{ts,tsx,js,mjs,mts,cts,cjs,jsx}',
    uiTestDeps,
    UI_MESSAGE + '；测试文件另外可以引 vitest',
  ),
  // 展示页：同理（写在后面，测试文件覆盖前一组）
  ...showcaseRules(SHOWCASE_EXT, showcaseDeps, SHOWCASE_MESSAGE),
  ...showcaseRules(
    `test.${SHOWCASE_EXT}`,
    [...showcaseDeps, 'vitest'],
    SHOWCASE_MESSAGE + '；测试文件另外可以引 vitest',
  ),
  {
    // 同网页面板：只许写 import type { X }
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-import-type-side-effects': 'error' },
  },
  // Markdown 解析的包：不得引用包外面的文件、node 模块和没声明的依赖
  ...markdownRules(MARKDOWN_EXT, markdownDeps, MARKDOWN_MESSAGE),
  // 测试文件另外可以引 vitest（写在后面，对测试文件覆盖上面那一组）
  ...markdownRules(
    `test.${MARKDOWN_EXT}`,
    [...markdownDeps, 'vitest'],
    MARKDOWN_MESSAGE + '；测试文件另外可以引 vitest',
  ),
  {
    // 同组件库：只许写 import type { X }
    files: ['packages/markdown/**/*.ts'],
    rules: { '@typescript-eslint/no-import-type-side-effects': 'error' },
  },
  // 网页面板：不得引用服务端、core、前端、工具的代码或 node 模块（import type 可以）；组件库只能按包名引
  ...Array.from({ length: WEB_DEPTHS }, (_, d) =>
    restrictImports(
      [`src/web/${'*/'.repeat(d)}*.{ts,tsx}`],
      rule(webPatterns(d), WEB_MESSAGE, { allowTypeImports: true }),
      viaPackageName,
    ),
  ),
  restrictImports(
    [`src/web/${'*/'.repeat(WEB_DEPTHS)}**/*.{ts,tsx}`],
    rule(webPatternsDeep, WEB_MESSAGE, { allowTypeImports: true }),
    viaPackageName,
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
      rule(
        cliForbidden,
        'CLI 是洛璃服务的客户端：服务端只许 import type，core 只许 tool-content 与类型，不引用其他前端、共用代码、工具或网页',
        { allowTypeImports: true },
      ),
      noUi,
      viaPackageName,
    ),
    // 测试走最前面那一份（不得引用组件库）
    ignores: ['src/cli/**/*.test.ts'],
  },
  {
    // 同上：CLI 引用服务、core 的类型时只许写 import type { X }，不把它们带进运行时
    files: ['src/cli/**/*.ts'],
    rules: { '@typescript-eslint/no-import-type-side-effects': 'error' },
  },
);
