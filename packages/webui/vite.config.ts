import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('packages/webui'),
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  // 代理目标可用 `WEBUI_DEV_API` 改：在真实例旁边起一个隔离实例（自己的库 / skills / memory）
  // 调界面时，dev server 要指向那一个而不是 8787。默认值不变，`pnpm webui:dev` 照旧。
  server: { port: 5173, proxy: { '/api': process.env.WEBUI_DEV_API ?? 'http://127.0.0.1:8787' } },
});
