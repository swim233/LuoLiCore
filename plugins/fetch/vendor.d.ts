// turndown 与它的 gfm 插件不带类型，这里只声明用到的部分

declare module 'turndown' {
  type Options = {
    headingStyle?: 'setext' | 'atx';
    codeBlockStyle?: 'indented' | 'fenced';
    bulletListMarker?: '-' | '+' | '*';
  };
  type Plugin = (service: TurndownService) => void;
  type Node = { nodeName: string; textContent: string | null };
  type Rule = {
    filter: (node: Node) => boolean;
    replacement: (content: string, node: Node) => string;
  };

  export default class TurndownService {
    constructor(options?: Options);
    use(plugin: Plugin | Plugin[]): this;
    addRule(key: string, rule: Rule): this;
    /** 传 HTML 字符串时由 turndown 自带的 domino 解析 */
    turndown(html: string): string;
  }
}

declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  /** 表格、删除线、任务列表、带语言名的代码块 */
  export function gfm(service: TurndownService): void;
}
