import { afterEach, describe, expect, it } from 'vitest';
import { formatPretty, highlight, tagged } from '@luoli/core';

const ESC = String.fromCharCode(27); // SGR 前缀，源码里不放裸控制字符
const AT = new Date(2026, 7, 30, 9, 5, 3, 47).getTime();
/** 取某一段文本前面那个 SGR 的色号。着色只求「同类同色、异类异色」，因此断色号相等与否，不断具体值。 */
const colorBefore = (line: string, text: string): string =>
  line.match(new RegExp(`${ESC}\\[(\\d+)m${text.replace(/[.\\+*?[\]^$(){}|]/g, '\\$&')}`))![1]!;

afterEach(() => { delete process.env.FORCE_COLOR; });

describe('pretty 控制台行', () => {
  /** 着色由 Node 按目标流判定，非终端时应当一个字节都不多写 —— 日志重定向进文件、
   *  journald 与 `docker logs` 走的都是这一路，混进 SGR 序列后 grep 与 awk 的列就不对齐了。 */
  it('非终端不写转义序列，五个字段按序在行上', () => {
    const line = formatPretty(AT, { level: 'info', kind: 'model.call', summary: 'openai/gpt-5 in=6240', durationMs: 2431, traceId: '01JABCDEF9XZ' });
    expect(line).not.toContain(ESC);
    expect(line).toContain('09:05:03.047');
    expect(line).toContain('INFO');
    expect(line).toContain('model.call');
    expect(line).toContain('openai/gpt-5 in=6240');
    expect(line).toContain('2431ms');
    expect(line).toContain('#DEF9XZ');           // trace 只留尾六位，整条 ULID 占满半行
  });

  it('无耗时与 traceId 时不留空位', () => {
    const line = formatPretty(AT, { level: 'warn', kind: 'quota.exceeded', summary: '今日额度用尽' });
    expect(line.endsWith('今日额度用尽')).toBe(true);
    expect(line).not.toContain('#');
  });

  /** 色相取自 `kind` 的命名空间而非整串：`tool.call` 与 `tool.result` 同色、与 `model.call` 不同色，
   *  刷屏时按颜色分组快于读文字。 */
  it('FORCE_COLOR 下着色，同一命名空间同色', () => {
    process.env.FORCE_COLOR = '1';
    const hue = (kind: string): string => colorBefore(formatPretty(AT, { level: 'info', kind, summary: 's' }), kind);
    expect(formatPretty(AT, { level: 'error', kind: 'tool.call', summary: 's' })).toContain(ESC);
    expect(hue('tool.call')).toBe(hue('tool.result'));
    expect(hue('tool.call')).not.toBe(hue('model.call'));
  });

  /** 慢 span 与快 span 不同色：耗时一列的作用就是让超时那几行自己跳出来。 */
  it('超过一秒的耗时换色', () => {
    process.env.FORCE_COLOR = '1';
    const hue = (durationMs: number): string => colorBefore(formatPretty(AT, { level: 'info', kind: 'tool.call', summary: 's', durationMs }), `${durationMs}ms`);
    expect(hue(999)).not.toBe(hue(1000));
  });
});

describe('启动期的 [tag] 行', () => {
  const LOCK = '[lock] 另一个实例正在使用该数据库（pid 4211）。\n[lock] 删除 ./data/luoli.db.lock 后重启。\n';

  /** 正文里是 SQL 清理命令、路径与 pid，整段染色对判读无帮助，也会盖掉正文自带的强调。 */
  it('只染行首的 tag，正文一个字节不动', () => {
    process.env.FORCE_COLOR = '1';
    const line = tagged('error', LOCK, process.stdout);
    const rows = line.split('\n').filter(Boolean);
    expect(rows).toHaveLength(2);                        // 两行的 tag 各染各的，不只染第一行
    // 剥掉「若干 SGR + [tag] + 若干 SGR」这个前缀；前缀不成形时 replace 空转，正文里就还留着 ESC。
    const body = (row: string): string => row.replace(new RegExp(`^(?:${ESC}\\[\\d+m)+\\[[a-z]+\\](?:${ESC}\\[\\d+m)+`), '');
    expect(rows.every((row) => !body(row).includes(ESC))).toBe(true);
    expect(line.replace(new RegExp(`${ESC}\\[\\d+m`, 'g'), '')).toBe(LOCK);
  });

  it('非终端时原样返回', () => {
    expect(tagged('error', LOCK, process.stdout)).toBe(LOCK);
    expect(highlight('setup-token', process.stdout)).toBe('setup-token');
  });

  /** 这些行没有级别列，严重程度只能落在 tag 的颜色上。 */
  it('info 按 tag 取色，warn 与 error 各自成色', () => {
    process.env.FORCE_COLOR = '1';
    const hue = (level: 'info' | 'warn' | 'error', tag: string): string => colorBefore(tagged(level, `[${tag}] x`, process.stdout), `[${tag}]`);
    expect(hue('info', 'ledger')).not.toBe(hue('info', 'context'));
    expect(hue('warn', 'ledger')).toBe(hue('warn', 'context'));
    expect(hue('warn', 'lock')).not.toBe(hue('error', 'lock'));
  });
});
