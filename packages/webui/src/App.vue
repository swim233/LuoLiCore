<script setup lang="ts">
import { ref } from "vue";
import { RouterView } from "vue-router";
import AmbientField from "./components/AmbientField.vue";
import ToastHost from "./ui/ToastHost.vue";
import ConfirmHost from "./ui/ConfirmHost.vue";

const dark = ref(true);
const apply = (): void =>
  document.documentElement.classList.toggle("dark", dark.value);
apply();
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
