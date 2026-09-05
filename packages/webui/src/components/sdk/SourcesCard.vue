<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiTag from "../../ui/UiTag.vue";
import UiModal from "../../ui/UiModal.vue";
import DataGrid from "../../ui/DataGrid.vue";
import { pushToast, toastError } from "../../ui/toast";
import { askConfirm } from "../../ui/confirm";
import { api } from "../../api/client";
import {
  disabledState,
  issueDisabledReason,
  KEY_COLUMNS,
  SOURCE_COLUMNS,
  SOURCE_KIND_LABELS,
  SOURCE_KIND_SEVERITY,
  type ApiKeyRow,
  type SourceRow,
} from "./types";

/**
 * SDK 来源与密钥（docs/12-sdk.md T3.11）。单张卡管完两个实体：来源本身只有「列出 / 新建」两个动作，
 * 密钥管理挂在点开的来源详情弹窗里，不值得为此再拆一张独立的卡（同 `TasksCard` 把列表、详情、
 * 全部写操作放在一个文件里的先例）。
 *
 * 普通 `<script setup>`，不 `return` 任何东西（docs/24 · R-UI-01）。
 */

// ── 来源列表 ──────────────────────────────────────────────────────────────────
const sources = ref<SourceRow[]>([]);
const sourcesLoading = ref(false);

/** 归一化而不是直接赋值：形状不匹配的响应不应使整页在 DataGrid 的 rows 上崩溃（docs/24 · R-UI-01）。 */
async function reloadSources(): Promise<void> {
  sourcesLoading.value = true;
  try {
    const result = await api<{ sources?: SourceRow[] }>("/api/sdk/sources");
    sources.value = Array.isArray(result?.sources) ? result.sources : [];
  } catch (error) {
    toastError("加载来源失败", error);
  } finally {
    sourcesLoading.value = false;
  }
}

// ── 新建来源：只填名称，id 由服务端生成（A3） ──────────────────────────────────
const createDialog = ref(false);
const createName = ref("");
const creating = ref(false);
function openCreateDialog(): void {
  createName.value = "";
  createDialog.value = true;
}
async function createSource(): Promise<void> {
  if (!createName.value.trim()) return;
  creating.value = true;
  try {
    const result = await api<{ source: SourceRow }>("/api/sdk/sources", {
      method: "POST",
      body: JSON.stringify({ name: createName.value.trim() }),
    });
    pushToast({
      severity: "success",
      summary: `来源「${result.source.name}」已创建`,
    });
    createDialog.value = false;
    await reloadSources();
  } catch (error) {
    toastError("新建来源失败", error);
  } finally {
    creating.value = false;
  }
}

// ── 密钥：点一行来源打开详情弹窗，签发 / 回显 / 停用都在弹窗里完成 ──────────────
const keysDialog = ref(false);
const selectedSource = ref<SourceRow | null>(null);
const keys = ref<ApiKeyRow[]>([]);
const keysLoading = ref(false);
const keysModalTitle = computed(() =>
  selectedSource.value ? `密钥 · ${selectedSource.value.name}` : "密钥",
);

async function loadKeys(sourceId: string): Promise<void> {
  keysLoading.value = true;
  try {
    const result = await api<{ keys?: ApiKeyRow[] }>(
      `/api/sdk/sources/${encodeURIComponent(sourceId)}/keys`,
    );
    keys.value = Array.isArray(result?.keys) ? result.keys : [];
  } catch (error) {
    toastError("加载密钥列表失败", error);
    keys.value = [];
  } finally {
    keysLoading.value = false;
  }
}
async function openKeys(source: SourceRow): Promise<void> {
  selectedSource.value = source;
  revealedToken.value = "";
  issueForm.value = { label: "", expiresAt: "" };
  keysDialog.value = true;
  await loadKeys(source.id);
}

// ── 签发密钥：label / 过期时间均可选 ─────────────────────────────────────────
interface IssueForm {
  label: string;
  /** `<input type="datetime-local">` 的本地墙钟字符串，提交前转毫秒时间戳。 */
  expiresAt: string;
}
const issueForm = ref<IssueForm>({ label: "", expiresAt: "" });
const issuing = ref(false);
const issueReason = computed(() => issueDisabledReason(selectedSource.value));
/** 过期时间选择器的下限：服务端要求晚于当前时间（`invalid_expires_at`），此处提前拦一道。 */
const nowLocal = computed(() => toLocalInputValue(Date.now()));
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function issueKey(): Promise<void> {
  const source = selectedSource.value;
  if (!source || issueReason.value) return;
  issuing.value = true;
  try {
    const body: { label?: string; expiresAt?: number } = {};
    const label = issueForm.value.label.trim();
    if (label) body.label = label;
    if (issueForm.value.expiresAt)
      body.expiresAt = new Date(issueForm.value.expiresAt).getTime();
    const result = await api<{ token: string; key: ApiKeyRow }>(
      `/api/sdk/sources/${encodeURIComponent(source.id)}/keys`,
      { method: "POST", body: JSON.stringify(body) },
    );
    revealedToken.value = result.token;
    issueForm.value = { label: "", expiresAt: "" };
    pushToast({ severity: "success", summary: "密钥已签发" });
    await loadKeys(source.id);
  } catch (error) {
    toastError("签发密钥失败", error);
  } finally {
    issuing.value = false;
  }
}

// ── 回显：二次确认之后才请求 /reveal，明文只在这一块显示一次 ────────────────────
const revealedToken = ref("");
const revealBusy = ref("");
function revealKey(key: ApiKeyRow): void {
  askConfirm(
    `回显密钥 ${key.id}？`,
    "此次回显会被记录，明文仅显示一次。",
    async () => {
      revealBusy.value = key.id;
      try {
        const result = await api<{ token: string }>(
          `/api/sdk/keys/${encodeURIComponent(key.id)}/reveal`,
        );
        revealedToken.value = result.token;
        pushToast({ severity: "success", summary: "密钥已回显" });
      } catch (error) {
        toastError("回显失败", error);
      } finally {
        revealBusy.value = "";
      }
    },
  );
}

// ── 停用：软停用留行，无法撤销 ──────────────────────────────────────────────
const disableBusy = ref("");
function disableKey(key: ApiKeyRow): void {
  askConfirm(
    `停用密钥 ${key.id}？`,
    "该密钥立即失效，无法撤销。",
    async () => {
      disableBusy.value = key.id;
      try {
        await api(`/api/sdk/keys/${encodeURIComponent(key.id)}`, {
          method: "DELETE",
        });
        pushToast({ severity: "success", summary: "密钥已停用" });
        if (selectedSource.value) await loadKeys(selectedSource.value.id);
      } catch (error) {
        toastError("停用密钥失败", error);
      } finally {
        disableBusy.value = "";
      }
    },
  );
}

onMounted(() => {
  void reloadSources();
});
</script>

<template>
  <article class="surface">
    <div class="registry-heading">
      <div><h3>来源</h3><p class="section-note">Telegram 内建一行，其余为第三方接入。点击一行管理密钥。</p></div>
      <UiButton icon="pi pi-plus" label="新建来源" @click="openCreateDialog" />
    </div>
    <DataGrid
      :rows="sources"
      :columns="SOURCE_COLUMNS"
      data-key="id"
      clickable
      :loading="sourcesLoading"
      empty="暂无来源"
      @row-click="openKeys"
    >
      <template #kind="{ data }"
        ><UiTag
          :value="SOURCE_KIND_LABELS[data.kind as SourceRow['kind']]"
          :severity="SOURCE_KIND_SEVERITY[data.kind as SourceRow['kind']]"
      /></template>
      <template #state="{ data }"
        ><UiTag
          :value="disabledState(data.disabledAt).label"
          :severity="disabledState(data.disabledAt).severity"
      /></template>
      <template #createdAt="{ data }"
        ><time>{{ new Date(Number(data.createdAt)).toLocaleString() }}</time></template
      >
    </DataGrid>

    <UiModal
      v-model:visible="createDialog"
      title="新建来源"
      width="min(480px, 94vw)"
    >
      <div class="form-grid">
        <label class="wide"
          >名称<input
            v-model="createName"
            type="text"
            maxlength="64"
            placeholder="来源名称"
            @keyup.enter="createSource"
        /></label>
      </div>
      <template #footer>
        <UiButton variant="text" label="取消" @click="createDialog = false" />
        <UiButton
          label="创建"
          :loading="creating"
          :disabled="!createName.trim()"
          @click="createSource"
        />
      </template>
    </UiModal>

    <UiModal
      v-model:visible="keysDialog"
      :title="keysModalTitle"
      width="min(920px, 96vw)"
    >
      <template v-if="selectedSource">
        <div class="detail-summary">
          <span
            ><small>类型</small
            ><UiTag
              :value="SOURCE_KIND_LABELS[selectedSource.kind]"
              :severity="SOURCE_KIND_SEVERITY[selectedSource.kind]"
          /></span>
          <span
            ><small>状态</small
            ><UiTag
              :value="disabledState(selectedSource.disabledAt).label"
              :severity="disabledState(selectedSource.disabledAt).severity"
          /></span>
          <span
            ><small>创建</small
            ><b>{{ new Date(selectedSource.createdAt).toLocaleString() }}</b></span
          >
        </div>

        <div v-if="revealedToken" class="callout warn">
          <i class="pi pi-key" aria-hidden="true" /><code>{{ revealedToken }}</code
          >仅显示一次，关闭后不再展示。
          <UiButton
            size="small"
            variant="text"
            label="关闭"
            @click="revealedToken = ''"
          />
        </div>

        <div class="form-grid">
          <label
            >备注<input
              v-model="issueForm.label"
              type="text"
              maxlength="200"
              placeholder="可选"
          /></label>
          <label
            >过期时间<input
              v-model="issueForm.expiresAt"
              type="datetime-local"
              :min="nowLocal"
          /></label>
          <p v-if="issueReason" class="field-note wide">{{ issueReason }}</p>
          <div class="wide section-actions">
            <UiButton
              label="签发密钥"
              :loading="issuing"
              :disabled="Boolean(issueReason)"
              :title="issueReason || undefined"
              @click="issueKey"
            />
          </div>
        </div>

        <DataGrid
          :rows="keys"
          :columns="KEY_COLUMNS"
          data-key="id"
          :loading="keysLoading"
          empty="暂无密钥"
        >
          <template #id="{ data }"><code>{{ data.id }}</code></template>
          <template #label="{ data }">{{ data.label ?? "—" }}</template>
          <template #createdAt="{ data }"
            ><time>{{ new Date(Number(data.createdAt)).toLocaleString() }}</time></template
          >
          <template #expiresAt="{ data }">{{
            data.expiresAt
              ? new Date(Number(data.expiresAt)).toLocaleString()
              : "永不过期"
          }}</template>
          <template #lastUsedAt="{ data }">{{
            data.lastUsedAt
              ? new Date(Number(data.lastUsedAt)).toLocaleString()
              : "未使用"
          }}</template>
          <template #state="{ data }"
            ><UiTag
              :value="disabledState(data.disabledAt).label"
              :severity="disabledState(data.disabledAt).severity"
          /></template>
          <template #actions="{ data }"
            ><div class="section-actions">
              <UiButton
                size="small"
                variant="outlined"
                label="回显"
                :loading="revealBusy === data.id"
                @click="revealKey(data)"
              />
              <UiButton
                v-if="!data.disabledAt"
                size="small"
                variant="outlined"
                severity="danger"
                label="停用"
                :loading="disableBusy === data.id"
                @click="disableKey(data)"
              /></div
          ></template>
        </DataGrid>
      </template>
      <template #footer>
        <UiButton variant="text" label="关闭" @click="keysDialog = false" />
      </template>
    </UiModal>
  </article>
</template>
