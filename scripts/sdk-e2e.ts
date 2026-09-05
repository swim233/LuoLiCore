/**
 * `@luoli/sdk-client` 对真实进程的端到端验收（docs/12-sdk.md T3.10 验收 1/3）。
 *
 * 用法：`pnpm build && pnpm sdk:e2e`（验收 3 明确要求先 build 再跑，`ERR_MODULE_NOT_FOUND`
 * 这类问题只在 dist 产物下暴露，tsx 直接跑源码测不出来）。
 *
 * 起一个真实的 `node dist/apps/bot/src/main.js` 子进程（与 `pnpm start` 运行的是同一个入口
 * 文件；不直接 `spawn("pnpm", ["start"])`——那需要 cwd 落在仓库根，会让 `main.ts` 里那几个
 * 相对路径默认值（`memory.dir`/`sandbox.workspaceDir`/`skills.dir` 等）解析到仓库自己的
 * `data/`/`memory/`/`skills/`，与「不碰仓库 config/config.yaml 与 data/」冲突；`node` 直接起
 * 该文件、把 `cwd` 设为临时目录，二者等价——Node 的模块解析按文件自身位置向上找
 * `node_modules`，不受 `cwd` 影响，只有应用内部 `path.resolve()` 这类调用会被 `cwd` 改变，
 * 而这正是需要隔离的部分），配临时 `config.yaml` + `LUOLI_DATA_DIR`，随机空闲端口，
 * 常驻进程只在本脚本存在期间存活，`finally` 内必杀。
 *
 * 建来源 + 签发密钥直接调用 `issueApiKey`（不经 `/api/sdk/*` 管理端点的 cookie 登录流程——
 * 那条路径的验收由 T3.11 覆盖，本脚本只关心 SDK 客户端本身）：开一个独立的 db 连接、插入
 * provider/model/model_alias（模型侧无现成注入点，与 `tests/support/runtime.ts` 的先例一致，
 * 只是把「进程内 `runtime.db`」换成「进程外单独打开同一个 db 文件」）与 sources/api_keys 行，
 * 关闭连接后再启动真实进程——避免两个连接同时持有同一个 SQLite 文件的写锁。
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, closeDatabase, migrateDatabase } from "@luoli/db";
import { Secrets, ProviderStore, issueApiKey } from "@luoli/core";
import { SourceRepository, ApiKeyRepository } from "@luoli/db";
import { createSdkClient, SdkError, type SdkStreamEvent } from "@luoli/sdk-client";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const MAIN_JS = resolve(REPO_ROOT, "dist/apps/bot/src/main.js");
const MASTER_KEY = "sdk-e2e-master-key-0123456789abcdef"; // ≥32 字符，进程与种子脚本必须一致

let failed = false;
const steps: Array<{ name: string; ok: boolean; detail?: string }> = [];

function record(name: string, ok: boolean, detail?: string): void {
  steps.push(detail === undefined ? { name, ok } : { name, ok, detail });
  if (!ok) failed = true;
  process.stdout.write(`${ok ? "  ok " : " FAIL"} · ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function assertStep(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    record(name, true);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

/** 找一个当前空闲的端口：短暂 `listen(0)` 后立即关闭。存在极小的race——与仓库其余测试
 *  基建（`tests/support/upstream.ts` 的 `startFakeUpstream`）同一手法，可接受。 */
async function freePort(): Promise<number> {
  return new Promise((settle, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => settle(port));
    });
  });
}

/**
 * 最小假 upstream（自包含，不依赖 `tests/support/upstream.ts`——脚本不该依赖测试专用代码）：
 * 固定回复，非流式请求回一条完整 JSON，`stream:true` 回一段 SSE，格式对齐
 * `@ai-sdk/openai-compatible` 的期望（与 `tests/support/upstream.ts` 同一协议子集）。
 */
async function startFakeUpstream(reply: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: { model?: string; stream?: boolean } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof body;
      } catch {
        /* 空 body 按 {} 处理 */
      }
      const id = "sdk-e2e-fake-upstream";
      if (body.stream === true) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const created = Math.floor(Date.now() / 1000);
        const send = (payload: Record<string, unknown>): void =>
          void response.write(`data: ${JSON.stringify(payload)}\n\n`);
        send({
          id, object: "chat.completion.chunk", created, model: body.model ?? "fake",
          choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
        });
        send({
          id, object: "chat.completion.chunk", created, model: body.model ?? "fake",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id, object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model: body.model ?? "fake",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((settle) => server.close(() => settle())),
  };
}

async function waitForHealth(baseUrl: string, limitMs = 30_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const json = (await response.json()) as { ok: boolean };
        if (json.ok) return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((settle) => setTimeout(settle, 200));
  }
  throw new Error(`等待 /api/health 超时：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_JS)) {
    process.stderr.write(`${MAIN_JS} 不存在——先运行 pnpm build。\n`);
    process.exitCode = 1;
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "luoli-sdk-e2e-"));
  const dataDir = join(tempRoot, "data");
  const configPath = join(tempRoot, "config.yaml");
  mkdirSync(dataDir, { recursive: true });

  const upstream = await startFakeUpstream("你好，我是端到端测试的假上游");
  const webuiPort = await freePort();
  const dbPath = join(dataDir, "luoli.db");

  writeFileSync(
    configPath,
    [
      "general:",
      "  timezone: UTC",
      "webui:",
      `  port: ${webuiPort}`,
      "quota:",
      "  enabled: false",
      "sandbox:",
      "  mode: none",
      "  dockerBin: /bin/false",
      "",
    ].join("\n"),
  );

  // 种子：provider/model/model_alias 指向假 upstream；sources + api_keys 各一行。单独打开
  // db 连接，插入完毕即关闭——避免与即将启动的真实进程同时持有写锁。
  const db = openDatabase(dbPath);
  migrateDatabase(db, undefined, { path: join(dataDir, "logs.db") });
  const secrets = new Secrets(MASTER_KEY);
  const providers = new ProviderStore(db, secrets);
  const providerId = providers.save({
    name: "sdk-e2e-fake",
    kind: "openai-compatible",
    baseUrl: upstream.url,
    apiKey: "sk-fake-0123456789abcdef",
  });
  const now = Date.now();
  const modelRowId = `${providerId}:fake-model`;
  db.prepare(
    `INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,enabled,sort,created_at,updated_at)
    VALUES (?,?,?,128000,4096,'{}',1,2,1,0,?,?)`,
  ).run(modelRowId, providerId, "fake-model", now, now);
  db.prepare("INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)").run(
    "main",
    JSON.stringify([modelRowId]),
    now,
  );
  const sources = new SourceRepository(db);
  const apiKeys = new ApiKeyRepository(db);
  const source = sources.create("sdk-e2e");
  const issued = issueApiKey({ apiKeys, secrets, sourceId: source.id });
  closeDatabase(db);

  process.stdout.write(`[sdk-e2e] 临时目录：${tempRoot}\n`);
  process.stdout.write(`[sdk-e2e] 假 upstream：${upstream.url}\n`);
  process.stdout.write(`[sdk-e2e] 真实进程端口：${webuiPort}\n`);

  const child = spawn(process.execPath, [MAIN_JS], {
    cwd: tempRoot, // 隔离 memory.dir/sandbox.workspaceDir/skills.dir 等相对默认值，见文件头注释
    env: {
      ...process.env,
      LUOLI_CONFIG: configPath,
      LUOLI_DATA_DIR: dataDir,
      // `access.bootstrapOwnerId` 校验为 Telegram 数字 id 形态（`TG_ID_PATTERN`）——SDK 本身
      // 不使用这个身份，随便一串数字即可满足 `loadConfig` 的 `requireOwner` 闸。
      LUOLI_OWNER_ID: "900000000",
      LUOLI_MASTER_KEY: MASTER_KEY,
      BOT_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk: Buffer) => {
    childOutput += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    childOutput += chunk.toString("utf8");
  });
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });

  const baseUrl = `http://127.0.0.1:${webuiPort}`;

  try {
    await assertStep("真实进程就绪（GET /api/health）", async () => {
      if (childExited) throw new Error(`子进程已提前退出\n${childOutput.slice(-4000)}`);
      await waitForHealth(baseUrl);
    });
    // 就绪检查失败时跳过后续步骤（客户端连不上一个没起来的进程），但仍要走 `finally` 清理，
    // 再统一打印汇总——不能直接 `return`，那会跳过 `finally` 之后的汇总打印与 `exitCode` 赋值。
    if (!failed) {
      const client = createSdkClient({ baseUrl, apiKey: issued.token });
      let sessionId = "";

      await assertStep("createSession", async () => {
        const session = await client.createSession({ label: "e2e", outputFormat: "plain" });
        if (session.outputFormat !== "plain" || session.label !== "e2e")
          throw new Error(`会话字段不符：${JSON.stringify(session)}`);
        sessionId = session.id;
      });

      await assertStep("sendMessage（非流式）", async () => {
        const sent = await client.sendMessage(sessionId, { endUserId: "e2e-user", text: "你好" });
        if (!sent.text.includes("端到端测试的假上游")) throw new Error(`文本不含预期内容：${sent.text}`);
        if (!sent.turnId) throw new Error("turnId 为空");
      });

      await assertStep("streamMessage（SSE）：delta…done", async () => {
        const events: SdkStreamEvent[] = [];
        for await (const event of client.streamMessage(sessionId, { endUserId: "e2e-user", text: "第二轮" }))
          events.push(event);
        if (!events.some((event) => event.event === "delta")) throw new Error("未收到 delta 事件");
        const last = events.at(-1);
        if (last?.event !== "done") throw new Error(`末事件不是 done：${JSON.stringify(last)}`);
      });

      await assertStep("listSessions 含刚创建的会话", async () => {
        const listed = await client.listSessions();
        if (!listed.sessions.some((row) => row.id === sessionId)) throw new Error("列表中未找到该会话");
      });

      await assertStep("patchSession 更新 label", async () => {
        const patched = await client.patchSession(sessionId, { label: "e2e-renamed" });
        if (patched.label !== "e2e-renamed") throw new Error(`label 未更新：${patched.label}`);
      });

      await assertStep("listCommits 含两条 turn 提交", async () => {
        const commits = await client.listCommits(sessionId);
        const turns = commits.commits.filter((row) => row.kind === "turn");
        if (turns.length !== 2) throw new Error(`turn 提交数为 ${turns.length}，期望 2`);
      });

      await assertStep("deleteSession 后 getSession 返回 404 session_deleted", async () => {
        await client.deleteSession(sessionId);
        try {
          await client.getSession(sessionId);
          throw new Error("未抛出错误");
        } catch (error) {
          if (!(error instanceof SdkError) || error.code !== "session_deleted")
            throw new Error(`期望 session_deleted，实际 ${String(error)}`);
        }
      });

      await assertStep("purgeSession 后 getSession 返回 404 not_found", async () => {
        await client.purgeSession(sessionId);
        try {
          await client.getSession(sessionId);
          throw new Error("未抛出错误");
        } catch (error) {
          if (!(error instanceof SdkError) || error.code !== "not_found")
            throw new Error(`期望 not_found，实际 ${String(error)}`);
        }
      });
    }
  } finally {
    if (!childExited) {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise<boolean>((settle) => child.once("exit", () => settle(true))),
        new Promise<boolean>((settle) => setTimeout(() => settle(false), 8000)),
      ]);
      if (!exited) child.kill("SIGKILL");
    }
    await upstream.close();
    rmSync(tempRoot, { recursive: true, force: true });
    if (childOutput.trim())
      process.stdout.write(`[sdk-e2e] 子进程输出（末 4000 字符）：\n${childOutput.slice(-4000)}\n`);
  }

  process.stdout.write(`\n${failed ? "FAIL" : "PASS"} · ${steps.filter((s) => s.ok).length}/${steps.length} 步通过\n`);
  process.exitCode = failed ? 1 : 0;
}

await main();
