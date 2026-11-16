import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import rootManifest from './package.json' with { type: 'json' };
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

// 洛璃服务（src/server/）与网页面板（src/web/）：core 与插件的入口文件同样不得引用
const serverAndWeb = ['(^|[/#])server(/|$)', '(^|[/#])web(/|$)'];

// 插件（根目录的 plugins/，含插件清单 plugins/index.ts）：任何含 plugins 路径段的写法
// （服务自己的 ./plugins.js 不算：那一段是 plugins.js）
const pluginsDir = '(^|[/#])plugins(/|$)';
// 插件的入口文件（src/plugin-api.ts）：最后一段是 plugin-api 的写法（带不带扩展名、写几个 ../ 都算）。
// 它转出了核心的代码，src/ 下只有洛璃服务能引它，不然网页面板、CLI 能经它绕过「只引核心的类型」
const pluginApiFile = '(^|[/#])plugin-api(\\.[cm]?[jt]s)?$';

// core 不得引用的模块
const forbiddenInCore = [
  ...frontends,
  ...serverAndWeb,
  // 插件与插件的入口文件（src/plugin-api.ts）：core 只认 defineTool 的形状，不认识插件
  pluginsDir,
  pluginApiFile,
  // core 只依赖 Logger 接口，不引用 pino
  '^pino(/|$)',
  '^(node:)?readline(/|$)',
  '^chat(/|$)',
  '^@chat-adapter/',
  '^grammy(/|$)',
];

// 正则里要当普通字符的模块名（如 @mozilla/readability）先转义
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 网页面板里没有 Node：node: 模块与不带前缀的内置模块（fs、path……）都不能引用
const nodeBuiltins = `^(node:|(${builtinModules
  .filter((name) => !name.startsWith('_'))
  .join('|')})(/|$))`;

// 网页面板不得引用的目录：服务端、core、各前端与它们共用的代码（src/ 下的同名目录）
const outsideDirs = 'core|server|cli|telegram|shared|requests';

// 网页面板不得引用的模块，按文件所在的深度（d = src/web 到文件之间隔了几层目录）分别写：
// 走出 src/web 到 src/ 要 d+1 个 ../，所以只有 (../){d+1}core 这样的才是 core；
// 网页自己的 ./server/x、../cli/y（d ≥ 1 时是 src/web 里的目录）不拦。
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
// 插件（根目录的 plugins/）：走出 src/web 到仓库根要 d+2 个 ../（中间夹着 ./ 也算）；
// 绝对路径里含 plugins 路径段、子路径导入 #plugins 也拦。插件的入口文件 src/plugin-api.ts 也拦。
// import type 也不行
const webPluginPatterns = (d) => [
  `^(\\./)*(\\.\\.(/|$)(\\./)*){${d + 2}}plugins(/|$)`,
  '^/(.*/)?plugins(/|$)',
  '^#plugins(/|$)',
  pluginApiFile,
];

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
// core、插件的入口文件、服务、CLI、Telegram、导出脚本、共用代码都不能（测试也不例外，import type 也不行）
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

// 插件和插件的入口文件只有洛璃服务（src/server/）能引用，插件只引清单 plugins/index.js：src/ 下别的代码
// （前端、导出脚本、共用代码，CLI 的测试与非测试文件）都不能，import type 也不行。
// core、网页面板另有自己的一份
const noPlugins = rule(
  [pluginsDir, pluginApiFile],
  '插件（plugins/）和插件的入口文件（src/plugin-api.ts）只有洛璃服务（src/server/）能引用，插件只引清单 plugins/index.js',
);
// 洛璃服务只引插件清单，不引插件里的文件（插件的东西都经清单交给服务）
const onlyPluginList = rule(
  ['(^|[/#])plugins(/(?!index\\.js$)|$)'],
  '洛璃服务只引插件清单 plugins/index.js，不引插件里的文件',
);

// CLI 是洛璃服务的客户端（不带核心）：服务端的代码只许 import type；core 只许纯函数的
// tool-content（图片说明、工具结果的文字）与类型；不引用其他前端、共用代码、导出脚本、网页。
// 插件另由 noPlugins 拦（import type 也不行）。测试不在此列（连接部分的测试要装一个真的服务）
const cliForbidden = [
  '(^|[/#])server(/|$)',
  '(^|[/#])core(/(?!tool-content(\\.js)?$)|$)',
  '(^|[/#])telegram(/|$)',
  '(^|[/#])shared(/|$)',
  '(^|[/#])requests(/|$)',
  '(^|[/#])web(/|$)',
];

const WEB_MESSAGE = '网页面板不得引用服务端、core、前端的代码或 node 模块（import type 可以）';
const WEB_PLUGIN_MESSAGE =
  '网页面板不得引用插件（plugins/）和插件的入口文件（src/plugin-api.ts），import type 也不行';

// 插件的入口文件（src/plugin-api.ts）：只引核心（./core/…），别的一律拦：
// 不以 ./core/ 开头的（别的相对路径、npm 包、node 模块、绝对路径、#子路径）、任何含 .. 路径段的写法
const pluginApiPatterns = ['^(?!\\./core/)', '(^|/)\\.\\.(/|$)'];
const PLUGIN_API_MESSAGE =
  '插件的入口文件只引核心（./core/…），不引 npm 包、node 模块和前端、服务、网页的代码与插件';

// 插件（plugins/<名字>/）：只许引用自己这个插件目录里的文件、src/plugin-api.js（插件要用的东西都从这里引）、
// node 内置模块和根 package.json 里声明的依赖；不得引用 src/ 下别的代码、别的插件、工作区的包（@luoli/…），
// import type 也不行。测试文件（*.test.*、test-*.*）另外可以引 vitest。
// 按文件所在的深度（d = 插件目录到文件之间隔了几层目录）分别写：走出插件目录要 d+1 个 ../
// （中间夹着 ./ 也算），只放过正好 d+2 个 ../ 走到的 src/plugin-api.js；先进目录再往上退的写法（a/../../x）
// 一律拦；不以 . 开头的（裸模块名、绝对路径、#子路径）只放过 node 模块与声明了的依赖。
// d 达到 PLUGIN_DEPTHS 的文件用最宽的写法：开头有 PLUGIN_DEPTHS+1 个以上 ../ 的都拦，
// 任意个 ../ 接 src/plugin-api.js 都放过
const pluginDeps = Object.keys({
  ...rootManifest.dependencies,
  ...rootManifest.peerDependencies,
  ...rootManifest.optionalDependencies,
}).filter((name) => !name.startsWith('@luoli/'));
const nodeModuleNames = builtinModules.filter((name) => !name.startsWith('_'));
const PLUGIN_DEPTHS = 5;
const PLUGIN_EXT = '{ts,tsx,js,mjs,mts,cts,cjs,jsx}';
const pluginPatterns = (d, deps) => [
  `^(?!(\\.\\./)${d < PLUGIN_DEPTHS ? `{${d + 2}}` : '+'}src/plugin-api\\.js$)(\\./)*(\\.\\.(/|$)(\\./)*){${Math.min(d, PLUGIN_DEPTHS) + 1}}`,
  '(^|/)[^/.][^/]*/\\.\\.(/|$)',
  `^(?!\\.|node:|(${[...nodeModuleNames, ...deps].map(escapeRe).join('|')})(/|$))`,
];
const PLUGIN_MESSAGE =
  '插件只许引用自己这个插件目录里的文件、src/plugin-api.js、node 模块和根 package.json 里声明的依赖，不得引用 src/ 下别的代码、别的插件和工作区的包（@luoli/…）';
const pluginRules = (names, deps, message) => [
  ...Array.from({ length: PLUGIN_DEPTHS }, (_, d) =>
    restrictImports(
      names.map((name) => `plugins/*/${'*/'.repeat(d)}${name}`),
      rule(pluginPatterns(d, deps), message),
    ),
  ),
  restrictImports(
    names.map((name) => `plugins/*/${'*/'.repeat(PLUGIN_DEPTHS)}**/${name}`),
    rule(pluginPatterns(PLUGIN_DEPTHS, deps), message),
  ),
];
// 插件清单（plugins/index.ts 等 plugins/ 下直接放的文件）：只许引各插件的入口（./<名字>/index.js）
// 和 ../src/plugin-api.js（插件的类型），别的一律拦
const pluginListPatterns = ['^(?!\\./[^/.][^/]*/index\\.js$|\\.\\./src/plugin-api\\.js$)'];
const PLUGIN_LIST_MESSAGE = '插件清单只引各插件的入口（./<名字>/index.js）和 ../src/plugin-api.js';

// 组件库（packages/ui）：只许引用包里自己的文件，和它自己 package.json 里声明的依赖。
// 根目录的 node_modules 里解析得到的别的包（hono、ai、marked……）不能靠这个引到；import type 也不行。
const uiDeps = Object.keys({
  ...uiManifest.dependencies,
  ...uiManifest.peerDependencies,
  ...uiManifest.optionalDependencies,
});
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
  // src/ 下除了网页面板的全部代码（含测试）：不得引用组件库，也不得绕路径进 packages/；不得引用插件。
  // 写在最前面：后面 core、服务、插件的入口文件、CLI 各自的规则对它们的文件整份覆盖这一份，
  // 所以那几处也带上组件库、packages/ 这两组，插件各自另写
  { ...restrictImports(['src/**'], noUi, viaPackageName, noPlugins), ignores: ['src/web/**'] },
  restrictImports(
    ['src/core/**'],
    rule(forbiddenInCore, 'core 不得引用前端、服务、网页、平台代码或插件'),
    noUi,
    viaPackageName,
  ),
  // 洛璃服务：只引插件清单，不引插件里的文件
  restrictImports(['src/server/**'], onlyPluginList, noUi, viaPackageName),
  // 插件的入口文件：只引核心
  restrictImports(
    ['src/plugin-api.ts'],
    rule(pluginApiPatterns, PLUGIN_API_MESSAGE),
    noUi,
    viaPackageName,
  ),
  // 插件：只引自己目录里的文件、src/plugin-api.js、node 模块和声明了的依赖
  ...pluginRules([`*.${PLUGIN_EXT}`], pluginDeps, PLUGIN_MESSAGE),
  // 测试文件另外可以引 vitest（写在后面，对测试文件覆盖上面那一组）
  ...pluginRules(
    [`*.test.${PLUGIN_EXT}`, `test-*.${PLUGIN_EXT}`],
    [...pluginDeps, 'vitest'],
    PLUGIN_MESSAGE + '；测试文件（*.test.*、test-*.*）另外可以引 vitest',
  ),
  // 插件清单：只引各插件的入口和 ../src/plugin-api.js
  restrictImports([`plugins/*.${PLUGIN_EXT}`], rule(pluginListPatterns, PLUGIN_LIST_MESSAGE)),
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
  // 网页面板：不得引用服务端、core、前端的代码或 node 模块（import type 可以）；不得引用插件
  // （import type 也不行）；组件库只能按包名引
  ...Array.from({ length: WEB_DEPTHS }, (_, d) =>
    restrictImports(
      [`src/web/${'*/'.repeat(d)}*.{ts,tsx}`],
      rule(webPatterns(d), WEB_MESSAGE, { allowTypeImports: true }),
      rule(webPluginPatterns(d), WEB_PLUGIN_MESSAGE),
      viaPackageName,
    ),
  ),
  restrictImports(
    [`src/web/${'*/'.repeat(WEB_DEPTHS)}**/*.{ts,tsx}`],
    rule(webPatternsDeep, WEB_MESSAGE, { allowTypeImports: true }),
    rule([pluginsDir, pluginApiFile], WEB_PLUGIN_MESSAGE),
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
        'CLI 是洛璃服务的客户端：服务端只许 import type，core 只许 tool-content 与类型，不引用其他前端、共用代码或网页',
        { allowTypeImports: true },
      ),
      noUi,
      viaPackageName,
      noPlugins,
    ),
    // 测试走最前面那一份（不得引用组件库、插件）
    ignores: ['src/cli/**/*.test.ts'],
  },
  {
    // 同上：CLI 引用服务、core 的类型时只许写 import type { X }，不把它们带进运行时
    files: ['src/cli/**/*.ts'],
    rules: { '@typescript-eslint/no-import-type-side-effects': 'error' },
  },
);
