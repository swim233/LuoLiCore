import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { copyEditPlugin } from '../../scripts/copy/plugin.js';

const DEV_API = process.env.WEBUI_DEV_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  root: resolve('packages/webui'),
  // `copyEditPlugin()` 在 `COPY_EDIT !== '1'` 时返回 false（Vite 忽略假值），返回的插件又带
  // `apply: 'serve'` —— 两道闩，`pnpm build` 的产物里不会有文案面板的任何痕迹。
  plugins: [vue(), copyEditPlugin()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  // 代理目标可用 `WEBUI_DEV_API` 改：在真实例旁边起一个隔离实例（自己的库 / skills / memory）
  // 调界面时，dev server 要指向那一个而不是 8787。默认值不变，`pnpm webui:dev` 照旧。
  //
  // `headers.origin` 是**登录能不能成**的关键，不是可选的整洁化。`/api/*` 上那道 Origin 闸
  // （`server/src/app.ts` 的 `allowedOrigin`）比的是请求头 Origin 与**服务端自己**的 origin，
  // 后者由 Host 算出，而 `changeOrigin` 会把 Host 改写成上游的 —— 浏览器发来的
  // `http://localhost:5173` 与算出来的 `http://127.0.0.1:8787` 对不上，于是登录（以及一切
  // /api 请求）恒定 403 `origin`。两个头一起改写、让服务端看到一份彻底同源的请求。
  // 这件事对浏览器来说本来就是同源的（页面与 /api 都在 5173），跨源的只有代理这一跳。
  // 三个坑，改这行前逐条看：
  // - **`changeOrigin` 必须显式写。** Vite 只对**字符串简写**的代理自动补 `changeOrigin: true`
  //   （`vite/dist/node/chunks/config.js` 的 `proxyMiddleware`），换成对象形式就静静地丢了 ——
  //   Host 不再改写，`own` 变回 5173，而这里改写过的 Origin 指着 8787，照样 403。
  // - **不能改成删掉 Origin 头**：那是走「没有 Origin 就放行」那条分支，哪天那条分支被收紧，
  //   dev 又会静静地全线 403。
  // - **不要改用 `webui.allowOrigins` 绕过**：`config/config.yaml` 在版本控制里，那等于把一条
  //   开发用的跨源放行提交进仓库，且每台机器都得记着删。
  // 只在 dev server 生效：`vite build` 不读 `server`。
  server: { port: 5173, proxy: { '/api': { target: DEV_API, changeOrigin: true, headers: { origin: new URL(DEV_API).origin } } } },
});
