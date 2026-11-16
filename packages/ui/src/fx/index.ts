/* @luoli/ui/fx：窗口和背景上的特效——背景星空、星尘粒子（迸发、汇聚成形、散开）、三种悬停的效果（流光、边光、倾斜）、流光（edgeRun）。
   样式是单独的一份 @luoli/ui/fx.css（不在总样式 styles.css 里，用的项目在入口另引一次，排在 styles.css 后面）。
   入口加载时不碰 DOM（node 里能 import）；Worker、画布到 start 里才碰。库不认识外壳：
   - 星空：sky.start(canvas, { narrow, lowPower })，Worker 库自己建（也可以传自己建好的 worker）；全屏时要不要停住（sky.hold）、动画开关变了（sky.sync）由用的地方调；
   - 星尘：fx.start(canvas, { worker })，Worker 由用的地方建好传进来，入口里调 particleMessage（先问自己的消息再交给它，别的画布能共用这个 Worker）；
     窄屏、性能低时粒子少一点由 scale 传进来；窗口大小变了时 fx.size()，和这个 Worker 共用的东西用 fx.onResize 登记；
   - 悬停：窗口加类 ll-hover，用 hoverHandlers 的处理函数，根元素用 setHoverEffect 说用哪一种；窗口里放 <i class="ll-edge">，edgeRun 放流光。
   seed：星空、星尘的 Worker 都收一个可选的固定种子（随机数换成固定的序列，每次画出来一样，截图对照、测试用）。 */
export { sky } from './sky';
export type { SkyColors, SkyOptions } from './sky';
export { fx } from './fx';
export type { FxOptions, RectLike } from './fx';
export { particleMessage } from './particles';
export type { ParticleMsg } from './particles';
export { edgeRun } from './edge';
export type { EdgeRunOptions } from './edge';
export { hoverHandlers, setHoverEffect } from './hover';
export type { HoverEffect, HoverOptions } from './hover';
export { makeRandom, seededRandom } from './random';
