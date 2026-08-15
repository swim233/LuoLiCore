<script setup lang="ts">
import { dismissToast, toasts, type ToastSeverity } from './toast';

const ICON: Record<ToastSeverity, string> = { success: 'pi pi-check-circle', info: 'pi pi-info-circle', warn: 'pi pi-exclamation-triangle', error: 'pi pi-times-circle' };
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <article v-for="item in toasts" :key="item.id" :class="['toast', item.severity]">
          <i :class="ICON[item.severity]" aria-hidden="true" />
          <div><b>{{ item.summary }}</b><p v-if="item.detail">{{ item.detail }}</p></div>
          <button type="button" aria-label="关闭通知" @click="dismissToast(item.id)"><i class="pi pi-times" aria-hidden="true" /></button>
        </article>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
