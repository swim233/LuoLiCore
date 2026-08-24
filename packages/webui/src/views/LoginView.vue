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

/** 登录成功后的收尾。三处（口令、setup、一次性 token）必须一致：漏掉 csrf 那一步的表现是进得去、
 *  但每个写操作都 403。 */
async function enter(csrf: string | undefined): Promise<void> {
  if (csrf) auth.csrf = csrf;
  auth.authenticated = true;
  await router.push("/");
}

/**
 * Telegram `/webui` 那条一次性登录链接的兑换（docs/09 §2.3）。**这一跳此前压根不存在**：
 * `route.query.t` 早就读进来了，但只有 setup 分支发它，登录分支只 POST `{ password }` ——
 * 于是 `/login?t=…` 渲染的是普通口令框，服务端端点、bot 那一侧、CI 断言全都活着而整条功能是死的
 * （docs/28 · L-WEB-01）。
 *
 * 失败必须把服务端的原因显示出来：token 是 5 分钟一次性的，**过期与已用过是常态**，
 * 一句「请求失败」会让人以为链接坏了或服务挂了。失败即降级成口令框（fail-closed）。
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
    error.value = `${cause instanceof Error ? cause.message : "请求失败"}——一次性登录链接 5 分钟有效、且只能用一次。在私聊里重新发 /webui 换一条，或直接用下面的口令登录。`;
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
      <p>在此处管理你的助手</p>
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
        <h2>{{ props.setup ? "初始化控制台" : "欢迎回来" }}</h2>
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
        <i
          class="pi pi-spin pi-spinner"
          aria-hidden="true"
        />正在用一次性登录链接换取会话…
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
