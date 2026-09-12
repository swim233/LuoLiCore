/**
 * `/api/sdk/*`：SDK 来源与密钥的运维管理面（docs/12-sdk.md T3.3，A6）。
 *
 * 独立成文件，`app.ts` 只挂载 `mountSdkAdmin(app, dependencies)`（该文件已 5900+ 行）。
 * 这些路由挂在 `/api/*` 前缀下，因此复用 `app.ts` 里已经装好的那一整条中间件链——Origin 闸、
 * 请求体上限、鉴权（cookie 会话）与 CSRF、写操作审计日志——本文件不重新实现任何一层。
 *
 * `apiError` 从独立的 `../api-error.js` 引入（T3.6 交付 6：此前从 `app.ts` 引入，构成
 * `app.ts` ⇄ `admin.ts` 的循环 import；抽出后 `ServerDependencies` / `ServerEnv` 两个类型
 * 仍需从 `app.ts` 引入，但那是类型引用，不参与运行期求值，不构成循环）。
 *
 * `/sdk/v1/*`（T3.6，Bearer 认证的第三方入口）不在这里——那一侧的中间件、路由与本文件无关，
 * 本文件的端点全部只服务 WebUI 的 owner 管理面。
 */
import type { Hono } from "hono";
import { issueApiKey, SDK_FORBIDDEN_TOOLS } from "@luoli/core";
import { apiError } from "../api-error.js";
import type { ServerDependencies, ServerEnv } from "../app.js";

const NAME_MAX = 64;
const LABEL_MAX = 200;

export function mountSdkAdmin(
  app: Hono<ServerEnv>,
  dependencies: ServerDependencies,
): void {
  app.get("/api/sdk/sources", (ctx) => {
    if (!dependencies.sources)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配 SDK 来源仓储", 500).body,
        500,
      );
    return ctx.json({
      ok: true,
      data: { sources: dependencies.sources.list() },
    });
  });

  app.post("/api/sdk/sources", async (ctx) => {
    if (!dependencies.sources)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配 SDK 来源仓储", 500).body,
        500,
      );
    const body = await ctx.req
      .json<{ name?: unknown }>()
      .catch((): { name?: unknown } => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > NAME_MAX)
      return ctx.json(
        apiError("invalid_name", `名称不能为空，且不超过 ${NAME_MAX} 个字符`)
          .body,
        400,
      );
    return ctx.json({
      ok: true,
      data: { source: dependencies.sources.create(name) },
    });
  });

  /**
   * 这个来源的 SDK 会话能调哪些工具（`docs/12 §8`）。
   *
   * `tools: null` 恢复默认（记忆三件），`tools: []` 显式一件都不给，两者不同。
   *
   * 结构性禁止的那两族（派发、Telegram 输出）在此**拒收**而不是静默滤掉：运维在界面上勾了
   * 一个存不进去的名字，得到一句明确的拒绝比得到一份「保存成功但少了一项」的配置好查。
   * 运行期读侧仍然会再滤一次（`sdkToolsFromConfig`），那一层防的是库被直接编辑过。
   *
   * 工具名是否真的存在于注册表不在这里判：自撰写工具、插件、MCP 的名字随部署变化，
   * 管理面没有权威的全集；一个不存在的名字的后果只是它调不到，与没配它一样。
   */
  app.patch("/api/sdk/sources/:id/tools", async (ctx) => {
    if (!dependencies.sources)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配 SDK 来源仓储", 500).body,
        500,
      );
    const id = ctx.req.param("id");
    if (!dependencies.sources.get(id))
      return ctx.json(apiError("not_found", "来源不存在", 404).body, 404);
    const body = await ctx.req
      .json<{ tools?: unknown }>()
      .catch((): { tools?: unknown } => ({}));
    if (body.tools !== null && !Array.isArray(body.tools))
      return ctx.json(
        apiError("invalid_tools", "tools 必须是工具名数组，或 null 表示用默认").body,
        400,
      );
    let tools: string[] | null = null;
    if (body.tools !== null) {
      if (!body.tools.every((name): name is string => typeof name === "string"))
        return ctx.json(
          apiError("invalid_tools", "工具名必须是字符串").body,
          400,
        );
      const forbidden = body.tools.filter((name) => SDK_FORBIDDEN_TOOLS.has(name));
      if (forbidden.length)
        return ctx.json(
          apiError(
            "tool_forbidden_for_sdk",
            `这些工具与 SDK 通道的形状冲突，配了也不会生效：${forbidden.join("、")}`,
          ).body,
          400,
        );
      tools = [...new Set(body.tools)];
    }
    return ctx.json({
      ok: true,
      data: { source: dependencies.sources.setTools(id, tools) },
    });
  });

  app.get("/api/sdk/sources/:id/keys", (ctx) => {
    if (!dependencies.sources || !dependencies.apiKeys)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配 SDK 密钥仓储", 500).body,
        500,
      );
    const id = ctx.req.param("id");
    if (!dependencies.sources.get(id))
      return ctx.json(apiError("not_found", "来源不存在", 404).body, 404);
    return ctx.json({
      ok: true,
      data: { keys: dependencies.apiKeys.listBySource(id) },
    });
  });

  app.post("/api/sdk/sources/:id/keys", async (ctx) => {
    if (!dependencies.sources || !dependencies.apiKeys)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配 SDK 密钥仓储", 500).body,
        500,
      );
    if (!dependencies.secrets?.available)
      return ctx.json(
        apiError(
          "secrets_unavailable",
          "未配置 LUOLI_MASTER_KEY，无法签发密钥",
          500,
        ).body,
        500,
      );
    const id = ctx.req.param("id");
    const source = dependencies.sources.get(id);
    if (!source)
      return ctx.json(apiError("not_found", "来源不存在", 404).body, 404);
    // 内建 `telegram` 行（kind='telegram'）不签发 SDK 密钥：它的会话走 Telegram 自己的鉴权，
    // 一把能代表它的 sk- key 会绕开那条路径直接建会话。已停用的 sdk 来源同理拒绝——停用是
    // 「不再接受新签发」的语义，已签发的旧密钥不因来源停用而失效（那是密钥自己的 disabled_at）。
    if (source.kind !== "sdk")
      return ctx.json(
        apiError("source_not_sdk", "该来源不支持签发密钥", 400).body,
        400,
      );
    if (source.disabledAt !== null)
      return ctx.json(
        apiError("source_disabled", "来源已停用，无法签发密钥", 400).body,
        400,
      );
    const body = await ctx.req
      .json<{ label?: unknown; expiresAt?: unknown }>()
      .catch((): { label?: unknown; expiresAt?: unknown } => ({}));
    let label: string | null = null;
    if (body.label !== undefined && body.label !== null) {
      if (typeof body.label !== "string" || body.label.length > LABEL_MAX)
        return ctx.json(
          apiError("invalid_label", `label 不能超过 ${LABEL_MAX} 个字符`).body,
          400,
        );
      label = body.label;
    }
    let expiresAt: number | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (
        typeof body.expiresAt !== "number" ||
        !Number.isFinite(body.expiresAt) ||
        body.expiresAt <= Date.now()
      )
        return ctx.json(
          apiError(
            "invalid_expires_at",
            "expiresAt 需晚于当前时间（毫秒时间戳）",
          ).body,
          400,
        );
      expiresAt = body.expiresAt;
    }
    const issued = issueApiKey({
      apiKeys: dependencies.apiKeys,
      secrets: dependencies.secrets,
      sourceId: id,
      label,
      expiresAt,
    });
    return ctx.json({
      ok: true,
      data: { token: issued.token, key: issued.key },
    });
  });

  app.delete("/api/sdk/keys/:id", (ctx) => {
    if (!dependencies.apiKeys)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配 SDK 密钥仓储", 500).body,
        500,
      );
    const id = ctx.req.param("id");
    if (!dependencies.apiKeys.get(id))
      return ctx.json(apiError("not_found", "密钥不存在", 404).body, 404);
    return ctx.json({
      ok: true,
      data: { disabled: dependencies.apiKeys.disable(id) },
    });
  });

  /**
   * 回显明文（Q-B）。已停用的密钥同样允许回显——`ApiKeyRepository` 没有重新启用的方法，
   * 停用即终局状态，回显它不产生新的可用凭据，只用于事后核对「这把已经作废的 key 当初是什么」；
   * 隐藏它换不来任何安全收益，反而在事故排查时少一条能核对的线索。**每次成功回显**都记一条
   * warn（`sdk.key_revealed`），不管是否已停用、不管是否为重复回显——这是这个端点存在的前提
   * （Q-B「owner 可回显（记 warn）」），少记一次即让这次查看无凭无据。
   *
   * 解密可能失败（主密钥轮换后，旧密文用当前主密钥解不开，`verifyApiKey` 一侧同样按失败处理，
   * 见 `decryptEquals`）：不让异常冒泡到 `app.onError`（那条路径会把异常消息整段落进
   * `webui.error`，且回显端点抛出的异常本身可能就是围绕密文构造出来的字符串），也不记
   * `sdk.key_revealed`——解密失败意味着明文没有出网，这一行是「谁看过明文」的凭据，
   * 掺进没看到的行会让它失真。失败改记独立的 `sdk.key_reveal_failed`（lead 裁决，
   * docs/12-sdk.md T3.3 第 2 轮）。
   */
  app.get("/api/sdk/keys/:id/reveal", (ctx) => {
    if (!dependencies.apiKeys)
      return ctx.json(
        apiError("not_implemented", "这个部署没有装配 SDK 密钥仓储", 500).body,
        500,
      );
    if (!dependencies.secrets?.available)
      return ctx.json(
        apiError(
          "secrets_unavailable",
          "未配置 LUOLI_MASTER_KEY，无法回显密钥",
          500,
        ).body,
        500,
      );
    const id = ctx.req.param("id");
    const key = dependencies.apiKeys.get(id);
    if (!key)
      return ctx.json(apiError("not_found", "密钥不存在", 404).body, 404);
    let secret: string;
    try {
      secret = dependencies.secrets.decrypt(key.secretEnc);
    } catch {
      dependencies.log.event({
        level: "warn",
        kind: "sdk.key_reveal_failed",
        summary: `密钥 ${key.id} 回显失败：当前主密钥无法解密`,
        data: {
          keyId: key.id,
          sourceId: key.sourceId,
          actor: "webui",
          reason: "undecryptable",
        },
      });
      return ctx.json(
        apiError(
          "secret_undecryptable",
          "当前主密钥无法解密该密钥，无法回显",
          500,
        ).body,
        500,
      );
    }
    const token = `sk-${key.id}${secret}`;
    dependencies.log.event({
      level: "warn",
      kind: "sdk.key_revealed",
      summary: `密钥 ${key.id} 被回显`,
      data: { keyId: key.id, sourceId: key.sourceId, actor: "webui" },
    });
    return ctx.json({ ok: true, data: { token } });
  });
}
