<script setup lang="ts">
import TasksCard from "../components/tasks/TasksCard.vue";
import SchedulesCard from "../components/tasks/SchedulesCard.vue";
import ApprovalsCard from "../components/tasks/ApprovalsCard.vue";
import type { ChatOption } from "../components/tasks/types";

/**
 * 「任务与审批」页，三张卡竖排：任务、定时任务、审批。
 *
 * 这一层只负责排版，不拉取数据。三张卡的端点、分页游标、弹窗、busy 态没有交集，各自
 * 通过 `onMounted` 与 `watch(tick)` 拉取自身数据；`api` / `pushToast` / `toastError` 均为模块级单例，
 * 不作为 props 向下传递。不沿用 `ExtensionsPage` 中父层统管所有写操作的做法：那条规则防的是
 * 跨卡共享 busy，这里不存在；而服务端分页的页码必须与 loader 放在一起，提升到父层会重新形成争用点。
 *
 * `tick` 是父层发出的重新拉取脉冲：SSE 的 tasks / approvals / schedules 三组事件都只将其加一，
 * 组名、`EVENT_REFRESH` 映射、400ms 合并与可见性过滤均不改动。
 */
defineProps<{
  tick: number;
  chats: ChatOption[];
  approvalRulesEmpty: boolean;
  conditionalToolNames: string;
}>();
/**
 * `approvals-changed`：裁决之后左侧导航的角标需立即更新。角标读取的是
 * `GET /api/approvals` 信封中的全表 `pending`，只有父层能拉取到（`AC-WEB-049`：
 * 不切换到这一页也需可见）。
 * `open-turn` / `open-trace`：任务详情中两个跳转的出口，B2 接上行内入口后即连通。
 */
defineEmits<{
  "approvals-changed": [];
  "open-turn": [string];
  "open-trace": [string];
}>();
</script>

<template>
  <section class="surface page-surface">
    <header>
      <div>
        <p class="eyebrow">WORK QUEUE</p>
        <h2>任务与审批</h2>
        <p>子 agent 任务、定时任务与高风险调用审批</p>
      </div>
    </header>
    <div class="card-stack">
      <TasksCard
        :tick="tick"
        @open-turn="$emit('open-turn', $event)"
        @open-trace="$emit('open-trace', $event)"
      />
      <SchedulesCard :tick="tick" :chats="chats" />
      <ApprovalsCard
        :tick="tick"
        :approval-rules-empty="approvalRulesEmpty"
        :conditional-tool-names="conditionalToolNames"
        @changed="$emit('approvals-changed')"
      />
    </div>
  </section>
</template>
