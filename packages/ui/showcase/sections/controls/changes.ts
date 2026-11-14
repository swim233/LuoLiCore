/* 「面板上会变的地方」：第 5 步第一批换成库的面、控件以后，面板上每一处会变的样子（完全不变的不列，写在表下面）。
   这张表是请用户点头的清单：b 段换完以后，面板上除了这里列的，不能有别的变化。
   每一行的数字都由脚本对着对比块量出来的计算样式核对过：对比块里「现在」和「归并后」两边，
   每个被量的元素（对比块的 id、data-item、data-state）差了哪些属性，都必须出现在某一行的 targets 和 props 里，没有漏列。
   「现在」那边先拿真的面板页面核对过（把标记放进真的面板里量，和展示页里「现在」那边一致），所以这里的「现在」是面板里真有的数。 */
export interface Change {
  id: string;
  /** 哪一块 */
  part: string;
  /** 哪个东西（旧类名） */
  where: string;
  /** 变的是什么 */
  what: string;
  now: string;
  after: string;
  diff: string;
  /** 对应哪些被量的元素，写成「对比块 id:data-item[:data-state]」 */
  targets: string[];
  /** 对应哪些量出来的属性（核对用）：CSS 属性名，加上 rect-width、rect-height（元素框的宽、高）、text-x、text-y（第一段文字相对元素框左上角的位置） */
  props: string[];
  /** 只有一个数字时，脚本核对 props[0] 量出来的就是这两个值（px） */
  nowNum?: number;
  afterNum?: number;
}

const RADIUS = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
];

export const CHANGES: Change[] = [
  /* ---------- 玻璃 ---------- */
  {
    id: 'tray-radius',
    part: '玻璃面板',
    where: '收纳盒（.tray）',
    what: '圆角',
    now: '18px',
    after: '16px（玻璃面板统一的 --ll-radius-xl）',
    diff: '每个角 −2px',
    targets: ['surf-tray:tray'],
    props: RADIUS,
    nowNum: 18,
    afterNum: 16,
  },
  {
    id: 'glass-button-blur',
    part: '玻璃面板',
    where: '玻璃样子的按钮（「回到最新」，库里的 Button glass）',
    what: '背后的模糊（这一行 b 段第一次换面板时不动，第二段改库里的按钮时才变）',
    now: 'blur(12px)',
    after: 'blur(16px) saturate(1.2)（--ll-glass-blur）',
    diff: '糊得更开，背后的颜色饱和度 +20%',
    targets: ['surf-glassbtn:glass-btn'],
    props: ['backdrop-filter'],
  },
  /* ---------- 提示条 ---------- */
  {
    id: 'pill-blur',
    part: '提示条',
    where: '时间线、对话顶上的小提示（.log-pill）',
    what: '背后的模糊',
    now: 'blur(12px)，没有饱和度',
    after: 'blur(16px) saturate(1.2)（--ll-glass-blur，和整理提示条、收纳盒一样）',
    diff: '糊得更开，背后的颜色饱和度 +20%',
    targets: ['notice-sm:pill', 'notice-sm:pill-err', 'notice-sm:pill-retry'],
    props: ['backdrop-filter'],
  },
  {
    id: 'pill-height',
    part: '提示条',
    where: '时间线、对话顶上的小提示（.log-pill）',
    what: '高度（行高 18.59 加上下内边距各 3，换成最小高 24）',
    now: '24.59px',
    after: '24px',
    diff: '−0.59px',
    targets: ['notice-sm:pill', 'notice-sm:pill-err', 'notice-sm:pill-retry'],
    props: ['padding-top', 'padding-bottom', 'rect-height'],
    nowNum: 3,
    afterNum: 0,
  },
  {
    id: 'pill-text',
    part: '提示条',
    where: '时间线、对话顶上的小提示（.log-pill）',
    what: '文字在药丸里的上下位置（跟着高度变，居中）',
    now: '离药丸上沿 3px',
    after: '离药丸上沿 2.7px',
    diff: '上移 0.3px',
    targets: ['notice-sm:pill', 'notice-sm:pill-err', 'notice-sm:pill-retry'],
    props: ['text-y'],
  },
  {
    id: 'bar-leave-width',
    part: '提示条',
    where: '整理提示条（.arrange-bar）退出时（点「完成」，条固定在原处淡出的 0.26 秒）',
    what: '整个条的宽度、字和按钮的左右位置（面板把量到的整条宽写进 style.width，旧的盒模型当它是内容宽）',
    now: '446.06px（比退出前的 422.06px 宽 24px），字离左边 28px，按钮跟着右移 12px',
    after: '422.06px（和退出前一样，库的提示条是 border-box），字离左边 16px',
    diff: '淡出的瞬间不再先宽 24px、字和按钮不再右挪 12px。想要和现在逐像素一样的写法见表下面「量不出来」的第二条',
    targets: ['notice-lg-leave:bar-leave'],
    props: ['rect-width', 'text-x'],
  },
  /* ---------- 空状态 ---------- */
  {
    id: 'now-empty-title',
    part: '空状态',
    where: '「此刻」的空，标题（.now-empty-t）',
    what: '标题的字号、字重',
    now: '14px、不加粗（400）',
    after: '13px、粗 500（和别处的空状态一样）',
    diff: '字号 −1px、变粗一档；这一行矮 1.55px（行高 21.7 → 20.15），变窄 5px',
    targets: ['empty-now:now-empty-title', 'empty-now:now-empty'],
    props: ['font-size', 'font-weight', 'line-height', 'rect-width', 'rect-height', 'text-x'],
    nowNum: 14,
    afterNum: 13,
  },
  {
    id: 'now-empty-block',
    part: '空状态',
    where: '「此刻」的空，整块（.now-empty）',
    what: '整块居中的内容（标题变矮 1.55px，整块跟着矮）',
    now: '居中',
    after: '居中，文字整体下移约 0.8px',
    diff: '+0.78px',
    targets: ['empty-now:now-empty-box'],
    props: ['text-x', 'text-y'],
  },
  {
    id: 'desk-empty-size',
    part: '空状态',
    where: '桌面空着时的一句话（.desk-empty）',
    what: '字号',
    now: '14px（继承页面）',
    after: '13px（和别处的空状态一样）',
    diff: '字号 −1px；这一块矮 1.55px；每个字窄 1px，居中，起点右移半个字的宽度（和句子多长没关系）',
    targets: ['empty-desk:desk-empty'],
    props: ['font-size', 'line-height', 'rect-height', 'text-x'],
    nowNum: 14,
    afterNum: 13,
  },
  /* ---------- 表单项 ---------- */
  {
    id: 'field-row-label',
    part: '表单项',
    where: '窗口里设置的标签（.skel-live 里的 .set-label）',
    what: '标签的字号（横排时）',
    now: '12.5px',
    after: '12px（刻度里最近的一档）',
    diff: '字号 −0.5px；标签矮 0.78px（行高 19.375 → 18.6），窄 1px；这一行里的文字在竖直居中后下移 0.39px',
    targets: ['field-row:label', 'field-row:label2', 'field-row:field', 'field-row:field2'],
    props: ['font-size', 'line-height', 'rect-width', 'rect-height', 'text-y'],
    nowNum: 12.5,
    afterNum: 12,
  },
  /* ---------- 链接 ---------- */
  {
    id: 'link-focus',
    part: '链接',
    where: '写出来的链接和自动认出的网址的键盘焦点环（.md-a、a.hl-url）',
    what: '焦点环：偏移、圆角（并进库里统一的那一条）',
    now: '2px 实线，离字 1px，圆角 3px',
    after: '2px 实线，离字 2px，没有圆角',
    diff: '偏移 +1px，不再带圆角',
    targets: ['link:a:focus', 'link:u:focus'],
    props: ['outline-offset', ...RADIUS],
    nowNum: 1,
    afterNum: 2,
  },
  /* ---------- 统计格 ---------- */
  {
    id: 'tile-radius',
    part: '统计格',
    where: '今日概况全屏的方格（.tile）',
    what: '圆角',
    now: '14px',
    after: '12px（半透明面板统一的 --ll-radius-lg）',
    diff: '每个角 −2px',
    targets: ['stat-tile:tile', 'stat-tile:tile2'],
    props: RADIUS,
    nowNum: 14,
    afterNum: 12,
  },
  {
    id: 'stat-row-font',
    part: '统计格',
    where: '今日概况里一行的统计（.stat-row，标签在左、数字在右）',
    what: '字号',
    now: '12.5px',
    after: '12px（刻度里最近的一档）',
    diff: '字号 −0.5px；每行矮 0.78px（行高 19.375 → 18.6），标签、数字窄 1～6px。今日卡片里几行统计叠着排，下面各行依次上移 0.78、1.56、2.34px',
    targets: [
      'stat-lines:token',
      'stat-lines:token-label',
      'stat-lines:token-value',
      'stat-lines:row',
      'stat-lines:row-line',
      'stat-lines:row-label',
      'stat-lines:row-b',
      'stat-lines:row2',
      'stat-lines:row2-line',
      'stat-lines:row2-label',
      'stat-lines:row2-value',
    ],
    props: ['font-size', 'line-height', 'rect-width', 'rect-height', 'text-x'],
    nowNum: 12.5,
    afterNum: 12,
  },
];

/* 没有变化的：脚本量过，两边一样（以每个对比块里量的所有属性、位置、字的位置为准） */
export const UNCHANGED: string[] = [
  '整理提示条（.arrange-bar）：底、边光、模糊（本来就是 16px 加饱和度）、圆角、内边距、字号、按钮的位置和大小、整条的高（44）。窄窗口里最宽那条见表下面「量不出来、或不是数值的变化」',
  '时间线的小提示里带「重试」的：按钮的位置和大小（从 inline-block 加 margin-left 8 换成 flex 的 gap 8，量出来一样）',
  '空状态（.empty）：位置、大小、标题和说明的字号字重颜色、带「重试」时按钮的位置、flat 的',
  '骨架线（.skel-bar）和占位输入框（.set-input，含高 120 的）：高、圆角、底、细线；设置里两种分组外框（.skel-group、.skel-live）的底、细线、圆角、内边距',
  '设置的表单项（竖排的 .set-field）：标签、控件、说明的字号、颜色、位置',
  '分段摘要（.seg-sum）：底、细线、圆角、内边距、字',
  '夜空窗口：窗口（.w-card 加 .w-vig）、胶囊（.cap）、消失的空壳（.ghost）的底、外阴影、圆角、裁切、暗边和细线',
  '链接（.md-a、a.hl-url）：平常和悬停的颜色、下划线（实线淡色 / 虚线）、悬停的变亮',
  '数字滚动（.roll）：平常和滚动中（变白）；头条（.today-hero）的大数字和单位；方格里的小标题、大数字',
  '能量槽（.energy）：高、底、渐变、danger 的颜色、宽度的过渡（0.9 秒，动画关掉时 0.12 秒）、扫光',
];

/* 量不出来、或不是数值的变化 */
export const NOTES: string[] = [
  '整理提示条最宽（已定）：现在写 max-width: calc(100% - 32px)，那是内容宽（content-box），加上左右内边距 24 才是整个条；库的提示条是 border-box，所以 b 段面板里写成 calc(100% - 8px)，整个条的宽和现在一样，窄窗口里的折行也一样（上面「提示条 lg 在窄窗口里」那块，归并后那边就是这样写的）。',
  '整理提示条退出时的宽度有两种写法要你定：B（建议）面板的代码不变，条退出前后一样宽，淡出的 0.26 秒里不再先宽 24px（表里那一行）；A 是保持和现在逐像素一样的写法：面板量宽以后加 24（style.width 写成 barPos.width + 24），代码里带着一个补旧盒模型的 24。上面「提示条 lg 退出时的宽度」那块把两种都摆出来了。',
  '数字滚动开始得比面板现在的晚一点：库的 Roll 第一帧只记下起点、第二帧才开始动，比现在（Motion）晚不到一帧（16.7 毫秒以内）；时长（0.9 秒）、终点、曲线都一样。',
  '夜空窗口的空壳（.ghost）多了 isolation: isolate（窗口、胶囊本来就有）：只影响里面元素的叠放，空壳里没有会受影响的东西，看不出区别。',
  '能量槽的圆角原来写字面的 3px，库里写成全圆角（999px）：槽高 6px，画出来都是 3px，一样。',
  '链接的悬停只在能悬停的设备上才变（@media (hover: hover)）：桌面 Chrome 没有区别，触屏上点过以后不再卡在悬停色。',
  '数字滚动：计时从 Motion 的 animate 换成库自己用 requestAnimationFrame 走，曲线（EASE_OUT）、时长（0.9 秒）、中途换值接着滚、关动画时直接到位都一样；滚动期间的标记从类 .is-up 换成属性 data-rolling（颜色规则跟着换）。',
  '能量槽的扫光：标记从类 .run 换成属性 data-run，CSS 里「动画开着才扫」的条件从 .motion 类换成同样意思的写法（根上没有 still 类，系统没开「减少动态效果」；或者根上有 motion 类），面板里根上的 motion、still 类照旧管用。',
  '空状态的标记换了：说明文字由「直接跟在 <b> 后面」变成 Empty 的 children，标题是 .ll-empty-title；「此刻」的空、桌面的空外面要留一层居中的 grid（布局，留在面板）。',
  '表单项：标签原来永远是 <span>（占位字段是 <label>），现在给了 htmlFor 才是 <label>；说明同时写进根元素的 title（原来就是）；横排还是竖排由面板按窗口还是全屏传 layout，不再靠外层的后代选择器。',
  '链接：自动认出的网址（a.hl-url）多了 overflow-wrap: anywhere（.md-a 原来就有）；它们都放在气泡里，气泡本来就是这个设置，继承下来一样，没有区别。',
  '统计格方格里的数字（.tile .roll）原来是 flex 子项（铺满整格宽），现在是 Roll 套在 .ll-stat-value 里（只有数字那么宽）：字在同一处，看不出区别。',
];
