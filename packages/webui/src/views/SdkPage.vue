<script setup lang="ts">
import SourcesCard from "../components/sdk/SourcesCard.vue";

/**
 * 「SDK 接入」页（docs/12-sdk.md T3.11）：来源与密钥的最小运维面，对接 `/api/sdk/*`
 * （`packages/server/src/sdk/admin.ts`，T3.3）。
 *
 * 这一层只负责排版，不拉取数据 —— 与 `TasksPage` / `WorkerRunsPage` 同形：
 * `ConsoleView.vue` 只净减不再长胖（docs/09 §6），新页面单独成文件。
 * 目前只有一张卡：来源列表 + 新建，密钥的签发 / 回显 / 停用都在点开来源后的详情弹窗里完成，
 * 不必为此再拆一张独立的卡。
 */
</script>

<template>
  <section class="surface page-surface">
    <header>
      <div>
        <p class="eyebrow">SDK ACCESS</p>
        <h2>SDK 接入</h2>
        <p>来源与密钥</p>
      </div>
    </header>
    <div class="card-stack">
      <SourcesCard />
    </div>
  </section>
</template>
