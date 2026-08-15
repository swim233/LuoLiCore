import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('packages/webui'),
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
});
