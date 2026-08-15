<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { RouterView } from 'vue-router';

const dark = ref(matchMedia('(prefers-color-scheme: dark)').matches);
const apply = (): void => document.documentElement.classList.toggle('dark', dark.value);
onMounted(apply);
function toggleTheme(): void {
  dark.value = !dark.value;
  apply();
}
</script>

<template>
  <button class="theme-toggle" type="button" aria-label="切换深浅色主题" @click="toggleTheme">
    <i :class="dark ? 'pi pi-sun' : 'pi pi-moon'" aria-hidden="true" />
  </button>
  <RouterView />
</template>
