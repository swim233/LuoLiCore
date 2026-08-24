<script setup lang="ts">
import UiButton from "./UiButton.vue";
import UiModal from "./UiModal.vue";
import {
  confirmBox,
  confirmBusy,
  dismissConfirm,
  runConfirmed,
} from "./confirm";
</script>

<template>
  <UiModal
    v-model:visible="confirmBox.open"
    :title="confirmBox.title"
    width="min(560px, 94vw)"
  >
    <!-- `confirm-detail` 不是样式钩子而是层级钩子：`styles.css` 靠 `:has()` 认出「这张遮罩是确认框」
         再单独抬一层。确认框永远是问在别的弹窗之上的那一句，被盖住就等于点了没反应。 -->
    <p class="callout warn confirm-detail">
      <i class="pi pi-exclamation-triangle" aria-hidden="true" />{{
        confirmBox.detail
      }}
    </p>
    <template #footer>
      <UiButton variant="text" label="取消" @click="dismissConfirm" />
      <UiButton
        severity="danger"
        label="确认"
        :loading="confirmBusy"
        @click="runConfirmed"
      />
    </template>
  </UiModal>
</template>
