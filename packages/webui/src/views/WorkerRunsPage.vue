<script setup lang="ts">
import WorkerRunsCard from "../components/workers/WorkerRunsCard.vue";
import WorkerDryRunCard from "../components/workers/WorkerDryRunCard.vue";

/**
 * 「Worker 运行记录」页，两张卡竖排：运行记录、试跑。
 *
 * 这一层只负责排版，不拉取数据。两张卡的端点、分页游标、busy 态没有交集，各自 `onMounted`
 * 拉取自身数据；`api` / `pushToast` / `toastError` 均为模块级单例，不作为 props 向下传递。
 * 不沿用 `ExtensionsPage` 中父层统管所有写操作的做法：那条规则防的是跨卡共享 busy，这里不存在。
 *
 * `tick` 是父层发出的重新拉取脉冲，来源是 SSE 的 `task.updated`。
 */
defineProps<{ tick: number }>();
/** 两个跳转出口：父层已接到 `ConsoleView` 的 `openDetail` / `openTrace` 上。 */
defineEmits<{ "open-turn": [string]; "open-trace": [string] }>();
</script>

<template>
  <section class="surface page-surface">
    <header>
      <div>
        <p class="eyebrow">WORKER RUNS</p>
        <h2>Worker 运行记录</h2>
        <p>主 agent 派出去的每一次 worker 运行：lw、harness 与 ACP 三档</p>
      </div>
    </header>
    <div class="card-stack">
      <WorkerRunsCard
        :tick="tick"
        @open-turn="$emit('open-turn', $event)"
        @open-trace="$emit('open-trace', $event)"
      />
      <WorkerDryRunCard />
    </div>
  </section>
</template>
