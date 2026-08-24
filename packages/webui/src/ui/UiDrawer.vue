<script setup lang="ts">
withDefaults(defineProps<{ visible: boolean; title?: string }>(), {
  title: "",
});
const emit = defineEmits<{ "update:visible": [boolean] }>();
function close(): void {
  emit("update:visible", false);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div v-if="visible" class="ui-overlay drawer-overlay" @click.self="close">
        <aside
          class="ui-drawer"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <header>
            <b>{{ title }}</b
            ><button
              type="button"
              class="icon-btn"
              aria-label="关闭"
              @click="close"
            >
              <i class="pi pi-times" aria-hidden="true" />
            </button>
          </header>
          <slot />
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>
