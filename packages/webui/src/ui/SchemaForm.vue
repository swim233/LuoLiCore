<script setup lang="ts">
// 由 `config.schema.json` 自动生成的配置表单（docs/09 §3.13、docs/21 §1.1）。
// 153 个已接线叶子里此前只有 15 个能在界面上改，其余只能停机改 YAML；手写上百个控件必然漂移，
// 正路是消费 `GET /api/config/schema` 已经备好的 `{schema, hotReloadable, unimplemented}` 三件套。
// 每一项的作用说明也走 schema 的 `description`（core 的 `CONFIG_DESCRIPTIONS` 注入），同样不在这里抄第二份。
import { computed, ref, watch } from "vue";
import UiButton from "./UiButton.vue";
import UiTag from "./UiTag.vue";
import UiSelect from "./UiSelect.vue";
import UiNumber from "./UiNumber.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSwitch from "./UiSwitch.vue";
import type { TagSeverity } from "./types";

const props = withDefaults(
  defineProps<{
    schema: Record<string, unknown> | null;
    value: Record<string, unknown>;
    hotReloadable: string[];
    unimplemented: string[];
    saving: boolean;
    /** 只渲染这些前缀下的叶子（会话级覆盖白名单）。不裁剪 schema 文档本身：裁掉 `access`
     *  这类分支会让 `memory.pubWriteMinRole` 这种指向它的 `$ref` 无法解析。 */
    include?: readonly string[];
    /** 被环境变量钉住的键：写得进 config_kv，但 env 层会在加载时盖回去，所以这里只展示不给改。 */
    envPinned?: ReadonlyArray<{ key: string; env: string }>;
    /** 逐个取值的说明（core 的 `CONFIG_ENUM_NOTES`）：一格里的取值不等价时，光有键的说明不够。 */
    enumNotes?: Record<string, Record<string, string>>;
    notes?: Record<string, string>;
    saveLabel?: string;
  }>(),
  {
    include: undefined,
    envPinned: () => [],
    enumNotes: () => ({}),
    notes: () => ({}),
    saveLabel: "保存",
  },
);
const emit = defineEmits<{ save: [Record<string, unknown>] }>();

type FieldKind =
  | "boolean"
  | "number"
  | "enum"
  | "string"
  | "stringList"
  | "multiEnum"
  | "json";
interface Field {
  path: string;
  group: string;
  label: string;
  kind: FieldKind;
  enumValues: string[];
  itemHint: string;
  min: number | null;
  exclusiveMin: boolean;
  max: number | null;
  integer: boolean;
  nullable: boolean;
  defaultValue: unknown;
  hot: boolean;
  wired: boolean;
  readOnly: boolean;
  secret: boolean;
  pinnedEnv: string | null;
  description: string;
  note: string;
  optionNotes: Record<string, string>;
}
type Node = Record<string, unknown>;

/** `perChat` 是覆盖层容器不是配置项（docs/21 §1）；它的编辑入口在会话页。 */
const SKIP_PATHS = new Set(["perChat"]);
/** 有专用面板的键：这里照样能改，但得说清楚哪儿有更好的入口，否则两处都改会互相覆盖。 */
const DEDICATED: Record<string, string> = {
  trigger: "设置页上方有专用面板",
  output: "设置页上方有专用面板",
  quota: "「配额」页有专用面板",
  sandbox: "工具页有沙箱卡片",
  "tools.overrides": "工具页可逐项启停；在此写入会覆盖逐项开关",
  "agent.agents": "Agent 页有专用编辑器",
  "mcp.servers": "扩展页有 MCP 表单：不脱敏，可改 env / headers 密钥",
  "approval.rules": "写入时校验字段与正则；写错则审批不生效",
};
const SECRET_SEGMENT = /key|secret|token|password/i;
const REDACTED = "«redacted»";
/**
 * 真正只读的密钥字段。密钥曾整体只读，代价是 `tools.web.searchApiKey` 在 WebUI 里无法配置，
 * 而 `web_search` 的 `available()` 要求 provider 与 key 同时有值，于是可写的
 * `tools.web.searchProvider` 成为一个无效开关（选中后也不会有工具进入目录）。现在密钥改为只写：
 * 不回显，留空表示不修改。只有这一项保持只读：它需要的是 argon2 哈希而不是明文口令，
 * 在这里输入明文会导致无法登录，改口令走设置页那个表单。
 */
const READ_ONLY_PATHS = new Set(["webui.passwordHash"]);

function resolve(document_: Node, node: Node): Node {
  const reference = node.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/")) return node;
  let cursor: unknown = document_;
  for (const segment of reference.slice(2).split("/"))
    cursor = (cursor as Node)?.[segment];
  return resolve(document_, (cursor ?? {}) as Node);
}
const dotted = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (cursor, key) =>
        cursor && typeof cursor === "object"
          ? (cursor as Node)[key]
          : undefined,
      value,
    );
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * `raw` 必须是未解析的那个节点：zodToJsonSchema 对复用的 zod 实例生成 `$ref`，并把 `default`
 * 与注入的 `description` 放在 `$ref` 的同级位置。跟随 `$ref` 后再读，取到的是被指向那个键的值：
 * `quota.perChat.daily` 会显示为默认 5（实际值 1），`memory.pubWriteMinRole` 显示为
 * 默认 blocked（实际值 trusted），说明文字也会串成同一句。
 */
function classify(document_: Node, raw: Node, path: string): Field {
  const node = resolve(document_, raw);
  const anyOf = Array.isArray(node.anyOf)
    ? node.anyOf.map((entry) => resolve(document_, entry as Node))
    : null;
  // 可空数字在 schema 里是 anyOf[number, null]（配额的「不限」）：取非 null 的那一支，留空即 null。
  const primary = anyOf
    ? (anyOf.find((entry) => entry.type !== "null") ?? {})
    : node;
  const type = String(primary.type ?? "");
  const items = primary.items
    ? resolve(document_, primary.items as Node)
    : null;
  const enumValues = Array.isArray(primary.enum)
    ? primary.enum.map(String)
    : [];
  const itemEnum =
    items && Array.isArray(items.enum) ? items.enum.map(String) : [];
  // 取值受限的数组（`telegram.allowedUpdates`）渲染成一组复选框而不是文本框：那里能填的名字是
  // Telegram 定死的一张表，让运维自己回忆拼写等于把 `getUpdates` 400（表现为「一条消息都收不到」）
  // 留在保存成功之后。带 enum 的数组一律走这条路，不是给某个键开的特例。
  const kind: FieldKind =
    type === "boolean"
      ? "boolean"
      : enumValues.length
        ? "enum"
        : type === "integer" || type === "number"
          ? "number"
          : type === "array"
            ? itemEnum.length
              ? "multiEnum"
              : items?.type === "string"
                ? "stringList"
                : "json"
            : type === "string"
              ? "string"
              : "json";
  const segments = path.split(".");
  return {
    path,
    group: segments[0] ?? path,
    label: segments.slice(1).join(".") || path,
    kind,
    enumValues: kind === "multiEnum" ? itemEnum : enumValues,
    // 复选框自己就把可选值列全了，再重复一遍只会把说明挤下去。
    itemHint:
      itemEnum.length && kind !== "multiEnum"
        ? `可选值：${itemEnum.join(" / ")}`
        : "",
    min:
      typeof primary.minimum === "number"
        ? primary.minimum
        : typeof primary.exclusiveMinimum === "number"
          ? primary.exclusiveMinimum
          : null,
    exclusiveMin:
      typeof primary.minimum !== "number" &&
      typeof primary.exclusiveMinimum === "number",
    max: typeof primary.maximum === "number" ? primary.maximum : null,
    integer: type === "integer",
    nullable: Boolean(anyOf?.some((entry) => entry.type === "null")),
    defaultValue: "default" in raw ? raw.default : node.default,
    hot: props.hotReloadable.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}.`),
    ),
    wired: !props.unimplemented.includes(path),
    readOnly: READ_ONLY_PATHS.has(path),
    // 密钥字段在 `GET /api/config` 里已经是 «redacted»：不回显、只写，避免用字面量覆盖真值。
    secret:
      kind === "string" &&
      !READ_ONLY_PATHS.has(path) &&
      segments.some((segment) => SECRET_SEGMENT.test(segment)),
    pinnedEnv: props.envPinned.find((entry) => entry.key === path)?.env ?? null,
    description: text(raw.description) || text(node.description),
    note: props.notes[path] ?? DEDICATED[path] ?? "",
    optionNotes: props.enumNotes[path] ?? {},
  };
}

const root = computed<Node>(() =>
  props.schema ? resolve(props.schema, props.schema) : {},
);
const fields = computed<Field[]>(() => {
  const document_ = props.schema;
  if (!document_) return [];
  const out: Field[] = [];
  const walk = (node: Node, path: string): void => {
    const resolved = resolve(document_, node);
    if (path && SKIP_PATHS.has(path)) return;
    // 有 properties 的 object 才继续往下走；`additionalProperties` 型的 record（tools.overrides、
    // byRole）没有固定键，只能整块当 JSON 编辑。
    if (resolved.type === "object" && resolved.properties) {
      for (const [key, child] of Object.entries(resolved.properties as Node))
        walk(child as Node, path ? `${path}.${key}` : key);
      return;
    }
    if (!path) return;
    if (
      props.include &&
      !props.include.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}.`),
      )
    )
      return;
    out.push(classify(document_, node, path));
  };
  walk(root.value, "");
  return out;
});
/** 分组抬头那句话来自顶层节点自己的 `description`，跟每一格的说明同源。 */
const groupNote = (name: string): string =>
  text(
    ((root.value.properties as Node | undefined)?.[name] as Node | undefined)
      ?.description,
  );

/** 控件里显示的文本：JSON 与字符串数组都以文本编辑，避免每敲一个字就得是合法 JSON。 */
function display(field: Field, value: unknown): unknown {
  // 密钥一律不回显（服务端给的本来就是 «redacted»）：空 = 不改，输入了才提交。
  if (field.secret) return "";
  // multiEnum 与 stringList 共用「一行一条的文本」这个内部表示：`changed` 是拿 `!==` 跟基线比的，
  // 数组每次重建都是新引用，那样每一格都会永远显示「待保存」。
  if (field.kind === "stringList" || field.kind === "multiEnum")
    return (Array.isArray(value) ? value : []).join("\n");
  if (field.kind === "json")
    return JSON.stringify(value ?? field.defaultValue ?? null, null, 2);
  if (field.kind === "boolean") return value === true;
  if (field.kind === "number") return typeof value === "number" ? value : null;
  return value === null || value === undefined ? "" : String(value);
}
const draft = ref<Record<string, unknown>>({});
const pristine = ref<Record<string, unknown>>({});
/** 显式「清空这个密钥」：密钥字段留空的语义是不改，所以清空得单独记一笔。 */
const cleared = ref(new Set<string>());
const openGroups = ref(new Set<string>());
const search = ref("");
const hotOnly = ref(false);
const showUnwired = ref(false);
const nonDefaultOnly = ref(false);

/** 外部刷新（`config.changed`）不能冲掉正在编辑的格子：只回写没动过的那些。 */
function sync(): void {
  const next: Record<string, unknown> = { ...draft.value };
  const server: Record<string, unknown> = {};
  for (const field of fields.value) {
    server[field.path] = display(field, dotted(props.value, field.path));
    if (
      !(field.path in next) ||
      next[field.path] === pristine.value[field.path]
    )
      next[field.path] = server[field.path];
  }
  draft.value = next;
  pristine.value = server;
}
watch(() => [props.schema, props.value] as const, sync, {
  immediate: true,
  deep: true,
});

const changed = computed(() =>
  fields.value.filter(
    (field) =>
      cleared.value.has(field.path) ||
      (field.path in draft.value &&
        draft.value[field.path] !== pristine.value[field.path]),
  ),
);
const secretSet = (field: Field): boolean => {
  const value = dotted(props.value, field.path);
  return value === REDACTED || (typeof value === "string" && value.length > 0);
};
function clearSecret(field: Field): void {
  const next = new Set(cleared.value);
  next.add(field.path);
  cleared.value = next;
  draft.value = { ...draft.value, [field.path]: "" };
}
function keepSecret(field: Field): void {
  const next = new Set(cleared.value);
  next.delete(field.path);
  cleared.value = next;
}
const changedPaths = computed(
  () => new Set(changed.value.map((field) => field.path)),
);
/**
 * 该部署实际改过哪些配置：当前值不等于 schema 的 `default`。实测一个真实部署 243 个叶子里只有 21 个
 * 偏离默认值，而在此之前界面上给不出这一结论：原始 YAML 给出的是覆盖层而不是差异集
 * （专用面板保存时整组写回，`config_kv` 里大半行的值与默认值相同）。
 *
 * 两处判定不出时不标记，理由不是保守而是避免给出错误结论：`defaultValue` 取的是 `classify` 里那个
 * 未解析节点上的值（跟随 `$ref` 会取到被指向那个键的默认值，`memory.pubWriteMinRole` 会在未被修改时
 * 被标为非默认）；值本身缺失时同理，那说明这份 value 不完整，而不是被修改过。
 * 它与待保存是两件事：待保存表示本次编辑尚未提交，非默认表示已生效的值不是代码默认值。
 */
function isNonDefault(field: Field): boolean {
  if (field.defaultValue === undefined) return false;
  const current = dotted(props.value, field.path);
  if (current === undefined) return false;
  return JSON.stringify(current) !== JSON.stringify(field.defaultValue);
}
const nonDefaultPaths = computed(
  () => new Set(fields.value.filter(isNonDefault).map((field) => field.path)),
);
const nonDefaultCount = computed(() => nonDefaultPaths.value.size);
const matches = (field: Field): boolean => {
  const needle = search.value.trim().toLowerCase();
  // 说明文字一并参与匹配：运维记得住「沙箱」「防秒回」，记不住 sandbox.pidsLimit 这种键名。
  if (
    needle &&
    !field.path.toLowerCase().includes(needle) &&
    !field.description.toLowerCase().includes(needle)
  )
    return false;
  if (hotOnly.value && !field.hot) return false;
  // 正在编辑的格子不能被这个筛选吞掉：改到一半勾上「只看非默认值」，那一格连同未保存的值一起消失，
  // 而 `changed` 仍然算着它 —— 保存按钮说有 1 项改动，页面上却找不到是哪一项。
  if (
    nonDefaultOnly.value &&
    !nonDefaultPaths.value.has(field.path) &&
    !changedPaths.value.has(field.path)
  )
    return false;
  // 未接线的键默认藏起来：它们连控件都是禁用的，混在里面只会让人以为改得动。
  return field.wired || showUnwired.value;
};
const groups = computed(() => {
  const grouped = new Map<string, Field[]>();
  for (const field of fields.value) {
    if (!matches(field)) continue;
    grouped.set(field.group, [...(grouped.get(field.group) ?? []), field]);
  }
  return [...grouped].map(([name, entries]) => ({
    name,
    entries,
    note: groupNote(name),
    dirty: entries.filter((field) => changedPaths.value.has(field.path)).length,
    nonDefault: entries.filter((field) => nonDefaultPaths.value.has(field.path))
      .length,
  }));
});
const hidden = computed(
  () =>
    fields.value.length -
    groups.value.reduce((sum, group) => sum + group.entries.length, 0),
);
// 筛选后仍需展开八个分组才能看到结果，该筛选即无实际作用，因此搜索与只看非默认值都自动展开。
watch(search, (needle) => {
  if (needle.trim())
    openGroups.value = new Set(groups.value.map((group) => group.name));
});
watch(nonDefaultOnly, (on) => {
  if (on) openGroups.value = new Set(groups.value.map((group) => group.name));
});
function toggleGroup(name: string): void {
  const next = new Set(openGroups.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  openGroups.value = next;
}
const allOpen = computed(
  () =>
    Boolean(groups.value.length) &&
    groups.value.every((group) => openGroups.value.has(group.name)),
);
function toggleAll(): void {
  openGroups.value = allOpen.value
    ? new Set()
    : new Set(groups.value.map((group) => group.name));
}
function update(field: Field, value: unknown): void {
  if (field.secret && String(value)) keepSecret(field);
  draft.value = { ...draft.value, [field.path]: value };
}
// 模板里不能写 `as string | null`：编译器把那个 `|` 当成 Vue 2 的 filter 管道（vue/no-deprecated-filter）。
const asText = (path: string): string => String(draft.value[path] ?? "");
const asOption = (path: string): string | null => {
  const value = draft.value[path];
  return value === null || value === undefined ? null : String(value);
};
const asNumber = (path: string): number | null => {
  const value = draft.value[path];
  return typeof value === "number" ? value : null;
};
const asList = (path: string): string[] =>
  String(draft.value[path] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
/** 勾选结果按 schema 里 enum 的顺序重建，而不是按点击顺序：否则两次勾选同一组会得到两个不同的数组，
 *  而是否修改过是按字符串比较的。 */
function toggleOption(field: Field, option: string, on: boolean): void {
  const chosen = new Set(asList(field.path));
  if (on) chosen.add(option);
  else chosen.delete(option);
  update(
    field,
    field.enumValues.filter((value) => chosen.has(value)).join("\n"),
  );
}
function reset(): void {
  draft.value = { ...pristine.value };
  cleared.value = new Set();
}

const badge = (
  field: Field,
): { label: string; severity: TagSeverity; hint: string } =>
  field.pinnedEnv
    ? {
        label: "环境变量锁定",
        severity: "info",
        hint: `值由 ${field.pinnedEnv} 决定，此处不可编辑`,
      }
    : !field.wired
      ? {
          label: "未接线",
          severity: "secondary",
          hint: "可写入，运行时无代码读取",
        }
      : field.hot
        ? { label: "热更新", severity: "success", hint: "保存即生效，无需重启" }
        : {
            label: "需重启",
            severity: "warn",
            hint: "已写入 config_kv，进程重启后生效",
          };
/** 默认值只是一行脚注：`tools.fs.denyGlobs` 那种九条 glob 的数组原样铺出来会盖过说明本身。 */
function defaultText(field: Field): string {
  if (field.defaultValue === undefined) return "无默认值";
  if (field.defaultValue === null)
    return field.nullable ? "默认不限" : "默认 null";
  if (field.kind === "stringList") {
    const count = Array.isArray(field.defaultValue)
      ? field.defaultValue.length
      : 0;
    return count ? `默认 ${count} 条` : "默认为空";
  }
  const literal =
    typeof field.defaultValue === "object"
      ? JSON.stringify(field.defaultValue)
      : String(field.defaultValue);
  return `默认 ${literal.length > 48 ? `${literal.slice(0, 48)}…` : literal}`;
}
function rangeText(field: Field): string {
  if (field.kind !== "number") return "";
  const parts = [field.integer ? "整数" : "小数"];
  if (field.min !== null)
    parts.push(`${field.exclusiveMin ? ">" : "≥"} ${field.min}`);
  if (field.max !== null) parts.push(`≤ ${field.max}`);
  if (field.nullable) parts.push("留空 = 不限");
  return parts.join(" · ");
}

/** 保存前在本地把能挡的挡住：JSON 敲错、必填数字被清空，发过去只会拿回一条 zod 报错，
 *  而报错里的 path 未必对得上界面上是哪一格。 */
const problems = computed(() =>
  changed.value.flatMap((field) => {
    const value = draft.value[field.path];
    // 整块 JSON 里可能嵌着 «redacted»（`mcp.servers` 的 env / headers），原样发回去等于把真密钥
    // 换成这五个字。这种字段只能去专用面板改。
    if (
      (field.kind === "json" || field.kind === "stringList") &&
      String(value).includes(REDACTED)
    )
      return [`${field.path}：含 «redacted»，保存会以字面量覆盖真值`];
    if (field.kind === "json") {
      try {
        JSON.parse(String(value));
        return [];
      } catch {
        return [`${field.path}：不是合法 JSON`];
      }
    }
    if (field.kind === "number" && value === null && !field.nullable)
      return [`${field.path}：该项不能留空`];
    return [];
  }),
);
function toValue(field: Field, value: unknown): unknown {
  if (field.secret) return cleared.value.has(field.path) ? "" : String(value);
  if (field.kind === "stringList" || field.kind === "multiEnum")
    return String(value)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  if (field.kind === "json") return JSON.parse(String(value));
  if (field.kind === "number") return value === null ? null : Number(value);
  if (field.kind === "enum") return value === "" ? null : value;
  return value;
}
function save(): void {
  if (problems.value.length) return;
  emit(
    "save",
    Object.fromEntries(
      changed.value.map((field) => [
        field.path,
        toValue(field, draft.value[field.path]),
      ]),
    ),
  );
}
/** 保存成功后由父组件调用。写入落库是同步的，但 bot 进程要等 `config.changed` 才重新 loadConfig()，
 *  紧接着的那次 `GET /api/config` 可能还是旧值 —— 不把基线推上去，保存完按钮还挂着「保存 1 项改动」。 */
function commit(paths: string[]): void {
  const next = { ...pristine.value };
  const stillCleared = new Set(cleared.value);
  const secrets = new Set(
    fields.value.filter((field) => field.secret).map((field) => field.path),
  );
  for (const path of paths) {
    stillCleared.delete(path);
    // 密钥字段的基线恒为空（不回显），提交完把输入框清掉，否则密钥会一直挂在 DOM 里。
    if (secrets.has(path)) {
      next[path] = "";
      draft.value = { ...draft.value, [path]: "" };
      continue;
    }
    if (path in draft.value) next[path] = draft.value[path];
  }
  cleared.value = stillCleared;
  pristine.value = next;
}
defineExpose({ commit });
</script>

<template>
  <div class="schema-form">
    <div class="schema-toolbar">
      <label class="search grow"
        ><i class="pi pi-search" /><input
          v-model="search"
          placeholder="搜索键名或说明"
      /></label>
      <UiCheckbox
        v-model="nonDefaultOnly"
        :label="`只看非默认值（${nonDefaultCount}）`"
        title="当前值与代码默认值不同的项。无默认值的叶子不计入"
      />
      <UiCheckbox v-model="hotOnly" label="只看热更新项" />
      <UiCheckbox v-model="showUnwired" label="显示未接线项" />
      <!-- 三个按钮收成一组：工具栏是 flex-wrap，散着放时窄屏上「保存」会自己掉到第二行最左边，
           读成一个跟上面无关的孤立按钮。成组之后它们整体换行并仍然靠右。 -->
      <span class="schema-toolbar-actions">
        <UiButton
          variant="text"
          size="small"
          :icon="allOpen ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
          :label="allOpen ? '全部收起' : '全部展开'"
          :disabled="!groups.length"
          @click="toggleAll"
        />
        <UiButton
          variant="text"
          size="small"
          label="放弃改动"
          :disabled="!changed.length || saving"
          @click="reset"
        />
        <UiButton
          icon="pi pi-save"
          :label="
            changed.length ? `${saveLabel} ${changed.length} 项` : '没有改动'
          "
          :disabled="!changed.length || Boolean(problems.length)"
          :loading="saving"
          @click="save"
        />
      </span>
    </div>
    <p v-if="problems.length" class="callout error">
      <i class="pi pi-exclamation-triangle" />{{ problems.join("；") }}
    </p>
    <p class="section-note">
      共 {{ fields.length }} 个 schema 叶子，<b>{{ nonDefaultCount }}</b>
      项非默认值<span v-if="hidden">，筛掉 {{ hidden }} 个</span>。写入走
      <code>PUT /api/config</code>，<b>仅提交实际变更的项</b>。
    </p>
    <section
      v-for="group in groups"
      :key="group.name"
      class="schema-group"
      :class="{ open: openGroups.has(group.name) }"
    >
      <button
        type="button"
        class="schema-group-head"
        :aria-expanded="openGroups.has(group.name)"
        @click="toggleGroup(group.name)"
      >
        <i class="pi pi-chevron-right caret" aria-hidden="true" />
        <b>{{ group.name }}</b>
        <small v-if="group.note">{{ group.note }}</small>
        <UiTag
          v-if="group.dirty"
          :value="`${group.dirty} 项待保存`"
          severity="warn"
        />
        <span v-if="group.nonDefault" class="count nd" title="本组非默认值项数"
          >{{ group.nonDefault }} 项非默认</span
        >
        <span class="count">{{ group.entries.length }} 项</span>
      </button>
      <div v-if="openGroups.has(group.name)" class="schema-fields">
        <!-- multiEnum 与 boolean 一样不能包在 `<label>` 里：里面每个复选框自带 `<label>`，
             嵌套之后点哪一格都可能落到第一个控件上。 -->
        <component
          :is="
            field.kind === 'boolean' || field.kind === 'multiEnum'
              ? 'div'
              : 'label'
          "
          v-for="field in group.entries"
          :key="field.path"
          :class="[
            'schema-field',
            {
              dirty: changedPaths.has(field.path),
              nondefault: nonDefaultPaths.has(field.path),
              off: !field.wired,
              wide:
                field.kind === 'json' ||
                field.kind === 'stringList' ||
                field.kind === 'multiEnum',
            },
          ]"
        >
          <span class="schema-key"
            ><code
              ><span v-if="field.label !== field.path" class="prefix"
                >{{ field.group }}.</span
              >{{ field.label }}</code
            ><UiTag
              :value="badge(field).label"
              :severity="badge(field).severity"
              :title="badge(field).hint"
          /></span>
          <p v-if="field.description" class="schema-desc">
            {{ field.description }}
          </p>
          <template v-if="field.pinnedEnv">
            <input
              :value="String(display(field, dotted(value, field.path)))"
              disabled
            />
            <small class="field-note"
              >值由环境变量
              <code>{{ field.pinnedEnv }}</code>
              决定，修改需更新该变量并重启。</small
            >
          </template>
          <template v-else-if="field.readOnly">
            <input
              :value="
                String(dotted(value, field.path) ? '«已设置»' : '«未设置»')
              "
              disabled
            />
            <small class="field-note"
              >需 argon2 哈希，不是明文口令。改口令用上方「修改登录口令」，或
              <code>pnpm webui:passwd</code> 后写入
              <code>config.yaml</code>。</small
            >
          </template>
          <template v-else-if="field.secret">
            <span class="secret-row">
              <input
                :value="asText(field.path)"
                type="password"
                autocomplete="off"
                spellcheck="false"
                :placeholder="
                  cleared.has(field.path)
                    ? '保存后清空'
                    : secretSet(field)
                      ? '已设置，留空表示不改'
                      : '未设置'
                "
                :disabled="!field.wired"
                @input="
                  update(field, ($event.target as HTMLInputElement).value)
                "
              />
              <UiButton
                v-if="secretSet(field) && !cleared.has(field.path)"
                variant="text"
                size="small"
                severity="danger"
                label="清空"
                :disabled="!field.wired"
                @click="clearSecret(field)"
              />
              <UiButton
                v-else-if="cleared.has(field.path)"
                variant="text"
                size="small"
                label="撤销清空"
                @click="keepSecret(field)"
              />
            </span>
            <small class="field-note"
              >只写字段：不回显，留空表示不改。支持
              <code>${env:NAME}</code>
              引用。</small
            >
          </template>
          <div v-else-if="field.kind === 'multiEnum'" class="enum-choices">
            <UiCheckbox
              v-for="option in field.enumValues"
              :key="option"
              :model-value="asList(field.path).includes(option)"
              :disabled="!field.wired"
              @update:model-value="toggleOption(field, option, $event)"
            >
              <code>{{ option }}</code
              ><small v-if="field.optionNotes[option]">{{
                field.optionNotes[option]
              }}</small>
            </UiCheckbox>
          </div>
          <textarea
            v-else-if="field.kind === 'json' || field.kind === 'stringList'"
            :value="asText(field.path)"
            :disabled="!field.wired"
            :rows="field.kind === 'json' ? 6 : 3"
            spellcheck="false"
            @input="update(field, ($event.target as HTMLTextAreaElement).value)"
          />
          <UiSwitch
            v-else-if="field.kind === 'boolean'"
            :model-value="draft[field.path] === true"
            :disabled="!field.wired"
            on-label="已开启"
            off-label="已关闭"
            @update:model-value="update(field, $event)"
          />
          <UiSelect
            v-else-if="field.kind === 'enum'"
            :model-value="asOption(field.path)"
            :options="field.enumValues"
            :disabled="!field.wired"
            @update:model-value="update(field, $event)"
          />
          <UiNumber
            v-else-if="field.kind === 'number'"
            :model-value="asNumber(field.path)"
            :disabled="!field.wired"
            :step="field.integer ? 1 : 0.01"
            @update:model-value="update(field, $event)"
          />
          <input
            v-else
            :value="asText(field.path)"
            :disabled="!field.wired"
            @input="update(field, ($event.target as HTMLInputElement).value)"
          />
          <small class="field-note">
            {{ defaultText(field)
            }}<template v-if="rangeText(field)">
              · {{ rangeText(field) }}</template
            ><template v-if="field.itemHint"> · {{ field.itemHint }}</template>
            <template v-if="field.kind === 'stringList'"> · 一行一条</template>
            <template v-if="field.note"> · {{ field.note }}</template>
          </small>
        </component>
      </div>
    </section>
    <p v-if="!groups.length" class="empty-card">
      <i class="pi pi-filter-slash" aria-hidden="true" /> 暂无匹配
    </p>
  </div>
</template>
