import type { ChatImage } from '../../../src/chat';

/* 「聊天内容」一节用的示例数据：图片是现画的渐变（data: 地址），Markdown 把各种写法放在一份里 */
export function pic(h1: number, h2: number, w = 320, h = 200): ChatImage {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${h1} 70% 55%)"/><stop offset="1" stop-color="hsl(${h2} 70% 38%)"/>` +
    `</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return { src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), width: w, height: h };
}

export const MD_SAMPLE = `## 周末聚会安排

**时间**：周六下午 3 点，*老地方*咖啡馆（~~原定周日~~ 已改）。行内代码 \`npm run build\` 和 \`a < b && c\`。

1. 先确认人数
2. 再订位置
   - 带上《献给阿尔吉侬的花束》
   - 记得带围巾

> 引用：一个回车就换行，
> 不用空两行。

- [x] 已完成的事
- [ ] 没完成的事

| 项目 | 时间 | 备注 |
| --- | --- | --- |
| 聚餐 | 18:00 | 订 6 人位 |
| 散步 | 20:00 | 看天气，下雨就改成室内 |

\`\`\`ts
const sum = (a: number, b: number) => a + b;
console.log(sum(1, 2));
\`\`\`

---

网址 https://example.com/m42 能点，[Markdown 写的链接](https://example.com/doc) 悬停显示网址。<b>原始 HTML</b> 当文字，![图片](https://example.com/a.png) 不加载。`;

/* 一批批到的假流：每批的字数不一，停一会儿再来 */
export const STREAM_TEXT = `好的，我来排一下周末。

**周六**
- 上午：去植物园扫街，带上相机
- 下午 3 点：老地方咖啡馆，聊聊 *读书会* 下一本书
- 晚上：回家早点睡

\`\`\`
周日：休息，不安排
\`\`\`

要是下雨就把植物园换成 [美术馆](https://example.com/museum)，其余照旧～`;
