#!/usr/bin/env node
// 活性 / 泄漏用例（docs/28 · L-EXT-02 · L-EXT-03）要能数「起了几个子进程」并 kill 指定的那一个，
// 而 McpManager 不对外暴露 transport —— 所以让子进程自己往 MCP_SPAWN_LOG 追一行 pid。
// MCP_HANG=1 时只挂住不回 initialize（且 stdin 结束也不退出，只有信号收得掉它）：
// 用来造「spawn 得起来但握不上手」的那台 server。
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
if (process.env.MCP_SPAWN_LOG) appendFileSync(process.env.MCP_SPAWN_LOG, `${process.pid}\n`);
if (process.env.MCP_HANG === '1') {
  setInterval(() => {}, 60_000);
  process.stdin.resume();
} else {
  const server = new Server({ name: 'probe-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }] }));
  await server.connect(new StdioServerTransport());
}
