import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const coreBoundary = 'core 不得引用前端或平台代码';

// core 不得引用的模块（不区分大小写）
const forbiddenInCore = [
  // 任何含 cli 路径段的写法：../cli/x.js、../../src/cli/x.js、./../cli 等
  '(^|[/#])cli(/|$)',
  // Telegram 前端，同上
  '(^|[/#])telegram(/|$)',
  // 前端共用的配置与日志（含 pino），同上；core 只依赖 Logger 接口
  '(^|[/#])shared(/|$)',
  '^pino(/|$)',
  '^(node:)?readline(/|$)',
  '^chat(/|$)',
  '^@chat-adapter/',
  '^grammy(/|$)',
];

// 动态 import() 不受 no-restricted-imports 检查，用选择器补上；模板字符串只看开头一段
const forbiddenSelector = `/${forbiddenInCore.join('|').replaceAll('/', '\\/')}/i`;

export default defineConfig(
  globalIgnores(['node_modules', '.grill', '.handoff', 'coverage']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: forbiddenInCore.map((regex) => ({ regex, message: coreBoundary })) },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `ImportExpression > Literal[value=${forbiddenSelector}]`,
          message: coreBoundary,
        },
        {
          selector: `ImportExpression > TemplateLiteral[quasis.0.value.cooked=${forbiddenSelector}]`,
          message: coreBoundary,
        },
      ],
    },
  },
);
