import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import argon2 from "argon2";
import YAML from "yaml";
import {
  PrincipalRepository,
  closeDatabase,
  migrateDatabase,
  openDatabase,
  readPersistedConfig,
  writeConfigRows,
} from "@luoli/db";
import {
  BUILTIN_ALIASES,
  ProviderStore,
  Secrets,
  loadConfig,
  revisionJson,
  type ProviderInput,
} from "@luoli/core";
import { assignDotted, type Role } from "@luoli/shared";
import { MIN_PASSWORD_LENGTH, hashWebuiPassword } from "../passwd.js";

/**
 * `docs/13-acceptance-criteria.md` 顶部「通用前置环境 E1–E6」的铺设脚本。
 *
 * 它写入的内容全部落在 `LUOLI_DATA_DIR` 指向的目录中，缺少该变量时拒绝执行：`loadConfig`
 * 在缺失时会把 `db.path` 解析为 `./data/luoli.db`，那是生产库，且进程持续运行。
 *
 * 配置只向 `config_kv` 写入 schema 中真实存在的叶子键（`webui.host` / `webui.port` /
 * `webui.passwordHash`）：该表的每一行都会被 `loadConfig` 当作配置覆盖层解析，写错一行会导致下次
 * 启动直接失败（docs/19 · R-CFG-01）。铺设完成后会重放一遍覆盖层来验证这一点。
 */

const ACTOR = "acceptance-seed";
const USAGE = `用法：LUOLI_DATA_DIR=<目录> pnpm ac:seed [选项]

必需：
  LUOLI_DATA_DIR=<目录>        铺设目标。db.path 与 media.dir 都跟着它走（config/index.ts 的 envLayer）

选项（命令行 > 环境变量 > 默认值）：
  --force                      目标目录已有 luoli.db 时仍然继续（就地覆盖，见拒绝时打印的清单）
  --owner <id>          ACC_OWNER_ID          默认 8899001
  --trusted <id>        ACC_TRUSTED_ID        默认 8899002
  --limited <id>        ACC_LIMITED_ID        默认 8899003
  --blocked <id>        ACC_BLOCKED_ID        默认 8899004
  --group-trusted=<id>  ACC_GROUP_TRUSTED_ID  默认 -1002000000001
  --group-limited=<id>  ACC_GROUP_LIMITED_ID  默认 -1002000000002
  --group-blocked=<id>  ACC_GROUP_BLOCKED_ID  默认 -1002000000003
                        群 id 是负数，必须用 = 连写：parseArgs 把 \`--group-trusted -901\` 里的
                        -901 当成另一个选项。环境变量那条路没这个问题。
  --password <口令>     WEBUI_PASSWORD        E6 的登录口令，至少 ${MIN_PASSWORD_LENGTH} 位；不给则跳过口令
  --sandbox <docker|none>                     写进生成配置里的主用沙箱模式，默认 docker
  --port <端口>                               WebUI 端口，默认 8788。E6 原文是 8787，而生产实例
                                              占着它 —— 照抄的结果是验收实例 EADDRINUSE 起不来

E4 的 provider 参数只走环境变量（P 换成 1 / 2）：
  LUOLI_MASTER_KEY             缺失则整个 E4 跳过 —— API key 只走加密路径落库，不裸插表
  ACC_P<n>_KIND                openai | anthropic | google | openai-compatible，默认 openai-compatible
  ACC_P<n>_BASE_URL            缺失则建占位，标「要手填」
  ACC_P<n>_API_KEY             缺失则建占位，标「要手填」
  ACC_P<n>_MODEL_{MAIN,HIGH,LOW,VISION}       缺失则建占位模型名，标「要手填」`;

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
const out = (line = ""): void => void process.stdout.write(`${line}\n`);
const pick = (
  flag: string | undefined,
  variable: string,
  fallback: string,
): string => flag ?? process.env[variable] ?? fallback;

interface CliValues {
  help: boolean;
  force: boolean;
  owner?: string;
  trusted?: string;
  limited?: string;
  blocked?: string;
  "group-trusted"?: string;
  "group-limited"?: string;
  "group-blocked"?: string;
  password?: string;
  sandbox?: string;
  port?: string;
}
function parseCli(): CliValues {
  try {
    return parseArgs({
      /**
       * `pnpm ac:seed -- --force` 中的 `--` 被 pnpm 原样转发给脚本，而 `parseArgs` 将其视为
       * 后续全部为位置参数的终止符，导致最常见的写法以
       * ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL 失败，而该脚本唯一的闸正需要 `--force`
       * 才能通过。两种写法都接受。
       */
      args: process.argv.slice(2).filter((token) => token !== "--"),
      options: {
        help: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        owner: { type: "string" },
        trusted: { type: "string" },
        limited: { type: "string" },
        blocked: { type: "string" },
        "group-trusted": { type: "string" },
        "group-limited": { type: "string" },
        "group-blocked": { type: "string" },
        password: { type: "string" },
        sandbox: { type: "string" },
        port: { type: "string" },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    // 直接抛出时运维看到的是 node 内部栈，而不是具体哪个参数有误。
    die(
      `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
  }
}
const values = parseCli();
if (values.help) {
  out(USAGE);
  process.exit(0);
}
const sandboxMode = values.sandbox ?? "docker";
if (sandboxMode !== "docker" && sandboxMode !== "none")
  die(`--sandbox 只能是 docker 或 none，收到 ${sandboxMode}`);
/**
 * E6 的原文是监听 127.0.0.1:8787，而生产实例正占用 8787（验收的前提是它持续运行）。
 * 沿用 8787 的结果不是更贴合验收文档，而是验收实例无法启动（EADDRINUSE），因此默认让开一个端口。
 * 端口取值与任何一条验收判据都无关（`AC-SEC-010` 判定的是是否绑定 0.0.0.0，而非绑定哪个端口）。
 * 需严格按 8787 运行时使用 `--port 8787`，前提是先停止生产实例。
 */
const webuiPort = Number(values.port ?? 8788);
if (!Number.isInteger(webuiPort) || webuiPort < 1 || webuiPort > 65535)
  die(`--port 要是 1..65535 的整数，收到 ${values.port}`);

// ── 闸 1：缺少 LUOLI_DATA_DIR 时一律不执行 ──────────────────────────────────────
const dataDirectory = process.env.LUOLI_DATA_DIR;
if (!dataDirectory)
  die(
    [
      "拒绝运行：没有设 LUOLI_DATA_DIR。",
      "",
      "这个脚本会往库里写 principals / providers / models / model_aliases / config_kv。",
      "缺 LUOLI_DATA_DIR 时 loadConfig 把 db.path 解析成 ./data/luoli.db —— 那是生产库，进程正跑着。",
      "验收环境必须是另一份数据目录：",
      "",
      "  LUOLI_DATA_DIR=/path/to/staging/data-acc pnpm ac:seed",
      "",
      USAGE,
    ].join("\n"),
  );

const config = await loadConfig({ requireOwner: false });
const databasePath = resolve(config.db.path);
// 隔离完全依赖这条 env 覆盖，因此它未生效时不应继续：后续每一条写入都落在该路径下。
if (databasePath !== resolve(dataDirectory, "luoli.db"))
  die(
    `拒绝运行：LUOLI_DATA_DIR=${dataDirectory}，但 loadConfig 交回的 db.path 是 ${databasePath}。\n` +
      "这两个对不上说明 config/index.ts 的 envLayer 没生效，隔离没有保证。",
  );

// ── 闸 2：目标库已存在时需显式传入 --force ──────────────────────────────────────
const reused = existsSync(databasePath);
if (reused && !values.force)
  die(
    [
      `拒绝运行：${databasePath} 已经存在。`,
      "",
      "不带 --force 时这个脚本只往还没有库的目录铺。加上 --force 会在这个库上**就地覆盖**：",
      "  · principals —— 下面这 7 个主体的 role 与 display_name 被改写成本脚本的值",
      "  · providers  —— id 为 acc-p1 / acc-p2 的两行连同 api_key_enc 一起改写",
      "  · models     —— 挂在这两个 provider 名下、不属于本次铺设的行被删除",
      "  · model_aliases —— main / high / low / vision 四条被重新指向本次铺的模型",
      "  · config_kv  —— webui.host / webui.port / webui.passwordHash 被改写（各留一条 config_revisions）",
      "",
      "不会动的：消息、上下文、日志、用量、定时任务、审批。",
      "要的是 E1 那个「空库」的话，自己把这个目录删掉再跑 —— 脚本不替你删数据。",
      "",
      `  LUOLI_DATA_DIR=${dataDirectory} pnpm ac:seed --force`,
    ].join("\n"),
  );

// ── E1：干净部署 + 迁移 ──────────────────────────────────────────────────────────
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
mkdirSync(resolve(config.media.dir), { recursive: true, mode: 0o700 });
const db = openDatabase(databasePath);
// 第三个参数不能省，理由同 `scripts/migrate.ts`：默认值是 `<databasePath>-logs`，而铺完之后
// 进程按 `logs.dbPath`（即 `<dataDirectory>/logs.db`）去读，日志会落在两个文件里。
// `legacyDir` 是上一版那个按天分目录的 `logs/`，`--force` 铺在有存量日志的旧库上时要靠它解引用。
migrateDatabase(db, undefined, {
  path: config.logs.dbPath,
  legacyDir: resolve(dataDirectory, "logs"),
  compress: config.logs.compress,
});

// ── E2 / E3：principals ─────────────────────────────────────────────────────────
interface SeedPrincipal {
  kind: "user" | "chat";
  role: Role;
  tgId: string;
  label: string;
}
const users: SeedPrincipal[] = [
  {
    kind: "user",
    role: "owner",
    tgId: pick(values.owner, "ACC_OWNER_ID", "8899001"),
    label: "AC Owner",
  },
  {
    kind: "user",
    role: "trusted",
    tgId: pick(values.trusted, "ACC_TRUSTED_ID", "8899002"),
    label: "AC Trusted",
  },
  {
    kind: "user",
    role: "limited",
    tgId: pick(values.limited, "ACC_LIMITED_ID", "8899003"),
    label: "AC Limited",
  },
  {
    kind: "user",
    role: "blocked",
    tgId: pick(values.blocked, "ACC_BLOCKED_ID", "8899004"),
    label: "AC Blocked",
  },
];
const groups: SeedPrincipal[] = [
  {
    kind: "chat",
    role: "trusted",
    tgId: pick(
      values["group-trusted"],
      "ACC_GROUP_TRUSTED_ID",
      "-1002000000001",
    ),
    label: "G_TRUSTED",
  },
  {
    kind: "chat",
    role: "limited",
    tgId: pick(
      values["group-limited"],
      "ACC_GROUP_LIMITED_ID",
      "-1002000000002",
    ),
    label: "G_LIMITED",
  },
  {
    kind: "chat",
    role: "blocked",
    tgId: pick(
      values["group-blocked"],
      "ACC_GROUP_BLOCKED_ID",
      "-1002000000003",
    ),
    label: "G_BLOCKED",
  },
];
for (const entry of users)
  if (!/^\d+$/.test(entry.tgId))
    die(
      `用户 id 必须是正整数（Telegram user id），${entry.label} 收到 ${entry.tgId}`,
    );
for (const entry of groups)
  if (!/^-\d+$/.test(entry.tgId))
    die(
      `群 id 必须是负整数（Telegram 群 id），${entry.label} 收到 ${entry.tgId}`,
    );
const everyone = [...users, ...groups];
if (new Set(everyone.map((entry) => `${entry.kind}:${entry.tgId}`)).size !== 7)
  die(
    `七个主体 id 里有重复：${everyone.map((entry) => `${entry.label}=${entry.tgId}`).join(" ")}\n` +
      "重复会让「有效角色 = min(用户角色, 会话角色)」那组用例失去区分度。",
  );

const principals = new PrincipalRepository(db);
principals.ensureOwner(users[0]!.tgId);
for (const entry of everyone) {
  const id = `${entry.kind}:${entry.tgId}`;
  principals.upsertSeen(
    {
      id,
      kind: entry.kind,
      tgId: entry.tgId,
      role: entry.role,
      displayName: entry.label,
      username: null,
      chatType: entry.kind === "chat" ? "supergroup" : null,
    },
    ACTOR,
  );
  // `upsertSeen` 的 ON CONFLICT 刻意不修改 role（避免覆盖手工调整过的角色），因此重跑时由这一句收敛。
  principals.setRole(id, entry.role, ACTOR);
}

// ── E4：两个 provider + 四个别名 ────────────────────────────────────────────────
const masterKey = process.env.LUOLI_MASTER_KEY;
const aliasPlan = [
  {
    alias: "main",
    contextWindow: 200_000,
    maxOutput: 8_192,
    vision: false,
    priceIn: 3,
    priceOut: 15,
  },
  {
    alias: "high",
    contextWindow: 200_000,
    maxOutput: 32_000,
    vision: false,
    priceIn: 15,
    priceOut: 75,
  },
  {
    alias: "low",
    contextWindow: 128_000,
    maxOutput: 8_192,
    vision: false,
    priceIn: 0.25,
    priceOut: 1.25,
  },
  {
    alias: "vision",
    contextWindow: 128_000,
    maxOutput: 8_192,
    vision: true,
    priceIn: 2.5,
    priceOut: 10,
  },
] as const;
const providerPlan = [
  { id: "acc-p1", name: "AC-P1（主）", prefix: "ACC_P1" },
  { id: "acc-p2", name: "AC-P2（备）", prefix: "ACC_P2" },
] as const;

const providerLines: string[] = [];
const aliasLines: string[] = [];
const placeholders: string[] = [];
let e4Skipped: string | null = null;
let modelCount = 0;
let removedModels = 0;

if (!masterKey)
  e4Skipped =
    "缺 LUOLI_MASTER_KEY —— provider 的 API key 只走 Secrets 的加密路径落库，没有主密钥就没有\n" +
    "  能写进 providers.api_key_enc 的东西；裸插一行明文不在选项里。设好这个变量再跑一次即可补上 E4\n" +
    "  （E1–E3、E5、E6 已经铺好，重跑要带 --force）。";
else {
  const store = new ProviderStore(db, new Secrets(masterKey));
  const insertModel = db.prepare(
    `INSERT INTO models(id,provider_id,model_id,display_name,context_window,max_output,capabilities_json,
      price_in,price_out,price_cache_read,price_cache_write,enabled,sort,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
    ON CONFLICT(provider_id,model_id) DO UPDATE SET display_name=excluded.display_name,
      context_window=excluded.context_window,max_output=excluded.max_output,
      capabilities_json=excluded.capabilities_json,price_in=excluded.price_in,price_out=excluded.price_out,
      price_cache_read=excluded.price_cache_read,price_cache_write=excluded.price_cache_write,
      enabled=1,sort=excluded.sort,updated_at=excluded.updated_at`,
  );
  // 落库后按 (provider,model) 回查真实 id：库中可能已存在同名模型行，而该行的 id 是
  // WebUI 生成的随机串。别名链存储的是 `models.id`，指向错误时该别名会在 rebuild 时被静默跳过。
  const findModel = db
    .prepare("SELECT id FROM models WHERE provider_id=? AND model_id=?")
    .pluck();
  const upsertAlias = db.prepare(
    `INSERT INTO model_aliases(alias,model_ids_json,settings_json,description,updated_at) VALUES (?,?,NULL,?,?)
    ON CONFLICT(alias) DO UPDATE SET model_ids_json=excluded.model_ids_json,
      settings_json=excluded.settings_json,description=excluded.description,updated_at=excluded.updated_at`,
  );

  for (const spec of providerPlan) {
    const kind = process.env[`${spec.prefix}_KIND`] ?? "openai-compatible";
    const baseUrl = process.env[`${spec.prefix}_BASE_URL`];
    const apiKey = process.env[`${spec.prefix}_API_KEY`];
    if (!baseUrl) placeholders.push(`${spec.prefix}_BASE_URL`);
    if (!apiKey) placeholders.push(`${spec.prefix}_API_KEY`);
    const effectiveUrl = baseUrl ?? `https://${spec.id}.example.invalid/v1`;
    const effectiveKey = apiKey ?? `PLACEHOLDER-${spec.prefix}-FILL-ME`;
    /**
     * 已是同一把 key 时不重新加密。`Secrets.encrypt` 每次更换 salt 与 iv，无条件重写会使
     * 同一目录重跑两次结果一致这一性质仅在明文层面成立，`api_key_enc` 每次执行都会变化。
     */
    let stored: string | null = null;
    try {
      stored = store.key(spec.id, true);
    } catch {
      stored = null; // 更换主密钥后旧密文无法解开，按不存在处理，下面照常重写。
    }
    const input: ProviderInput = {
      id: spec.id,
      name: spec.name,
      kind,
      baseUrl: effectiveUrl,
      enabled: true,
    };
    if (stored !== effectiveKey) input.apiKey = effectiveKey;
    store.save(input);
    providerLines.push(
      `${spec.id}  ${spec.name}  kind=${kind}  baseUrl=${effectiveUrl}` +
        `  key=${apiKey ? "«来自环境变量»" : "«占位，要手填»"}`,
    );
  }

  const now = Date.now();
  const chains = new Map<string, string[]>();
  const keep: string[] = [];
  db.transaction(() => {
    for (const [index, plan] of aliasPlan.entries()) {
      const chain: string[] = [];
      for (const spec of providerPlan) {
        const variable = `${spec.prefix}_MODEL_${plan.alias.toUpperCase()}`;
        const modelId = process.env[variable];
        if (!modelId) placeholders.push(variable);
        const effectiveId = modelId ?? `acc-placeholder-${plan.alias}`;
        insertModel.run(
          `${spec.id}:${effectiveId}`,
          spec.id,
          effectiveId,
          `${spec.name} · ${plan.alias}`,
          plan.contextWindow,
          plan.maxOutput,
          JSON.stringify({ vision: plan.vision }),
          plan.priceIn,
          plan.priceOut,
          Number((plan.priceIn * 0.1).toFixed(4)),
          Number((plan.priceIn * 1.25).toFixed(4)),
          index,
          now,
          now,
        );
        chain.push(findModel.get(spec.id, effectiveId) as string);
      }
      chains.set(plan.alias, chain);
      keep.push(...chain);
    }
    // 上一次铺设遗留的模型行（修改 ACC_P*_MODEL_* 之后）若不清理会持续保持 enabled=1，
    // 使重跑两次结果一致这一性质不成立。只清理本脚本自身两个 provider 名下的行。
    removedModels = db
      .prepare(
        `DELETE FROM models WHERE provider_id IN (${providerPlan.map(() => "?").join(",")})
         AND id NOT IN (${keep.map(() => "?").join(",")})`,
      )
      .run(...providerPlan.map((spec) => spec.id), ...keep).changes;
    for (const [alias, chain] of chains) {
      const meta = BUILTIN_ALIASES.find((entry) => entry.alias === alias);
      upsertAlias.run(
        alias,
        JSON.stringify(chain),
        meta ? `${meta.purpose}（${meta.tier}）` : null,
        now,
      );
      aliasLines.push(`${alias.padEnd(7)} → ${chain.join(" , ")}`);
    }
  })();
  modelCount = keep.length;
}

// ── E5：沙箱模式，生成两份配置文件，config_kv 中刻意不保留 sandbox.mode ──────────
const dockerBin = config.sandbox.dockerBin;
const probe = (args: string[]): string | null => {
  try {
    return execFileSync(dockerBin, args, {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
};
const dockerVersion = probe(["info", "--format", "{{.ServerVersion}}"]);
const sandboxImage =
  dockerVersion === null
    ? null
    : probe(["image", "inspect", config.sandbox.image, "--format", "{{.Id}}"]);

const sourceConfigPath = resolve(
  process.env.LUOLI_CONFIG ?? "./config/config.yaml",
);
const baseConfig = existsSync(sourceConfigPath)
  ? ((YAML.parse(readFileSync(sourceConfigPath, "utf8")) as Record<
      string,
      unknown
    > | null) ?? {})
  : {};
const generatedConfigs = new Map<string, string>();
for (const mode of ["docker", "none"] as const) {
  const draft = structuredClone(baseConfig);
  assignDotted(draft, "sandbox.mode", mode);
  // 这六个默认值相对 cwd 解析，不跟随 LUOLI_DATA_DIR。保留默认值会使验收环境把工作区、
  // 记忆库、日志、模型目录缓存以及生成的 skill 与 plugin 写回仓库中的生产目录，
  // 隔离范围将只剩 db 与附件。skills 与 plugins 两条尤为关键：验收中包含新建、编辑、删除
  // Skill 这类条目，不修改则这些步骤会直接改动仓库中随包发布的目录树。
  assignDotted(
    draft,
    "sandbox.workspaceDir",
    resolve(dataDirectory, "workspace"),
  );
  assignDotted(draft, "memory.dir", resolve(dataDirectory, "memory"));
  assignDotted(draft, "logs.dbPath", resolve(dataDirectory, "logs.db"));
  assignDotted(draft, "skills.dir", resolve(dataDirectory, "skills"));
  assignDotted(draft, "plugins.dir", resolve(dataDirectory, "plugins"));
  // 端口在文件层同样写入一份。生效值由 config_kv 中的那一行决定（覆盖层优先于文件层），
  // 但两处数值不同会使实际监听端口必须先理解三层合并规则才能判断。
  assignDotted(draft, "webui.host", "127.0.0.1");
  assignDotted(draft, "webui.port", webuiPort);
  assignDotted(
    draft,
    "provider.catalog.cacheFile",
    resolve(dataDirectory, "cache/models.dev.json"),
  );
  const target = resolve(dataDirectory, `config.sandbox-${mode}.yaml`);
  writeFileSync(
    target,
    `# 由 pnpm ac:seed 从 ${sourceConfigPath} 生成（E5）。手改会在下次铺设时被覆盖。\n` +
      `# 用法：LUOLI_CONFIG=${target} LUOLI_DATA_DIR=${dataDirectory} pnpm dev\n` +
      YAML.stringify(draft),
    { mode: 0o600 },
  );
  generatedConfigs.set(mode, target);
}
// 没有 "logs"：日志是 `<dataDirectory>/logs.db` 一个文件，由 `openDatabase` 自己建目录（docs/10 §3）。
for (const sub of ["workspace", "memory", "cache", "plugins"])
  mkdirSync(resolve(dataDirectory, sub), { recursive: true, mode: 0o700 });
// 随包 skill 必须实际存在于磁盘，`BUNDLED_SKILLS` 只是一份名称清单：指向空目录时扩展页为空，
// 随包 skill 只放行启停这类条目将没有验证对象。仅在目标不存在时复制：重跑（含 `--force`）
// 不覆盖验收过程中修改的目录树，否则中途重新铺设会清除现场。
const skillsTarget = resolve(dataDirectory, "skills");
const skillsSource = resolve(process.cwd(), "skills");
let skillsCopied = false;
if (!existsSync(skillsTarget)) {
  if (existsSync(skillsSource)) {
    cpSync(skillsSource, skillsTarget, { recursive: true });
    skillsCopied = true;
  } else mkdirSync(skillsTarget, { recursive: true, mode: 0o700 });
}

// ── E6：WebUI 口令与监听地址 ────────────────────────────────────────────────────
// 空串按未设置处理：`envPinnedConfigKeys` 判断环境变量同样按真值进行，一个 `WEBUI_PASSWORD=` 不应
// 使整个铺设过程因口令过短而中止。
const password = (values.password ?? process.env.WEBUI_PASSWORD) || undefined;
if (password !== undefined && password.length < MIN_PASSWORD_LENGTH)
  die(`WebUI 口令至少 ${MIN_PASSWORD_LENGTH} 位，收到 ${password.length} 位。`);
const configEntries: Array<[string, unknown]> = [
  ["webui.host", "127.0.0.1"],
  ["webui.port", webuiPort],
];
let passwordState: string;
if (!password)
  passwordState =
    "跳过 —— 没给 --password 也没有 WEBUI_PASSWORD。webui.passwordHash 保持原样，" +
    "绑在 127.0.0.1 上仍能起（非回环地址会被 schema 拒绝启动）";
else {
  const existing = db
    .prepare("SELECT value_json FROM config_kv WHERE key='webui.passwordHash'")
    .pluck()
    .get() as string | undefined;
  let unchanged = false;
  if (existing)
    try {
      unchanged = await argon2.verify(JSON.parse(existing) as string, password);
    } catch {
      unchanged = false;
    }
  if (unchanged)
    passwordState =
      "已是同一个口令，保留原哈希（argon2 每次换盐，无条件重写会让重跑结果不一致）";
  else {
    configEntries.push([
      "webui.passwordHash",
      await hashWebuiPassword(password),
    ]);
    passwordState =
      "已写入 webui.passwordHash（argon2id，与 pnpm webui:passwd 同一组参数）";
  }
}
/**
 * 值未变化的键不写入。`writeConfigRows` 是配置写入的唯一出口，它对每一条 entry 都记录一行
 * `config_revisions`（无论值是否变化）：无条件写入会使每次 `--force` 重跑都向变更历史插入两条
 * 值未变的记录，而该历史是运维事后追溯配置修改来源的依据。
 */
const storedValue = db
  .prepare("SELECT value_json FROM config_kv WHERE key=?")
  .pluck();
const changedEntries = configEntries.filter(
  ([key, value]) => storedValue.get(key) !== JSON.stringify(value),
);
if (changedEntries.length)
  writeConfigRows(db, changedEntries, ACTOR, revisionJson);
closeDatabase(db);

// ── 验证：重放刚写入的覆盖层 ───────────────────────────────────────────────────
const rejectedKeys: string[] = [];
const droppedKeys: string[] = [];
await loadConfig({
  overrides: readPersistedConfig(databasePath, (key) => rejectedKeys.push(key)),
  requireOwner: false,
  onInvalidOverride: (keys) => droppedKeys.push(...keys),
});
if (rejectedKeys.length || droppedKeys.length)
  die(
    `铺设写出了 config_kv 里不合法的键：${[...rejectedKeys, ...droppedKeys].join(", ")}\n` +
      "这会让下次 loadConfig 逐条剔除它们（甚至拒绝启动）。脚本有 bug，别拿这份环境验收。",
  );

// ── 清单 ────────────────────────────────────────────────────────────────────────
const check = (ok: boolean, warn = false): string =>
  ok ? "✅" : warn ? "⚠️" : "❌";
out();
out("## 验收环境铺设结果（`pnpm ac:seed`）");
out();
out(
  `- 数据目录：\`${dataDirectory}\`${reused ? "（--force，就地覆盖）" : "（新建）"}`,
);
out(`- 数据库：\`${databasePath}\`（已迁移）`);
out(`- 附件目录：\`${resolve(config.media.dir)}\``);
out();
out("| 前置 | 状态 | 说明 |");
out("|---|---|---|");
out(
  `| E1 干净部署、已迁移 | ${check(true)} | ${reused ? "复用既有库并就地覆盖" : "新建空库并迁移"} |`,
);
out(
  `| E2 四个 user 主体 | ${check(true)} | ${users.map((u) => `${u.role}=${u.tgId}`).join(" · ")} |`,
);
out(
  `| E3 三个群主体 | ${check(true)} | ${groups.map((g) => `${g.label}(${g.role})=${g.tgId}`).join(" · ")} |`,
);
out(
  `| E4 两个 provider + 四别名 | ${check(e4Skipped === null, e4Skipped !== null)} | ` +
    (e4Skipped
      ? "已跳过，见下"
      : `providers 2 · models ${modelCount} · aliases ${aliasLines.length}（均有 price_in/price_out）` +
        (placeholders.length ? ` · ${placeholders.length} 项占位待手填` : "")) +
    " |",
);
out(
  `| E5 sandbox.mode | ${check(dockerVersion !== null && sandboxImage !== null, true)} | ` +
    `docker ${dockerVersion ? `可用（server ${dockerVersion}）` : `不可用（\`${dockerBin} info\` 失败）`}` +
    `，镜像 \`${config.sandbox.image}\` ${sandboxImage ? "在" : "不在"} |`,
);
out(
  `| E6 WebUI | ${check(Boolean(password), !password)} | 监听 127.0.0.1:${webuiPort}${webuiPort === 8787 ? "" : "（E6 原文是 8787，让开生产那一格；--port 可改）"}；口令：${password ? "已设" : "未设"} |`,
);
out();
out("### principals（7 行）");
out("```");
for (const entry of everyone)
  out(
    `${`${entry.kind}:${entry.tgId}`.padEnd(24)} ${entry.role.padEnd(8)} ${entry.label}`,
  );
out("```");
out();
out("### providers / 别名");
if (e4Skipped) {
  out(`E4 未铺设：${e4Skipped}`);
} else {
  out("```");
  for (const line of providerLines) out(line);
  out("");
  for (const line of aliasLines) out(line);
  if (removedModels)
    out(`\n（顺带清掉 ${removedModels} 行上一次铺设遗留的模型）`);
  out("```");
  if (placeholders.length) {
    out();
    out(
      `**要手填**（没给就建了占位，真发请求会失败）：\`${placeholders.join("` `")}\``,
    );
  }
  out();
  out(
    "未铺设：`title` / `embed` 两个内建别名 —— E4 只点名了 `main`/`high`/`low`/`vision`。",
  );
}
out();
out("### E5 的两套配置");
out("```");
for (const [mode, path] of generatedConfigs)
  out(
    `${mode.padEnd(7)} LUOLI_CONFIG=${path} LUOLI_DATA_DIR=${dataDirectory} pnpm dev`,
  );
out("```");
out(
  `主用 \`sandbox.mode=${sandboxMode}\`。**\`config_kv\` 里刻意没有 \`sandbox.mode\` 这一行** —— ` +
    "覆盖层压在文件层之上，写进去这两个文件就都不算数了。",
);
out(
  skillsCopied
    ? `\`skills.dir\` 指到 \`${skillsTarget}\`，随包那棵树已从 \`${skillsSource}\` 复制过来 —— ` +
        "验收里的新建 / 编辑 / 删除 Skill 从此改的是这一份，不是仓库那份。"
    : `\`skills.dir\` 指到 \`${skillsTarget}\`（已存在，**没有覆盖**：重跑不抹掉验收现场）。`,
);
out();
out("### E6");
out(`口令：${passwordState}`);
if (process.env.WEBUI_PASSWORD)
  out(
    "注意：环境里有 `WEBUI_PASSWORD`，`apps/bot` 的 `envOverlay` 每次启动都会用它重算哈希并压过 " +
      "`config_kv`（docs/11 §1）。跑验收时要么让它和这里设的是同一个口令，要么从环境里删掉它。",
  );
if (process.env.LUOLI_WEBUI_HOST)
  out(
    `注意：环境里有 \`LUOLI_WEBUI_HOST=${process.env.LUOLI_WEBUI_HOST}\`，它钉死 \`webui.host\`，` +
      "刚写下的 `127.0.0.1` 不会生效（E6 要求监听 127.0.0.1）。",
  );
out();
