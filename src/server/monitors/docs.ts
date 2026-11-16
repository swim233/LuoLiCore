import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ServiceError } from '../services/layer.js';
import { fieldsText, limitsText, opsText } from './rules.js';

// 元文档「监视任务怎么写」（ADR-0014）：read_docs 的 doc 写 monitor 时读它。手写的部分是
// docs/monitor.md（发给模型的原文，不做格式化）；{{fields}}、{{ops}}、{{limits}} 由程序从 rules.ts 填。
// 启动时检查文件在、占位认得、三个都在；每次读的时候重新读文件

/** read_docs 里元文档的名字；不能有服务叫这个名字 */
export const monitorDocName = 'monitor';

const defaultFile = fileURLToPath(new URL('./docs/monitor.md', import.meta.url));

/** 占位与填进去的文字 */
const placeholders: Record<string, () => string> = {
  fields: fieldsText,
  ops: opsText,
  limits: limitsText,
};

// 写法同提示词文件：{{名字}}，{{ 与 }} 之间（不跨行）的任何文字都算一个占位
const placeholder = /\{\{([^{}\n]*)\}\}/g;

/** 文字里占位的毛病：不认得的、缺了的；没有毛病时是空的 */
function problemsOf(text: string): string[] {
  const used = new Set([...text.matchAll(placeholder)].map((match) => match[1]!));
  return [
    ...[...used]
      .filter((name) => !(name in placeholders))
      .map((name) => `不认得的占位 {{${name}}}`),
    ...Object.keys(placeholders)
      .filter((name) => !used.has(name))
      .map((name) => `缺了占位 {{${name}}}`),
  ];
}

export type MonitorDoc = {
  /** 启动时检查：文件读得了、占位都对。有毛病时返回说明（服务打到 stderr 后退出），没有时 undefined */
  check(): string | undefined;
  /** 读一次（每次都重新读文件），占位填好。读不了或占位不对时抛 ServiceError（docs） */
  read(): Promise<string>;
};

/** 元文档。file 默认是这个目录下的 docs/monitor.md，测试里换成临时文件 */
export function createMonitorDoc({ file = defaultFile }: { file?: string } = {}): MonitorDoc {
  const label = '监视任务的文档（src/server/monitors/docs/monitor.md）';
  return {
    check() {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (error) {
        return `${label}读不了：${(error as NodeJS.ErrnoException).code ?? String(error)}`;
      }
      const problems = problemsOf(text);
      return problems.length > 0 ? `${label}有误：${problems.join('，')}` : undefined;
    },
    async read() {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        throw new ServiceError('docs', '监视任务的文档读不了');
      }
      if (problemsOf(text).length > 0) throw new ServiceError('docs', '监视任务的文档读不了');
      return text.replace(placeholder, (_whole, name: string) => placeholders[name]!());
    },
  };
}

/** 有服务叫 monitor 时的说明（和元文档重名，服务启动时报错退出）；没有时 undefined */
export function monitorDocClash(services: ReadonlyArray<{ name: string }>): string | undefined {
  return services.some(({ name }) => name === monitorDocName)
    ? `服务名 ${monitorDocName} 和监视任务的文档重名，服务改个名字`
    : undefined;
}
