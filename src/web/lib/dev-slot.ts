import type { ComponentType } from 'react';

/* 开发模式往页面里插东西的口子：演示控制面板。dev/index.ts 在开发模式启动时填上，
   正式构建里这两样始终是空的（那段代码根本不会被打进去，见 main.tsx） */
export const devSlot: { Panel: ComponentType | null } = { Panel: null };

/* Esc 的额外处理：排在「对话生成中先中止」之后、「退出全屏」之前。返回 true 表示这次 Esc 已经处理了 */
export const escHooks: ((e: KeyboardEvent) => boolean)[] = [];
