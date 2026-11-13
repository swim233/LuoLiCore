import type { SVGProps } from 'react';

/* 面板里手写的通用图标：四角星、标题栏按钮（缩小、放大、还原）、整理、拖动的把手。
   和 Lucide 抄来的那批（lucide.tsx）画布不一样（这几个是 16 或 10×16 格、线宽 1.4~1.6），这里照原样搬过来，样子不变；
   大小默认 1em，用的地方自己指定（按钮里由按钮的样式定）。 */
export type IconProps = SVGProps<SVGSVGElement>;

/** 四角星的轮廓（-50 到 50 的画布，原点在中心） */
export const STAR_PATH = 'M0-42C3-14 14-3 42 0C14 3 3 14 0 42C-3 14-14 3-42 0C-14-3-3-14 0-42Z';

export function Star4(props: IconProps) {
  return (
    <svg
      viewBox="-50 -50 100 100"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={STAR_PATH} />
    </svg>
  );
}

const box16 = {
  viewBox: '0 0 16 16',
  width: '1em',
  height: '1em',
  fill: 'none',
  stroke: 'currentColor',
  'aria-hidden': true,
  focusable: false,
} as const;

/** 缩小（一条横线） */
export function IconMin(props: IconProps) {
  return (
    <svg {...box16} strokeWidth={1.6} strokeLinecap="round" {...props}>
      <path d="M3.5 8h9" />
    </svg>
  );
}

/** 放大（两个斜箭头朝外） */
export function IconMax(props: IconProps) {
  return (
    <svg {...box16} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
    </svg>
  );
}

/** 还原（两个斜箭头朝里） */
export function IconRestore(props: IconProps) {
  return (
    <svg {...box16} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" />
    </svg>
  );
}

/** 整理（四个方块） */
export function IconArrange(props: IconProps) {
  return (
    <svg {...box16} strokeWidth={1.4} {...props}>
      <rect x="1.5" y="1.5" width="5" height="5" rx="1.2" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1.2" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1.2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1.2" />
    </svg>
  );
}

/** 拖动的把手（两列三个点），实心 */
export function IconGrip(props: IconProps) {
  return (
    <svg
      viewBox="0 0 10 16"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle cx="2.5" cy="3" r="1.4" />
      <circle cx="7.5" cy="3" r="1.4" />
      <circle cx="2.5" cy="8" r="1.4" />
      <circle cx="7.5" cy="8" r="1.4" />
      <circle cx="2.5" cy="13" r="1.4" />
      <circle cx="7.5" cy="13" r="1.4" />
    </svg>
  );
}
