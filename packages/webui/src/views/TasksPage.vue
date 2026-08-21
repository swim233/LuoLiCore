<script setup lang="ts">
import TasksCard from '../components/tasks/TasksCard.vue';
import SchedulesCard from '../components/tasks/SchedulesCard.vue';
import ApprovalsCard from '../components/tasks/ApprovalsCard.vue';
import type { ChatOption } from '../components/tasks/types';

/**
 * 「任务与审批」页 —— 三张卡竖排：任务 → 定时任务 → 审批。
 *
 * **这一层只排版，不拉数据。** 三张卡的端点、分页游标、弹窗、busy 态零交集，各自
 * `onMounted` + `watch(tick)` 拉自己的那份；`api` / `pushToast` / `toastError` 都是模块级单例，
 * 不当 props 往下传。**不照抄 `ExtensionsPage` 的「父层管所有写操作」** —— 那条规矩防的是
 * 跨卡共享 busy，这里没有；而服务端分页的页码必须和 loader 待在一起，提到父层就又变回争用点。
 *
 * `tick` 是父层的「该重拉了」脉冲：SSE 的 tasks / approvals / schedules 三组事件都只把它 +1，
 * 组名、`EVENT_REFRESH` 映射、400ms 合并与可见性过滤一个字不改。
 */
defineProps<{
  tick: number;
  chats: ChatOption[];
  approvalRulesEmpty: boolean;
  conditionalToolNames: string;
}>();
/**
 * `approvals-changed`：裁决之后左侧导航那个角标要立刻跟上。角标读的是
 * `GET /api/approvals` 信封里的**全表** `pending`，只有父层拉得到（`AC-WEB-049`：
 * 不切到这一页也得看得见）。
 * `open-turn` / `open-trace`：任务详情里那两个跳转的出口，B2 接上行内入口后就通了。
 */
defineEmits<{ 'approvals-changed': []; 'open-turn': [string]; 'open-trace': [string] }>();
</script>

<template>
  <section class="surface page-surface">
    <header><div><p class="eyebrow">WORK QUEUE</p><h2>任务与审批</h2><p>在此处查看子 agent 任务、管理定时任务、审批高风险调用</p></div></header>
    <div class="card-stack">
      <TasksCard :tick="tick" @open-turn="$emit('open-turn', $event)" @open-trace="$emit('open-trace', $event)" />
      <SchedulesCard :tick="tick" :chats="chats" />
      <ApprovalsCard
        :tick="tick" :approval-rules-empty="approvalRulesEmpty" :conditional-tool-names="conditionalToolNames"
        @changed="$emit('approvals-changed')"
      />
    </div>
  </section>
</template>
