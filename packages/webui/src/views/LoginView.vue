<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import UiButton from '../ui/UiButton.vue';
import { auth } from '../api/client';

const props = defineProps<{ setup?: boolean }>();
const router = useRouter();
const route = useRoute();
const password = ref('');
const token = ref(String(route.query.t ?? ''));
const error = ref('');
const loading = ref(false);

async function submit(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const endpoint = props.setup ? '/api/setup' : '/api/auth/login';
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(props.setup ? { token: token.value, password: password.value } : { password: password.value }) });
    const result = await response.json() as { ok: boolean; data?: { csrf: string }; error?: { message: string } };
    if (!result.ok) throw new Error(result.error?.message ?? '请求失败');
    if (result.data?.csrf) auth.csrf = result.data.csrf;
    auth.authenticated = true;
    await router.push('/');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '请求失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-copy">
      <div class="brand-mark">L</div>
      <p class="eyebrow">LUOLICORE / CONTROL PLANE</p>
      <h1>把复杂运行状态<br /><span>收进一个安静的界面。</span></h1>
      <p>上下文提交、模型调用、工具权限、费用与任务进度。默认仅在本机可见。</p>
      <div class="trust-row">
        <span><i class="pi pi-shield" /> Session + CSRF</span>
        <span><i class="pi pi-lock" /> 密钥不回显</span>
        <span><i class="pi pi-eye-slash" /> 全链路脱敏</span>
      </div>
    </section>
    <form class="auth-card" @submit.prevent="submit">
      <div>
        <p class="eyebrow">{{ props.setup ? 'FIRST RUN' : 'OWNER ACCESS' }}</p>
        <h2>{{ props.setup ? '初始化控制台' : '欢迎回来' }}</h2>
        <p>{{ props.setup ? '使用终端输出的一次性 token 设置管理员密码。' : '输入管理员密码继续。' }}</p>
      </div>
      <label v-if="props.setup">
        <span>Setup token</span>
        <input v-model="token" autocomplete="one-time-code">
      </label>
      <label>
        <span>管理员密码</span>
        <input v-model="password" type="password" autocomplete="current-password">
      </label>
      <!-- 登录失败是表单内校验，留在原地；写操作的成败才走右上角通知（docs/09 §6） -->
      <p v-if="error" class="callout error"><i class="pi pi-times-circle" aria-hidden="true" />{{ error }}</p>
      <UiButton type="submit" :loading="loading" fluid :label="props.setup ? '完成初始化' : '进入控制台'" icon="pi pi-arrow-right" icon-pos="right" />
      <small><i class="pi pi-info-circle" /> WebUI 默认只监听 127.0.0.1:8787</small>
    </form>
  </main>
</template>
