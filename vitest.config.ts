import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'plugins/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'packages/*/showcase/**/*.test.ts',
    ],
  },
});
