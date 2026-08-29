import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { copyEditPlugin } from '../../scripts/copy/plugin.js';

const DEV_API = process.env.WEBUI_DEV_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  root: resolve('packages/webui'),
  // `copyEditPlugin()` 在 `COPY_EDIT !== '1'` 时返回 false（Vite 忽略假值），返回的插件又带
  // `apply: 'serve'`。两道闸保证 `pnpm build` 的产物中不含文案面板的任何痕迹。
  plugins: [vue(), copyEditPlugin()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  // 代理目标可用 `WEBUI_DEV_API` 修改：在真实例旁边起一个隔离实例（独立的库 / skills / memory）
  // 调试界面时，dev server 需指向该实例而不是 8787。默认值不变，`pnpm webui:dev` 行为不变。
  //
  // `headers.origin` 决定登录能否成功，不是可选的整洁化。`/api/*` 上的 Origin 闸
  // （`server/src/app.ts` 的 `allowedOrigin`）比对的是请求头 Origin 与服务端自身的 origin，
  // 后者由 Host 计算，而 `changeOrigin` 会把 Host 改写为上游的：浏览器发来的
  // `http://localhost:5173` 与计算出的 `http://127.0.0.1:8787` 不一致，导致登录及一切
  // /api 请求恒定返回 403 `origin`。两个头一起改写，使服务端看到一份完全同源的请求。
  // 对浏览器而言这本就是同源的（页面与 /api 都在 5173），跨源只发生在代理这一跳。
  // 三处易错点，修改此行前逐条确认：
  // - `changeOrigin` 必须显式写出。Vite 只对字符串简写形式的代理自动补 `changeOrigin: true`
  //   （`vite/dist/node/chunks/config.js` 的 `proxyMiddleware`），改为对象形式后该默认值失效，
  //   Host 不再改写、`own` 变回 5173，而此处改写过的 Origin 指向 8787，同样返回 403。
  // - 不能改为删除 Origin 头：那会走「没有 Origin 则放行」的分支，一旦该分支被收紧，
  //   dev 环境将再次全线 403。
  // - 不要改用 `webui.allowOrigins` 绕过：`config/config.yaml` 在版本控制中，那等于把一条
  //   开发用的跨源放行提交进仓库，且每台机器都需记得删除。
  // 只在 dev server 生效：`vite build` 不读取 `server`。
  server: { port: 5173, proxy: { '/api': { target: DEV_API, changeOrigin: true, headers: { origin: new URL(DEV_API).origin } } } },
});
