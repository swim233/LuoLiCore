/**
 * AC-OPS-009 的扳机。`uncaughtException` / `unhandledRejection` 的处理器焊在
 * `apps/bot/src/main.ts` 的模块顶层（`process.on('uncaughtException'…)` 那两段），没有可单独
 * import 的导出 —— import 那个文件等于把整个 bot 装起来。所以只能起真进程，从进程内部制造
 * 那两种事件。**这里不复刻处理器**，只负责扣扳机；跑的仍是 main.ts 里那两个。
 *
 * `--import` 排在入口之前，那时处理器还没挂上，所以扳机挂在信号上、由测试择时扣动：
 * 第一枪 rejection、第二枪 exception。顺序本身是判据的一半 —— 进程扛住了前者才轮得到后者。
 */
let fired = 0;
process.on('SIGUSR2', () => {
  fired += 1;
  // 没有 .catch 的 promise：微任务队列排空时它仍无人认领，于是触发 unhandledRejection。
  if (fired === 1) return void Promise.reject(new Error('luoli-fatal-fixture-rejection'));
  // 从 timer 回调里抛而不是就地抛：信号回调里的 throw 走哪条路取决于 Node 内部，timer 一定是 uncaughtException。
  setTimeout(() => { throw new Error('luoli-fatal-fixture-exception'); }, 0);
});
