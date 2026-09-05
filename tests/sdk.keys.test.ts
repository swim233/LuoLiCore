import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ApiKeyRepository,
  SourceRepository,
  closeDatabase,
  decodeLogPayload,
  migrateDatabase,
  openDatabase,
  type Sqlite,
} from "@luoli/db";
import { Secrets, issueApiKey, redact, verifyApiKey } from "@luoli/core";
import { startTestRuntime } from "./support/runtime.js";
import { code, source } from "./support/source.js";

/**
 * docs/12-sdk.md T3.3：密钥签发与校验（`packages/core/src/sdk/keys.ts`）+
 * `/api/sdk/*` 管理端点（`packages/server/src/sdk/admin.ts`）。逐条覆盖正文给出的 8 条验收。
 */
function harness(name: string): {
  db: Sqlite;
  secrets: Secrets;
  sources: SourceRepository;
  apiKeys: ApiKeyRepository;
} {
  const database = `./data/${name}.test.db`;
  for (const suffix of ["", "-wal", "-shm", "-logs", "-logs-wal", "-logs-shm"])
    rmSync(`${database}${suffix}`, { force: true });
  const db = openDatabase(database);
  migrateDatabase(db);
  return {
    db,
    secrets: new Secrets("x".repeat(32)),
    sources: new SourceRepository(db),
    apiKeys: new ApiKeyRepository(db),
  };
}

describe("issueApiKey / verifyApiKey", () => {
  it("验收1：签发的 token 匹配 /^sk-[A-Za-z0-9]{48}$/", () => {
    const { db, secrets, apiKeys } = harness("sdk-keys-format");
    const issued = issueApiKey({ apiKeys, secrets, sourceId: "telegram" });
    expect(issued.token).toMatch(/^sk-[A-Za-z0-9]{48}$/);
    // id 段落库为 `api_keys.id`，与 token 里那 16 个字符逐字相同。
    expect(issued.token.slice(3, 19)).toBe(issued.key.id);
    expect(issued.key).not.toHaveProperty("secretEnc");
    closeDatabase(db);
  });

  it("验收2：一条含 token 的日志经 redact 后不含该 token 任何 8 字符以上片段", () => {
    const { db, secrets, apiKeys } = harness("sdk-keys-redact");
    const issued = issueApiKey({ apiKeys, secrets, sourceId: "telegram" });
    const line = `issued ${issued.token} for source=telegram actor=owner`;
    const cleaned = redact(line);
    expect(cleaned).not.toContain(issued.token);
    for (let index = 0; index + 8 <= issued.token.length; index += 1) {
      const chunk = issued.token.slice(index, index + 8);
      expect(cleaned, `子串「${chunk}」未被脱敏`).not.toContain(chunk);
    }
    closeDatabase(db);
  });

  it("验收4：停用（disabled_at）后校验失败", () => {
    const { db, secrets, apiKeys } = harness("sdk-keys-disabled");
    const issued = issueApiKey({ apiKeys, secrets, sourceId: "telegram" });
    expect(apiKeys.disable(issued.key.id)).toBe(true);
    expect(verifyApiKey({ apiKeys, secrets, token: issued.token })).toEqual({
      ok: false,
    });
    closeDatabase(db);
  });

  it("验收5：过期（expires_at）后校验失败", () => {
    const { db, secrets, apiKeys } = harness("sdk-keys-expired");
    const issueTime = Date.now();
    const issued = issueApiKey({
      apiKeys,
      secrets,
      sourceId: "telegram",
      expiresAt: issueTime + 1000,
    });
    // 签发时刻本身未过期。
    expect(
      verifyApiKey({ apiKeys, secrets, token: issued.token, now: issueTime })
        .ok,
    ).toBe(true);
    // `expires_at <= now` 才算过期——边界值本身即失败。
    expect(
      verifyApiKey({
        apiKeys,
        secrets,
        token: issued.token,
        now: issueTime + 1000,
      }),
    ).toEqual({ ok: false });
    closeDatabase(db);
  });

  it("验收6：secret 段错误时校验失败，且不区分「id 不存在」「secret 不对」「已停用」——三者返回值深相等", () => {
    const { db, secrets, apiKeys } = harness("sdk-keys-uniform-failure");
    const valid = issueApiKey({ apiKeys, secrets, sourceId: "telegram" });
    const disabled = issueApiKey({ apiKeys, secrets, sourceId: "telegram" });
    expect(apiKeys.disable(disabled.key.id)).toBe(true);

    const wrongSecretToken = `sk-${valid.key.id}${"Z".repeat(32)}`;
    const nonExistentToken = `sk-${"Q".repeat(16)}${"R".repeat(32)}`;

    const bySecret = verifyApiKey({
      apiKeys,
      secrets,
      token: wrongSecretToken,
    });
    const byMissingId = verifyApiKey({
      apiKeys,
      secrets,
      token: nonExistentToken,
    });
    const byDisabled = verifyApiKey({
      apiKeys,
      secrets,
      token: disabled.token,
    });
    for (const result of [bySecret, byMissingId, byDisabled])
      expect(result).toEqual({ ok: false });
    expect(bySecret).toEqual(byMissingId);
    expect(byMissingId).toEqual(byDisabled);
    closeDatabase(db);
  });

  it("验收7：last_used_at 在成功校验后更新，失败校验不更新", () => {
    const { db, secrets, apiKeys } = harness("sdk-keys-touch");
    const issued = issueApiKey({ apiKeys, secrets, sourceId: "telegram" });
    expect(issued.key.lastUsedAt).toBeNull();
    // 先来一次失败的校验：不应该动 last_used_at。
    verifyApiKey({
      apiKeys,
      secrets,
      token: `sk-${issued.key.id}${"Z".repeat(32)}`,
    });
    expect(apiKeys.get(issued.key.id)?.lastUsedAt).toBeNull();
    const now = Date.now() + 5000;
    const result = verifyApiKey({ apiKeys, secrets, token: issued.token, now });
    expect(result.ok).toBe(true);
    expect(apiKeys.get(issued.key.id)?.lastUsedAt).toBe(now);
    closeDatabase(db);
  });

  it("主密钥轮换后旧密文解不开：按校验失败处理，不抛异常", () => {
    const { db, apiKeys } = harness("sdk-keys-rotated-master");
    const original = new Secrets("x".repeat(32));
    const issued = issueApiKey({
      apiKeys,
      secrets: original,
      sourceId: "telegram",
    });
    const rotated = new Secrets("y".repeat(32));
    expect(() =>
      verifyApiKey({ apiKeys, secrets: rotated, token: issued.token }),
    ).not.toThrow();
    expect(
      verifyApiKey({ apiKeys, secrets: rotated, token: issued.token }),
    ).toEqual({ ok: false });
    closeDatabase(db);
  });

  it("来源已停用（sourceDisabledAt）后校验失败，secret 正确也不更新 last_used_at", () => {
    const { db, secrets, sources, apiKeys } = harness("sdk-keys-source-disabled");
    const createdSource = sources.create("Eta");
    const issued = issueApiKey({
      apiKeys,
      secrets,
      sourceId: createdSource.id,
    });
    expect(sources.disable(createdSource.id)).toBe(true);
    // 密钥本身的 disabled_at 仍是 null——失败来自 sourceDisabledAt 这条独立分支
    // （keys.ts:128），不是与 disabled_at 分支撞在一起碰巧通过。
    expect(apiKeys.get(issued.key.id)?.disabledAt).toBeNull();
    expect(verifyApiKey({ apiKeys, secrets, token: issued.token })).toEqual({
      ok: false,
    });
    expect(apiKeys.get(issued.key.id)?.lastUsedAt).toBeNull();
    closeDatabase(db);
  });

  /**
   * plan 原文：「id 不存在时对一个常量密文走一遍同样的解密与比对，两分支时延一致」——
   * 时延本身在 CI 环境里量不准（GC 暂停、共享 CPU 都能吞掉几毫秒级的差异，
   * 一次失败的计时断言只会制造 flaky，不会验证到任何东西），改用 plan 允许的降级方案：
   * 源码断言两个分支确实走同一段 `decryptEquals` 调用，而不是「id 不存在」提前 return。
   */
  it("两分支走同一段代码（源码断言，替代无法可靠计时的行为断言）", () => {
    const text = source("packages/core/src/sdk/keys.ts");
    expect(
      text,
      "id 存在与否必须取同一个 ciphertext 变量再统一 decryptEquals，不能分叉成两段代码",
    ).toContain(
      code(
        "const ciphertext = row ? row.secretEnc : dummyCiphertextFor(input.secrets);",
      ),
    );
    expect(
      text,
      "常量密文按 Secrets 实例持有（WeakMap），不用单个模块级变量跨实例共享",
    ).toContain(
      code("const dummyCiphertexts = new WeakMap<Secrets, string>();"),
    );
    expect(
      text,
      "每个 Secrets 实例的常量密文只生成一次，不是每次校验都重新 encrypt",
    ).toContain(code("dummyCiphertexts.set(secrets, generated);"));
  });

  /**
   * qa-T3-3 第 1 轮 F1：`{ ok: false }` 深相等本身对这条修复没有判别力——`decryptEquals`
   * 的 catch 把「跨实例解不开」与「id 不存在」两种情形都收敛成同一个返回值（校验 6 的判据
   * 本身要求如此），所以修复前的模块级单例在这条用例下会返回一模一样的结果，用例恒真。
   * 判据须落在「catch 是否触发」这一步：包一层 `decrypt`，记录调用与抛出次数。
   */
  function trackDecrypt(secrets: Secrets): { calls: number; threw: number } {
    const original = secrets.decrypt.bind(secrets);
    const state = { calls: 0, threw: 0 };
    secrets.decrypt = (value: string): string => {
      state.calls += 1;
      try {
        return original(value);
      } catch (error) {
        state.threw += 1;
        throw error;
      }
    };
    return state;
  }

  it("常量密文按 Secrets 实例持有：两个不同主密钥的实例各自拿到能被自己解密的常量密文，互不干扰", () => {
    const { db, apiKeys } = harness("sdk-keys-dummy-per-instance");
    const secretsA = new Secrets("a".repeat(32));
    const secretsB = new Secrets("b".repeat(32));
    const stateA = trackDecrypt(secretsA);
    const stateB = trackDecrypt(secretsB);
    // 两个实例各自对同一个不存在的 id 校验一次：都必须干净地返回 { ok: false }，
    // 不能因为共享了对方生成的常量密文而抛出解密异常（跨实例共享正是本轮修复要消除的问题）。
    const nonExistentToken = `sk-${"Q".repeat(16)}${"R".repeat(32)}`;
    expect(
      verifyApiKey({ apiKeys, secrets: secretsA, token: nonExistentToken }),
    ).toEqual({ ok: false });
    expect(
      verifyApiKey({ apiKeys, secrets: secretsB, token: nonExistentToken }),
    ).toEqual({ ok: false });
    // 行为判据（裁决①本身）：各自的常量密文都能被自己解密，`decryptEquals` 不提前从 catch
    // 返回。修复前，B 会尝试用自己的派生密钥解开 A 生成的密文（模块级单例共享的那一份），
    // 触发一次 decrypt 异常——这条断言在回退到旧实现时会变红，`toEqual({ ok: false })` 不会。
    expect(stateA).toMatchObject({ threw: 0 });
    expect(stateB).toMatchObject({ threw: 0 });
    // 顺带确认真的执行到了比对这一步，不是被更早的分支短路掉。
    expect(stateA.calls).toBeGreaterThan(0);
    expect(stateB.calls).toBeGreaterThan(0);
    closeDatabase(db);
  });
});

describe("/api/sdk/*（真实 createServer，cookie 会话 + CSRF 闸）", () => {
  async function withServer() {
    const runtime = await startTestRuntime("sdk-admin-http");
    const session = runtime.deps.operations.createSession(1);
    const headers = {
      cookie: `luoli_sid=${session.id}`,
      "x-csrf-token": session.csrf,
      "content-type": "application/json",
    };
    return { runtime, headers };
  }

  it("验收8：无 cookie 会话 401；带 Authorization: Bearer sk-... 但无 cookie 同样 401（/api/* 只认 cookie）；签发→回显 token 逐字相同", async () => {
    const { runtime, headers } = await withServer();
    try {
      expect((await runtime.server.request("/api/sdk/sources")).status).toBe(
        401,
      );
      expect(
        (
          await runtime.server.request("/api/sdk/sources", {
            headers: {
              authorization: `Bearer sk-${"A".repeat(16)}${"B".repeat(32)}`,
            },
          })
        ).status,
      ).toBe(401);

      const sourceResponse = await runtime.server.request("/api/sdk/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Acme" }),
      });
      expect(sourceResponse.status).toBe(200);
      const {
        data: { source: createdSource },
      } = (await sourceResponse.json()) as {
        data: { source: { id: string } };
      };

      const issueResponse = await runtime.server.request(
        `/api/sdk/sources/${createdSource.id}/keys`,
        { method: "POST", headers, body: JSON.stringify({ label: "ci" }) },
      );
      expect(issueResponse.status).toBe(200);
      const {
        data: { token: issuedToken, key },
      } = (await issueResponse.json()) as {
        data: { token: string; key: { id: string } };
      };
      expect(issuedToken).toMatch(/^sk-[A-Za-z0-9]{48}$/);

      const revealResponse = await runtime.server.request(
        `/api/sdk/keys/${key.id}/reveal`,
        { headers },
      );
      expect(revealResponse.status).toBe(200);
      const {
        data: { token: revealedToken },
      } = (await revealResponse.json()) as { data: { token: string } };
      expect(revealedToken).toBe(issuedToken);
    } finally {
      await runtime.dispose();
    }
  });

  it("验收3：明文只出现在签发响应与回显端点；列表端点不含明文也不含密文列", async () => {
    const { runtime, headers } = await withServer();
    try {
      const sourceResponse = await runtime.server.request("/api/sdk/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Beta" }),
      });
      const {
        data: { source: createdSource },
      } = (await sourceResponse.json()) as {
        data: { source: { id: string } };
      };
      const issueResponse = await runtime.server.request(
        `/api/sdk/sources/${createdSource.id}/keys`,
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      const {
        data: { token: issuedToken, key },
      } = (await issueResponse.json()) as {
        data: { token: string; key: { id: string } };
      };

      const listResponse = await runtime.server.request(
        `/api/sdk/sources/${createdSource.id}/keys`,
        { headers },
      );
      const listBody = await listResponse.text();
      expect(listBody).not.toContain(issuedToken);
      const parsedList = JSON.parse(listBody) as {
        data: { keys: Array<Record<string, unknown>> };
      };
      expect(parsedList.data.keys.map((row) => row.id)).toContain(key.id);
      for (const row of parsedList.data.keys)
        expect(row).not.toHaveProperty("secretEnc");

      // T3.6：`/sdk/v1/*` 现挂了真实路由（Bearer 中间件先于路由处理函数），不再落 SPA 静态兜底。
      // 无 Authorization 头一律 401、结构化 JSON（不是 index.html）——但 401 响应体本就不携带
      // 请求方的 token，「不含明文」这半句对着它恒真，没有判别力（qa-T3-6 verify-1 FAIL-4）。
      const sdkV1Response = await runtime.server.request("/sdk/v1/sessions");
      expect(sdkV1Response.status).toBe(401);
      expect(sdkV1Response.headers.get("content-type")).toMatch(/application\/json/);

      // 真正有判别力的是一次成功（200）响应：用刚签发的这把 key（已认证、来源存在）打
      // `GET /sdk/v1/sessions`，断言响应体不含它自己的明文、也不匹配 sk- 形状——
      // 这才是「/sdk/v1/* 任何响应不含明文 token」的正式验证（lead 判据原文「任何响应」）。
      const authedResponse = await runtime.server.request("/sdk/v1/sessions", {
        headers: { authorization: `Bearer ${issuedToken}` },
      });
      expect(authedResponse.status).toBe(200);
      const authedBody = await authedResponse.text();
      expect(authedBody).not.toContain(issuedToken);
      expect(authedBody).not.toMatch(/sk-[A-Za-z0-9]{48}/);
    } finally {
      await runtime.dispose();
    }
  });

  it("验收3：每次回显留一条 warn（sdk.key_revealed），条数随回显次数增长；已停用的密钥仍可回显", async () => {
    const { runtime, headers } = await withServer();
    try {
      const sourceResponse = await runtime.server.request("/api/sdk/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Gamma" }),
      });
      const {
        data: { source: createdSource },
      } = (await sourceResponse.json()) as {
        data: { source: { id: string } };
      };
      const issueResponse = await runtime.server.request(
        `/api/sdk/sources/${createdSource.id}/keys`,
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      const {
        data: { token: issuedToken, key },
      } = (await issueResponse.json()) as {
        data: { token: string; key: { id: string } };
      };

      // `log_events` 没有单列的 key id，载荷在 data/data_codec 里；这里的密钥 id 是
      // `issueApiKey` 现生成的随机串，不会撞上同一进程内其他用例留下的行，按 summary 计数足够精确。
      const revealedCount = (): number =>
        runtime.db
          .prepare(
            "SELECT COUNT(*) FROM log_events WHERE kind='sdk.key_revealed' AND summary=?",
          )
          .pluck()
          .get(`密钥 ${key.id} 被回显`) as number;

      expect(revealedCount()).toBe(0);
      const first = await runtime.server.request(
        `/api/sdk/keys/${key.id}/reveal`,
        { headers },
      );
      expect(first.status).toBe(200);
      expect(revealedCount()).toBe(1);

      const row = runtime.db
        .prepare(
          "SELECT data,data_codec AS codec FROM log_events WHERE kind='sdk.key_revealed' ORDER BY id DESC LIMIT 1",
        )
        .get() as { data: Buffer | null; codec: string };
      const payload = JSON.parse(
        decodeLogPayload(row.data, row.codec) ?? "null",
      ) as {
        keyId: string;
        sourceId: string;
        actor: string;
      };
      expect(payload).toEqual({
        keyId: key.id,
        sourceId: createdSource.id,
        actor: "webui",
      });
      // 回显的日志载荷本身不夹带明文 token。
      expect(JSON.stringify(payload)).not.toContain(issuedToken);

      // 停用之后仍可回显（本任务的设计决定，见报告）；warn 计数继续增长。
      const disableResponse = await runtime.server.request(
        `/api/sdk/keys/${key.id}`,
        { method: "DELETE", headers },
      );
      expect(disableResponse.status).toBe(200);
      const second = await runtime.server.request(
        `/api/sdk/keys/${key.id}/reveal`,
        { headers },
      );
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { data: { token: string } };
      expect(secondBody.data.token).toBe(issuedToken);
      expect(revealedCount()).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("裁决（第 2 轮）：reveal 解密失败（主密钥轮换遗留的旧密文）返回明确错误体，记 sdk.key_reveal_failed 而非 sdk.key_revealed", async () => {
    const { runtime, headers } = await withServer();
    try {
      const sourceResponse = await runtime.server.request("/api/sdk/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Theta" }),
      });
      const {
        data: { source: createdSource },
      } = (await sourceResponse.json()) as {
        data: { source: { id: string } };
      };
      // 直接经仓储插入一行用「另一把主密钥」加密的密文，模拟主密钥轮换后遗留的旧行——
      // 服务端当前的 Secrets 实例（测试固定用 "x".repeat(32)）解不开它。
      const rotated = new Secrets("z".repeat(32));
      const undecryptableCiphertext = rotated.encrypt("R".repeat(32));
      const undecryptableId = "Undecryptable1234";
      runtime.deps.apiKeys.insert({
        id: undecryptableId,
        sourceId: createdSource.id,
        secretEnc: undecryptableCiphertext,
      });

      const revealedCount = (): number =>
        runtime.db
          .prepare("SELECT COUNT(*) FROM log_events WHERE kind='sdk.key_revealed'")
          .pluck()
          .get() as number;
      const failedCount = (): number =>
        runtime.db
          .prepare(
            "SELECT COUNT(*) FROM log_events WHERE kind='sdk.key_reveal_failed'",
          )
          .pluck()
          .get() as number;
      const revealedBefore = revealedCount();
      const failedBefore = failedCount();

      const response = await runtime.server.request(
        `/api/sdk/keys/${undecryptableId}/reveal`,
        { headers },
      );
      expect(response.status).toBe(500);
      const bodyText = await response.text();
      // 响应体不夹带密文片段，也不是裸异常（`decrypt` 真实抛出的消息不出网）。
      expect(bodyText).not.toContain(undecryptableCiphertext);
      const body = JSON.parse(bodyText) as {
        ok: boolean;
        error: { code: string };
      };
      expect(body).toMatchObject({
        ok: false,
        error: { code: "secret_undecryptable" },
      });

      // 解密失败不记 sdk.key_revealed（明文没有出网，这一行是「谁看过明文」的凭据）；
      // 改记独立的 sdk.key_reveal_failed。
      expect(revealedCount()).toBe(revealedBefore);
      expect(failedCount()).toBe(failedBefore + 1);

      const row = runtime.db
        .prepare(
          "SELECT data,data_codec AS codec FROM log_events WHERE kind='sdk.key_reveal_failed' ORDER BY id DESC LIMIT 1",
        )
        .get() as { data: Buffer | null; codec: string };
      const payload = JSON.parse(
        decodeLogPayload(row.data, row.codec) ?? "null",
      ) as { keyId: string; sourceId: string; actor: string; reason: string };
      expect(payload).toEqual({
        keyId: undecryptableId,
        sourceId: createdSource.id,
        actor: "webui",
        reason: "undecryptable",
      });
      // 失败日志的载荷同样不含密文。
      expect(JSON.stringify(payload)).not.toContain(undecryptableCiphertext);
    } finally {
      await runtime.dispose();
    }
  });

  it("请求体非法 / 来源或密钥不存在时的状态码：名称为空 400，来源不存在 404，密钥不存在 404，过期时间早于当前 400", async () => {
    const { runtime, headers } = await withServer();
    try {
      expect(
        (
          await runtime.server.request("/api/sdk/sources", {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "" }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await runtime.server.request("/api/sdk/sources", {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "x".repeat(65) }),
          })
        ).status,
      ).toBe(400);
      expect(
        (await runtime.server.request("/api/sdk/sources/does-not-exist/keys"))
          .status,
      ).toBe(401); // 未带 cookie
      expect(
        (
          await runtime.server.request("/api/sdk/sources/does-not-exist/keys", {
            headers,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await runtime.server.request("/api/sdk/sources/does-not-exist/keys", {
            method: "POST",
            headers,
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await runtime.server.request("/api/sdk/keys/does-not-exist/reveal", {
            headers,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await runtime.server.request("/api/sdk/keys/does-not-exist", {
            method: "DELETE",
            headers,
          })
        ).status,
      ).toBe(404);

      const sourceResponse = await runtime.server.request("/api/sdk/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Delta" }),
      });
      const {
        data: { source: createdSource },
      } = (await sourceResponse.json()) as {
        data: { source: { id: string } };
      };
      expect(
        (
          await runtime.server.request(
            `/api/sdk/sources/${createdSource.id}/keys`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ expiresAt: Date.now() - 1000 }),
            },
          )
        ).status,
      ).toBe(400);
    } finally {
      await runtime.dispose();
    }
  });

  it("签发限未停用的 kind='sdk' 来源：内建 telegram 行 400 source_not_sdk，停用后的 sdk 来源 400 source_disabled", async () => {
    const { runtime, headers } = await withServer();
    try {
      // 内建 telegram 行（0019 种子，kind='telegram'）不接受签发。
      const telegramResponse = await runtime.server.request(
        "/api/sdk/sources/telegram/keys",
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      expect(telegramResponse.status).toBe(400);
      expect(
        (await telegramResponse.json()) as { error: { code: string } },
      ).toMatchObject({ error: { code: "source_not_sdk" } });

      const sourceResponse = await runtime.server.request("/api/sdk/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Epsilon" }),
      });
      const {
        data: { source: createdSource },
      } = (await sourceResponse.json()) as {
        data: { source: { id: string } };
      };
      // 停用来源前：正常签发一把成功。
      expect(
        (
          await runtime.server.request(
            `/api/sdk/sources/${createdSource.id}/keys`,
            { method: "POST", headers, body: JSON.stringify({}) },
          )
        ).status,
      ).toBe(200);
      // 停用来源——`SourceRepository` 没有单独的「停用」端点挂在 /api/sdk/* 下（本任务范围只有
      // 密钥的停用），直接调仓储方法模拟运维已停用这个来源的状态。
      expect(runtime.deps.sources.disable(createdSource.id)).toBe(true);
      const afterDisable = await runtime.server.request(
        `/api/sdk/sources/${createdSource.id}/keys`,
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      expect(afterDisable.status).toBe(400);
      expect(
        (await afterDisable.json()) as { error: { code: string } },
      ).toMatchObject({ error: { code: "source_disabled" } });
    } finally {
      await runtime.dispose();
    }
  });

  it("kind/disabled 限制只挡签发：GET .../keys 与 reveal 对 telegram 行、已停用来源仍可读", async () => {
    const { runtime, headers } = await withServer();
    try {
      // 直接经仓储签发一把绑定 telegram 来源的密钥，模拟限制生效前遗留的旧密钥——
      // 只读端点（列出、回显）不该因为来源不是 kind='sdk' 或已停用就把既有密钥藏起来。
      const legacyIssued = issueApiKey({
        apiKeys: runtime.deps.apiKeys,
        secrets: runtime.deps.secrets,
        sourceId: "telegram",
      });
      const telegramList = await runtime.server.request(
        "/api/sdk/sources/telegram/keys",
        { headers },
      );
      expect(telegramList.status).toBe(200);
      const telegramListBody = (await telegramList.json()) as {
        data: { keys: Array<{ id: string }> };
      };
      expect(telegramListBody.data.keys.map((row) => row.id)).toContain(
        legacyIssued.key.id,
      );
      const telegramReveal = await runtime.server.request(
        `/api/sdk/keys/${legacyIssued.key.id}/reveal`,
        { headers },
      );
      expect(telegramReveal.status).toBe(200);
      expect(
        ((await telegramReveal.json()) as { data: { token: string } }).data
          .token,
      ).toBe(legacyIssued.token);

      // 已停用的 sdk 来源同理：停用只挡「新签发」，既有密钥的列出与回显不受影响。
      const sourceResponse = await runtime.server.request("/api/sdk/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Zeta" }),
      });
      const {
        data: { source: createdSource },
      } = (await sourceResponse.json()) as {
        data: { source: { id: string } };
      };
      const issueResponse = await runtime.server.request(
        `/api/sdk/sources/${createdSource.id}/keys`,
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      const {
        data: { key },
      } = (await issueResponse.json()) as { data: { key: { id: string } } };
      expect(runtime.deps.sources.disable(createdSource.id)).toBe(true);
      expect(
        (
          await runtime.server.request(
            `/api/sdk/sources/${createdSource.id}/keys`,
            { headers },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await runtime.server.request(`/api/sdk/keys/${key.id}/reveal`, {
            headers,
          })
        ).status,
      ).toBe(200);
    } finally {
      await runtime.dispose();
    }
  });
});
