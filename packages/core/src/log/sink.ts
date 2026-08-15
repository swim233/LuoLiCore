import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ulid } from 'ulid';
import type { OperationsRepository } from '@luoli/db';
import { redact } from '../secrets.js';

export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  kind: string;
  summary: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  chatId?: string;
  userId?: string;
  key?: string;
  data?: unknown;
  durationMs?: number;
}

const CATEGORY_BY_PREFIX: Record<string, string> = {
  model: 'model', tool: 'tool', sandbox: 'tool', approval: 'tool', system: 'system',
  config: 'system', maintenance: 'system', webui: 'system', plugin: 'system', mcp: 'system',
};
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export interface LogSinkOptions {
  level?: LogEvent['level'];
  maxFileMb?: number;
  bodyMaxBytes?: number;
  console?: 'pretty' | 'json' | 'off';
}

export class LogSink {
  #level: LogEvent['level'];
  readonly #maxFileBytes: number;
  readonly #bodyMaxBytes: number;
  readonly #console: 'pretty' | 'json' | 'off';

  constructor(private readonly repository: OperationsRepository, private readonly directory: string, private readonly secrets: string[] = [], options: LogSinkOptions = {}) {
    this.#level = options.level ?? 'debug';
    this.#maxFileBytes = (options.maxFileMb ?? 128) * 1024 * 1024;
    this.#bodyMaxBytes = options.bodyMaxBytes ?? 262_144;
    this.#console = options.console ?? 'off';
  }

  setLevel(level: LogEvent['level']): void {
    this.#level = level;
  }

  event(input: LogEvent): number {
    if (LEVEL_RANK[input.level] < LEVEL_RANK[this.#level]) return 0;
    const safe = redact(input, this.secrets);
    const prefix = input.kind.split('.')[0] ?? 'turn';
    const category = CATEGORY_BY_PREFIX[prefix] ?? 'turn';
    const day = new Date().toISOString().slice(0, 10);
    let data = safe.data;
    let fileRef: string | undefined;
    if (data !== undefined) {
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > this.#bodyMaxBytes) {
        fileRef = join(day, 'blobs', `${Date.now()}-${ulid()}.json`);
        const blobPath = resolve(this.directory, fileRef);
        mkdirSync(dirname(blobPath), { recursive: true, mode: 0o700 });
        writeFileSync(blobPath, serialized, { mode: 0o600 });
        data = { fileRef, bytes: Buffer.byteLength(serialized) };
      }
    }
    const path = join(this.directory, day, `${category}.jsonl`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size >= this.#maxFileBytes) {
      let suffix = 1;
      while (existsSync(`${path}.${suffix}`)) suffix += 1;
      renameSync(path, `${path}.${suffix}`);
    }
    const stored = { ...safe, data };
    const line = JSON.stringify({ ts: Date.now(), ...stored, ...(fileRef ? { fileRef } : {}) });
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
    if (this.#console === 'json') process.stdout.write(`${line}\n`);
    else if (this.#console === 'pretty') process.stdout.write(`${new Date().toISOString()} ${input.level.toUpperCase()} ${input.kind} ${input.summary}\n`);
    return this.repository.insertLog(stored);
  }

  span(input: Omit<LogEvent, 'spanId'>): { id: string; end: (data?: unknown, error?: unknown) => void } {
    const id = ulid();
    const started = performance.now();
    let ended = false;
    return {
      id,
      end: (data?: unknown, error?: unknown) => {
        if (ended) return;
        ended = true;
        const level = error ? 'error' : input.level;
        this.event({ ...input, level, spanId: id, data: error ? { error: error instanceof Error ? error.message : String(error), data } : data, durationMs: Math.round(performance.now() - started) });
      },
    };
  }
}
