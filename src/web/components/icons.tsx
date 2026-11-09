/* 小四角星、各部件的图标、标题栏按钮的图标：内联 SVG，各平台长得一样，不靠字体里的 ✦ */
export const STAR_PATH = 'M0-42C3-14 14-3 42 0C14 3 3 14 0 42C-3 14-14 3-42 0C-14-3-3-14 0-42Z';

export function Star4({ className = 'st4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">
      <path d={STAR_PATH} />
    </svg>
  );
}
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
export const ICON_MIN = (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M3.5 8h9" />
  </svg>
);
export const ICON_MAX = (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </svg>
);
export const ICON_RESTORE = (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" />
  </svg>
);
export const ICON_ARRANGE = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
    <rect x="1.5" y="1.5" width="5" height="5" rx="1.2" />
    <rect x="9.5" y="1.5" width="5" height="5" rx="1.2" />
    <rect x="1.5" y="9.5" width="5" height="5" rx="1.2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1.2" />
  </svg>
);
export const GripIcon = (
  <svg className="grip-ico" viewBox="0 0 10 16" aria-hidden="true">
    <circle cx="2.5" cy="3" r="1.4" />
    <circle cx="7.5" cy="3" r="1.4" />
    <circle cx="2.5" cy="8" r="1.4" />
    <circle cx="7.5" cy="8" r="1.4" />
    <circle cx="2.5" cy="13" r="1.4" />
    <circle cx="7.5" cy="13" r="1.4" />
  </svg>
);
