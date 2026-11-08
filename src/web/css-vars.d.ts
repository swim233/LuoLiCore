import 'react';

/* style 里可以直接写 CSS 自定义属性：style={{ '--bs': '44px' }} */
declare module 'react' {
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
