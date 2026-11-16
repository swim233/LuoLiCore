# @luoli/ui

洛璃网页面板的组件库：设计变量、基础控件、滚动、浮层、表单控件、聊天内容、特效。夜蓝星空是默认的配色，只有深色；只管桌面 Chrome。

为什么这样设计，见仓库的 `docs/adr/0011-ui-component-library.md`。

## 怎么用

这个包不构建、不发布，用它的项目直接引用源码（TypeScript 和 CSS），所以项目的打包器要能处理 `.ts`、`.tsx` 和 CSS 的 `@import`（Vite 可以）。在同一个 pnpm workspace 里把它声明成依赖：

```json
{ "dependencies": { "@luoli/ui": "workspace:*" } }
```

没有总入口，用到哪个引哪个：

```tsx
import '@luoli/ui/styles.css';
import { Button } from '@luoli/ui/controls';

<Button variant="primary">保存</Button>;
```

用它的项目要自己做的事：

- 提供 `react` 和 `react-dom`（19）。
- 在入口引一次 `@luoli/ui/styles.css`，排在自己的样式前面。用到聊天内容、特效时，再引 `@luoli/ui/chat.css`、`@luoli/ui/fx.css`。
- 自己的样式不要放进 `@layer`：库的样式都在层里，层外的规则天然盖过库的。
- 字体：库只定了变量 `--ll-font-ui`、`--ll-font-mono`，不带字体文件。
- 动画开关：启动时、用户拨开关时调 `setMotionMode()`（`@luoli/ui/motion`），再按 `motionOn()` 给根元素加上 `motion` 或 `still` 类，库的样式靠这两个类决定关不关动画。库不存储用户的选择。
- 用浮层时：根元素加 `isolation: isolate`；用 toast 要在页面里挂一次 `<Toaster />`。
- 用滚轮缓动、聊天气泡时：启动时各调一次 `installWheel()`、`installBubbleFrame()`。页面里有大动画时，把「现在在不在走」经 `busy` 传给它们。
- 用特效时：星空调 `sky.start(canvas, …)`，Worker 由库自己建。星尘的 Worker 要自己写一个入口文件，在里面把消息交给 `particleMessage`，建好以后传给 `fx.start(canvas, { worker })`。悬停效果：窗口加 `ll-hover` 类、接上 `hoverHandlers()` 给的处理函数，用 `setHoverEffect()` 选流光、边光、倾斜里的一种。

## 入口

| 入口                                        | 里面有什么                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@luoli/ui/styles.css`                      | 设计变量、基础样式，三种「面」（玻璃面板 `ll-glass`、半透明面板 `ll-inset`、夜空窗口的底 `ll-sky`），基础控件、滚动、浮层、表单控件的样式                            |
| `@luoli/ui/controls`                        | 按钮、图标按钮、开关、分段选择、两步确认、标签、数字徽标、状态点、转圈、小箭头、提示条、空状态、骨架条、表单项、链接、统计格、数字滚动、能量槽、折叠、标签页、列表行 |
| `@luoli/ui/icons`                           | 通用图标：手写的（四角星、缩小、放大、还原、整理、拖动的把手）和从 Lucide 抄来的（勾、叉、搜索、眼睛、加减、箭头、警告、信息等）                                     |
| `@luoli/ui/scroll`                          | 窗格 `Pane`（标题和输入框浮在内容上，上下渐变模糊）、长列表 `VirtualLog`、悬停高亮 `useGlide`、滚轮缓动 `installWheel`                                               |
| `@luoli/ui/overlay`                         | 弹出框、下拉菜单、提示气泡、对话框和确认框、toast                                                                                                                    |
| `@luoli/ui/forms`                           | 单行、密码、数字、多行输入，下拉选择、复选框、单选、滑块，带校验的表单项，列表编辑                                                                                   |
| `@luoli/ui/chat`、`@luoli/ui/chat.css`      | 聊天气泡（含思考与工具的折叠）、Markdown、逐字输出和光标、正文高亮、图片、打字的三个点                                                                               |
| `@luoli/ui/md`                              | Markdown 的纯逻辑（词法分析、一行预览），不带组件                                                                                                                    |
| `@luoli/ui/fx`、`@luoli/ui/fx.css`          | 星空背景、星尘粒子、三种悬停效果（流光、边光、倾斜）                                                                                                                 |
| `@luoli/ui/motion`                          | 动画开关：跟随系统、开、关                                                                                                                                           |
| `@luoli/ui/easing`                          | 动画的曲线和时长（加载时会把其中几个写成 CSS 变量）                                                                                                                  |
| `@luoli/ui/env`                             | 窄屏、有没有鼠标、性能低不低的判断（加载时会用到 `window`）                                                                                                          |
| `@luoli/ui/slide`、`@luoli/ui/wheel`        | 平滑滚动、滚轮缓动的算法                                                                                                                                             |
| `@luoli/ui/sky-stars`                       | 夜空窗口的星点贴图                                                                                                                                                   |
| `@luoli/ui/store`、`storage`、`url`、`util` | 极简的状态库、localStorage 的包装、网址识别、通用的小工具                                                                                                            |

每个组件收什么属性、怎么接，写在各自文件开头的注释里。

## 展示页

```sh
pnpm ui:dev   # 127.0.0.1:5174
```

展示页是库自己的开发入口，不经过面板。每一节摆一批组件的各种状态，垫着星空的底，能切动画开关和缩放。新的样子先摆在这里看，定了再用到项目里。

## 规矩

- 样式放进 `@layer`（`ll.tokens`、`ll.base`、`ll.controls`），类名以 `ll-` 开头，变量以 `--ll-` 开头。
- 样式里不写颜色字面值（颜色都起成变量）、不写 `!important`；悬停写在 `@media (hover: hover)` 里；变化用 `data-*` 属性。
- 关动画时的规则写在各目录的 `still.css` 里：只留很短的淡入淡出。
- 动画只用 CSS 的过渡和动画，不引 Motion。
- 只引包里自己的文件和 `package.json` 里声明的依赖；不引用它的项目的代码。库里的东西要知道项目的状态时，由项目传进来。
- 入口加载时不碰 DOM（node 里能 import），每个入口有一条测试守着。
- 写死的中文都留了可以换的属性。
- 纯逻辑写自动化测试（`pnpm test`）；样子和交互在展示页上用真实浏览器看。

## 加一个组件

1. 组件文件和它的样式文件放进对应的目录（比如 `src/controls/Thing.tsx`、`src/controls/thing.css`）。
2. 样式在 `src/styles.css` 里 `@import`，组件在目录的 `index.ts` 里转出。
3. 在展示页对应的一节里摆上它的各种状态（`showcase/sections/`）。
4. 纯逻辑抽成单独的文件、写测试。
5. 在仓库根目录跑 `pnpm typecheck`、`pnpm lint`、`pnpm test`。
