<script setup lang="ts">
// 由 `config.schema.json` 自动生成的配置表单（docs/09 §3.13、docs/21 §1.1）。
// 153 个已接线叶子里此前只有 15 个能在界面上改，其余只能停机改 YAML；手写上百个控件必然漂移，
// 正路是消费 `GET /api/config/schema` 已经备好的 `{schema, hotReloadable, unimplemented}` 三件套。
// 每一项的作用说明也走 schema 的 `description`（core 的 `CONFIG_DESCRIPTIONS` 注入），同样不在这里抄第二份。
import { computed, ref, watch } from 'vue';
import UiButton from './UiButton.vue';
import UiTag from './UiTag.vue';
import UiSelect from './UiSelect.vue';
import UiNumber from './UiNumber.vue';
import UiCheckbox from './UiCheckbox.vue';
import UiSwitch from './UiSwitch.vue';
import type { TagSeverity } from './types';

const props = withDefaults(defineProps<{
  schema: Record<string, unknown> | null; value: Record<string, unknown>; hotReloadable: string[]; unimplemented: string[]; saving: boolean;
  /** 只渲染这些前缀下的叶子（会话级覆盖白名单）。**不裁剪 schema 文档本身** —— 裁掉 `access`
   *  之类的分支会让 `memory.pubWriteMinRole` 那种指过去的 `$ref` 解析不到。 */
  include?: readonly string[];
  notes?: Record<string, string>;
  saveLabel?: string;
}>(), { include: undefined, notes: () => ({}), saveLabel: '保存' });
const emit = defineEmits<{ save: [Record<string, unknown>] }>();

type FieldKind = 'boolean' | 'number' | 'enum' | 'string' | 'stringList' | 'json';
interface Field {
  path: string; group: string; label: string; kind: FieldKind; enumValues: string[]; itemHint: string;
  min: number | null; exclusiveMin: boolean; max: number | null; integer: boolean; nullable: boolean;
  defaultValue: unknown; hot: boolean; wired: boolean; readOnly: boolean; description: string; note: string;
}
type Node = Record<string, unknown>;

/** `perChat` 是覆盖层容器不是配置项（docs/21 §1）；它的编辑入口在会话页。 */
const SKIP_PATHS = new Set(['perChat']);
/** 有专用面板的键：这里照样能改，但得说清楚哪儿有更好的入口，否则两处都改会互相覆盖。 */
const DEDICATED: Record<string, string> = {
  trigger: '设置页上方有专用面板（带唤醒词可用性校验）', output: '设置页上方有专用面板',
  quota: '「配额」页有专用面板，还能看实时计数器', sandbox: '工具页有沙箱卡片，还能探测可用性',
  'tools.overrides': '工具页可逐个启停', 'agent.agents': 'Agent 页有专用编辑器',
};
const SECRET_SEGMENT = /key|secret|token|password/i;
const REDACTED = '«redacted»';

function resolve(document_: Node, node: Node): Node {
  const reference = node.$ref;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return node;
  let cursor: unknown = document_;
  for (const segment of reference.slice(2).split('/')) cursor = (cursor as Node)?.[segment];
  return resolve(document_, (cursor ?? {}) as Node);
}
const dotted = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>((cursor, key) => (cursor && typeof cursor === 'object' ? (cursor as Node)[key] : undefined), value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * `raw` 必须是**未解析**的那个节点：zodToJsonSchema 对复用的 zod 实例发 `$ref`，并把 `default`
 * 与（我们注入的）`description` 放在 `$ref` 的兄弟位置。跟着 `$ref` 走再读，拿到的是被指向的那个键
 * 的值 —— `quota.perChat.daily` 会显示成「默认 5」（真值 1），`memory.pubWriteMinRole` 显示成
 * 「默认 blocked」（真值 trusted），说明文字也会串成同一句。
 */
function classify(document_: Node, raw: Node, path: string): Field {
  const node = resolve(document_, raw);
  const anyOf = Array.isArray(node.anyOf) ? node.anyOf.map((entry) => resolve(document_, entry as Node)) : null;
  // 可空数字在 schema 里是 anyOf[number, null]（配额的「不限」）：取非 null 的那一支，留空即 null。
  const primary = anyOf ? anyOf.find((entry) => entry.type !== 'null') ?? {} : node;
  const type = String(primary.type ?? '');
  const items = primary.items ? resolve(document_, primary.items as Node) : null;
  const enumValues = Array.isArray(primary.enum) ? primary.enum.map(String) : [];
  const itemEnum = items && Array.isArray(items.enum) ? items.enum.map(String) : [];
  const kind: FieldKind = type === 'boolean' ? 'boolean'
    : enumValues.length ? 'enum'
      : type === 'integer' || type === 'number' ? 'number'
        : type === 'array' ? (items?.type === 'string' ? 'stringList' : 'json')
          : type === 'string' ? 'string' : 'json';
  const current = dotted(props.value, path);
  const segments = path.split('.');
  return {
    path, group: segments[0] ?? path, label: segments.slice(1).join('.') || path, kind, enumValues,
    itemHint: itemEnum.length ? `可选值：${itemEnum.join(' / ')}` : '',
    min: typeof primary.minimum === 'number' ? primary.minimum : typeof primary.exclusiveMinimum === 'number' ? primary.exclusiveMinimum : null,
    exclusiveMin: typeof primary.minimum !== 'number' && typeof primary.exclusiveMinimum === 'number',
    max: typeof primary.maximum === 'number' ? primary.maximum : null,
    integer: type === 'integer', nullable: Boolean(anyOf?.some((entry) => entry.type === 'null')),
    defaultValue: 'default' in raw ? raw.default : node.default,
    hot: props.hotReloadable.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)),
    wired: !props.unimplemented.includes(path),
    // 密钥字段在 `GET /api/config` 里已经是 «redacted»，把它写回去等于用字面量覆盖真值。
    readOnly: current === REDACTED || (kind === 'string' && segments.some((segment) => SECRET_SEGMENT.test(segment))),
    description: text(raw.description) || text(node.description),
    note: props.notes[path] ?? DEDICATED[path] ?? '',
  };
}

const root = computed<Node>(() => (props.schema ? resolve(props.schema, props.schema) : {}));
const fields = computed<Field[]>(() => {
  const document_ = props.schema;
  if (!document_) return [];
  const out: Field[] = [];
  const walk = (node: Node, path: string): void => {
    const resolved = resolve(document_, node);
    if (path && SKIP_PATHS.has(path)) return;
    // 有 properties 的 object 才继续往下走；`additionalProperties` 型的 record（tools.overrides、
    // byRole）没有固定键，只能整块当 JSON 编辑。
    if (resolved.type === 'object' && resolved.properties) {
      for (const [key, child] of Object.entries(resolved.properties as Node)) walk(child as Node, path ? `${path}.${key}` : key);
      return;
    }
    if (!path) return;
    if (props.include && !props.include.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) return;
    out.push(classify(document_, node, path));
  };
  walk(root.value, '');
  return out;
});
/** 分组抬头那句话来自顶层节点自己的 `description`，跟每一格的说明同源。 */
const groupNote = (name: string): string => text((((root.value.properties as Node | undefined)?.[name]) as Node | undefined)?.description);

/** 控件里显示的文本：JSON 与字符串数组都以文本编辑，避免每敲一个字就得是合法 JSON。 */
function display(field: Field, value: unknown): unknown {
  if (field.kind === 'stringList') return (Array.isArray(value) ? value : []).join('\n');
  if (field.kind === 'json') return JSON.stringify(value ?? (field.defaultValue ?? null), null, 2);
  if (field.kind === 'boolean') return value === true;
  if (field.kind === 'number') return typeof value === 'number' ? value : null;
  return value === null || value === undefined ? '' : String(value);
}
const draft = ref<Record<string, unknown>>({});
const pristine = ref<Record<string, unknown>>({});
const openGroups = ref(new Set<string>());
const search = ref('');
const hotOnly = ref(false);
const showUnwired = ref(false);

/** 外部刷新（`config.changed`）不能冲掉正在编辑的格子：只回写没动过的那些。 */
function sync(): void {
  const next: Record<string, unknown> = { ...draft.value };
  const server: Record<string, unknown> = {};
  for (const field of fields.value) {
    server[field.path] = display(field, dotted(props.value, field.path));
    if (!(field.path in next) || next[field.path] === pristine.value[field.path]) next[field.path] = server[field.path];
  }
  draft.value = next;
  pristine.value = server;
}
watch(() => [props.schema, props.value] as const, sync, { immediate: true, deep: true });

const changed = computed(() => fields.value.filter((field) => field.path in draft.value && draft.value[field.path] !== pristine.value[field.path]));
const changedPaths = computed(() => new Set(changed.value.map((field) => field.path)));
const matches = (field: Field): boolean => {
  const needle = search.value.trim().toLowerCase();
  // 说明文字一并参与匹配：运维记得住「沙箱」「防秒回」，记不住 sandbox.pidsLimit 这种键名。
  if (needle && !field.path.toLowerCase().includes(needle) && !field.description.toLowerCase().includes(needle)) return false;
  if (hotOnly.value && !field.hot) return false;
  // 未接线的键默认藏起来：它们连控件都是禁用的，混在里面只会让人以为改得动。
  return field.wired || showUnwired.value;
};
const groups = computed(() => {
  const grouped = new Map<string, Field[]>();
  for (const field of fields.value) {
    if (!matches(field)) continue;
    grouped.set(field.group, [...(grouped.get(field.group) ?? []), field]);
  }
  return [...grouped].map(([name, entries]) => ({ name, entries, note: groupNote(name), dirty: entries.filter((field) => changedPaths.value.has(field.path)).length }));
});
const hidden = computed(() => fields.value.length - groups.value.reduce((sum, group) => sum + group.entries.length, 0));
watch(search, (needle) => { if (needle.trim()) openGroups.value = new Set(groups.value.map((group) => group.name)); });
function toggleGroup(name: string): void {
  const next = new Set(openGroups.value);
  if (next.has(name)) next.delete(name); else next.add(name);
  openGroups.value = next;
}
const allOpen = computed(() => Boolean(groups.value.length) && groups.value.every((group) => openGroups.value.has(group.name)));
function toggleAll(): void { openGroups.value = allOpen.value ? new Set() : new Set(groups.value.map((group) => group.name)); }
function update(field: Field, value: unknown): void { draft.value = { ...draft.value, [field.path]: value }; }
// 模板里不能写 `as string | null`：编译器把那个 `|` 当成 Vue 2 的 filter 管道（vue/no-deprecated-filter）。
const asText = (path: string): string => String(draft.value[path] ?? '');
const asOption = (path: string): string | null => { const value = draft.value[path]; return value === null || value === undefined ? null : String(value); };
const asNumber = (path: string): number | null => { const value = draft.value[path]; return typeof value === 'number' ? value : null; };
function reset(): void { draft.value = { ...pristine.value }; }

const badge = (field: Field): { label: string; severity: TagSeverity; hint: string } => (!field.wired
  ? { label: '未接线', severity: 'secondary', hint: '在 KNOWN_UNIMPLEMENTED_CONFIG_KEYS 里：存得下，运行时没有任何代码读它' }
  : field.hot ? { label: '热更新', severity: 'success', hint: '保存即生效，无需重启' }
    : { label: '需重启', severity: 'warn', hint: '写进 config_kv 了，但运行时要重启才会读到新值' });
/** 默认值只是一行脚注：`tools.fs.denyGlobs` 那种九条 glob 的数组原样铺出来会盖过说明本身。 */
function defaultText(field: Field): string {
  if (field.defaultValue === undefined) return '无默认值';
  if (field.defaultValue === null) return field.nullable ? '默认不限' : '默认 null';
  if (field.kind === 'stringList') { const count = Array.isArray(field.defaultValue) ? field.defaultValue.length : 0; return count ? `默认 ${count} 条` : '默认为空'; }
  const literal = typeof field.defaultValue === 'object' ? JSON.stringify(field.defaultValue) : String(field.defaultValue);
  return `默认 ${literal.length > 48 ? `${literal.slice(0, 48)}…` : literal}`;
}
function rangeText(field: Field): string {
  if (field.kind !== 'number') return '';
  const parts = [field.integer ? '整数' : '小数'];
  if (field.min !== null) parts.push(`${field.exclusiveMin ? '>' : '≥'} ${field.min}`);
  if (field.max !== null) parts.push(`≤ ${field.max}`);
  if (field.nullable) parts.push('留空 = 不限');
  return parts.join(' · ');
}

/** 保存前在本地把能挡的挡住：JSON 敲错、必填数字被清空，发过去只会拿回一条 zod 报错，
 *  而报错里的 path 未必对得上界面上是哪一格。 */
const problems = computed(() => changed.value.flatMap((field) => {
  const value = draft.value[field.path];
  if (field.kind === 'json') { try { JSON.parse(String(value)); return []; } catch { return [`${field.path}：不是合法 JSON`]; } }
  if (field.kind === 'number' && value === null && !field.nullable) return [`${field.path}：这一项不能留空`];
  return [];
}));
function toValue(field: Field, value: unknown): unknown {
  if (field.kind === 'stringList') return String(value).split('\n').map((line) => line.trim()).filter(Boolean);
  if (field.kind === 'json') return JSON.parse(String(value));
  if (field.kind === 'number') return value === null ? null : Number(value);
  if (field.kind === 'enum') return value === '' ? null : value;
  return value;
}
function save(): void {
  if (problems.value.length) return;
  emit('save', Object.fromEntries(changed.value.map((field) => [field.path, toValue(field, draft.value[field.path])])));
}
/** 保存成功后由父组件调用。写入落库是同步的，但 bot 进程要等 `config.changed` 才重新 loadConfig()，
 *  紧接着的那次 `GET /api/config` 可能还是旧值 —— 不把基线推上去，保存完按钮还挂着「保存 1 项改动」。 */
function commit(paths: string[]): void {
  const next = { ...pristine.value };
  for (const path of paths) if (path in draft.value) next[path] = draft.value[path];
  pristine.value = next;
}
defineExpose({ commit });
</script>

<template>
  <div class="schema-form">
    <div class="schema-toolbar">
      <label class="search grow"><i class="pi pi-search" /><input v-model="search" placeholder="搜键名或说明，例如 沙箱、防秒回、logs."></label>
      <UiCheckbox v-model="hotOnly" label="只看热更新项" />
      <UiCheckbox v-model="showUnwired" label="显示未接线项" />
      <UiButton variant="text" size="small" :icon="allOpen ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" :label="allOpen ? '全部收起' : '全部展开'" :disabled="!groups.length" @click="toggleAll" />
      <UiButton variant="text" size="small" label="放弃改动" :disabled="!changed.length || saving" @click="reset" />
      <UiButton icon="pi pi-save" :label="changed.length ? `${saveLabel} ${changed.length} 项` : '没有改动'" :disabled="!changed.length || Boolean(problems.length)" :loading="saving" @click="save" />
    </div>
    <p v-if="problems.length" class="callout error"><i class="pi pi-exclamation-triangle" />{{ problems.join('；') }}</p>
    <p class="section-note">
      共 {{ fields.length }} 个 schema 叶子<span v-if="hidden">，当前筛掉 {{ hidden }} 个</span>；每格的说明来自 schema 的 <code>description</code>
      （唯一来源是 core 的 <code>CONFIG_DESCRIPTIONS</code>）。写入走 <code>PUT /api/config</code> 的点分键，整体过一次
      <code>configSchema</code> 校验后落 <code>config_kv</code> + <code>config_revisions</code>；<b>只发真正改过的那几项</b>。
    </p>
    <section v-for="group in groups" :key="group.name" class="schema-group" :class="{ open: openGroups.has(group.name) }">
      <button type="button" class="schema-group-head" :aria-expanded="openGroups.has(group.name)" @click="toggleGroup(group.name)">
        <i class="pi pi-chevron-right caret" aria-hidden="true" />
        <b>{{ group.name }}</b>
        <small v-if="group.note">{{ group.note }}</small>
        <UiTag v-if="group.dirty" :value="`${group.dirty} 项待保存`" severity="warn" />
        <span class="count">{{ group.entries.length }} 项</span>
      </button>
      <div v-if="openGroups.has(group.name)" class="schema-fields">
        <component :is="field.kind === 'boolean' ? 'div' : 'label'" v-for="field in group.entries" :key="field.path"
          :class="['schema-field', { dirty: changedPaths.has(field.path), off: !field.wired, wide: field.kind === 'json' || field.kind === 'stringList' }]">
          <span class="schema-key"><code><span v-if="field.label !== field.path" class="prefix">{{ field.group }}.</span>{{ field.label }}</code><UiTag :value="badge(field).label" :severity="badge(field).severity" :title="badge(field).hint" /></span>
          <p v-if="field.description" class="schema-desc">{{ field.description }}</p>
          <template v-if="field.readOnly">
            <input :value="String(display(field, dotted(value, field.path)))" disabled>
            <small class="field-note">密钥字段不在这里改：Provider 的 key 在模型页、WebUI 口令用 <code>pnpm webui:passwd</code>、其余走环境变量。</small>
          </template>
          <textarea v-else-if="field.kind === 'json' || field.kind === 'stringList'" :value="asText(field.path)" :disabled="!field.wired" :rows="field.kind === 'json' ? 6 : 3" spellcheck="false" @input="update(field, ($event.target as HTMLTextAreaElement).value)" />
          <UiSwitch v-else-if="field.kind === 'boolean'" :model-value="draft[field.path] === true" :disabled="!field.wired"
            on-label="已开启" off-label="已关闭" @update:model-value="update(field, $event)" />
          <UiSelect v-else-if="field.kind === 'enum'" :model-value="asOption(field.path)" :options="field.enumValues" :disabled="!field.wired" @update:model-value="update(field, $event)" />
          <UiNumber v-else-if="field.kind === 'number'" :model-value="asNumber(field.path)" :disabled="!field.wired" :step="field.integer ? 1 : 0.01" @update:model-value="update(field, $event)" />
          <input v-else :value="asText(field.path)" :disabled="!field.wired" @input="update(field, ($event.target as HTMLInputElement).value)">
          <small class="field-note">
            {{ defaultText(field) }}<template v-if="rangeText(field)"> · {{ rangeText(field) }}</template><template v-if="field.itemHint"> · {{ field.itemHint }}</template>
            <template v-if="field.kind === 'stringList'"> · 一行一条</template>
            <template v-if="field.note"> · {{ field.note }}</template>
          </small>
        </component>
      </div>
    </section>
    <p v-if="!groups.length" class="empty-card"><i class="pi pi-filter-slash" aria-hidden="true" /> 没有匹配的配置项。</p>
  </div>
</template>
