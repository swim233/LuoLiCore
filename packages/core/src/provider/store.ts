import { createHash, randomBytes } from 'node:crypto';
import type { Sqlite } from '@luoli/db';
import type { Secrets } from '../secrets.js';

export interface ProviderInput {
  id?: string;
  name: string;
  kind: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export class ProviderStore {
  constructor(private readonly db: Sqlite, private readonly secrets: Secrets) {}

  save(input: ProviderInput): string {
    const id = input.id ?? randomBytes(16).toString('hex');
    const current = this.db.prepare('SELECT api_key_enc AS encrypted,api_key_hint AS hint FROM providers WHERE id=?').get(id) as { encrypted: string | null; hint: string | null } | undefined;
    let encrypted = current?.encrypted ?? null;
    let hint = current?.hint ?? null;
    if (input.apiKey) {
      if (!this.secrets.available) throw new Error('LUOLI_MASTER_KEY is unavailable');
      encrypted = this.secrets.encrypt(input.apiKey);
      hint = input.apiKey.length > 4 ? `…${input.apiKey.slice(-4)}` : 'set';
    }
    const now = Date.now();
    this.db.prepare(`INSERT INTO providers(id,name,kind,base_url,api_key_enc,api_key_hint,headers_json,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,
      api_key_enc=excluded.api_key_enc,api_key_hint=excluded.api_key_hint,headers_json=excluded.headers_json,enabled=excluded.enabled,updated_at=excluded.updated_at`).run(
      id, input.name, input.kind, input.baseUrl ?? null, encrypted, hint, input.headers ? JSON.stringify(input.headers) : null, input.enabled === false ? 0 : 1, now, now);
    return id;
  }

  list(): unknown[] {
    return this.db.prepare('SELECT id,name,kind,base_url AS baseUrl,api_key_hint AS apiKeyHint,enabled,health_state AS healthState,health_error AS healthError FROM providers ORDER BY name').all();
  }

  key(id: string): string | null {
    const row = this.db.prepare('SELECT api_key_enc AS encrypted FROM providers WHERE id=? AND enabled=1').get(id) as { encrypted: string | null } | undefined;
    return row?.encrypted ? this.secrets.decrypt(row.encrypted) : null;
  }
}

export function fallbackOrder<T>(chain: T[], health: (entry: T) => boolean): T[] {
  return [...chain.filter(health), ...chain.filter((entry) => !health(entry))];
}

export function retryDelay(attempt: number, retryAfterMs: number | null, baseMs: number, maxMs: number): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, maxMs);
  const jitter = Number.parseInt(createHash('sha256').update(String(attempt)).digest('hex').slice(0, 4), 16) / 0xffff;
  return Math.min(baseMs * 2 ** attempt * (0.8 + jitter * 0.4), maxMs);
}
