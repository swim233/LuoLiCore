import { rmSync } from "node:fs";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  SourceRepository,
  closeDatabase,
  migrateDatabase,
  openDatabase,
} from "@luoli/db";
import {
  SDK_AGENT_TOOLS,
  SDK_FORBIDDEN_TOOLS,
  ToolRegistry,
  configSchema,
  newToolScope,
  sdkToolsFromConfig,
  toolCallableBy,
} from "@luoli/core";
import type { ApprovalBroker, LogSink, ToolExecutionContext } from "@luoli/core";
import { startTestRuntime } from "./support/runtime.js";

/**
 * 按来源可配的 SDK 工具白名单（docs/12-sdk.md §8，docs/05 §3.13）。
 *
 * 这一轴回答「这一档 agent 该拿哪些工具」，不是安全边界——角色轴（SDK 恒 trusted）与审批
 * fail-closed 都不因它放开而变化。本文件两头都要钉住：配了就真的能调；没配的部署一字不变。
 */

function harness(name: string) {
  const database = `./data/${name}.test.db`;
  for (const suffix of ["", "-wal", "-shm", "-logs", "-logs-wal", "-logs-shm"])
    rmSync(`${database}${suffix}`, { force: true });
  const db = openDatabase(database);
  migrateDatabase(db);
  return { db, sources: new SourceRepository(db) };
}

describe("sources.tools 的存取", () => {
  it("新建来源为 null（用默认），不是空数组", () => {
    const { db, sources } = harness("sdk-tools-default");
    // 这两者必须可区分：null 是「用默认三件」，空数组是「一件都不给」。
    expect(sources.create("Acme").tools).toBeNull();
    expect(sources.get("telegram")?.tools).toBeNull();
    closeDatabase(db);
  });

  it("setTools 往返；空数组与 null 是两个不同的取值", () => {
    const { db, sources } = harness("sdk-tools-roundtrip");
    const created = sources.create("Acme");

    expect(sources.setTools(created.id, ["read_file", "grep"])?.tools).toEqual([
      "read_file",
      "grep",
    ]);
    expect(sources.get(created.id)?.tools).toEqual(["read_file", "grep"]);

    expect(sources.setTools(created.id, [])?.tools).toEqual([]);
    expect(sources.get(created.id)?.tools).toEqual([]);

    expect(sources.setTools(created.id, null)?.tools).toBeNull();
    closeDatabase(db);
  });

  it("不存在的来源返回 null，不静默建行", () => {
    const { db, sources } = harness("sdk-tools-missing");
    expect(sources.setTools("nope", ["grep"])).toBeNull();
    closeDatabase(db);
  });

  /**
   * 库文件是运维可以直接编辑的。一段坏 JSON 只该让这一列退回默认，不该让整个来源读不出来——
   * 那会连带把这个来源的人格与 ASSIST 配置一起弄丢。
   */
  it("列里是坏 JSON 时退回默认，不让整行读不出来", () => {
    const { db, sources } = harness("sdk-tools-corrupt");
    const created = sources.create("Acme");
    db.prepare("UPDATE sources SET tools='{不是数组' WHERE id=?").run(created.id);

    const row = sources.get(created.id);
    expect(row?.name).toBe("Acme");
    expect(row?.tools).toBeNull();
    closeDatabase(db);
  });
});

describe("sdkToolsFromConfig()", () => {
  it("未配置回落到 SDK_AGENT_TOOLS（存量部署行为不变）", () => {
    expect(sdkToolsFromConfig(null)).toBe(SDK_AGENT_TOOLS);
    expect(sdkToolsFromConfig(undefined)).toBe(SDK_AGENT_TOOLS);
  });

  it("空数组是「一件都不给」，不是「用默认」", () => {
    expect([...sdkToolsFromConfig([])]).toEqual([]);
  });

  it("结构性禁止的两族即便存进过库也被滤掉", () => {
    const tools = sdkToolsFromConfig(["read_file", "spawn_worker", "send_message"]);
    expect([...tools]).toEqual(["read_file"]);
  });
});

describe("toolCallableBy(sdk, ·, tools)", () => {
  it("缺省参数与常量白名单逐条一致", () => {
    expect(toolCallableBy("sdk", "memory_read")).toBe(true);
    expect(toolCallableBy("sdk", "read_file")).toBe(false);
  });

  it("配了就放行，没配的仍然拒", () => {
    const tools = sdkToolsFromConfig(["read_file", "grep"]);
    expect(toolCallableBy("sdk", "read_file", tools)).toBe(true);
    expect(toolCallableBy("sdk", "grep", tools)).toBe(true);
    // 配了 read_file 不等于连记忆也一起给——配置是整份替换，不是叠加。
    expect(toolCallableBy("sdk", "memory_read", tools)).toBe(false);
  });

  /**
   * 这一条是整个特性的安全底座：即便有人绕过管理面直接往库里写，判据本身也不放行这两族。
   */
  it("结构性禁止的两族即便直接塞进集合也拒", () => {
    const forged = new Set(["spawn_worker", "send_message", "stay_silent"]);
    for (const name of forged)
      expect(toolCallableBy("sdk", name, forged), name).toBe(false);
  });

  it("main / lw 两档不受 sdkTools 影响", () => {
    const tools = new Set(["read_file"]);
    expect(toolCallableBy("main", "read_file", tools)).toBe(
      toolCallableBy("main", "read_file"),
    );
    expect(toolCallableBy("lw", "read_file", tools)).toBe(
      toolCallableBy("lw", "read_file"),
    );
  });
});

describe("PATCH /api/sdk/sources/:id/tools", () => {
  async function withServer(name: string) {
    const runtime = await startTestRuntime(name);
    const session = runtime.deps.operations.createSession(1);
    return {
      runtime,
      headers: {
        cookie: `luoli_sid=${session.id}`,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
    };
  }

  async function patchTools(
    runtime: Awaited<ReturnType<typeof startTestRuntime>>,
    headers: Record<string, string>,
    id: string,
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await runtime.server.request(`/api/sdk/sources/${id}/tools`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  it("配置往返，并且去重", async () => {
    const { runtime, headers } = await withServer("sdk-tools-admin-ok");
    try {
      const created = runtime.deps.sources.create("Acme");
      const saved = await patchTools(runtime, headers, created.id, {
        tools: ["read_file", "grep", "read_file"],
      });

      expect(saved.status).toBe(200);
      expect(runtime.deps.sources.get(created.id)?.tools).toEqual([
        "read_file",
        "grep",
      ]);

      const cleared = await patchTools(runtime, headers, created.id, { tools: null });
      expect(cleared.status).toBe(200);
      expect(runtime.deps.sources.get(created.id)?.tools).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  /**
   * 拒收而不是静默滤掉：运维在界面上勾了一个存不进去的名字，得到一句明确的拒绝，
   * 比得到一份「保存成功但少了一项」的配置好查。
   */
  it("结构性禁止的工具被拒收，且一个字都不写进去", async () => {
    const { runtime, headers } = await withServer("sdk-tools-admin-forbidden");
    try {
      const created = runtime.deps.sources.create("Acme");
      const rejected = await patchTools(runtime, headers, created.id, {
        tools: ["read_file", "spawn_worker"],
      });

      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.json)).toContain("spawn_worker");
      expect(runtime.deps.sources.get(created.id)?.tools).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  it("形状不对 400，来源不存在 404，无 cookie 会话 401", async () => {
    const { runtime, headers } = await withServer("sdk-tools-admin-reject");
    try {
      const created = runtime.deps.sources.create("Acme");
      expect((await patchTools(runtime, headers, created.id, { tools: "grep" })).status).toBe(400);
      expect((await patchTools(runtime, headers, created.id, { tools: [1] })).status).toBe(400);
      expect((await patchTools(runtime, headers, "nope", { tools: [] })).status).toBe(404);

      const noSession = await runtime.server.request(
        `/api/sdk/sources/${created.id}/tools`,
        { method: "PATCH", body: JSON.stringify({ tools: [] }) },
      );
      expect(noSession.status).toBe(401);
    } finally {
      await runtime.dispose();
    }
  });

  it("SDK_FORBIDDEN_TOOLS 每一件都被拒收", async () => {
    const { runtime, headers } = await withServer("sdk-tools-admin-each");
    try {
      const created = runtime.deps.sources.create("Acme");
      for (const name of SDK_FORBIDDEN_TOOLS) {
        const rejected = await patchTools(runtime, headers, created.id, { tools: [name] });
        expect(rejected.status, name).toBe(400);
      }
    } finally {
      await runtime.dispose();
    }
  });
});

/**
 * 两个强制点：`#eligible()`（目录取数）与 `admit()`（准入复查）。判据改成按来源取数之后，
 * 两处必须一起改——只改目录的话，模型沿用上一步的工具名直接调用仍会被 `admit()` 拒，
 * 表现成「目录里有、调了却说不可用」。
 */
describe("ToolRegistry 的两个强制点都读来源配置", () => {
  const log = {
    span: () => ({ id: "span", end: () => undefined }),
    event: () => undefined,
  } as unknown as LogSink;
  const broker = {
    request: () => Promise.resolve({ ok: false as const, error: "approval_unavailable" }),
  } as unknown as ApprovalBroker;

  function setup(sdkTools: ReadonlySet<string> | undefined) {
    const config = configSchema.parse({ access: { bootstrapOwnerId: "1" } });
    const registry = new ToolRegistry(log, broker, {
      maxRegistered: 10,
      maxCallsPerTurn: 10,
      maxConsecutiveErrors: 8,
    });
    // 借用两个真实工具名：`grep` 默认不在 SDK 白名单里，`memory_read` 在。实现与真身无关，
    // 这里只关心准入判据。两者都取 `trusted`，把角色轴从这条断言里排除掉。
    for (const name of ["grep", "memory_read"])
      registry.register({
        name,
        description: `探针工具 ${name}`,
        inputSchema: z.object({}),
        policy: { minRole: "trusted", approval: "never", scope: "workspace", source: "custom" },
        sourcePriority: 30,
        execute: () => ({ ok: true }),
      });
    const context: ToolExecutionContext = {
      turn: {
        turnId: `t-${Math.random()}`,
        key: "chat:c1",
        chatId: "c1",
        threadId: null,
        initiatorUserId: "c1",
        effectiveRole: "trusted",
        isPrivate: true,
        baseCommitId: null,
        snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
        delta: [],
        abortSignal: new AbortController().signal,
        config,
        ...(sdkTools ? { sdkTools } : {}),
      },
      workspace: ".",
      agentKind: "sdk",
      ...newToolScope(),
    };
    return { registry, context };
  }

  it("没配置时 grep 既不进目录也不准入（既有行为）", () => {
    const { registry, context } = setup(undefined);
    expect(registry.active("trusted", context).map((tool) => tool.name)).toEqual([
      "memory_read",
    ]);
    const admitted = registry.admit("grep", context);
    expect(admitted.ok).toBe(false);
    expect(admitted.ok === false && admitted.reason).toBe("sdk");
  });

  it("配了 grep 之后目录与准入一起放行，没配的 memory_read 一起拒", () => {
    const { registry, context } = setup(sdkToolsFromConfig(["grep"]));
    expect(registry.active("trusted", context).map((tool) => tool.name)).toEqual([
      "grep",
    ]);
    expect(registry.admit("grep", context).ok).toBe(true);
    expect(registry.admit("memory_read", context).ok).toBe(false);
  });

  /**
   * 放开这一轴不等于放开角色轴。`memory_list` 的 `minRole` 是 owner，而 SDK 会话恒 trusted，
   * 它在角色那一层就被拒，配进白名单也到不了 `toolCallableBy()`。
   */
  it("角色轴仍然先生效：配了 owner 档的工具也拿不到", () => {
    const config = configSchema.parse({ access: { bootstrapOwnerId: "1" } });
    const registry = new ToolRegistry(log, broker, {
      maxRegistered: 10,
      maxCallsPerTurn: 10,
      maxConsecutiveErrors: 8,
    });
    registry.register({
      name: "memory_list",
      description: "探针工具，minRole 取 owner",
      inputSchema: z.object({}),
      policy: { minRole: "owner", approval: "never", scope: "global", source: "custom" },
      sourcePriority: 30,
      execute: () => ({ ok: true }),
    });
    const context: ToolExecutionContext = {
      turn: {
        turnId: "t-role",
        key: "chat:c1",
        chatId: "c1",
        threadId: null,
        initiatorUserId: "c1",
        effectiveRole: "trusted",
        isPrivate: true,
        baseCommitId: null,
        snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
        delta: [],
        abortSignal: new AbortController().signal,
        config,
        sdkTools: sdkToolsFromConfig(["memory_list"]),
      },
      workspace: ".",
      agentKind: "sdk",
      ...newToolScope(),
    };
    const admitted = registry.admit("memory_list", context);
    expect(admitted.ok).toBe(false);
    expect(admitted.ok === false && admitted.reason).toBe("role");
  });
});
