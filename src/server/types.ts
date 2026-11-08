// 洛璃服务对外的数据类型。网页面板会 import type 这个文件，所以这里不引用任何模块
// （网页的 tsconfig 没有 Node 的类型，也检查不了服务端的代码）

/** 洛璃服务此刻的状态：SSE 的 hello 与 /api/health 都用它 */
export type ServiceStatus = {
  /** 服务启动的时间，ISO */
  startedAt: string;
  /** 服务启动了多少秒 */
  uptimeSeconds: number;
  telegram: {
    /** 设了 token、启动了 Telegram 前端 */
    enabled: boolean;
    /** 连得上 Telegram（最近一次拉取更新成功）；没启动时为 false */
    connected: boolean;
  };
};

/**
 * 经 SSE（GET /api/events）推给面板的事件：事件名 → data 的类型。
 * 每个事件是一条 `event: 名字` 加一行 `data: JSON`；面板不认识的事件名直接忽略，
 * 以后加事件只在这里加一项，旧的不改。
 */
export type ServerEvents = {
  /** 连上时的第一个事件：服务此刻的状态。面板据此画出全部现状，之后的事件都是增量 */
  hello: ServiceStatus;
};
