-- 需要登录的 MCP server 的凭据（docs/03 §2.15，语义见 docs/07 §4.5）。
--
-- **为什么不放在 `mcp.servers` 配置里**：`config_kv` 的每一行都会被 `loadConfig` 当配置覆盖层
-- 解析，而配置还要走 `config_revisions`（审计，存完整值）与 `GET /api/config/export`。此前
-- `headers: { Authorization: 'Bearer …' }` 就是这么漏的 —— `SECRET_KEY_SEGMENT` 是
-- `/key|secret|token|password/i`，匹配不到 `Authorization` 这个键名，于是一个只用 bearer 的
-- server，它的 token 明文进了 revision、也从配置导出里原样出来。
-- 凭据在这张表里，配置里只留「用哪种方式登录」。
--
-- 密文一律经 `Secrets`（AES-256-GCM + scrypt，`LUOLI_MASTER_KEY`）。**这张表里没有明文列**，
-- `hint` 只留末 4 位（照 `providers.api_key_hint` 的既有做法），让界面不必解密就能显示。
CREATE TABLE IF NOT EXISTS mcp_auth (
  server         TEXT PRIMARY KEY,
  mode           TEXT NOT NULL CHECK (mode IN ('bearer','oauth')),
  -- bearer: token 本身；oauth: 整块 OAuthTokens 的 JSON（access + refresh + expires_in）
  secret_enc     TEXT,
  -- oauth: 动态注册（RFC 7591）拿到的 client_information
  client_enc     TEXT,
  -- oauth: 正在进行的那一次授权的 PKCE code_verifier。换完 token 就清掉
  verifier_enc   TEXT,
  -- oauth: 授权服务器发现结果的缓存，省掉每次连接的两趟往返。不含密，故不加密
  discovery_json TEXT,
  scope          TEXT,
  hint           TEXT,
  -- access token 的到期时刻（毫秒）。null = 不会过期或对方没说
  expires_at     INTEGER,
  authorized_at  INTEGER,
  -- **每次写凭据都 +1，并且进 `McpManager` 的连接指纹。** 指纹此前只含 transport/command/env/
  -- url/headers：token 搬进这张表之后轮换一次 token 不再改变指纹，于是
  -- `existing.fingerprint === print` 命中旧连接、拿着已经作废的 token 一直用下去。
  version        INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);
