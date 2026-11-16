// 插件的入口文件（ADR-0014）：plugins/ 下的插件要用的东西只从这里引，不引 src/ 下别的文件，
// 也不引别的插件（lint 规则保证）。以后插件要单独打包时，把这个文件换成一个包就行。
// 这里只转出核心、安全请求（src/net/）里插件用得到的东西，用到新的再加；这个文件只引这两处，
// 不引前端、服务的代码。插件的测试另有 src/plugin-test-api.ts
import type { ToolDefinition } from './core/index.js';

export {
  defineTool,
  describeImage,
  imageSize,
  isSupportedImage,
  TextAndImages,
  ToolError,
  type Logger,
  type NewFile,
  type ToolDefinition,
} from './core/index.js';
export {
  createRequester,
  decodeText,
  defaultUserAgents,
  FetchError,
  type FetchErrorKind,
  type FetchResponse,
  type Requester,
} from './net/index.js';

/** definePlugin 的结果，插件清单（plugins/index.ts）里列的就是它 */
export type Plugin = {
  /** 插件名：小写字母、数字、下划线，以字母开头，清单里不能重复 */
  readonly name: string;
  /** 插件里的工具，按这个顺序发给模型 */
  readonly tools: readonly ToolDefinition[];
};

/**
 * 定义一个插件：一个插件一个目录（plugins/<名字>/），入口 index.ts 用它导出插件，
 * 再列进 plugins/index.ts 的清单。名字与重名由洛璃服务启动时装配插件清单时检查
 */
export function definePlugin({
  name,
  tools,
}: {
  /** 插件名：小写字母、数字、下划线，以字母开头，清单里不能重复 */
  name: string;
  /** 插件里的工具（defineTool 的结果），按这个顺序发给模型 */
  tools: readonly ToolDefinition[];
}): Plugin {
  return { name, tools: [...tools] };
}
