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
// - `ACP_CAPS`：initialize 时把收到的 `clientCapabilities` 原样记进 method log（`caps:{…}`）——
//   「不是 host 就不申报 terminal」这条断言只有它证明得了：申报值是客户端算出来的，从外面看不见。
// - `ACP_PERMISSION_OPTIONS`：逗号分隔的 option kind（默认 `allow_once,reject_once`）。写成只有
//   `allow_once` 就造出「一个 reject 档都没给」那一档，客户端必须回 error 而不是假 cancelled。
// - `ACP_PERMISSION_COUNT` / `ACP_PERMISSION_KIND` / `ACP_PERMISSION_PATHS`：问几次、报什么 kind、
//   带哪些 locations（逗号分隔的绝对路径）—— always 那一档要两次同目录的请求才量得到。
// - `ACP_TERMINAL` (+ `_ARGS` / `_CWD` / `_NO_RELEASE` / `_KILL` / `_NO_WAIT`)：prompt 期间真起一个
//   终端，走 create → wait_for_exit → output（→ release），结果逐条进 method log。`_NO_WAIT` 是
//   「起了就不管了」那一档 —— 客户端收摊时那条命令**还在跑**，也就是三道 release 兜底真正要挡的形态。
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
      // 申报值是客户端**算出来的**，从外面唯一看得见的地方就是这里收到的这份。
      if (env.ACP_CAPS === '1') note(`caps:${JSON.stringify(params.clientCapabilities ?? null)}`);
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
        // option 集合可脚本化：只给 allow 就造出「拒绝表达不出来」那一档，而那一档客户端必须回
        // 一个 JSON-RPC error + 取消整轮，**不能**回一句 cancelled 假装是用户取消的。
        const kinds = (env.ACP_PERMISSION_OPTIONS ?? 'allow_once,reject_once').split(',').filter(Boolean);
        const options = kinds.map((kind) => ({ optionId: kind, name: kind, kind }));
        const locations = (env.ACP_PERMISSION_PATHS ?? '').split(',').filter(Boolean).map((path) => ({ path }));
        for (let index = 0; index < Number(env.ACP_PERMISSION_COUNT ?? 1); index += 1) {
          const answer = await request('session/request_permission', { sessionId: SESSION,
            // toolCallId 带 pid：真 agent 每次调用都是新 id，而用例要靠它区分「always 那份会话内记忆」
            // 与 `approval.rememberWithinTurn`（按 turnId + input 记，跨调用同轮仍然命中）。
            toolCall: { toolCallId: `tc-${process.pid}-${index}`, kind: env.ACP_PERMISSION_KIND ?? 'execute', title: 'run pwd', ...(locations.length ? { locations } : {}) },
            options });
          // 成功与失败分开记：`permission_error:` 那一行是「客户端拒绝作答」的唯一凭据。
          if (answer.error) note(`permission_error:${JSON.stringify(answer.error.code)}`);
          else note(`permission:${JSON.stringify(answer.result?.outcome ?? null)}`);
        }
      }
      if (env.ACP_TERMINAL) {
        const created = await request('terminal/create', { sessionId: SESSION, command: env.ACP_TERMINAL,
          args: (env.ACP_TERMINAL_ARGS ?? '').split(',').filter(Boolean),
          ...(env.ACP_TERMINAL_CWD ? { cwd: env.ACP_TERMINAL_CWD } : {}) });
        if (created.error) note(`terminal_error:${JSON.stringify(created.error.code)}`);
        else {
          const terminalId = created.result.terminalId;
          note(`terminal_created:${terminalId}`);
          if (env.ACP_TERMINAL_KILL === '1') await request('terminal/kill', { sessionId: SESSION, terminalId });
          // 「起了就不管了」：客户端收摊时那条命令还在跑。等它退出反而会让硬期限先把它收掉，
          // 于是这一档就再也量不到「有命令活到了我们收摊的时候」。
          if (env.ACP_TERMINAL_NO_WAIT === '1') return reply(id, { stopReason: env.ACP_STOP_REASON ?? 'end_turn' });
          const exited = await request('terminal/wait_for_exit', { sessionId: SESSION, terminalId });
          note(`terminal_exit:${JSON.stringify(exited.result ?? exited.error ?? null)}`);
          const out = await request('terminal/output', { sessionId: SESSION, terminalId });
          note(`terminal_output:${JSON.stringify(out.result ?? out.error ?? null)}`);
          // 不 release 那一档是刻意的：客户端的兜底回收必须替我们收拾，并留一条看得见的凭据。
          if (env.ACP_TERMINAL_NO_RELEASE !== '1') await request('terminal/release', { sessionId: SESSION, terminalId });
        }
      }
      if (env.ACP_SLEEP_MS) await sleep(Number(env.ACP_SLEEP_MS));
      if (env.ACP_NEVER_STOP === '1' && !cancelled) return;
      // `session/cancel` 可能已经替这条 prompt 答过了（它就是这么做的）。再答一次的表现是客户端
      // 一句 `Got response to unknown request` —— 无害，但那是 fixture 不守规矩，不该留在噪声里。
      if (pending !== id) return;
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
// 交回 `{ result, error }` 而不是裸 result：客户端**拒绝作答**（回一个 JSON-RPC error）是这一轮要量
// 的一整档行为，而 `message.result ?? null` 把它和「答了个 null」压成了同一件事。
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
    if (resolve) { waiting.delete(message.id); resolve({ result: message.result ?? null, error: message.error ?? null }); }
  }
});
// `ACP_HANG_AT` 那一档必须扛住 stdin 结束：客户端的关停梯是 `stdin.end → SIGTERM → 5s → SIGKILL`，
// 用例要量的正是「握手超时之后这条子进程真的被收掉了」。
if (env.ACP_HANG_AT) { setInterval(() => {}, 60_000); process.stdin.resume(); }
else process.stdin.on('end', () => process.exit(0));
