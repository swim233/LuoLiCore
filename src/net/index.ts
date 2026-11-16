// 安全请求（ADR-0007「安全」）：发往外网的 GET 请求，连接时检查实际要连的 IP，不许连内网地址。
// 外面（插件经 src/plugin-api.ts）只从这里引；测试用的本地服务在 ./test-server.js
export { decodeText } from './body.js';
export {
  createRequester,
  defaultUserAgents,
  FetchError,
  type FetchErrorKind,
  type FetchResponse,
  type Requester,
} from './request.js';
