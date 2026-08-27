#!/usr/bin/env node
// AC-MCP-011：握手与 listTools 都正常应答，**只有 callTool 永不返回**。
// 与 mcp-server-probe.mjs 的 MCP_HANG=1 是两种故障：那台连不上（连接超时那条路），
// 这台连得上、进得了工具目录，卡的是模型真的调下去的那一次。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'hang-server', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'hang', description: 'never returns', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
// 客户端超时后会发 notifications/cancelled，这里刻意不认它 —— 超时必须由客户端自己兜住。
server.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {}));
await server.connect(new StdioServerTransport());
