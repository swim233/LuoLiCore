/* 各部件的图标（此刻、会话、对话、设置、今日概况、任务）：内联 SVG，各平台长得一样，不靠字体里的 ✦。
   四角星、标题栏按钮、整理、拖动把手这些通用图标在组件库（@luoli/ui/icons） */
import { STAR_PATH } from '@luoli/ui/icons';
const lineIcon = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  'aria-hidden': true,
} as const;
export const IconNow = (
  <svg viewBox="-50 -50 100 100" aria-hidden="true">
    <path fill="currentColor" d={STAR_PATH} />
  </svg>
);
export const IconSessions = (
  <svg {...lineIcon} strokeLinejoin="round">
    <path d="M2.8 5.3A2.3 2.3 0 0 1 5.1 3h6.3a2.3 2.3 0 0 1 2.3 2.3v3.4a2.3 2.3 0 0 1-2.3 2.3H6.8l-3 2.4v-2.6a2.3 2.3 0 0 1-1-1.9z" />
    <path d="M13.7 7.4h1.2a2.3 2.3 0 0 1 2.3 2.3v3.2a2.3 2.3 0 0 1-1 1.9v2.4l-2.8-1.9H9.9a2.3 2.3 0 0 1-2.2-1.6" />
  </svg>
);
export const IconChat = (
  <svg {...lineIcon} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 4h13v9.5H9.2L5.5 16.5v-3H3.5z" />
    <path d="M7 7.6h6M7 10.2h3.8" />
    <path
      d="M15.6 1.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);
export const IconSettings = (
  <svg {...lineIcon} strokeLinecap="round">
    <path d="M3 6h8.5M15.5 6H17M3 14h1.5M8.5 14H17" />
    <circle cx="13.5" cy="6" r="2" />
    <circle cx="6.5" cy="14" r="2" />
  </svg>
);
export const IconToday = (
  <svg {...lineIcon} strokeWidth={1.6} strokeLinecap="round">
    <path d="M4 16V10M8 16V5.5M12 16v-7M16 16V7.5" />
  </svg>
);
export const IconTasks = (
  <svg {...lineIcon} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="10" cy="10.5" r="6.6" />
    <path d="M10 6.8v4l2.6 1.6" />
    <path d="M4.6 3.4 2.9 5M15.4 3.4 17.1 5" />
  </svg>
);
