import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // vue 插件让 `tests/webui/**` 能直接 import `.vue`。**这一层是重做 `D-UI-01` 的前置条件**
  // （docs/24 §3）：上一轮把 ConsoleView 拆成 15 个子视图，构建通过、测试全绿、`/login` 打得开，
  // 而 14 个控制台页面全是空白 —— 因为一个组件级测试都没有，没人在「真的渲染一次」这件事上把关。
  plugins: [vue()],
  resolve: {
    alias: {
      '@luoli/shared': `${root}packages/shared/src/index.ts`,
      '@luoli/db': `${root}packages/db/src/index.ts`,
      '@luoli/core': `${root}packages/core/src/index.ts`,
      '@luoli/telegram': `${root}packages/telegram/src/index.ts`,
      '@luoli/server': `${root}packages/server/src/index.ts`,
    },
  },
  test: {
    testTimeout: 15_000,
    // 两个 project 而不是 `environmentMatchGlobs`（vitest 3 已弃用后者）：
    // 绝大多数用例跑的是真 SQLite 与真 HTTP，套一层 DOM 只会变慢，所以默认仍是 node，
    // 只有 `tests/webui/**` 换成 happy-dom。
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['tests/**/*.test.ts'], exclude: ['tests/webui/**'] } },
      { extends: true, test: { name: 'webui', environment: 'happy-dom', include: ['tests/webui/**/*.test.ts'] } },
    ],
  },
});
