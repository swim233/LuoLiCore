import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { readAppKv, writeAppKv } from "@luoli/db";
import { guardedFetch, type GuardedResponse } from "../net/outbound.js";
import type { Sqlite } from "@luoli/db";

/**
 * 上游的 `/models` 只给模型名（Google 额外给窗口与输出），窗口、最大输出、定价、输入模态、
 * 可用思考档位一概没有；这些事实来自 models.dev 的公共目录（`api.json`，185 家 provider /
 * 6586 条），拉取一次缓存到磁盘，之后靠 ETag 条件请求续期（docs/04 §5.4.1）。
 */
export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
  temperature: boolean;
  attachment: boolean;
}
export interface CatalogPrice {
  priceIn: number | null;
  priceOut: number | null;
  priceCacheRead: number | null;
  priceCacheWrite: number | null;
}
/** `provider`＝该 provider 在 models.dev 中有条目，用它自报的价格（这才是实际扣费依据）；
 *  `official`＝匹配不上（自建中转网关），退回模型厂商自家条目取官方价；
 *  `third-party`＝厂商侧查不到（旧型号已下架、开源权重模型），只有第三方托管价，价格一律留空，
 *  只给出区间由 owner 自行填写。伪造价格会让配额按错误数字计算（docs/04 §5.5）。 */
export type CatalogMatch = "provider" | "official" | "third-party" | "none";
export interface PriceRange {
  min: number;
  max: number;
  providers: number;
}
export interface ModelMetadata extends CatalogPrice {
  match: CatalogMatch;
  catalogProviderId: string | null;
  catalogProviderName: string | null;
  catalogModelId: string | null;
  normalized: boolean;
  displayName: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  priceRange: PriceRange | null;
  capabilities: ModelCapabilities;
  reasoningControl: "effort" | "toggle" | "budget_tokens" | null;
  reasoningEfforts: string[];
  modalities: { input: string[]; output: string[] };
  knowledge: string | null;
  releaseDate: string | null;
}

interface RawModel {
  name?: unknown;
  attachment?: unknown;
  reasoning?: unknown;
  tool_call?: unknown;
  structured_output?: unknown;
  temperature?: unknown;
  knowledge?: unknown;
  release_date?: unknown;
  reasoning_options?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  limit?: { context?: unknown; output?: unknown };
  cost?: {
    input?: unknown;
    output?: unknown;
    cache_read?: unknown;
    cache_write?: unknown;
  };
}
interface RawProvider {
  id?: unknown;
  name?: unknown;
  api?: unknown;
  models?: Record<string, RawModel>;
}
interface Occurrence {
  providerId: string;
  providerName: string;
  modelId: string;
  model: RawModel;
}

const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
const money = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/** `:free` / `@20250929` / `-latest` 与日期后缀都是同一模型的别名；剥离后才能匹配厂商目录中的条目。
 *  剥离结果以 `catalogModelId` 回传给界面，运维可据此看出该行是靠哪个 key 匹配上的。 */
function variants(modelId: string): string[] {
  const out = [modelId];
  const push = (value: string): void => {
    if (value && value !== modelId && !out.includes(value)) out.push(value);
  };
  push(modelId.replace(/:[^:]+$/, ""));
  push(modelId.replace(/@[\w.-]+$/, ""));
  push(modelId.replace(/-latest$/, ""));
  push(modelId.replace(/-\d{4}-\d{2}-\d{2}$/, ""));
  push(modelId.replace(/-\d{8}$/, ""));
  return out;
}

export class CatalogIndex {
  readonly providers = new Map<
    string,
    {
      id: string;
      name: string;
      api: string | null;
      models: Map<string, RawModel>;
    }
  >();
  /** models.dev 有 159/185 家带 `api` 字段，baseUrl → provider id 的映射直接由数据生成，
   *  无需手写域名表。同域名的多家（api.z.ai 的普通版与 coding 版）按路径最长前缀区分。 */
  readonly endpoints: Array<{
    host: string;
    path: string;
    providerId: string;
  }> = [];
  /** 网关一律把第三方模型写成 `anthropic/claude-sonnet-4-5`，该前缀即厂商归属的社区共识；
   *  多数投票可把 `claude-sonnet-4-5 → anthropic` 这类裸 id 定位到厂商自家条目。 */
  readonly owners = new Map<string, Map<string, number>>();
  readonly occurrences = new Map<string, Occurrence[]>();
  readonly modelCount: number;

  constructor(payload: Record<string, RawProvider>) {
    let count = 0;
    for (const [providerId, provider] of Object.entries(payload)) {
      if (
        !provider ||
        typeof provider !== "object" ||
        !provider.models ||
        typeof provider.models !== "object"
      )
        continue;
      const models = new Map<string, RawModel>();
      const providerName = text(provider.name) ?? providerId;
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (!model || typeof model !== "object") continue;
        models.set(modelId, model);
        count += 1;
        const [vendor, ...rest] = modelId.split("/");
        const bare = rest.length ? rest.join("/") : modelId;
        if (rest.length && vendor) {
          const votes = this.owners.get(bare) ?? new Map<string, number>();
          votes.set(vendor, (votes.get(vendor) ?? 0) + 1);
          this.owners.set(bare, votes);
        }
        const list = this.occurrences.get(bare) ?? [];
        list.push({ providerId, providerName, modelId, model });
        this.occurrences.set(bare, list);
      }
      if (!models.size) continue;
      const api = text(provider.api);
      this.providers.set(providerId, {
        id: providerId,
        name: providerName,
        api,
        models,
      });
      if (api) {
        try {
          const url = new URL(api);
          this.endpoints.push({
            host: url.host.toLowerCase(),
            path: url.pathname.replace(/\/+$/, ""),
            providerId,
          });
        } catch {
          /* 目录中的 api 字段偶有非 URL，忽略该条即可 */
        }
      }
    }
    this.endpoints.sort((left, right) => right.path.length - left.path.length);
    this.modelCount = count;
  }

  providerFor(kind: string, baseUrl: string | null | undefined): string | null {
    const trimmed = baseUrl?.trim();
    if (trimmed) {
      try {
        const url = new URL(trimmed);
        const host = url.host.toLowerCase();
        const path = url.pathname.replace(/\/+$/, "");
        const hit = this.endpoints.find(
          (entry) =>
            entry.host === host &&
            (entry.path === "" ||
              path === entry.path ||
              path.startsWith(`${entry.path}/`)),
        );
        if (hit) return hit.providerId;
      } catch {
        /* baseUrl 由运维手填，非法时视为未填 */
      }
    }
    // 一方 provider（openai/anthropic/google/xai）在 models.dev 中没有 `api` 字段，由 kind 兜底。
    const byKind: Record<string, string> = {
      openai: "openai",
      anthropic: "anthropic",
      google: "google",
    };
    return byKind[kind] ?? null;
  }
}

function capabilities(model: RawModel): ModelCapabilities {
  const input = strings(model.modalities?.input);
  return {
    vision: input.includes("image"),
    tools: model.tool_call === true,
    reasoning: model.reasoning === true,
    structuredOutput: model.structured_output === true,
    temperature: model.temperature !== false,
    attachment: model.attachment === true,
  };
}
function reasoning(model: RawModel): {
  control: ModelMetadata["reasoningControl"];
  efforts: string[];
} {
  const options = Array.isArray(model.reasoning_options)
    ? model.reasoning_options
    : [];
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const type = text((option as { type?: unknown }).type);
    if (type === "effort")
      return {
        control: "effort",
        efforts: strings((option as { values?: unknown }).values),
      };
    if (type === "toggle" || type === "budget_tokens")
      return { control: type, efforts: [] };
  }
  return { control: null, efforts: [] };
}
const priceOf = (model: RawModel): CatalogPrice => ({
  priceIn: money(model.cost?.input),
  priceOut: money(model.cost?.output),
  priceCacheRead: money(model.cost?.cache_read),
  priceCacheWrite: money(model.cost?.cache_write),
});
const priced = (model: RawModel): boolean =>
  money(model.cost?.input) !== null && money(model.cost?.output) !== null;

function describe(
  match: CatalogMatch,
  hit: Occurrence | null,
  normalized: boolean,
  range: PriceRange | null,
  withPrice: boolean,
): ModelMetadata {
  const model = hit?.model ?? {};
  const think = reasoning(model);
  const price = withPrice
    ? priceOf(model)
    : {
        priceIn: null,
        priceOut: null,
        priceCacheRead: null,
        priceCacheWrite: null,
      };
  return {
    match,
    ...price,
    catalogProviderId: hit?.providerId ?? null,
    catalogProviderName: hit?.providerName ?? null,
    catalogModelId: hit?.modelId ?? null,
    normalized,
    displayName: text(model.name),
    contextWindow: positive(model.limit?.context),
    maxOutput: positive(model.limit?.output),
    priceRange: range,
    capabilities: hit
      ? capabilities(model)
      : {
          vision: false,
          tools: false,
          reasoning: false,
          structuredOutput: false,
          temperature: false,
          attachment: false,
        },
    reasoningControl: think.control,
    reasoningEfforts: think.efforts,
    modalities: {
      input: strings(model.modalities?.input),
      output: strings(model.modalities?.output),
    },
    knowledge: text(model.knowledge),
    releaseDate: text(model.release_date),
  };
}
/** 每次返回新对象：调用方会写入界面用的字段，共享同一份 EMPTY 会污染其他行。 */
const empty = (): ModelMetadata => describe("none", null, false, null, false);

function rangeOf(list: Occurrence[]): PriceRange | null {
  const prices = list
    .map((entry) => money(entry.model.cost?.input))
    .filter((value): value is number => value !== null);
  return prices.length
    ? {
        min: Math.min(...prices),
        max: Math.max(...prices),
        providers: prices.length,
      }
    : null;
}

/**
 * 第三方托管的同名模型连窗口都不同（990 个跨 provider 同名模型中 479 个 context 不同），
 * 逐字段取众数会拼出一行现实中不存在的配置。改为整体选取认同家数最多的条目，
 * 并列时按 provider id 排序以保证结果稳定；否则同一份缓存两次拉取给出的行会不一致。
 */
function representative(list: Occurrence[]): Occurrence {
  const votes = new Map<string, number>();
  const key = (entry: Occurrence): string =>
    `${positive(entry.model.limit?.context) ?? 0}:${positive(entry.model.limit?.output) ?? 0}`;
  for (const entry of list)
    votes.set(key(entry), (votes.get(key(entry)) ?? 0) + 1);
  const best = [...votes.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]![0];
  return [...list]
    .filter((entry) => key(entry) === best)
    .sort((left, right) => left.providerId.localeCompare(right.providerId))[0]!;
}

export interface CatalogState {
  fetchedAt: number;
  etag: string | null;
  url: string;
  bytes: number;
  providers: number;
  models: number;
}
export interface CatalogStatus extends Partial<CatalogState> {
  enabled: boolean;
  available: boolean;
  stale: boolean;
  ageMs: number | null;
  ttlHours: number;
  path: string;
  error: string | null;
}
export interface CatalogOptions {
  enabled: boolean;
  url: string;
  cacheFile: string;
  ttlHours: number;
  timeoutMs: number;
  allowPrivate?: boolean;
}
export type CatalogOutcome =
  "hit" | "fetched" | "not-modified" | "stale" | "disabled" | "unavailable";
export interface CatalogLoad {
  index: CatalogIndex | null;
  outcome: CatalogOutcome;
  state: CatalogState | null;
  error: string | null;
}

const STATE_KEY = "catalog:models.dev";
const MAX_BYTES = 33_554_432;

export class ModelCatalog {
  #index: CatalogIndex | null = null;
  #indexedAt = 0;
  #inflight: Promise<CatalogLoad> | null = null;
  #lastError: string | null = null;

  constructor(
    private readonly db: Sqlite,
    private readonly options: () => CatalogOptions,
    private readonly fetcher?: typeof fetch,
  ) {}

  #state(): CatalogState | null {
    const state = readAppKv<CatalogState>(this.db, STATE_KEY);
    return state && typeof state.fetchedAt === "number" ? state : null;
  }

  status(): CatalogStatus {
    const options = this.options();
    const state = this.#state();
    const usable = Boolean(state && existsSync(options.cacheFile));
    const ageMs = state ? Math.max(0, Date.now() - state.fetchedAt) : null;
    return {
      ...(state ?? {}),
      enabled: options.enabled,
      available: usable,
      ttlHours: options.ttlHours,
      path: options.cacheFile,
      stale:
        !usable || (ageMs !== null && ageMs > options.ttlHours * 3_600_000),
      ageMs,
      error: this.#lastError,
    };
  }

  /** 并发的两次拉取模型不应各下载一次 3.7MB。 */
  async ensure(force = false): Promise<CatalogLoad> {
    if (this.#inflight) return this.#inflight;
    const task = this.#load(force).finally(() => {
      this.#inflight = null;
    });
    this.#inflight = task;
    return task;
  }

  async #load(force: boolean): Promise<CatalogLoad> {
    const options = this.options();
    if (!options.enabled)
      return { index: null, outcome: "disabled", state: null, error: null };
    const state = this.#state();
    const cached = this.#fromDisk(options.cacheFile, state);
    const ageMs = state
      ? Date.now() - state.fetchedAt
      : Number.POSITIVE_INFINITY;
    const fresh =
      Boolean(cached) &&
      state?.url === options.url &&
      ageMs < options.ttlHours * 3_600_000;
    if (cached && fresh && !force) {
      this.#lastError = null;
      return { index: cached, outcome: "hit", state, error: null };
    }
    try {
      const result = await this.#fetch(
        options,
        cached && state?.url === options.url ? state.etag : null,
      );
      this.#lastError = null;
      if (result.notModified && cached) {
        // 304 只有几百字节：内容未变，将 fetchedAt 前推一格，下一个 TTL 周期内不再出网。
        const next: CatalogState = { ...state!, fetchedAt: Date.now() };
        writeAppKv(this.db, STATE_KEY, next, "catalog");
        return {
          index: cached,
          outcome: "not-modified",
          state: next,
          error: null,
        };
      }
      const index = new CatalogIndex(result.payload!);
      if (!index.providers.size || !index.modelCount)
        throw new Error("目录里没有任何模型条目");
      this.#write(options.cacheFile, result.body!);
      const next: CatalogState = {
        fetchedAt: Date.now(),
        etag: result.etag,
        url: options.url,
        bytes: Buffer.byteLength(result.body!),
        providers: index.providers.size,
        models: index.modelCount,
      };
      writeAppKv(this.db, STATE_KEY, next, "catalog");
      this.#index = index;
      this.#indexedAt = next.fetchedAt;
      return { index, outcome: "fetched", state: next, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastError = message;
      // 出网失败但磁盘上仍有旧副本：降级使用旧副本，不让整个拉取失败。元数据过期几天
      // 远好于运维在缺少窗口与价格的情况下手填一整页。
      return cached
        ? { index: cached, outcome: "stale", state, error: message }
        : { index: null, outcome: "unavailable", state, error: message };
    }
  }

  #fromDisk(path: string, state: CatalogState | null): CatalogIndex | null {
    if (!state || !existsSync(path)) return null;
    try {
      const mtime = statSync(path).mtimeMs;
      if (this.#index && this.#indexedAt === mtime) return this.#index;
      const payload = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        RawProvider
      >;
      const index = new CatalogIndex(payload);
      if (!index.providers.size) return null;
      this.#index = index;
      this.#indexedAt = mtime;
      return index;
    } catch {
      return null;
    }
  }

  async #fetch(
    options: CatalogOptions,
    etag: string | null,
  ): Promise<{
    notModified: boolean;
    etag: string | null;
    body?: string;
    payload?: Record<string, RawProvider>;
  }> {
    let response: GuardedResponse | Response;
    try {
      const init = {
        headers: {
          accept: "application/json",
          "user-agent": "LuoLiCore/0.1",
          ...(etag ? { "if-none-match": etag } : {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      };
      response = this.fetcher
        ? await this.fetcher(options.url, init)
        : await guardedFetch(options.url, init, {
            allowPrivate: options.allowPrivate ?? false,
            maxBytes: MAX_BYTES,
          });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError")
        throw new Error(`models.dev ${options.timeoutMs} ms 内未响应`);
      throw new Error(
        `无法连接 models.dev：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 304) return { notModified: true, etag };
    if (!response.ok) throw new Error(`models.dev 返回 ${response.status}`);
    const body =
      "body" in response && Buffer.isBuffer(response.body)
        ? response.body.toString("utf8")
        : await (response as Response).text();
    if (
      Buffer.byteLength(body) > MAX_BYTES ||
      ("truncated" in response && response.truncated)
    )
      throw new Error("models.dev 返回体超过 32MB，拒绝载入");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("models.dev 返回的不是 JSON");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("models.dev 返回的不是 provider 字典");
    const header =
      response.headers instanceof Headers
        ? response.headers.get("etag")
        : response.headers.etag;
    return {
      notModified: false,
      etag: Array.isArray(header) ? (header[0] ?? null) : (header ?? null),
      body,
      payload: payload as Record<string, RawProvider>,
    };
  }

  #write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    // 先写临时文件再 rename：写到一半被 SIGTERM 打断时，留在磁盘上的会是一份无法解析的 JSON，
    // 此后每次启动都要重新下载 3.7MB。
    try {
      writeFileSync(temporary, body, "utf8");
      renameSync(temporary, path);
    } catch (error) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        /* 清理失败不影响主流程 */
      }
      throw error;
    }
  }

  /**
   * provider 能匹配到 models.dev 条目时用它自报的价格；匹配不上退回厂商官方价；两者都没有时
   * 只给窗口、能力与第三方价区间，价格留空（docs/04 §5.4.1）。
   */
  lookup(
    index: CatalogIndex | null,
    target: { kind: string; baseUrl?: string | null },
    modelId: string,
  ): ModelMetadata {
    if (!index) return empty();
    const trimmed = modelId.trim();
    if (!trimmed) return empty();
    const providerId = index.providerFor(target.kind, target.baseUrl);
    const forms = variants(trimmed);
    const bareForms = forms.flatMap((form) => {
      const [vendor, ...rest] = form.split("/");
      return rest.length && vendor ? [form, rest.join("/")] : [form];
    });
    if (providerId) {
      const provider = index.providers.get(providerId);
      for (const form of forms) {
        const model = provider?.models.get(form);
        if (model)
          return describe(
            "provider",
            { providerId, providerName: provider!.name, modelId: form, model },
            form !== trimmed,
            null,
            priced(model),
          );
      }
    }
    for (const form of bareForms) {
      const [prefix, ...rest] = form.split("/");
      const candidates = rest.length && prefix ? [prefix] : [];
      for (const [vendor] of [
        ...(index.owners.get(rest.length ? rest.join("/") : form) ??
          new Map<string, number>()),
      ].sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      ))
        candidates.push(vendor);
      const bare = rest.length ? rest.join("/") : form;
      for (const vendor of candidates) {
        const provider = index.providers.get(vendor);
        const model = provider?.models.get(bare);
        if (model && priced(model))
          return describe(
            "official",
            {
              providerId: vendor,
              providerName: provider!.name,
              modelId: bare,
              model,
            },
            bare !== trimmed,
            null,
            true,
          );
      }
    }
    for (const form of bareForms) {
      const list = index.occurrences.get(form);
      if (!list?.length) continue;
      // 只有第三方托管价：窗口与能力照常给出，价格留空并给出区间，取任何一家的价格都是猜测。
      return describe(
        "third-party",
        representative(list),
        form !== trimmed,
        rangeOf(list),
        false,
      );
    }
    return empty();
  }
}
