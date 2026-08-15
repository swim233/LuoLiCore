<script setup lang="ts">
withDefaults(defineProps<{
  label?: string; icon?: string; iconPos?: 'left' | 'right'; variant?: 'solid' | 'outlined' | 'text';
  severity?: 'primary' | 'danger' | 'secondary'; size?: 'small' | 'normal'; loading?: boolean; disabled?: boolean; fluid?: boolean; type?: 'button' | 'submit';
}>(), { label: '', icon: '', iconPos: 'left', variant: 'solid', severity: 'primary', size: 'normal', type: 'button' });
</script>

<template>
  <button :type="type" :class="['ui-btn', variant, severity, { small: size === 'small', fluid, 'icon-only': !label && !$slots.default }]" :disabled="disabled || loading">
    <i v-if="loading" class="pi pi-spin pi-spinner" aria-hidden="true" />
    <i v-else-if="icon && iconPos === 'left'" :class="icon" aria-hidden="true" />
    <span v-if="label">{{ label }}</span><slot />
    <i v-if="icon && !loading && iconPos === 'right'" :class="icon" aria-hidden="true" />
  </button>
</template>
