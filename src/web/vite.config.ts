import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { chatMock } from './dev/chat-mock.ts';

/* 网页面板的 Vite 配置：root 是这个目录（pnpm web:dev、web:build 都带着 src/web 这个参数）。
   - 开发模式：只监听 127.0.0.1，挂上模拟的 /api/chat；演示面板和模拟数据由 main.tsx 在开发模式里动态引入；
   - 正式构建：输出到 dist/web/，不带这些。 */
export default defineConfig({
  plugins: [react(), chatMock()],
  worker: { format: 'es' },
  envDir: false,
  build: { target: 'es2023', sourcemap: false, outDir: '../../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
