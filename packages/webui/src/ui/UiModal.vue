<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";

const props = withDefaults(
  defineProps<{ visible: boolean; title?: string; width?: string }>(),
  { title: "", width: "min(560px, 94vw)" },
);
const emit = defineEmits<{ "update:visible": [boolean] }>();
function close(): void {
  emit("update:visible", false);
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") close();
}
watch(
  () => props.visible,
  (open) => {
    document.body.classList.toggle("modal-open", open);
    if (open) window.addEventListener("keydown", onKeydown);
    else window.removeEventListener("keydown", onKeydown);
  },
);
// 对话框在 v-if 里被销毁时不会走上面的 watch，监听器和 body 上的锁得自己收
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.body.classList.remove("modal-open");
});
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div v-if="visible" class="ui-overlay" @click.self="close">
        <section
          class="ui-modal"
          :style="{ width }"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <header>
            <h2>{{ title }}</h2>
            <button
              type="button"
              class="icon-btn"
              aria-label="关闭对话框"
              @click="close"
            >
              <i class="pi pi-times" aria-hidden="true" />
            </button>
          </header>
          <div class="modal-body"><slot /></div>
          <footer v-if="$slots.footer" class="modal-foot">
            <slot name="footer" />
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
