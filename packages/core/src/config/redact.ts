/**
 * 配置脱敏口径。**只有这一份** —— WebUI 的读端点、导出、变更历史，以及 `install_mcp` 这条
 * 非 WebUI 的写入路径共用它。分成两份的表现是密钥在其中一条路径上明文落库（docs/09 §3.13）。
 */
export const SECRET_KEY_SEGMENT = /key|secret|token|password/i;

/**
 * 导出 / YAML 渲染时判断「这一行是不是密钥」。判据是**叶子段 + 值是非空字符串**，与
 * `publicConfig` / `revisionJson` 同一套口径 —— 拿整条点分路径去 test 会把
 * `context.limit.tokens` 也当成密钥（`/token/i` 匹配到 "tokens"），于是一份导出里
 * 静静地少了几项真配置。值不是字符串的行由 `publicConfig` 的 `«redacted»` 检查兜住。
 */
export function looksSecret(key: string, value: unknown): boolean {
  return (
    SECRET_KEY_SEGMENT.test(key.split(".").at(-1) ?? key) &&
    typeof value === "string" &&
    value.length > 0
  );
}

export function publicConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicConfig);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_KEY_SEGMENT.test(key) && typeof nested === "string" && nested
        ? "«redacted»"
        : publicConfig(nested),
    ]),
  );
}

/**
 * 进 `config_revisions` 的那份值。`config_kv` 存真值，历史只存脱敏后的 ——
 * docs/09 §3.13 承诺「密钥类字段在写入时就已存成 «redacted»」，而按点分键写入时
 * `publicConfig` 拿不到键名（值是个裸字符串），于是密钥会明文躺在变更历史里。
 */
export function revisionJson(key: string, value: unknown): string {
  const leaf = key.split(".").at(-1) ?? key;
  if (SECRET_KEY_SEGMENT.test(leaf) && typeof value === "string" && value)
    return JSON.stringify("«redacted»");
  return JSON.stringify(publicConfig(value));
}
