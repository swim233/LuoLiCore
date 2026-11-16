import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, ToolError } from '../../core/index.js';
import { closeAll } from '../../net/test-server.js';
import { ServiceError } from '../services/layer.js';
import { fakeService, tempDir } from '../services/test-services.js';
import { createServiceTools } from '../services/tools.js';
import { createMonitorDoc, monitorDocClash } from './docs.js';
import { fieldsText, limitsText, monitorFields, monitorOps, opsText } from './rules.js';
import { layerFor } from './test-monitors.js';

afterEach(closeAll);

/** 临时目录里的一份元文档 */
function docFile(text: string): string {
  const file = join(tempDir(), 'monitor.md');
  writeFileSync(file, text);
  return file;
}

describe('元文档', () => {
  it('仓库里的那份：启动时的检查通过；三个占位由程序填好，每个字段、每个比法都在里面', async () => {
    const doc = createMonitorDoc();
    expect(doc.check()).toBeUndefined();

    const text = await doc.read();
    expect(text).not.toMatch(/\{\{[^{}\n]*\}\}/);
    expect(text).toContain(fieldsText());
    expect(text).toContain(opsText());
    expect(text).toContain(limitsText());
    for (const { name } of monitorFields) expect(text).toContain(`- ${name}（`);
    for (const { op } of monitorOps) expect(text).toContain(`- ${op}（`);
  });

  it('每次读都重新读文件', async () => {
    const file = docFile('第一版 {{fields}} {{ops}} {{limits}}');
    const doc = createMonitorDoc({ file });
    expect(await doc.read()).toMatch(/^第一版 /);
    writeFileSync(file, '第二版 {{limits}} {{ops}} {{fields}}');
    expect(await doc.read()).toBe(`第二版 ${limitsText()} ${opsText()} ${fieldsText()}`);
  });

  it('启动时的检查：文件读不了、有不认得的占位、缺了占位，都说出来', () => {
    const label = '监视任务的文档（src/server/monitors/docs/monitor.md）';
    expect(createMonitorDoc({ file: join(tempDir(), 'none.md') }).check()).toBe(
      `${label}读不了：ENOENT`,
    );
    expect(
      createMonitorDoc({ file: docFile('{{fields}} {{ops}} {{limits}} {{ field }}') }).check(),
    ).toBe(`${label}有误：不认得的占位 {{ field }}`);
    expect(createMonitorDoc({ file: docFile('{{ops}}') }).check()).toBe(
      `${label}有误：缺了占位 {{fields}}，缺了占位 {{limits}}`,
    );
  });

  it('运行中读不了、占位不对：抛服务层的 docs 错误', async () => {
    const file = docFile('{{fields}} {{ops}} {{limits}}');
    const doc = createMonitorDoc({ file });
    writeFileSync(file, '{{fields}} {{ops}}');
    const error = await doc.read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ kind: 'docs', message: '监视任务的文档读不了' });
  });

  it('有服务叫 monitor 时和元文档重名', () => {
    expect(monitorDocClash([{ name: 'qweather' }])).toBeUndefined();
    expect(monitorDocClash([{ name: 'qweather' }, { name: 'monitor' }])).toBe(
      '服务名 monitor 和监视任务的文档重名，服务改个名字',
    );
  });
});

describe('read_docs 读元文档', () => {
  function readDocs(withMonitorDoc: boolean) {
    const { layer } = layerFor([fakeService()]);
    const monitorDoc = withMonitorDoc
      ? createMonitorDoc({ file: docFile('监视任务怎么写\n{{fields}}\n{{ops}}\n{{limits}}') })
      : undefined;
    const tool = createServiceTools(layer, monitorDoc ? { monitorDoc } : {})[0]!;
    const run = (input: Record<string, unknown>) =>
      Promise.resolve(
        tool.execute(tool.input.parse(input), {
          conversation: {},
          triggers: [],
          abortSignal: new AbortController().signal,
          logger: silentLogger,
          env: {},
        }),
      ) as Promise<string>;
    return { tool, run };
  }

  it('给了元文档：说明里多一句，doc 写 monitor 时读它（写了 section 也不管），界面摘要是「监视任务怎么写」', async () => {
    const { tool, run } = readDocs(true);
    expect(tool.description).toContain('doc 写 monitor（不用写 section）时读「监视任务怎么写」');
    const expected = `监视任务怎么写\n${fieldsText()}\n${opsText()}\n${limitsText()}`;
    expect(await run({ doc: 'monitor' })).toBe(expected);
    expect(await run({ doc: 'monitor', section: 'search' })).toBe(expected);
    expect(tool.summary!({ input: { doc: 'monitor' } })).toBe('监视任务怎么写');
    // 服务的文档照旧
    expect(await run({ doc: 'demo', section: 'search' })).toBe('# demo 的 search 一节\n');
  });

  it('没给元文档：说明照旧，doc 写 monitor 是没有这个服务', async () => {
    const { tool, run } = readDocs(false);
    expect(tool.description).not.toContain('monitor');
    const error = await run({ doc: 'monitor' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).message).toBe('没有这个服务：monitor（有：demo）');
  });
});
