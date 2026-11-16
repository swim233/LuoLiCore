import { useMemo } from 'react';
import { nf } from '../util';

/* 聊天内容里写死的话：中文默认值，用的项目可以按需换（库里别的组件的做法：ConfirmButton 的 armedLabel、ListEdit 的 addLabel）。
   Markdown、Typed、Pic、ChatBubble 都收一个 labels（只写要换的那几条）；不给就是默认的。 */
export interface ChatLabels {
  /** 生成中又发的、还没被回复看到的消息 */
  queued: string;
  /** 「排队中」的悬停说明 */
  queuedTip: string;
  /** 思考：思考中、思考了 N 秒、没记秒数的、思考到一半断了、被中止 */
  thinking: string;
  thought: (sec: number) => string;
  thoughtPlain: string;
  thinkBroken: string;
  thinkAborted: string;
  /** 工具调用展开后：参数、结果（共多少字符、是不是只有开头）、出错、没有错误说明、没有参数、调用中、调用没完成、出错的状态字 */
  params: string;
  result: (chars: number, truncated: boolean) => string;
  error: string;
  noErrorText: string;
  noParams: string;
  calling: string;
  callUnfinished: string;
  errorShort: string;
  /** 回复出错中断的标记 */
  failedMark: string;
  /** 正在回复（打字的三个点）的读屏名字 */
  typing: string;
  /** 代码块：复制钮的字、点了以后的字、读屏名字；任务列表的方框 */
  copy: string;
  copied: string;
  copyCode: string;
  taskDone: string;
  taskTodo: string;
  /** 图片读不到、图片没有名字时的说明 */
  imageLost: string;
  image: string;
}

export const DEFAULT_LABELS: ChatLabels = {
  queued: '排队中',
  queuedTip: '洛璃正在回复上一条，这条等她说完再回复',
  thinking: '思考中…',
  thought: (sec) => `思考了 ${sec} 秒`,
  thoughtPlain: '思考过程',
  thinkBroken: '思考中断',
  thinkAborted: '思考被中止',
  params: '参数',
  result: (chars, truncated) => `结果 · 共 ${nf(chars)} 字符${truncated ? '，这里只有开头' : ''}`,
  error: '出错',
  noErrorText: '（没有错误说明）',
  noParams: '（无）',
  calling: '正在调用…',
  callUnfinished: '工具调用未完成',
  errorShort: '出错',
  failedMark: '（回复出错中断）',
  typing: '正在回复',
  copy: '复制',
  copied: '已复制',
  copyCode: '复制代码',
  taskDone: '已完成',
  taskTodo: '未完成',
  imageLost: '图片已丢失',
  image: '图片',
};

/** 只写了要换的几条：补全成完整的。不给（或给空）时是同一个对象，用它做 memo 的比较也稳 */
export function resolveLabels(over?: Partial<ChatLabels>): ChatLabels {
  if (!over || over === DEFAULT_LABELS) return DEFAULT_LABELS;
  const keys = Object.keys(over) as (keyof ChatLabels)[];
  if (!keys.some((k) => over[k] !== undefined)) return DEFAULT_LABELS;
  return {
    ...DEFAULT_LABELS,
    ...Object.fromEntries(keys.filter((k) => over[k] !== undefined).map((k) => [k, over[k]])),
  };
}

/** 组件里用：over 的内容没变（引用没变）时拿到的是同一个对象 */
export function useLabels(over?: Partial<ChatLabels>): ChatLabels {
  return useMemo(() => resolveLabels(over), [over]);
}
