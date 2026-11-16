/* toast 的指令缓冲（纯逻辑，不碰 DOM、不认识 React 和 Base UI；toast.tsx 用它，测试里直接试）。
   为什么要缓冲：Base UI 的 toast 管理器只是一个监听器集合，<Toaster /> 还没挂上（没人订阅）时发的指令就丢了；
   而 toast() 是普通函数，页面刚启动、<Toaster /> 还没挂上时就可能被调（比如启动时读出来的偏好有问题要提示一句）。
   所以 toast() 把指令都交给总线：有人接着（attach）就直接送过去；没人接着就先存着，有人接上时按顺序补发。
   - put：显示或原地更新一条（id 是给定的，toast() 在调用的当时就定好并返回，不用等 Toaster）；close：关一条（带 id）或全部（不带 id）；
   - 存着的时候压一压：同一个 id 的 put 合并成一条（后面的盖前面的，位置不变）；close(id) 把存着的同一个 id 的 put 一起撤掉（那条根本还没显示过，
     不用「先出现再消失」）；close() 把存着的全部清掉；存着的最多 MAX_PENDING 条，满了丢最旧的（Toaster 一直没挂上时不无限涨）；
   - 接着的人走了（detach，比如 <Toaster /> 卸载）以后，再来的指令又先存着，下一个接上的人补发；
   - 同时有几个人接着（页面里挂了不止一个 <Toaster />，本来不该这样）：指令送给最后接上的那个；它走了就退回到前一个，谁先走谁后走都不会让剩下的收不到。 */
export interface ToastPut<T> {
  type: 'put';
  id: string;
  item: T;
}
export interface ToastClose {
  type: 'close';
  /** 不给 id 就是全部 */
  id?: string;
}
export type ToastCommand<T> = ToastPut<T> | ToastClose;

/** 没人接着时最多存这么多条 */
export const MAX_PENDING = 50;

export interface ToastBus<T> {
  /** 发一条指令：有人接着就直接送过去，没有就存着 */
  post(cmd: ToastCommand<T>): void;
  /** 有人接着：先把存着的按顺序补发，之后的指令直接送过去。返回「不接了」的函数（只撤掉自己这一次接上） */
  attach(sink: (cmd: ToastCommand<T>) => void): () => void;
  /** 存着几条（测试用） */
  pending(): number;
}

export function createToastBus<T>(): ToastBus<T> {
  const sinks: ((cmd: ToastCommand<T>) => void)[] = [];
  let queue: ToastCommand<T>[] = [];

  const hold = (cmd: ToastCommand<T>) => {
    if (cmd.type === 'close') {
      if (cmd.id === undefined) {
        queue = [];
        return;
      }
      const at = queue.findIndex((c) => c.type === 'put' && c.id === cmd.id);
      // 存着的里面有这一条：撤掉就行（它还没显示过）；没有的就是不认识的 id，也不用存
      if (at !== -1) queue.splice(at, 1);
      return;
    }
    const at = queue.findIndex((c) => c.type === 'put' && c.id === cmd.id);
    if (at !== -1) queue[at] = cmd;
    else queue.push(cmd);
    if (queue.length > MAX_PENDING) queue.shift();
  };

  return {
    post(cmd) {
      const sink = sinks[sinks.length - 1];
      if (sink) sink(cmd);
      else hold(cmd);
    },
    attach(next) {
      sinks.push(next);
      const replay = queue;
      queue = [];
      for (const cmd of replay) next(cmd);
      return () => {
        const at = sinks.lastIndexOf(next);
        if (at !== -1) sinks.splice(at, 1);
      };
    },
    pending: () => queue.length,
  };
}
