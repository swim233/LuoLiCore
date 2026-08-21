#!/usr/bin/env node
// 一台可脚本化的 ACP agent（裸 node、NDJSON、行为全由 env 决定），形状照 `mcp-server-probe.mjs`。
//
// 用例必须离线且确定性，所以**不许**把真 `omp` 写进任何用例。这份 fixture 顶替它：
// - `ACP_SPAWN_LOG`：起来时往里追一行 pid —— 用例靠它数 spawn 次数、验泄漏与关停（同 MCP 那份）。
// - `ACP_METHOD_LOG`：每收到一条 method 追一行 —— 「abort 走的是 `session/cancel` 而不是 SIGTERM」
//   这条断言只有它证明得了。
// - `ACP_HANG_AT`：在这一步之前的都正常答，到它就永远不答（且 stdin 结束也不退，只有信号收得掉）。
//   `initialize` 用来造「spawn 得起来但握不上手」。
// - `ACP_LONG_LINE`：先吐一行超长 JSON，逼客户端那道单行上界。
// - `ACP_FLOOD`：prompt 期间发这么多条 `session/update`，验「撞上界只丢弃、不断连」。
// - `ACP_NEVER_STOP`：不主动答 `session/prompt`，只在收到 `session/cancel` 之后才用 cancelled 应答。
// - `ACP_DELAY_AT` + `ACP_DELAY_MS`：把握手的某一跳撑慢，好让 abort 真的落在握手里（默认四跳
//   × 30 秒是真实窗口，而这份 fixture 快到毫秒级）。
// - `ACP_FINISH_ANYWAY`：收到过 cancel 但活其实已经干完了 —— 竞态的另一半。
// - `ACP_LEAK_FD`：留一个继承 stdout/stderr 的孙进程，逼客户端的关停梯露出它有没有绝对上界。
// - `ACP_STDERR_LINES` / `ACP_REJECT_CONFIG=long`：把结果对象的固定字段撑到最紧，量「按构造有界」。
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const env = process.env;
if (env.ACP_SPAWN_LOG) appendFileSync(env.ACP_SPAWN_LOG, `${process.pid}\n`);
// stderr 噪声：真 agent 把 console.* 全重定向到这里，失败时那段尾巴会进结果对象 ——
// 「结果按构造有界」那条断言要能量到它。全是引号与换行，JSON 转义放大最狠的那种。
if (env.ACP_STDERR_LINES) for (let index = 0; index < Number(env.ACP_STDERR_LINES); index += 1) process.stderr.write(`[31m"噪声 ${index}"[0m\t\n`);
// 留一个继承了本进程 stdout/stderr 的**孙进程**，它比我们活得久。ChildProcess 的 'close' 要求三条
// 管道全关，于是这一档下 SIGKILL 掉 fixture 之后 'close' 永远不来 —— 客户端的关停梯必须自己有
// 绝对上界，否则 `shutdown()` 就钉在这里（`docs/28 · L-EXT-03` 那个形态）。omp 的 `bash` 会留下
// 正是这种孙进程，所以这不是造出来的极端情形。
if (env.ACP_LEAK_FD === '1') spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();
const note = (line) => { if (env.ACP_METHOD_LOG) appendFileSync(env.ACP_METHOD_LOG, `${line}\n`); };
const send = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const update = (sessionId, payload) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const SESSION = 'sess-fixture-1';
let authenticated = env.ACP_AUTH_REQUIRED !== '1';
let cancelled = false;
let pending = null;

async function handle(method, params, id) {
  note(method);
  if (env.ACP_HANG_AT === method) return;
  // 让握手的某一跳慢下来。`/cancel` 落在握手里（默认最长四跳 × 30 秒）是真实场景，
  // 而 fixture 快到毫秒级 —— 不人为撑开这个窗口就量不到那条路。
  if (env.ACP_DELAY_AT === method && env.ACP_DELAY_MS) await sleep(Number(env.ACP_DELAY_MS));
  switch (method) {
    case 'initialize': {
      if (env.ACP_LONG_LINE === '1') process.stdout.write(`{"jsonrpc":"2.0","method":"noop","params":{"pad":"${'x'.repeat(Number(env.ACP_LONG_LINE_BYTES ?? 200_000))}"}}\n`);
      return reply(id, { protocolVersion: Number(env.ACP_PROTOCOL_VERSION ?? 1),
        agentInfo: { name: 'acp-fixture', version: '0.0.1' },
        ...(env.ACP_AUTH_REQUIRED === '1' ? { authMethods: [{ id: 'local', name: 'Use local credentials' }] } : {}),
        agentCapabilities: { loadSession: false, ...(env.ACP_NO_CLOSE === '1' ? {} : { sessionCapabilities: { close: {} } }) } });
    }
    case 'authenticate': { authenticated = true; return reply(id, {}); }
    case 'session/new': {
      if (!authenticated) return fail(id, -32000, 'Authentication required');
      return reply(id, { sessionId: SESSION,
        configOptions: [{ id: 'mode', name: 'Mode', type: 'select', currentValue: 'default', values: [{ id: 'default', name: 'default' }, { id: 'plan', name: 'plan' }] }] });
    }
    case 'session/set_config_option': {
      // 长中文报错：`detail` 的上界必须按**字节**算，而结果对象的固定字段又要按量出来的长度让位 ——
      // 「结果按构造有界」那条断言的最紧一档就在这里。
      if (env.ACP_REJECT_CONFIG === 'long') return fail(id, -32603, `不支持的会话模式：${'这一档在这台 agent 上没有实现，'.repeat(40)}`);
      if (env.ACP_REJECT_CONFIG === '1') return fail(id, -32603, 'Unsupported ACP mode');
      return reply(id, { configOptions: [{ id: 'mode', name: 'Mode', type: 'select', currentValue: params.value, values: [] }] });
    }
    case 'session/prompt': {
      pending = id;
      const flood = Number(env.ACP_FLOOD ?? 0);
      for (let index = 0; index < flood; index += 1) {
        update(SESSION, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `think ${index}` } });
      }
      if (env.ACP_TEXT) update(SESSION, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: env.ACP_TEXT } });
      if (env.ACP_TOOL_CALL === '1') update(SESSION, { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'edit probe.txt', kind: 'edit', status: 'completed' });
      if (env.ACP_COST) {
        // 累计值，与真 agent 的语义一致（`usage_update.cost.amount` 是 session 累计）。
        for (const step of (env.ACP_COST_STEPS ?? env.ACP_COST).split(',')) {
          update(SESSION, { sessionUpdate: 'usage_update', used: 1000, size: 500_000, cost: { amount: Number(step), currency: 'USD' } });
        }
      }
      if (env.ACP_PERMISSION === '1') {
        const answer = await request('session/request_permission', { sessionId: SESSION, toolCall: { toolCallId: 'tc-p', kind: 'execute', title: 'run pwd' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
        note(`permission:${JSON.stringify(answer?.outcome ?? null)}`);
      }
      if (env.ACP_SLEEP_MS) await sleep(Number(env.ACP_SLEEP_MS));
      if (env.ACP_NEVER_STOP === '1' && !cancelled) return;
      pending = null;
      // `ACP_FINISH_ANYWAY`：收到过 cancel 但活其实已经干完了 —— 竞态的另一半，agent 如实答
      // `end_turn`。客户端在这一档仍然不能报成功（文件已经被改，而这一轮本该是取消的）。
      const stopReason = env.ACP_FINISH_ANYWAY === '1' || !cancelled ? (env.ACP_STOP_REASON ?? 'end_turn') : 'cancelled';
      return reply(id, { stopReason });
    }
    case 'session/cancel': {
      cancelled = true;
      // 规矩的 agent：收到 cancel 之后**用 cancelled 应答那条 prompt**，而不是等着被杀。
      if (pending !== null && env.ACP_IGNORE_CANCEL !== '1') { const id_ = pending; pending = null; reply(id_, { stopReason: 'cancelled' }); }
      return;
    }
    case 'session/close': return reply(id, {});
    default: return id === undefined ? undefined : fail(id, -32601, `method not found: ${method}`);
  }
}

let nextId = 1;
const waiting = new Map();
const request = (method, params) => new Promise((resolve) => { const id = `f${nextId++}`; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf('\n');
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method) { void handle(message.method, message.params ?? {}, message.id); continue; }
    const resolve = waiting.get(message.id);
    if (resolve) { waiting.delete(message.id); resolve(message.result ?? null); }
  }
});
// `ACP_HANG_AT` 那一档必须扛住 stdin 结束：客户端的关停梯是 `stdin.end → SIGTERM → 5s → SIGKILL`，
// 用例要量的正是「握手超时之后这条子进程真的被收掉了」。
if (env.ACP_HANG_AT) { setInterval(() => {}, 60_000); process.stdin.resume(); }
else process.stdin.on('end', () => process.exit(0));
