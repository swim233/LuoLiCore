import type { ReactNode } from 'react';

/* 聊天内容的数据形状：库不认识 AI SDK 的消息，只收这些简单的结构，由用它的项目把自己的消息变成这些（面板在 model/bubble.ts 里转）。 */

/** 一张图的信息：地址和（知道的话）原图的宽高（知道宽高时按原图比例占位，加载完不会把列表顶开） */
export interface ChatImage {
  src: string;
  width?: number;
  height?: number;
}

/** 气泡里的角色：决定底色和名字的颜色。别人、自己、助手 */
export type ChatRole = 'other' | 'self' | 'assistant';
/** 气泡靠哪边：start 靠左、end 靠右，靠近说话人的那个下角收尖 */
export type ChatSide = 'start' | 'end';

/** 一条消息按先后排的块：文字、图片（连着的并成一排）、思考、工具调用 */
export type ChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; info: ChatImage | null | undefined; name?: string }
  | { kind: 'think'; text: string; sec?: number; streaming: boolean }
  | {
      kind: 'tool';
      name: string;
      /** 工具名后面那一行写的话：给界面看的一句话，没有就是参数的前一截（由用的项目算好，库不认识参数） */
      label: string;
      state: 'running' | 'ok' | 'error';
      input: unknown;
      /** 用了多少毫秒 */
      ms?: number;
      /** 结果的文字（接口里截短过的）与原来的长度 */
      outText?: string;
      chars?: number;
      truncated?: boolean;
      images: (ChatImage | null | undefined)[];
      errorText?: string;
    };

/** 一条消息已经结束的方式：中止、出错；还在进行或正常结束为 null */
export type ChatEnded = 'abort' | 'fail' | null;

/** 正在逐字出的回复的状态 */
export interface ChatLive {
  /** 这一处逐字输出的标识：光标上的 data-stream 写它，用的项目按它找「这一处现在看得见的光标」 */
  streamId: string;
  streaming: boolean;
  lingerUntil: number;
  /** 回复正常完成、最后一个字出现的那一刻（刚渲染完，光标已经在最后一个字后面）。每次回复只调一次；参数是取光标的函数。中止、出错不给 */
  onRevealed?: (cursor: () => HTMLElement | null) => void;
}

/** 毛玻璃：默认气泡自己实时模糊（backdrop-filter）；用的项目有别的做法（预先糊好的一层垫在气泡里）时从这里传进来 */
export interface ChatGlass {
  /** 气泡自己实时模糊（默认 true）；false 就不模糊，由 layer 画气泡后面的东西 */
  blur?: boolean;
  /** 垫在气泡里第一个子元素的位置的一层（气泡后面的星空）：库只给它留位置，铺满气泡、圆角跟着气泡（样子和对位是用的项目的事） */
  layer?: ReactNode;
}

/** 正文里「提到助手」的高亮要认的名字：助手的显示名、唤醒词、bot 的 @用户名（不带 @）。没有就不高亮「提到」 */
export interface ChatMentionsValue {
  name: string;
  wakeWords: readonly string[];
  username?: string;
}
