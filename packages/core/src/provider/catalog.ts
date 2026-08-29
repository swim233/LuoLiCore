import { redact } from "../secrets.js";
import { guardedFetch } from "../net/outbound.js";

export interface CatalogModel {
  modelId: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
}

export type ProbeCode =
  | "ok"
  | "unauthorized"
  | "not_found"
  | "upstream_error"
  | "timeout"
  | "network"
  | "invalid_response"
  | "missing_base_url"
  | "no_master_key";

export interface ProviderProbe {
  reachable: boolean;
  code: ProbeCode;
  message: string;
  status: number | null;
  latencyMs: number;
  models: CatalogModel[];
}

export interface ProbeTarget {
  name: string;
  kind: string;
  baseUrl?: string | null;
  headers?: Record<string, string> | null;
}

/** 与 ModelRegistry 交给 AI SDK 的 baseURL 同一层级（含版本段），探测只在其后拼 `/models`。 */
const DEFAULT_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function catalogUrl(kind: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Anthropic 的 limit 上限为 1000、Google 的 pageSize 上限为 1000；一次取满即无需翻页，
  // 翻页会让一次探测变成 N 次出网请求，超时语义也难以界定。
  if (kind === "anthropic") return `${base}/models?limit=1000`;
  if (kind === "google") return `${base}/models?pageSize=1000`;
  return `${base}/models`;
}

function authHeaders(
  kind: string,
  apiKey: string | null,
): Record<string, string> {
  if (!apiKey) return {};
  if (kind === "anthropic")
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  if (kind === "google") return { "x-goog-api-key": apiKey };
  return { authorization: `Bearer ${apiKey}` };
}

function normalize(kind: string, payload: unknown): CatalogModel[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)[
          kind === "google" ? "models" : "data"
        ]
      : null;
  if (!Array.isArray(rows)) return [];
  const seen = new Map<string, CatalogModel>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    // Google 的 name 是 `models/gemini-2.5-pro`，SDK 要的是去掉前缀的那截。
    const raw =
      kind === "google"
        ? (text(entry.name)?.replace(/^models\//, "") ?? null)
        : (text(entry.id) ?? text(entry.model) ?? text(entry.name));
    if (!raw || seen.has(raw)) continue;
    seen.set(raw, {
      modelId: raw,
      displayName: text(entry.display_name) ?? text(entry.displayName) ?? null,
      contextWindow:
        positive(entry.inputTokenLimit) ??
        positive(entry.context_window) ??
        positive(entry.context_length) ??
        null,
      maxOutput:
        positive(entry.outputTokenLimit) ??
        positive(entry.max_output_tokens) ??
        null,
    });
  }
  return [...seen.values()].sort((left, right) =>
    left.modelId.localeCompare(right.modelId),
  );
}

/**
 * 一次最小出网调用，同时服务于测试连接与拉取模型列表（docs/04 §5.4）。
 * 上游错误体可能原样回显请求头（不少网关如此），因此摘要必须经过 `redact` 并带上本次使用的 key。
 */
export async function probeProvider(
  target: ProbeTarget,
  apiKey: string | null,
  timeoutMs = 15_000,
  allowPrivate = false,
): Promise<ProviderProbe> {
  const baseUrl = target.baseUrl?.trim() || DEFAULT_BASE_URL[target.kind] || "";
  const started = Date.now();
  const fail = (
    code: ProbeCode,
    message: string,
    status: number | null = null,
  ): ProviderProbe => ({
    reachable: false,
    code,
    message,
    status,
    latencyMs: Date.now() - started,
    models: [],
  });
  if (!baseUrl)
    return fail(
      "missing_base_url",
      `${target.kind} 未配置 base_url，无法定位模型目录接口`,
    );
  const clean = (value: string): string =>
    redact(value.replace(/\s+/g, " ").trim(), apiKey ? [apiKey] : []).slice(
      0,
      300,
    );
  let response: Awaited<ReturnType<typeof guardedFetch>>;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    response = await guardedFetch(
      catalogUrl(target.kind, baseUrl),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(target.headers ?? {}),
          ...authHeaders(target.kind, apiKey),
        },
        signal,
      },
      { allowPrivate, maxBytes: 8_388_608 },
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError")
      return fail("timeout", `上游 ${timeoutMs} ms 内未响应`);
    return fail(
      "network",
      `无法连接上游：${clean(error instanceof Error ? error.message : String(error))}`,
    );
  }
  const body = response.body.toString("utf8");
  if (!response.ok) {
    const summary = clean(body) || response.statusText || "无响应体";
    if (response.status === 401 || response.status === 403)
      return fail(
        "unauthorized",
        `API Key 被拒绝（${response.status}）：${summary}`,
        response.status,
      );
    if (response.status === 404)
      return fail(
        "not_found",
        `上游没有模型目录接口（404）：${summary}`,
        response.status,
      );
    return fail(
      "upstream_error",
      `上游返回 ${response.status}：${summary}`,
      response.status,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return fail(
      "invalid_response",
      `上游返回的不是 JSON：${clean(body) || "空响应体"}`,
      response.status,
    );
  }
  return {
    reachable: true,
    code: "ok",
    message: "连接正常",
    status: response.status,
    latencyMs: Date.now() - started,
    models: normalize(target.kind, payload),
  };
}
