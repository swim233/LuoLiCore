// 插件的测试用的入口文件（ADR-0014）：只给插件的测试文件（*.test.*、test-*.*）引，插件的非测试文件、
// src/ 下的代码都不能引（lint 规则保证）。现在只转出测试用的本地 HTTP 服务（不访问外网）；
// 这个文件只引 ./net/test-server.js
export {
  closeAll,
  ok,
  onClose,
  onlyLoopback,
  router,
  serve,
  status,
  type Handler,
  type TestServer,
} from './net/test-server.js';
