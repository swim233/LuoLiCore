import type { ToolDefinition } from '../core/index.js';

// 工具清单：前端启动时交给 installTools 装配，按这个顺序发给模型。
// 加工具：在本目录新建一个文件，用 defineTool 定义并导出，再在这里 import 并加进数组
export const tools: ToolDefinition[] = [];
