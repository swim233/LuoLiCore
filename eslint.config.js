import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// 前端（CLI、Telegram）与前端共用的配置、日志：任何含这些路径段的写法，
// 如 ../cli/x.js、../../src/cli/x.js、./../cli 等（不区分大小写）
const frontends = ['(^|[/#])cli(/|$)', '(^|[/#])telegram(/|$)', '(^|[/#])shared(/|$)'];

// core 不得引用的模块
const forbiddenInCore = [
  ...frontends,
  // 工具清单与工具（src/tools/），同上；core 只认 defineTool 的形状。core 自己的 ./tools.js 不算
  '(^|[/#])tools(/|$)',
  // core 只依赖 Logger 接口，不引用 pino
  '^pino(/|$)',
  '^(node:)?readline(/|$)',
  '^chat(/|$)',
  '^@chat-adapter/',
  '^grammy(/|$)',
];

/** files 里的代码不得引用 patterns 匹配的模块，静态 import 与动态 import() 都查 */
function restrictImports(files, patterns, message) {
  // 动态 import() 不受 no-restricted-imports 检查，用选择器补上；模板字符串只看开头一段
  const selector = `/${patterns.join('|').replaceAll('/', '\\/')}/i`;
  return {
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: patterns.map((regex) => ({ regex, message })) },
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

export default defineConfig(
  globalIgnores(['node_modules', '.grill', '.handoff', 'coverage']),
  js.configs.recommended,
  tseslint.configs.recommended,
  restrictImports(['src/core/**'], forbiddenInCore, 'core 不得引用前端、平台代码或工具清单'),
  restrictImports(['src/tools/**'], frontends, '工具不得引用前端代码'),
);
