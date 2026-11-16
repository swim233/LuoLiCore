/* 从 Lucide 抄来的通用图标（路径数据照抄 lucide-react 1.28.0 的源文件）。
   Lucide：https://lucide.dev ，ISC 许可：
     Copyright (c) 2026 Lucide Icons and Contributors
     Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
     provided that the above copyright notice and this permission notice appear in all copies.
     THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
     IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
     INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
     ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
     THIS SOFTWARE.
   其中 check、chevron-*（四个）、info、minus、plus、search、x、triangle-alert（原名 alert-triangle）这几个是 Lucide 从 Feather 带过来的，
   Lucide 的 LICENSE 要求另外带上 Feather 的 MIT 许可：
     The MIT License (MIT)  Copyright (c) 2013-present Cole Bemis
     Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
     files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
     modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
     Software is furnished to do so, subject to the following conditions:
     The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
     THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
     WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
     COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
     ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

   统一成：24 格的画布，stroke="currentColor"，线宽 2（Lucide 自己的默认值；和面板里 16 格手写的、线宽 1.4 的图标按比例几乎一样粗：15px 下 1.25 对 1.31），圆头圆角，aria-hidden；
   大小默认 1em，用的地方自己指定。 */
import type { ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

const make = (name: string, body: ReactNode) => {
  const Icon = (props: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {body}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
};

/** 勾（Lucide check） */
export const IconCheck = make('IconCheck', <path d="M20 6 9 17l-5-5" />);

/** 叉（Lucide x） */
export const IconX = make(
  'IconX',
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
);

/** 搜索（Lucide search） */
export const IconSearch = make(
  'IconSearch',
  <>
    <path d="m21 21-4.34-4.34" />
    <circle cx="11" cy="11" r="8" />
  </>,
);

/** 眼睛（Lucide eye） */
export const IconEye = make(
  'IconEye',
  <>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

/** 划掉的眼睛（Lucide eye-off） */
export const IconEyeOff = make(
  'IconEyeOff',
  <>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
    <path d="m2 2 20 20" />
  </>,
);

/** 加（Lucide plus） */
export const IconPlus = make(
  'IconPlus',
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
);

/** 三个点「更多」（Lucide ellipsis） */
export const IconMore = make(
  'IconMore',
  <>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </>,
);

/** 减（Lucide minus） */
export const IconMinus = make('IconMinus', <path d="M5 12h14" />);

/** 向上的箭头（Lucide chevron-up） */
export const IconChevronUp = make('IconChevronUp', <path d="m18 15-6-6-6 6" />);

/** 向下的箭头（Lucide chevron-down） */
export const IconChevronDown = make('IconChevronDown', <path d="m6 9 6 6 6-6" />);

/** 向左的箭头（Lucide chevron-left） */
export const IconChevronLeft = make('IconChevronLeft', <path d="m15 18-6-6 6-6" />);

/** 向右的箭头（Lucide chevron-right） */
export const IconChevronRight = make('IconChevronRight', <path d="m9 18 6-6-6-6" />);

/** 警告，三角形里一个叹号（Lucide triangle-alert） */
export const IconAlert = make(
  'IconAlert',
  <>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </>,
);

/** 信息，圆圈里一个 i（Lucide info） */
export const IconInfo = make(
  'IconInfo',
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </>,
);
