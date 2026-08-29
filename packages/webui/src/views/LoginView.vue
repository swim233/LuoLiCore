<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import UiButton from "../ui/UiButton.vue";
import { auth } from "../api/client";

const props = defineProps<{ setup?: boolean }>();
const router = useRouter();
const route = useRoute();
const password = ref("");
const token = ref(String(route.query.t ?? ""));
const error = ref("");
const loading = ref(false);
const exchanging = ref(false);

/** 登录成功后的收尾。三处（口令、setup、一次性 token）必须一致：遗漏 csrf 一步的表现是可以登录，
 *  但每个写操作都返回 403。 */
async function enter(csrf: string | undefined): Promise<void> {
  if (csrf) auth.csrf = csrf;
  auth.authenticated = true;
  await router.push("/");
}

/**
 * Telegram `/webui` 一次性登录链接的兑换（docs/09 §2.3）。此前这一步完全缺失：
 * `route.query.t` 早已读入，但只有 setup 分支发送它，登录分支仅 POST `{ password }`，
 * 因此 `/login?t=…` 渲染的是普通口令框，服务端端点、bot 侧与 CI 断言均正常而整条功能不可用
 * （docs/28 · L-WEB-01）。
 *
 * 失败必须展示服务端给出的原因：token 为 5 分钟一次性，过期与已使用属于常见情况，
 * 仅提示请求失败会让用户误以为链接损坏或服务不可用。失败即降级为口令框（fail-closed）。
 */
onMounted(async () => {
  if (props.setup || !token.value) return;
  exchanging.value = true;
  loading.value = true;
  try {
    const response = await fetch("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.value }),
    });
    const result = (await response.json()) as {
      ok: boolean;
      data?: { csrf: string };
      error?: { message: string };
    };
    if (!result.ok)
      throw new Error(
        result.error?.message ?? `请求失败：HTTP ${response.status}`,
      );
    await enter(result.data?.csrf);
  } catch (cause) {
    error.value = `${cause instanceof Error ? cause.message : "请求失败"}。链接 5 分钟有效且仅可用一次，在私聊重新发送 /webui 获取新链接。`;
  } finally {
    exchanging.value = false;
    loading.value = false;
  }
});

async function submit(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const endpoint = props.setup ? "/api/setup" : "/api/auth/login";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        props.setup
          ? { token: token.value, password: password.value }
          : { password: password.value },
      ),
    });
    const result = (await response.json()) as {
      ok: boolean;
      data?: { csrf: string };
      error?: { message: string };
    };
    if (!result.ok) throw new Error(result.error?.message ?? "请求失败");
    await enter(result.data?.csrf);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "请求失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-copy">
      <div class="brand-mark">L</div>
      <p class="eyebrow">Welcome To LuoLiCore</p>
      <h1>「Hello World」<br /><span>你好 世界</span></h1>
      <p>管理会话、工具、模型与配额</p>
      <div class="trust-row">
        <span class="u-display-none"
          ><i class="pi pi-shield" /> Session + CSRF</span
        >
        <span class="u-display-none"><i class="pi pi-lock" /> 密钥不回显</span>
        <span class="u-display-none"
          ><i class="pi pi-eye-slash" /> 全链路脱敏</span
        >
      </div>
    </section>
    <form class="auth-card" @submit.prevent="submit">
      <div>
        <p class="eyebrow">{{ props.setup ? "FIRST RUN" : "OWNER ACCESS" }}</p>
        <h2>{{ props.setup ? "初始化控制台" : "管理员登录" }}</h2>
        <p>
          {{
            props.setup
              ? "使用终端输出的一次性 token 设置管理员密码。"
              : "输入管理员密码继续。"
          }}
        </p>
      </div>
      <label v-if="props.setup">
        <span>Setup token</span>
        <input v-model="token" autocomplete="one-time-code" />
      </label>
      <label>
        <span>管理员密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
        />
      </label>
      <!-- 兑换期间说清正在做什么：否则界面只是一个转着的按钮，而这一步可能失败并落回口令框 -->
      <p v-if="exchanging" class="callout" data-exchanging>
        <i class="pi pi-spin pi-spinner" aria-hidden="true" />正在兑换登录链接…
      </p>
      <!-- 登录失败是表单内校验，留在原地；写操作的成败才走右上角通知（docs/09 §6） -->
      <p v-if="error" class="callout error">
        <i class="pi pi-times-circle" aria-hidden="true" />{{ error }}
      </p>
      <UiButton
        type="submit"
        :loading="loading"
        fluid
        :label="props.setup ? '完成初始化' : '进入控制台'"
        icon="pi pi-arrow-right"
        icon-pos="right"
      />
      <small
        ><i class="pi pi-info-circle" /> WebUI 默认监听 127.0.0.1:8787</small
      >
    </form>
  </main>
</template>
