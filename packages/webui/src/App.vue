<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { RouterView, useRouter } from "vue-router";
import { AUTH_REQUIRED_EVENT } from "./api/client";
import AmbientField from "./components/AmbientField.vue";
import ToastHost from "./ui/ToastHost.vue";
import ConfirmHost from "./ui/ConfirmHost.vue";

const dark = ref(true);
const router = useRouter();
let redirecting = false;
const apply = (): void =>
  document.documentElement.classList.toggle("dark", dark.value);
apply();
function redirectToLogin(): void {
  if (redirecting || router.currentRoute.value.path === "/login") return;
  redirecting = true;
  void router.replace("/login").finally(() => { redirecting = false; });
}
window.addEventListener(AUTH_REQUIRED_EVENT, redirectToLogin);
onBeforeUnmount(() => window.removeEventListener(AUTH_REQUIRED_EVENT, redirectToLogin));
function toggleTheme(): void {
  dark.value = !dark.value;
  apply();
}
</script>

<template>
  <AmbientField />
  <button
    class="theme-toggle"
    type="button"
    aria-label="切换深浅色主题"
    @click="toggleTheme"
  >
    <i :class="dark ? 'pi pi-sun' : 'pi pi-moon'" aria-hidden="true" />
  </button>
  <ToastHost />
  <!-- 确认框与 toast 同一个道理：状态在模块里，宿主全站挂一次（`ui/confirm.ts`）。 -->
  <ConfirmHost />
  <RouterView />
</template>
