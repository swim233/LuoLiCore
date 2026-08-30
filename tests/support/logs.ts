import { type Sqlite, decodeLogPayload } from '@luoli/db';

/**
 * 读 `log_events` 载荷的唯一入口（同 `tests/support/source.ts` 的理由：不留第二种写法可抄）。
 *
 * 载荷自 2026-08-30 起是 BLOB 且默认经 zstd 压缩（`data_codec`，docs/10 §3）。直接
 * `SELECT data … .pluck().get()` 拿到的是 Buffer —— `expect(buffer).toContain('foo')` 在 vitest 里
 * 会按数组成员判定，于是**恒假而不报错**；关掉压缩时它又碰巧能过。这类断言红着比恒假好，
 * 而恒假的断言与「谁来守住这件事」是同一个问题。
 */
export interface LogRow {
  id: number;
  kind: string;
  level: string;
  summary: string;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  durationMs: number | null;
  /** 解码后的载荷 JSON 文本；该行没有载荷时为 null。 */
  data: string | null;
}

export function logRows(db: Sqlite, kind?: string): LogRow[] {
  const sql = `SELECT id,kind,level,summary,trace_id AS traceId,span_id AS spanId,parent_span_id AS parentSpanId,
    duration_ms AS durationMs,data,data_codec AS codec FROM log_events${kind ? ' WHERE kind=?' : ''} ORDER BY id`;
  const rows = (
    kind ? db.prepare(sql).all(kind) : db.prepare(sql).all()
  ) as Array<LogRow & { data: Buffer | null; codec: string | null }>;
  return rows.map(({ codec, data, ...rest }) => ({
    ...rest,
    data: decodeLogPayload(data, codec),
  }));
}

/** 某个 kind 的全部载荷，按落库顺序。没有载荷的行给空串，便于直接 `.toContain`。 */
export const logPayloads = (db: Sqlite, kind: string): string[] =>
  logRows(db, kind).map((row) => row.data ?? '');

/** 第一条。用例通常只发一条，取不到时给空串而不是 undefined —— 断言失败信息更像话。 */
export const logPayload = (db: Sqlite, kind: string): string =>
  logPayloads(db, kind)[0] ?? '';

/** 最后一条。`ORDER BY id DESC LIMIT 1` 那一族的替代。 */
export const lastLogPayload = (db: Sqlite, kind: string): string =>
  logPayloads(db, kind).at(-1) ?? '';
