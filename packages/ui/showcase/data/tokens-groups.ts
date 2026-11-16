/* 「变量」一节里的分组：每个变量属于哪一组、按什么样子摆。名字要和 tokens.css 对得上——
   页面上运行时会从样式表里读出 @layer ll.tokens 的全部变量，和这里对一遍（sections/Tokens.tsx、lib/token-diff.ts）：
   tokens.css 里有、这里没登记的，自动出现在最后一个「还没分组」的组里；这里登记了、tokens.css 里没有的（名字写错、变量删了），
   那一格标红。两种情况控制台都会 console.error 一次。 */

/** 样子：color 色块（垫棋盘格和页面底）；fill 一整块背景（渐变、多层）；shadow 阴影；font 字体样例；
 *  text 只显示值；length 一条长度；number 只显示值；time 时长；curve 曲线；z 层级 */
export type Kind =
  'color' | 'fill' | 'shadow' | 'font' | 'text' | 'length' | 'number' | 'time' | 'curve' | 'z';

export interface TokenItem {
  name: string;
  kind: Kind;
  /** 一句说明（用在哪） */
  note?: string;
  /** fill 垫在哪种底上看：page 页面底（默认），sky 夜空窗口的底（半透明的气泡要垫在星空上才看得出） */
  stage?: 'page' | 'sky';
  /** shadow 画在哪个变量当底的块上（阴影要有块才看得到）：变量名，默认是页面上最浅的一档 */
  base?: string;
}
export interface TokenGroup {
  id: string;
  title: string;
  note?: string;
  items: TokenItem[];
}

const c = (name: string, note?: string): TokenItem => ({
  name: `--ll-${name}`,
  kind: 'color',
  note,
});
const f = (name: string, note?: string, stage: 'page' | 'sky' = 'page'): TokenItem => ({
  name: `--ll-${name}`,
  kind: 'fill',
  note,
  stage,
});
const s = (name: string, note?: string, base?: string): TokenItem => ({
  name: `--ll-${name}`,
  kind: 'shadow',
  note,
  base,
});
const t = (name: string, kind: Kind, note?: string): TokenItem => ({
  name: `--ll-${name}`,
  kind,
  note,
});

export const TOKEN_GROUPS: TokenGroup[] = [
  {
    id: 'page',
    title: '页面',
    note: '页面底和右上、左侧的两团辉光（面板的 body 是这样画的：底色加两层径向渐变）。',
    items: [c('bg', '页面底'), c('bg-glow', '页面右上、左侧的两团辉光')],
  },
  {
    id: 'text',
    title: '文字四档',
    items: [
      c('fg', '主要文字'),
      c('fg-2', '次要文字'),
      c('fg-3', '三级文字、没选中的标签'),
      c('fg-dim', '最淡：时间、说明'),
    ],
  },
  {
    id: 'accent',
    title: '强调色',
    note: '现在是蓝：选中的底、焦点环、链接、自己的气泡。',
    items: [
      c('accent', '强调色'),
      c('on-accent', '压在强调色上的字'),
      c('accent-soft', '强调色的淡底（22%）'),
    ],
  },
  {
    id: 'star',
    title: '点睛色',
    note: '现在是金，只给主角用（名字、星星、未读数）。',
    items: [
      c('star', '点睛色'),
      c('on-star', '压在点睛色上的字'),
      c('star-pale', '偏白的一档'),
      c('star-deep', '偏深的一档'),
      c('star-dust', '星尘的颜色'),
      c('star-glow', '点睛色的光晕（70%）'),
    ],
  },
  {
    id: 'status',
    title: '状态色',
    items: [
      c('ok', '成功'),
      c('danger', '出错'),
      c('danger-pale', '出错的浅色字'),
      c('danger-glow', '出错的光晕（55%）'),
      c('danger-soft', '出错的淡底（24%）：危险按钮'),
      c('danger-tint', '出错的底（10%）：表单控件出错时叠在输入框的底上'),
      c('warning', '重试中'),
    ],
  },
  {
    id: 'misc',
    title: '黑白、遮罩和别的',
    items: [
      c('white'),
      c('black'),
      c('mask', '只用于遮罩的不透明部分'),
      c('quote', '引用的竖线、徽记里的 z'),
      c('tool', '调用工具的颜色'),
      c('scrollbar', '滚动条的颜色（强调色 35%）'),
    ],
  },
  {
    id: 'line',
    title: '线',
    note: '分隔、描边用的淡线，亮一档。',
    items: [c('line'), c('line-hi')],
  },
  {
    id: 'ctl',
    title: '控件的底',
    note: '按钮、开关、分段控件、标签页的底：没有边框。',
    items: [
      c('ctl-bg', '平时'),
      c('ctl-bg-hover', '悬停'),
      c('ctl-bg-on', '选中（强调色 30%）'),
      c('item-bg-on', '侧栏里选中的一项（强调色 15%）'),
      t('disabled-opacity', 'number', '禁用的控件整个变淡到这个不透明度'),
    ],
  },
  {
    id: 'inset',
    title: '嵌进去的面',
    note: '设置的分组、输入框、折叠的内容：半透明的底加一道细边。',
    items: [c('inset-bg', '底'), c('inset-line', '细边')],
  },
  {
    id: 'glass',
    title: '玻璃',
    note: '菜单、弹出框、提示条、收纳盒。库里的 .ll-glass、提示条用的就是这三样；自己写别的玻璃面时，backdrop-filter 用 --ll-glass-blur。',
    items: [
      c('glass-bg', '底'),
      t('glass-blur', 'text', '背后的模糊（backdrop-filter 的值）：整个库就这一档'),
      s('glass-edge', '边光和外阴影', '--ll-glass-bg'),
    ],
  },
  {
    id: 'sky',
    title: '夜空窗口',
    note: '底从上到下叠：压暗层、两层星点贴图、左上一团紫、右下一团蓝、底色；再加外阴影、四周的细线和暗边。星点贴图由 @luoli/ui/sky-stars 的 startSkyStars() 在启动时画好、写进这两个变量；没有调用时是 none，窗口里就没有星点（这一页调了，所以窗口里有）。',
    items: [
      c('sky-base', '底色'),
      c('sky-shade', '压暗层'),
      c('sky-glow-a', '左上那团紫'),
      c('sky-glow-b', '右下那团蓝'),
      t('sky-stars-a', 'text', '星点贴图 A（startSkyStars() 写入；没有写时是 none）'),
      t('sky-stars-b', 'text', '星点贴图 B（startSkyStars() 写入；没有写时是 none）'),
      s('sky-shadow', '窗口的外阴影', '--ll-sky-base'),
      c('sky-line', '窗口四周的细线'),
      c('sky-line-cap', '胶囊四周的细线'),
      s('sky-vignette', '窗口四周的暗边', '--ll-sky-base'),
      f('sky-bg', '整个窗口的底'),
      c('hover-edge-hi', '悬停：边光里鼠标正下方那段的亮色（@luoli/ui/fx）'),
      c('hover-edge-mid', '悬停：边光里往外一圈的亮色'),
      c('sweep-hi', '悬停：流光的亮头'),
      s('hover-halo', '悬停：流光效果里窗口多出来的一圈淡光（连窗口自己的阴影）', '--ll-sky-base'),
      c('side-bg', '全屏会话左边的列表暗一档'),
      c('pane-tint', '窗格上下渐变的底'),
    ],
  },
  {
    id: 'bubble',
    title: '气泡',
    note: '群友、自己、助手三种：没有边，只靠底色（叠在星空上）。圆角 16、靠近说话人的下角 5（见「刻度」一节的专用值）。这里只是示意变量，不是气泡组件。',
    items: [
      f('bubble-other-bg', '群友的底', 'sky'),
      c('bubble-other-fg', '群友的字'),
      f('bubble-self-bg', '自己的底', 'sky'),
      c('bubble-self-fg', '自己的字'),
      f('bubble-assistant-bg', '助手的底', 'sky'),
      c('bubble-assistant-fg', '助手的字'),
      c('bubble-code-inline', '行内代码的底'),
      c('bubble-code-block', '代码块的底'),
    ],
  },
  {
    id: 'who',
    title: '每人一色',
    note: '按发言人的 id 算下标，同一个人永远同一个颜色。',
    items: Array.from({ length: 10 }, (_, i) => c(`who-${i}`)),
  },
  {
    id: 'font',
    title: '字体',
    note: '库不带字体文件，只定变量；展示页自己引了思源黑体和 JetBrains Mono。',
    items: [t('font-ui', 'font', '界面'), t('font-mono', 'font', '等宽：终端、代码、数字')],
  },
  {
    id: 'motion',
    title: '动画',
    note: '曲线和时长的出处是 easing.ts；tokens.css 里静态写了同样的一份，给只引样式的项目用。下面显示的是页面上实际生效的值（有 JS 时是 easing.ts 写的）。',
    items: [
      t('ease-out', 'curve', '出现、进入、到位'),
      t('dur-hover', 'time', '悬停：按钮、胶囊的底色和边框'),
      t('dur-card', 'time', '卡片的边框、阴影、发光'),
      t('dur-glide', 'time', '悬停高亮滑到另一行'),
      t('dur-glide-in', 'time', '悬停高亮淡入'),
      t('dur-glide-out', 'time', '悬停高亮淡出'),
      t('dur-blur-in', 'time', '窗格的模糊淡入'),
    ],
  },
  {
    id: 'z',
    title: '层级',
    note: '浮层（@luoli/ui/overlay）用，它们画在页面最上层：提示气泡压过对话框和 toast，toast 压过对话框。',
    items: [
      t('z-popover', 'z', '弹出框、下拉菜单'),
      t('z-dialog', 'z', '对话框'),
      t('z-toast', 'z', 'toast'),
      t('z-tooltip', 'z', '提示气泡'),
    ],
  },
  {
    id: 'overlay',
    title: '浮层',
    note: '弹出框、菜单、提示气泡、对话框、toast 的进出场时长（曲线只在样式里定、没有 easing.ts 里的另一份：平常的是 --ll-ease-out，长开的写在 grow.css 里）、用下拉钮打开时「长开」的几个时长、对话框的遮罩、提示气泡的底、toast 离底边的距离。关动画时时长一律缩到 0.12 秒。',
    items: [
      t('dur-pop-in', 'time', '弹出框、菜单：出现'),
      t('dur-pop-out', 'time', '弹出框、菜单：消失'),
      t('dur-tip', 'time', '提示气泡：出现和消失'),
      t('dur-dim', 'time', '对话框的遮罩：淡入淡出'),
      t('dur-dialog-in', 'time', '对话框：出现'),
      t('dur-dialog-out', 'time', '对话框：消失'),
      t('dur-toast', 'time', 'toast：出现和消失'),
      t('dur-grow-in', 'time', '长开：面长大（钮的底长成浮层的底）'),
      t('dur-grow-content-in', 'time', '长开：内容出来'),
      t('dur-grow-out', 'time', '长开：关时面缩回钮'),
      t('dur-grow-content-out', 'time', '长开：关时内容淡掉'),
      t('dur-grow-tint', 'time', '长开：起点样子的颜色过渡（鼠标进出钮）'),
      c('dim', '对话框后面的遮罩：页面底 62%，只压暗不模糊'),
      c('tip-bg', '提示气泡的底'),
      t('toast-bottom', 'length', 'toast 离视口底边的距离（面板要避开输入区时自己改）'),
    ],
  },
  {
    id: 'scale',
    title: '刻度和专用值',
    note: '提案，还没有套用到面板上。样子和「现在的数字并到哪一档」在「刻度」一节。',
    items: [
      ...['xs', 'sm', 'md', 'lg', 'xl'].map((n) => t(`text-${n}`, 'length')),
      ...[2, 4, 6, 8, 10, 12, 14, 16, 24].map((n) => t(`space-${n}`, 'length')),
      ...['xs', 'sm', 'md', 'lg', 'xl', 'full', 'window'].map((n) => t(`radius-${n}`, 'length')),
      t('bubble-text', 'length', '气泡的字号（专用）'),
      t('bubble-leading', 'number', '气泡的行高（专用）'),
      t('bubble-radius', 'length', '气泡的圆角（专用）'),
      t('bubble-radius-tail', 'length', '气泡靠近说话人的下角（专用）'),
      t(
        'bubble-blur',
        'text',
        '气泡的毛玻璃（backdrop-filter 的值，专用；和面板里「预先糊好」的那对数字一致）',
      ),
      t('text-figure', 'length', '今日概况数字格里的数字（专用）'),
      t('text-figure-lg', 'length', '今日概况头条的大数字（专用）'),
    ],
  },
];
