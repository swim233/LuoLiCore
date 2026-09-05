import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // vue 插件使 `tests/webui/**` 可直接 import `.vue`。这一层是重做 `D-UI-01` 的前置条件
  // （docs/24 §3）：上一轮把 ConsoleView 拆成 15 个子视图，构建通过、测试全部通过、`/login` 可访问，
  // 而 14 个控制台页面全部空白，原因是没有任何组件级测试对实际渲染结果做验证。
  plugins: [vue()],
  resolve: {
    alias: {
      '@luoli/shared': `${root}packages/shared/src/index.ts`,
      '@luoli/db': `${root}packages/db/src/index.ts`,
      '@luoli/core': `${root}packages/core/src/index.ts`,
      '@luoli/telegram': `${root}packages/telegram/src/index.ts`,
      '@luoli/server': `${root}packages/server/src/index.ts`,
      // 子路径别名必须排在裸包名之前：vite 的字符串别名按插入顺序取第一个匹配
      // （`importee === find || importee.startsWith(find + '/')`），裸名在前会把
      // `@luoli/sdk-client/schema` 错配到裸名条目、拼出 `.../src/index.ts/schema`。
      '@luoli/sdk-client/schema': `${root}packages/sdk-client/src/schema.ts`,
      '@luoli/sdk-client': `${root}packages/sdk-client/src/index.ts`,
    },
  },
  test: {
    testTimeout: 15_000,
    // 使用两个 project 而不是 `environmentMatchGlobs`（vitest 3 已弃用后者）：
    // 绝大多数用例运行在真实 SQLite 与真实 HTTP 之上，附加一层 DOM 只会降低速度，因此默认仍为 node，
    // 只有 `tests/webui/**` 切换为 happy-dom。
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['tests/**/*.test.ts'], exclude: ['tests/webui/**'] } },
      { extends: true, test: { name: 'webui', environment: 'happy-dom', include: ['tests/webui/**/*.test.ts'] } },
    ],
  },
});
