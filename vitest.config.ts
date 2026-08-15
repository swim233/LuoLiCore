import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@luoli/shared': `${root}packages/shared/src/index.ts`,
      '@luoli/db': `${root}packages/db/src/index.ts`,
      '@luoli/core': `${root}packages/core/src/index.ts`,
      '@luoli/telegram': `${root}packages/telegram/src/index.ts`,
      '@luoli/server': `${root}packages/server/src/index.ts`,
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});
