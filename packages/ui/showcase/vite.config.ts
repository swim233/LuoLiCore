import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/* 组件库展示页的 Vite 配置：root 是这个目录（pnpm ui:dev 带着 packages/ui/showcase 这个参数）。
   只在开发时用，没有正式构建，也不进面板的构建；只监听 127.0.0.1，端口 5174，被占用就报错退出（不换端口） */
export default defineConfig({
  plugins: [react()],
  envDir: false,
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
