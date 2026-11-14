import type { ComponentType } from 'react';
import { Controls } from './sections/Controls';
import { Scale } from './sections/Scale';
import { Scroll } from './sections/Scroll';
import { Surfaces } from './sections/Surfaces';
import { Tokens } from './sections/Tokens';

/* 导航里的各节登记在这里：以后每一步加一节，只加一个 sections/ 里的文件、在这里登记一行。
   Component 有就是已经做了的节；没有就是「还没有」，steps 是哪一步加进来（点开只显示一行字） */
export interface SectionDef {
  /** 地址里 # 后面的那段：#tokens、#scale…… */
  id: string;
  title: string;
  Component?: ComponentType;
  steps?: string;
}

export const SECTIONS: SectionDef[] = [
  { id: 'tokens', title: '变量', Component: Tokens },
  { id: 'scale', title: '刻度', Component: Scale },
  { id: 'surfaces', title: '面', Component: Surfaces, steps: '5' },
  { id: 'controls', title: '基础控件', Component: Controls, steps: '4、5' },
  { id: 'scroll', title: '滚动', Component: Scroll, steps: '6' },
  { id: 'overlay', title: '浮层', steps: '7' },
  { id: 'forms', title: '表单', steps: '8' },
  { id: 'chat', title: '聊天内容', steps: '9' },
  { id: 'fx', title: '特效', steps: '10' },
];
export const DEFAULT_SECTION = 'tokens';
